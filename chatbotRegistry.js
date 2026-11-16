"use strict";

const { randomUUID, scrypt, randomBytes, timingSafeEqual } = require("crypto");
const dns = require("dns/promises");
const net = require("net");
const pool = require("./dbPool");

// Block non-public IPv4/IPv6 ranges. DNS results are checked before the
// database record is created; if DNS cannot be resolved, registration fails.
const blockedAddresses = new net.BlockList();
[
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
    ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
    ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
    ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
].forEach(([address, prefix]) => blockedAddresses.addSubnet(address, prefix, "ipv4"));
[
    ["::", 128], ["::1", 128],
    ["64:ff9b:1::", 48], ["100::", 64], ["2001::", 23],
    ["2001:db8::", 32], ["2002::", 16], ["fc00::", 7],
    ["fe80::", 10], ["ff00::", 8]
].forEach(([address, prefix]) => blockedAddresses.addSubnet(address, prefix, "ipv6"));

function isPublicAddress(address) {
    const family = net.isIP(address);

    if (family === 4) {
        const blocked = blockedAddresses.check(address, "ipv4");
        return !blocked;
    }

    if (family === 6) {
        const first = parseInt(address.split(":")[0] || "0", 16);

        return (
            first >= 0x2000 &&
            first <= 0x3fff &&
            !blockedAddresses.check(address, "ipv6")
        );
    }

    return false;
}




// Errors with a message that is safe to show to the caller (bad input),
// as opposed to unexpected internal errors such as database failures.
function validationError(message) {
    const error = new Error(message);
    error.expose = true;
    return error;
}

async function assertPublicWebsiteUrl(parsedUrl) {
    const hostname = parsedUrl.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") ||
        hostname.endsWith(".local") || hostname.endsWith(".internal")) {
        throw validationError("Private or local network addresses cannot be registered.");
    }

    if (net.isIP(hostname)) {
        if (!isPublicAddress(hostname)) {
            throw validationError("Private or non-public IP addresses cannot be registered.");
        }
        return;
    }

    let addresses;
    try {
        addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    } catch {
        throw validationError("Website hostname could not be resolved safely.");
    }

    // Every address must be public; a mix of public and private is rejected.
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw validationError("Website hostname resolves to a private or non-public IP address.");
    }
}

// Only the standard web ports. Other ports are rarely public websites and
// would let the crawler probe arbitrary services on public hosts.
const ALLOWED_PORTS = new Set(["", "80", "443"]);

function normalizeWebsiteUrl(websiteUrl) {
    let parsedUrl;

    try {
        parsedUrl = new URL(String(websiteUrl || "").trim());
    } catch {
        throw validationError("Please enter a valid website URL.");
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw validationError("Only HTTP and HTTPS websites are supported.");
    }

    if (parsedUrl.username || parsedUrl.password) {
        throw validationError("Website URLs must not contain embedded credentials.");
    }

    if (!ALLOWED_PORTS.has(parsedUrl.port)) {
        throw validationError("Only websites on the standard ports (80 and 443) are supported.");
    }

    parsedUrl.hash = "";

    // Keep the path and query string because they may identify the page to crawl.
    const normalizedUrl = parsedUrl.toString();
    const allowedDomain = parsedUrl.hostname.toLowerCase();

    return { normalizedUrl, allowedDomain };
}

// Registering the same URL again returns the existing chatbot (preferring one
// that is already indexed) instead of creating a duplicate record.
// ownerAccountId: the customer account that owns the new chatbot (null = not assigned; platform admin
// only). An existing chatbot for the same address is returned only if it has the same owner, so two
// customers registering one website get two separate chatbots.
async function registerChatbot(websiteUrl, { ownerAccountId = null } = {}) {
    const { normalizedUrl, allowedDomain } = normalizeWebsiteUrl(websiteUrl);
    await assertPublicWebsiteUrl(new URL(normalizedUrl));

    const existing = await pool.query(
        `SELECT id, website_url, allowed_domain, status, owner_account_id
         FROM chatbots
         WHERE website_url = $1 AND owner_account_id IS NOT DISTINCT FROM $2
         ORDER BY (status = 'ready') DESC, created_at ASC
         LIMIT 1`,
        [normalizedUrl, ownerAccountId]
    );

    if (existing.rows[0]) {
        return { ...existing.rows[0], existing: true };
    }

    const id = randomUUID();

    const result = await pool.query(
        `INSERT INTO chatbots
            (id, website_url, allowed_domain, status, owner_account_id)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, website_url, allowed_domain, status, owner_account_id`,
        [id, normalizedUrl, allowedDomain, "pending", ownerAccountId]
    );

    return { ...result.rows[0], existing: false };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidChatbotId(id) {
    return typeof id === "string" && UUID_PATTERN.test(id.trim());
}

async function getChatbotById(id) {
    // Never send a malformed ID to PostgreSQL (the column is a UUID).
    if (!isValidChatbotId(id)) return null;

    const result = await pool.query(
        `SELECT ${CHATBOT_COLUMNS}
         FROM chatbots
         WHERE id = $1`,
        [id.trim()]
    );

    return result.rows[0] || null;
}

const CHATBOT_COLUMNS = `id, website_url, allowed_domain, status, created_at, updated_at,
    display_name, welcome_message, accent_color, allowed_origins,
    last_indexed_at, pages_indexed, pages_failed, chunks_indexed, crawl_complete, page_limit, last_error,
    pages_discovered, pages_not_processed, crawl_stop_reason, pages_read, pages_skipped, support_email,
    owner_account_id`;

// All chatbots (platform admin), or only those of one customer account.
async function listChatbots({ ownerAccountId } = {}) {
    if (ownerAccountId !== undefined) {
        if (!isValidChatbotId(ownerAccountId)) return [];
        const owned = await pool.query(
            `SELECT ${CHATBOT_COLUMNS} FROM chatbots WHERE owner_account_id = $1 ORDER BY created_at DESC`,
            [ownerAccountId]
        );
        return owned.rows;
    }
    const result = await pool.query(
        `SELECT ${CHATBOT_COLUMNS}
         FROM chatbots
         ORDER BY created_at DESC`
    );
    return result.rows;
}

// Assigns a chatbot to a customer account (null = unassigned). Platform admin only (checked in server.js).
async function setChatbotOwner(id, ownerAccountId) {
    if (!isValidChatbotId(id) || (ownerAccountId !== null && !isValidChatbotId(ownerAccountId))) return null;
    const result = await pool.query(
        `UPDATE chatbots SET owner_account_id = $2, updated_at = NOW() WHERE id = $1 RETURNING ${CHATBOT_COLUMNS}`,
        [id, ownerAccountId]
    );
    return result.rows[0] || null;
}

// ---- Customer accounts and login sessions ----
// Passwords: scrypt (Node's crypto, no extra dependency), stored as "scrypt$N$r$p$salt$hash" (base64).
// Session tokens: random 32 bytes in the cookie; only their SHA-256 is stored (sessions.token_hash).
const SCRYPT = { N: 16384, r: 8, p: 1, keyLength: 64 };
const ACCOUNT_COLUMNS = "id, email, status, created_at, password_changed_at, last_login_at";

function scryptAsync(password, salt, keyLength, options) {
    return new Promise((resolve, reject) => scrypt(password, salt, keyLength, options, (error, key) => (error ? reject(error) : resolve(key))));
}

async function hashPassword(password) {
    const salt = randomBytes(16);
    const key = await scryptAsync(String(password), salt, SCRYPT.keyLength, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024 });
    return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${key.toString("base64")}`;
}

// True only for the right password; a malformed stored hash is never a match.
async function verifyPassword(password, stored) {
    const parts = String(stored || "").split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const [N, r, p] = parts.slice(1, 4).map(Number);
    const salt = Buffer.from(parts[4], "base64"), expected = Buffer.from(parts[5], "base64");
    if (![N, r, p].every(Number.isInteger) || N > 1048576 || r > 32 || p > 16 || !salt.length || expected.length !== SCRYPT.keyLength) return false;
    const key = await scryptAsync(String(password), salt, expected.length, { N, r, p, maxmem: 256 * 1024 * 1024 });
    return timingSafeEqual(key, expected);
}

// email must already be validated; it is stored lower-case. Throws code 23505 for a duplicate email.
async function createAccount({ email, passwordHash }) {
    const result = await pool.query(
        `INSERT INTO accounts (id, email, password_hash) VALUES ($1, $2, $3) RETURNING ${ACCOUNT_COLUMNS}`,
        [randomUUID(), String(email).toLowerCase(), passwordHash]
    );
    return result.rows[0];
}

// With the password hash: only for checking a login.
async function getAccountForLogin(email) {
    const result = await pool.query("SELECT id, email, status, password_hash FROM accounts WHERE lower(email) = lower($1)", [String(email)]);
    return result.rows[0] || null;
}

async function getAccountById(id) {
    if (!isValidChatbotId(id)) return null;
    const result = await pool.query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

async function listAccounts() {
    const result = await pool.query(`SELECT ${ACCOUNT_COLUMNS} FROM accounts ORDER BY created_at`);
    return result.rows;
}

// Disable or enable an account. Its sessions end in the same statement.
async function setAccountStatus(id, status) {
    if (!isValidChatbotId(id) || !["active", "disabled"].includes(status)) return null;
    const result = await pool.query(
        `WITH ended AS (DELETE FROM sessions WHERE account_id = $1)
         UPDATE accounts SET status = $2 WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
        [id, status]
    );
    return result.rows[0] || null;
}

// A new password (already hashed). Its sessions end in the same statement.
async function setAccountPassword(id, passwordHash) {
    if (!isValidChatbotId(id)) return null;
    const result = await pool.query(
        `WITH ended AS (DELETE FROM sessions WHERE account_id = $1)
         UPDATE accounts SET password_hash = $2, password_changed_at = NOW() WHERE id = $1 RETURNING ${ACCOUNT_COLUMNS}`,
        [id, passwordHash]
    );
    return result.rows[0] || null;
}

async function recordLogin(accountId) {
    await pool.query("UPDATE accounts SET last_login_at = NOW() WHERE id = $1", [accountId]);
}

async function createSession(tokenHash, accountId, expiresAt) {
    await pool.query("INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)", [tokenHash, accountId, expiresAt]);
}

// The session with its account (email, status); null if unknown.
async function findSession(tokenHash) {
    const result = await pool.query(
        `SELECT s.account_id, s.last_seen_at, s.expires_at, a.email, a.status
         FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = $1`,
        [tokenHash]
    );
    return result.rows[0] || null;
}

async function touchSession(tokenHash) {
    await pool.query("UPDATE sessions SET last_seen_at = NOW() WHERE token_hash = $1", [tokenHash]);
}

async function deleteSession(tokenHash) {
    await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash]);
}

// Sessions past their maximum lifetime or idle for longer than idleMs.
async function deleteExpiredSessions(idleMs) {
    await pool.query("DELETE FROM sessions WHERE expires_at <= NOW() OR last_seen_at <= NOW() - make_interval(secs => $1)", [Math.round(idleMs / 1000)]);
}

// ---- Settings shown in the widget ----
const ACCENT_PATTERN = /^#[0-9a-f]{6}$/i;
const MAX_ALLOWED_ORIGINS = 10;

// Validates "https://www.example.com" style origins; returns the normalised origin.
function normalizeOrigin(value) {
    let parsed;
    try {
        parsed = new URL(String(value || "").trim());
    } catch {
        throw validationError(`"${String(value).slice(0, 60)}" is not a valid website address.`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
        throw validationError("Allowed websites must start with http:// or https://.");
    }
    return parsed.origin;
}

const SUPPORT_EMAIL_PATTERN = /^[^\s@<>()[\]",;:\\]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/;

async function updateChatbotSettings(id, settings) {
    if (!isValidChatbotId(id)) return null;

    const updates = {};
    if (settings.displayName !== undefined) {
        const name = String(settings.displayName || "").trim();
        if (name.length > 60) throw validationError("The chatbot name can be at most 60 characters.");
        updates.display_name = name || null;
    }
    if (settings.welcomeMessage !== undefined) {
        const message = String(settings.welcomeMessage || "").trim();
        if (message.length > 300) throw validationError("The welcome message can be at most 300 characters.");
        updates.welcome_message = message || null;
    }
    if (settings.accentColor !== undefined) {
        const color = String(settings.accentColor || "").trim();
        if (color && !ACCENT_PATTERN.test(color)) throw validationError("The colour must look like #2563eb.");
        updates.accent_color = color || null;
    }
    if (settings.supportEmail !== undefined) {
        const email = String(settings.supportEmail || "").trim();
        // One plain address (no names, lists or line breaks: it becomes an email header).
        if (email && (email.length > 254 || !SUPPORT_EMAIL_PATTERN.test(email))) {
            throw validationError("The support email must be one address like support@example.com.");
        }
        updates.support_email = email || null;
    }
    if (settings.allowedOrigins !== undefined) {
        if (!Array.isArray(settings.allowedOrigins)) throw validationError("Allowed websites must be a list.");
        if (settings.allowedOrigins.length > MAX_ALLOWED_ORIGINS) throw validationError(`At most ${MAX_ALLOWED_ORIGINS} allowed websites.`);
        const origins = [...new Set(settings.allowedOrigins.filter(value => String(value || "").trim()).map(normalizeOrigin))];
        updates.allowed_origins = origins.length ? origins.join(",") : null;
    }

    const columns = Object.keys(updates);
    if (!columns.length) return getChatbotById(id);

    const assignments = columns.map((column, index) => `${column} = $${index + 2}`).join(", ");
    const result = await pool.query(
        `UPDATE chatbots SET ${assignments}, updated_at = NOW() WHERE id = $1 RETURNING ${CHATBOT_COLUMNS}`,
        [id, ...columns.map(column => updates[column])]
    );
    return result.rows[0] || null;
}

// Stores the outcome of an indexing run (counts on success, a short reason on failure).
async function recordIndexingResult(id, result) {
    if (result.error) {
        await pool.query(
            "UPDATE chatbots SET last_error = $2, updated_at = NOW() WHERE id = $1",
            [id, String(result.error).slice(0, 300)]
        );
        return;
    }
    const counts = result.crawlCounts || {};
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query(
            `UPDATE chatbots
             SET last_indexed_at = NOW(), pages_indexed = $2, pages_failed = $3, chunks_indexed = $4,
                 crawl_complete = $5, page_limit = $6, last_error = NULL,
                 pages_discovered = $7, pages_not_processed = $8, crawl_stop_reason = $9, crawl_report = $10,
                 pages_read = $11, pages_skipped = $12,
                 updated_at = NOW()
             WHERE id = $1`,
            [id, result.pagesIndexed ?? result.pagesCrawled, result.pagesFailed, result.sectionsInIndex ?? result.chunksStored, result.crawlComplete, result.pageLimit,
                result.pagesDiscovered ?? null, result.pagesNotProcessed ?? null, result.stopReason || null,
                result.crawlReport ? JSON.stringify(result.crawlReport) : null,
                counts.read ?? null, counts.skipped ?? null]
        );
        // The URL-level report of this crawl replaces the previous one.
        if (Array.isArray(result.urlReport)) {
            await client.query("DELETE FROM crawl_urls WHERE chatbot_id = $1", [id]);
            const rows = result.urlReport;
            for (let start = 0; start < rows.length; start += 500) {
                const batch = rows.slice(start, start + 500);
                await client.query(
                    `INSERT INTO crawl_urls (chatbot_id, url, status, reason, source, http_status, sections, final_url, discovered_at, processed_at, title, duration_ms, attempts)
                     SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::text[], $9::timestamptz[], $10::timestamptz[], $11::text[], $12::int[], $13::int[])`,
                    [id,
                        batch.map(entry => String(entry.url).slice(0, 2000)),
                        batch.map(entry => entry.status),
                        batch.map(entry => entry.reason ? String(entry.reason).slice(0, 300) : null),
                        batch.map(entry => entry.source || null),
                        batch.map(entry => (Number.isInteger(entry.httpStatus) && entry.httpStatus > 0 ? entry.httpStatus : null)),
                        batch.map(entry => (Number.isInteger(entry.sections) ? entry.sections : null)),
                        batch.map(entry => entry.finalUrl ? String(entry.finalUrl).slice(0, 2000) : null),
                        batch.map(entry => entry.discoveredAt || null),
                        batch.map(entry => entry.processedAt || null),
                        batch.map(entry => entry.title ? String(entry.title).slice(0, 300) : null),
                        batch.map(entry => (Number.isFinite(entry.durationMs) && entry.durationMs >= 0 ? Math.round(entry.durationMs) : null)),
                        batch.map(entry => (Number.isInteger(entry.attempts) && entry.attempts > 0 ? entry.attempts : null))]
                );
            }
        }
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

// ---- URL-level crawl report (admin) ----
const CRAWL_URL_STATUSES = ["indexed", "failed", "skipped", "not-processed"];

// One page of the latest crawl's URL report, optionally filtered by status and a search
// text (part of the address or of the reason), plus the count per status.
// Single-URL crawl: replaces only these addresses' rows in the crawl report (the rest of the
// report stays), and refreshes the chatbot's page/section counts from the real stored state.
// sectionCount: the chatbot's website sections in Qdrant after the crawl.
async function updateCrawlUrls(id, entries, sectionCount) {
    if (!isValidChatbotId(id) || !Array.isArray(entries) || !entries.length) return;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await client.query("DELETE FROM crawl_urls WHERE chatbot_id = $1 AND url = ANY($2::text[])", [id, entries.map(entry => String(entry.url).slice(0, 2000))]);
        await client.query(
            `INSERT INTO crawl_urls (chatbot_id, url, status, reason, source, http_status, sections, final_url, discovered_at, processed_at, title, duration_ms, attempts)
             SELECT $1, * FROM UNNEST($2::text[], $3::text[], $4::text[], $5::text[], $6::int[], $7::int[], $8::text[], $9::timestamptz[], $10::timestamptz[], $11::text[], $12::int[], $13::int[])`,
            [id,
                entries.map(entry => String(entry.url).slice(0, 2000)),
                entries.map(entry => entry.status),
                entries.map(entry => entry.reason ? String(entry.reason).slice(0, 300) : null),
                entries.map(entry => entry.source || null),
                entries.map(entry => (Number.isInteger(entry.httpStatus) && entry.httpStatus > 0 ? entry.httpStatus : null)),
                entries.map(entry => (Number.isInteger(entry.sections) ? entry.sections : null)),
                entries.map(entry => entry.finalUrl ? String(entry.finalUrl).slice(0, 2000) : null),
                entries.map(entry => entry.discoveredAt || null),
                entries.map(entry => entry.processedAt || null),
                entries.map(entry => entry.title ? String(entry.title).slice(0, 300) : null),
                entries.map(entry => (Number.isFinite(entry.durationMs) && entry.durationMs >= 0 ? Math.round(entry.durationMs) : null)),
                entries.map(entry => (Number.isInteger(entry.attempts) && entry.attempts > 0 ? entry.attempts : null))]
        );
        await client.query(
            `UPDATE chatbots SET
                pages_indexed = (SELECT count(*)::int FROM crawl_urls WHERE chatbot_id = $1 AND status = 'indexed'),
                pages_failed = (SELECT count(*)::int FROM crawl_urls WHERE chatbot_id = $1 AND status = 'failed'),
                chunks_indexed = $2,
                updated_at = NOW()
             WHERE id = $1`,
            [id, Number.isInteger(sectionCount) ? sectionCount : null]
        );
        await client.query("COMMIT");
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

async function listCrawlUrls(id, { status, search, limit = 50, offset = 0 } = {}) {
    if (!isValidChatbotId(id)) return null;
    const conditions = ["chatbot_id = $1"];
    const values = [id];
    if (status && CRAWL_URL_STATUSES.includes(status)) {
        values.push(status);
        conditions.push(`status = $${values.length}`);
    }
    if (search && String(search).trim()) {
        values.push(`%${String(search).trim().toLowerCase().replace(/[\\%_]/g, character => "\\" + character)}%`);
        conditions.push(`(lower(url) LIKE $${values.length} OR lower(coalesce(reason, '')) LIKE $${values.length})`);
    }
    const where = conditions.join(" AND ");
    const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = Math.max(Number(offset) || 0, 0);
    const [rows, total, counts] = await Promise.all([
        pool.query(
            `SELECT url, status, reason, source, http_status, sections, final_url, discovered_at, processed_at, title, duration_ms, attempts
             FROM crawl_urls WHERE ${where}
             ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'not-processed' THEN 1 WHEN 'skipped' THEN 2 ELSE 3 END, url
             LIMIT ${pageSize} OFFSET ${skip}`,
            values
        ),
        pool.query(`SELECT count(*)::int AS n FROM crawl_urls WHERE ${where}`, values),
        pool.query("SELECT status, count(*)::int AS n FROM crawl_urls WHERE chatbot_id = $1 GROUP BY status", [id])
    ]);
    return {
        total: total.rows[0].n,
        counts: Object.fromEntries(counts.rows.map(row => [row.status, row.n])),
        urls: rows.rows
    };
}

// Current number of report rows per status (they change after single-page crawls; the totals
// of the last full crawl stay in the chatbot's summary columns and crawl_report).
async function countCrawlUrls(id) {
    if (!isValidChatbotId(id)) return {};
    const result = await pool.query("SELECT status, count(*)::int AS n FROM crawl_urls WHERE chatbot_id = $1 GROUP BY status", [id]);
    return Object.fromEntries(result.rows.map(row => [row.status, row.n]));
}

// Every report row of a chatbot (at most one crawl report: MAX_REPORTED_CRAWL_URLS), for
// reconciliation with the stored content and for continuing pending addresses.
async function listAllCrawlUrls(id) {
    if (!isValidChatbotId(id)) return [];
    const result = await pool.query(
        `SELECT url, status, reason, source, http_status, sections, final_url, discovered_at, processed_at, title, duration_ms, attempts
         FROM crawl_urls WHERE chatbot_id = $1
         ORDER BY CASE status WHEN 'failed' THEN 0 WHEN 'not-processed' THEN 1 WHEN 'skipped' THEN 2 ELSE 3 END, url
         LIMIT 10000`,
        [id]
    );
    return result.rows;
}

// The report rows for one address (any www./slash variant), for diagnostics.
async function findCrawlUrls(id, urls) {
    if (!isValidChatbotId(id) || !urls.length) return [];
    const result = await pool.query(
        "SELECT url, status, reason, http_status, sections, final_url FROM crawl_urls WHERE chatbot_id = $1 AND url = ANY($2::text[])",
        [id, urls]
    );
    return result.rows;
}

// ---- Uploaded documents ----
const DOCUMENT_COLUMNS = "id, chatbot_id, filename, file_type, size_bytes, sha256, storage_name, status, error, pages, sections, uploaded_at, indexed_at, visitor_access";

async function createDocument(document) {
    const result = await pool.query(
        `INSERT INTO documents (id, chatbot_id, filename, file_type, size_bytes, sha256, storage_name, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'processing') RETURNING ${DOCUMENT_COLUMNS}`,
        [document.id, document.chatbotId, document.filename, document.fileType, document.sizeBytes, document.sha256, document.storageName]
    );
    return result.rows[0];
}

async function updateDocument(id, fields) {
    const allowed = { status: "status", error: "error", pages: "pages", sections: "sections", indexedAt: "indexed_at", visitorAccess: "visitor_access" };
    const entries = Object.entries(fields).filter(([key]) => key in allowed);
    if (!entries.length) return getDocument(id);
    const assignments = entries.map(([key], index) => `${allowed[key]} = $${index + 2}`).join(", ");
    const result = await pool.query(
        `UPDATE documents SET ${assignments} WHERE id = $1 RETURNING ${DOCUMENT_COLUMNS}`,
        [id, ...entries.map(([, value]) => value)]
    );
    return result.rows[0] || null;
}

async function getDocument(id) {
    if (!isValidChatbotId(id)) return null;
    const result = await pool.query(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE id = $1`, [id]);
    return result.rows[0] || null;
}

async function listDocuments(chatbotId) {
    if (!isValidChatbotId(chatbotId)) return [];
    const result = await pool.query(`SELECT ${DOCUMENT_COLUMNS} FROM documents WHERE chatbot_id = $1 ORDER BY uploaded_at`, [chatbotId]);
    return result.rows;
}

async function deleteDocumentRow(id) {
    await pool.query("DELETE FROM documents WHERE id = $1", [id]);
}

// Only when no address is set: an address someone chose is never replaced. Returns whether it was saved.
async function setSupportEmailIfEmpty(id, email) {
    if (!isValidChatbotId(id) || email.length > 254 || !SUPPORT_EMAIL_PATTERN.test(email)) return false;
    const result = await pool.query(
        "UPDATE chatbots SET support_email = $2, updated_at = NOW() WHERE id = $1 AND support_email IS NULL",
        [id, email]
    );
    return result.rowCount === 1;
}

async function updateChatbotStatus(id, status) {
    // "deleting": a chatbot deletion started and has not finished (it can be retried).
    const allowedStatuses = ["pending", "indexing", "ready", "failed", "deleting"];

    if (!allowedStatuses.includes(status)) {
        throw new Error("Invalid chatbot status.");
    }

    const result = await pool.query(
        `UPDATE chatbots
         SET status = $2, updated_at = NOW()
         WHERE id = $1
         RETURNING id, website_url, allowed_domain, status`,
        [id, status]
    );

    return result.rows[0] || null;
}

// ---- Removing knowledge (admin) ----
// Each runs in one short transaction; the vectors and files are removed by the caller before.

// One page removed by an administrator: its report rows (any of the given address forms, as
// requested or as the final address after redirects) are marked skipped with that reason, and
// the chatbot's page/section counts are refreshed. Returns the number of report rows changed.
async function markPagesRemoved(id, urls, sectionCount) {
    if (!isValidChatbotId(id) || !Array.isArray(urls) || !urls.length) return 0;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const changed = await client.query(
            `UPDATE crawl_urls SET status = 'skipped', reason = 'removed by an administrator', sections = 0, processed_at = NOW()
             WHERE chatbot_id = $1 AND (url = ANY($2::text[]) OR final_url = ANY($2::text[]))`,
            [id, urls]
        );
        await client.query(
            `UPDATE chatbots SET
                pages_indexed = (SELECT count(*)::int FROM crawl_urls WHERE chatbot_id = $1 AND status = 'indexed'),
                chunks_indexed = $2,
                updated_at = NOW()
             WHERE id = $1`,
            [id, Number.isInteger(sectionCount) ? sectionCount : null]
        );
        await client.query("COMMIT");
        return changed.rowCount;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

// The website's crawl results removed (report rows and crawl summary); the chatbot itself, its
// settings and its documents stay. status: what the chatbot becomes (ready if documents can
// still answer, otherwise pending). Returns the number of report rows removed.
async function clearWebsiteReport(id, status) {
    if (!isValidChatbotId(id) || !["ready", "pending"].includes(status)) throw new Error("Invalid request.");
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const removed = await client.query("DELETE FROM crawl_urls WHERE chatbot_id = $1", [id]);
        await client.query(
            `UPDATE chatbots SET status = $2, last_indexed_at = NULL, pages_indexed = NULL, pages_failed = NULL,
                chunks_indexed = NULL, crawl_complete = NULL, page_limit = NULL, last_error = NULL,
                pages_discovered = NULL, pages_not_processed = NULL, crawl_stop_reason = NULL, crawl_report = NULL,
                pages_read = NULL, pages_skipped = NULL, updated_at = NOW()
             WHERE id = $1`,
            [id, status]
        );
        await client.query("COMMIT");
        return removed.rowCount;
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

// The chatbot row; its documents and crawl report rows go with it (ON DELETE CASCADE).
// Returns { chatbots, documents, crawlUrls } removed.
async function deleteChatbotRow(id) {
    if (!isValidChatbotId(id)) throw new Error("Invalid request.");
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        const counts = (await client.query(
            "SELECT (SELECT count(*)::int FROM documents WHERE chatbot_id = $1) AS documents, (SELECT count(*)::int FROM crawl_urls WHERE chatbot_id = $1) AS crawl_urls",
            [id]
        )).rows[0];
        const removed = await client.query("DELETE FROM chatbots WHERE id = $1", [id]);
        await client.query("COMMIT");
        return { chatbots: removed.rowCount, documents: counts.documents, crawlUrls: counts.crawl_urls };
    } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
    } finally {
        client.release();
    }
}

// ---- Enquiries: questions sent with the contact form after an unanswered question ----
// Every query is limited to one chatbot; nothing here is reachable without the admin key except
// createEnquiry (the public contact form, which writes only to the chatbot it names).
const ENQUIRY_COLUMNS = "id, chatbot_id, request_id, name, email, question, details, recipient, status, email_status, email_error, created_at, emailed_at, handled_at";
const ENQUIRY_STATUSES = ["open", "handled"];
// accepted = the mail transport accepted the email (not proof of delivery); no-recipient = the chatbot had
// no support address (recipient NULL); disabled = no email settings on the server (not attempted).
const ENQUIRY_EMAIL_STATUSES = ["pending", "no-recipient", "disabled", "accepted", "failed"];

// Whether the enquiries table exists (db/schema.sql applied). While it is missing the check is
// repeated at most once a minute, so running `npm run setup:db` takes effect without a restart.
let enquiryTableSeen = false;
let enquiryTableCheckedAt = 0;
async function enquiryStorageReady() {
    if (enquiryTableSeen) return true;
    if (Date.now() - enquiryTableCheckedAt < 60 * 1000) return false;
    enquiryTableCheckedAt = Date.now();
    const result = await pool.query("SELECT to_regclass('public.enquiries') IS NOT NULL AS ready");
    enquiryTableSeen = result.rows[0].ready === true;
    return enquiryTableSeen;
}

// Saves one enquiry. The same form (chatbot + requestId) is saved once: a repeated submission
// returns the stored enquiry with created: false. Returns { enquiry, created }.
async function createEnquiry({ id, chatbotId, requestId, name, email, question, details, recipient }) {
    if (!isValidChatbotId(chatbotId) || !isValidChatbotId(id)) throw new Error("Invalid enquiry.");
    const inserted = await pool.query(
        `INSERT INTO enquiries (id, chatbot_id, request_id, name, email, question, details, recipient)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (chatbot_id, request_id) DO NOTHING
         RETURNING ${ENQUIRY_COLUMNS}`,
        [id, chatbotId, requestId, name, email, question, details || null, recipient || null]
    );
    if (inserted.rows[0]) return { enquiry: inserted.rows[0], created: true };
    const existing = await pool.query(`SELECT ${ENQUIRY_COLUMNS} FROM enquiries WHERE chatbot_id = $1 AND request_id = $2`, [chatbotId, requestId]);
    return { enquiry: existing.rows[0] || null, created: false };
}

// Records the outcome of the email notification (no-recipient / disabled / accepted / failed).
async function updateEnquiryEmail(id, emailStatus, error = null) {
    if (!isValidChatbotId(id) || !ENQUIRY_EMAIL_STATUSES.includes(emailStatus)) throw new Error("Invalid enquiry update.");
    const result = await pool.query(
        `UPDATE enquiries SET email_status = $2, email_error = $3,
            emailed_at = CASE WHEN $2 = 'accepted' THEN NOW() ELSE emailed_at END
         WHERE id = $1 RETURNING ${ENQUIRY_COLUMNS}`,
        [id, emailStatus, error ? String(error).slice(0, 200) : null]
    );
    return result.rows[0] || null;
}

// One page of a chatbot's enquiries (newest first), optionally by status, plus counts per status.
async function listEnquiries(chatbotId, { status, limit = 50, offset = 0 } = {}) {
    if (!isValidChatbotId(chatbotId)) return null;
    const values = [chatbotId];
    let where = "chatbot_id = $1";
    if (ENQUIRY_STATUSES.includes(status)) {
        values.push(status);
        where += " AND status = $2";
    }
    const pageSize = Math.min(Math.max(Number(limit) || 50, 1), 200);
    const skip = Math.max(Number(offset) || 0, 0);
    const [rows, total, counts] = await Promise.all([
        pool.query(`SELECT ${ENQUIRY_COLUMNS} FROM enquiries WHERE ${where} ORDER BY created_at DESC, id LIMIT ${pageSize} OFFSET ${skip}`, values),
        pool.query(`SELECT count(*)::int AS n FROM enquiries WHERE ${where}`, values),
        pool.query("SELECT status, count(*)::int AS n FROM enquiries WHERE chatbot_id = $1 GROUP BY status", [chatbotId])
    ]);
    return { total: total.rows[0].n, counts: Object.fromEntries(counts.rows.map(row => [row.status, row.n])), enquiries: rows.rows };
}

// One enquiry, only if it belongs to this chatbot.
async function getEnquiry(chatbotId, id) {
    if (!isValidChatbotId(chatbotId) || !isValidChatbotId(id)) return null;
    const result = await pool.query(`SELECT ${ENQUIRY_COLUMNS} FROM enquiries WHERE id = $1 AND chatbot_id = $2`, [id, chatbotId]);
    return result.rows[0] || null;
}

// open / handled, only for an enquiry of this chatbot.
async function setEnquiryStatus(chatbotId, id, status) {
    if (!isValidChatbotId(chatbotId) || !isValidChatbotId(id) || !ENQUIRY_STATUSES.includes(status)) return null;
    const result = await pool.query(
        `UPDATE enquiries SET status = $3, handled_at = CASE WHEN $3 = 'handled' THEN NOW() ELSE NULL END
         WHERE id = $1 AND chatbot_id = $2 RETURNING ${ENQUIRY_COLUMNS}`,
        [id, chatbotId, status]
    );
    return result.rows[0] || null;
}

// The address an enquiry's email goes to, only for an enquiry of this chatbot (Resend uses the
// chatbot's current support email, so a corrected address takes effect).
async function setEnquiryRecipient(chatbotId, id, recipient) {
    if (!isValidChatbotId(chatbotId) || !isValidChatbotId(id) || !recipient) return null;
    const result = await pool.query(
        `UPDATE enquiries SET recipient = $3 WHERE id = $1 AND chatbot_id = $2 RETURNING ${ENQUIRY_COLUMNS}`,
        [id, chatbotId, String(recipient)]
    );
    return result.rows[0] || null;
}

// Whether the crawler clicks this chatbot's menu buttons. false while the column does not exist yet
// (db/schema.sql not applied), so the server works before `npm run setup:db`.
async function getButtonDiscovery(id) {
    if (!isValidChatbotId(id)) return false;
    try {
        const result = await pool.query("SELECT button_discovery FROM chatbots WHERE id = $1", [id]);
        return result.rows[0]?.button_discovery === true;
    } catch (error) {
        if (error.code === "42703") return false;
        throw error;
    }
}

// Turns menu-button clicking on or off. Returns the chatbot row, or null if there is none.
async function setButtonDiscovery(id, enabled) {
    if (!isValidChatbotId(id)) return null;
    try {
        const result = await pool.query(
            `UPDATE chatbots SET button_discovery = $2, updated_at = NOW() WHERE id = $1 RETURNING ${CHATBOT_COLUMNS}`,
            [id, enabled === true]
        );
        return result.rows[0] || null;
    } catch (error) {
        if (error.code === "42703") throw validationError("This setting needs the latest database schema: run npm run setup:db, then restart the server.");
        throw error;
    }
}

// Addresses from the latest crawl (indexed, failed with reason, not processed). Admin only.
async function getCrawlReport(id) {
    if (!isValidChatbotId(id)) return null;
    const result = await pool.query("SELECT crawl_report FROM chatbots WHERE id = $1", [id]);
    return result.rows[0]?.crawl_report || null;
}

module.exports = {
    assertPublicWebsiteUrl,
    getButtonDiscovery,
    setButtonDiscovery,
    getCrawlReport,
    listCrawlUrls,
    listAllCrawlUrls,
    countCrawlUrls,
    setSupportEmailIfEmpty,
    updateCrawlUrls,
    findCrawlUrls,
    createDocument,
    updateDocument,
    getDocument,
    listDocuments,
    deleteDocumentRow,
    isValidChatbotId,
    SUPPORT_EMAIL_PATTERN,
    normalizeWebsiteUrl,
    registerChatbot,
    getChatbotById,
    listChatbots,
    updateChatbotSettings,
    recordIndexingResult,
    updateChatbotStatus,
    markPagesRemoved,
    clearWebsiteReport,
    deleteChatbotRow,
    enquiryStorageReady,
    createEnquiry,
    updateEnquiryEmail,
    listEnquiries,
    getEnquiry,
    setEnquiryStatus,
    setEnquiryRecipient,
    setChatbotOwner,
    hashPassword,
    verifyPassword,
    createAccount,
    getAccountForLogin,
    getAccountById,
    listAccounts,
    setAccountStatus,
    setAccountPassword,
    recordLogin,
    createSession,
    findSession,
    touchSession,
    deleteSession,
    deleteExpiredSessions
};

