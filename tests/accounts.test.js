// Customer accounts (Phase 1): two customers A and B, each owning one chatbot (A1, B1), plus one unassigned
// chatbot (U). Proves on the SERVER: every admin route with another customer's chatbot answers 404 exactly
// like an unknown ID and changes nothing; logged out -> 401 everywhere; the admin key still works everywhere
// and sees everything; passwords are stored only as scrypt hashes; sessions end after 2 h idle / 12 h and
// at logout; login is rate-limited per email and per address with one error for wrong email or password; a
// cookie request from another website is refused; two customers registering one website get two separate
// chatbots; crawl-live of another customer's chatbot -> 404; platform-only routes are 404 for customers.
// Dashboard in a real browser at 375 px: the admin-key flow as before; the platform section creates accounts,
// assigns owners, disables and resets; a customer logs in and sees only their own chatbots, with platform
// controls hidden and nothing in browser storage; expired session and logout return to the login form.
// ISOLATED: runs only through tests/run-isolated.js (test database and collection, temporary upload folder,
// fake email). The real server.js runs IN THIS PROCESS on a free port (never 3000-3005 or 5050). No crawling:
// test chatbots point at http://127.0.0.1:1 (refused as private before any request) and registered test
// websites (*.accounts-test.example) are never crawled. Run: npm run test:accounts
"use strict";
const fs = require("fs"), path = require("path"), net = require("net"), crypto = require("crypto"), Module = require("module");
const { assertIsolated } = require("./support/isolated-env");

const projectDir = path.join(__dirname, "..");
const RESERVED_PORTS = new Set([3000, 3001, 3002, 3003, 3004, 3005, 5050]);
const NOT_FOUND_BODY = JSON.stringify({ success: false, error: "Registered chatbot not found" });

const results = [];
function check(name, ok, note = "") {
    results.push({ test: name, result: ok ? "PASS" : "FAIL" });
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${note && !ok ? `\n     ${String(note).replace(/\s+/g, " ").slice(0, 400)}` : ""}\n`);
}

async function freePort() {
    for (;;) {
        const port = await new Promise((resolve, reject) => {
            const probe = net.createServer();
            probe.once("error", reject);
            probe.listen(0, "127.0.0.1", () => { const p = probe.address().port; probe.close(() => resolve(p)); });
        });
        if (!RESERVED_PORTS.has(port)) return port;
    }
}

// Loads a project file with a test-only patch (cached, so server.js uses the patched module).
function loadPatched(file, patch) {
    const filename = path.join(projectDir, file);
    const source = fs.readFileSync(filename, "utf8");
    const patched = patch(source);
    if (patched === source) throw new Error(`test patch did not apply to ${file}`);
    const m = new Module(filename);
    m.filename = filename;
    m.paths = Module._nodeModulePaths(projectDir);
    require.cache[filename] = m;
    m._compile(patched, filename);
    m.loaded = true;
    return m.exports;
}

(async () => {
    const KEY = crypto.randomBytes(32).toString("hex");
    process.env.ADMIN_API_KEY = KEY;
    process.env.ADMIN_API_KEYS = "";
    process.env.TRUST_PROXY = "1"; // each login scenario uses its own X-Forwarded-For (own rate-limit budget)
    delete process.env.COOKIE_SECURE;
    const port = await freePort();
    process.env.PORT = String(port);

    const pool = require(path.join(projectDir, "dbPool"));
    const isolation = await assertIsolated(pool); // throws (nothing written) unless isolated
    console.log(`isolated environment: database ${isolation.database}, collection ${isolation.collection}`);
    // Registration checks DNS; the reserved test domain *.accounts-test.example is accepted without a lookup.
    loadPatched("chatbotRegistry.js", src => src.replace("async function assertPublicWebsiteUrl(parsedUrl) {",
        match => `${match}\r\n    if (/\\.accounts-test\\.example$/.test(parsedUrl.hostname)) return;`));
    const log = console.log, warn = console.warn, error = console.error;
    const logged = [];
    const capture = (...args) => logged.push(args.map(String).join(" "));
    console.log = capture; console.warn = capture; console.error = capture;
    require(path.join(projectDir, "server.js"));
    const BASE = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(BASE + "/api/health")).ok) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    // The server's console stays captured until the end (checked for secrets); results go to stdout directly.

    let ip = 0;
    // auth: { key } admin key | { cookie } session | {} nothing. visitor: X-Forwarded-For.
    const call = async (method, route, body, { key, cookie, origin, visitor } = {}) => {
        const headers = { "X-Forwarded-For": visitor || `198.51.100.${(++ip % 250) + 1}` };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (key) headers["x-admin-api-key"] = key;
        if (cookie) headers.Cookie = cookie;
        if (origin) headers.Origin = origin;
        const r = await fetch(BASE + route, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { status: r.status, json, text, setCookie: r.headers.get("set-cookie") || "" };
    };
    const login = async (email, password, options = {}) => {
        const r = await call("POST", "/api/auth/login", { email, password }, options);
        const match = r.setCookie.match(/cb_session=([A-Za-z0-9_-]{43})/);
        return { ...r, token: match ? match[1] : null, cookie: match ? `cb_session=${match[1]}` : null };
    };
    const tokenHash = token => crypto.createHash("sha256").update(token).digest();
    const sessionRow = async token => (await pool.query("SELECT last_seen_at, expires_at FROM sessions WHERE token_hash = $1", [tokenHash(token)])).rows[0] || null;

    const A1 = crypto.randomUUID(), B1 = crypto.randomUUID(), U = crypto.randomUUID();
    const DOC_A = crypto.randomUUID(), DOC_B = crypto.randomUUID(), ENQ_A = crypto.randomUUID(), ENQ_B = crypto.randomUUID();
    const chatbotIds = [A1, B1, U];
    const accountIds = [];
    const EMAIL_A = "owner-a@accounts-test.example", EMAIL_B = "Owner-B@Accounts-Test.example";
    const PASSWORD_A = `pw-A-${crypto.randomBytes(12).toString("base64url")}`, PASSWORD_B = `pw-B-${crypto.randomBytes(12).toString("base64url")}`;
    const tokens = [];
    const uiSecrets = [];
    let browser = null;

    try {
        // ================= Setup: two accounts (platform route), three chatbots, a document and an enquiry each =================
        let r = await call("POST", "/api/admin/accounts", { email: EMAIL_A, password: PASSWORD_A }, { key: KEY });
        const A = r.json?.account?.id;
        check("platform: account A created (201), no password or hash in the response", r.status === 201 && Boolean(A) && !r.text.includes(PASSWORD_A) && !/scrypt/.test(r.text), r.text);
        r = await call("POST", "/api/admin/accounts", { email: EMAIL_B, password: PASSWORD_B }, { key: KEY });
        const B = r.json?.account?.id;
        check("platform: account B created; email stored lower-case", r.status === 201 && r.json.account.email === EMAIL_B.toLowerCase(), r.text);
        accountIds.push(A, B);
        r = await call("POST", "/api/admin/accounts", { email: EMAIL_A.toUpperCase(), password: "another-password-1" }, { key: KEY });
        check("platform: duplicate email (any case) refused with 409", r.status === 409, r.text);
        r = await call("POST", "/api/admin/accounts", { email: "short@accounts-test.example", password: "too-short" }, { key: KEY });
        check("platform: password under 12 characters refused (400, field password)", r.status === 400 && r.json?.field === "password", r.text);

        await pool.query(
            `INSERT INTO chatbots (id, website_url, allowed_domain, status, owner_account_id) VALUES
             ($1, 'http://127.0.0.1:1/a', '127.0.0.1', 'ready', $4), ($2, 'http://127.0.0.1:1/b', '127.0.0.1', 'ready', $5), ($3, 'http://127.0.0.1:1/u', '127.0.0.1', 'ready', NULL)`,
            [A1, B1, U, A, B]);
        await pool.query(
            `INSERT INTO documents (id, chatbot_id, filename, file_type, size_bytes, sha256, storage_name, status) VALUES
             ($1, $2, 'a.pdf', 'pdf', 10, 'x', 'missing-a.pdf', 'processing'), ($3, $4, 'b.pdf', 'pdf', 10, 'x', 'missing-b.pdf', 'processing')`,
            [DOC_A, A1, DOC_B, B1]);
        await pool.query(
            `INSERT INTO enquiries (id, chatbot_id, request_id, name, email, question) VALUES
             ($1, $2, 'req-a-0001', 'Visitor A', 'va@example.org', 'Question A'), ($3, $4, 'req-b-0001', 'Visitor B', 'vb@example.org', 'Question B')`,
            [ENQ_A, A1, ENQ_B, B1]);

        // ================= Passwords stored only as scrypt hashes =================
        const stored = (await pool.query("SELECT * FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY email", [[A, B]])).rows;
        const scryptPattern = /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/]+=*\$[A-Za-z0-9+/]+=*$/;
        check("passwords: stored only as scrypt strings (scrypt$16384$8$1$salt$hash)", stored.length === 2 && stored.every(row => scryptPattern.test(row.password_hash)), stored.map(row => row.password_hash.slice(0, 20)).join(" | "));
        check("passwords: no column of either account contains a password", !JSON.stringify(stored).includes(PASSWORD_A) && !JSON.stringify(stored).includes(PASSWORD_B));

        // ================= Login, cookie, same error for wrong email or password =================
        const la = await login(EMAIL_A, PASSWORD_A);
        const lb = await login(EMAIL_B.toUpperCase(), PASSWORD_B); // email case does not matter
        tokens.push(la.token, lb.token);
        const COOKIE_A = la.cookie, COOKIE_B = lb.cookie;
        check("login: A and B log in (200) and get a session cookie", la.status === 200 && lb.status === 200 && Boolean(COOKIE_A) && Boolean(COOKIE_B), `${la.status} ${lb.status}`);
        check("cookie: HttpOnly, SameSite=Strict, Path=/, Max-Age=43200 (12 h), no Secure on plain http",
            /HttpOnly/.test(la.setCookie) && /SameSite=Strict/.test(la.setCookie) && /Path=\//.test(la.setCookie) && /Max-Age=43200/.test(la.setCookie) && !/Secure/.test(la.setCookie), la.setCookie.replace(/cb_session=[^;]+/, "cb_session=<token>"));
        check("session: only the token's SHA-256 is stored (the token itself is not)",
            Boolean(await sessionRow(la.token)) && (await pool.query("SELECT count(*)::int AS n FROM sessions WHERE token_hash = $1", [Buffer.from(la.token)])).rows[0].n === 0);
        r = await call("GET", "/api/auth/me", undefined, { cookie: COOKIE_A });
        check("me: A's session identifies customer A", r.status === 200 && r.json.kind === "customer" && r.json.email === EMAIL_A, r.text);
        r = await call("GET", "/api/auth/me", undefined, { key: KEY });
        check("me: the admin key is the platform admin", r.status === 200 && r.json.kind === "platform", r.text);
        const wrongPassword = await call("POST", "/api/auth/login", { email: EMAIL_A, password: "wrong-password-123" });
        const unknownEmail = await call("POST", "/api/auth/login", { email: "nobody@accounts-test.example", password: "wrong-password-123" });
        check("login: wrong password and unknown email get the same 401 and the same body, no cookie",
            wrongPassword.status === 401 && unknownEmail.status === 401 && JSON.stringify(wrongPassword.json) === JSON.stringify(unknownEmail.json) && !wrongPassword.setCookie && !unknownEmail.setCookie, `${wrongPassword.text} | ${unknownEmail.text}`);

        // ================= Every admin route with B's chatbot, as customer A -> 404 like an unknown ID =================
        const routesFor = (bot, doc, enquiry) => [
            ["GET", `/api/admin/chatbots/${bot}`],
            ["PATCH", `/api/admin/chatbots/${bot}`, { displayName: "Hijacked", supportEmail: "attacker@accounts-test.example" }],
            ["GET", `/api/admin/chatbots/${bot}/crawl-urls`],
            ["GET", `/api/admin/chatbots/${bot}/crawl-live`],
            ["POST", `/api/admin/chatbots/${bot}/crawl-urls/index`, { urls: ["http://127.0.0.1:1/b/page"] }],
            ["POST", `/api/admin/chatbots/${bot}/crawl-urls/continue`, {}],
            ["GET", `/api/admin/chatbots/${bot}/documents`],
            ["POST", `/api/admin/chatbots/${bot}/documents`, {}],
            ["GET", `/api/admin/chatbots/${bot}/documents/${doc}/file`],
            ["PATCH", `/api/admin/chatbots/${bot}/documents/${doc}`, { visitorAccess: true }],
            ["POST", `/api/admin/chatbots/${bot}/documents/${doc}/reindex`],
            ["DELETE", `/api/admin/chatbots/${bot}/documents/${doc}`],
            ["GET", `/api/admin/chatbots/${bot}/deletion-preview`],
            ["DELETE", `/api/admin/chatbots/${bot}/pages`, { url: "http://127.0.0.1:1/b", confirm: bot }],
            ["DELETE", `/api/admin/chatbots/${bot}/website-content`, { confirm: bot }],
            ["DELETE", `/api/admin/chatbots/${bot}`, { confirm: bot }],
            ["GET", `/api/admin/chatbots/${bot}/enquiries`],
            ["PATCH", `/api/admin/chatbots/${bot}/enquiries/${enquiry}`, { status: "handled" }],
            ["POST", `/api/admin/chatbots/${bot}/enquiries/${enquiry}/resend`],
            ["POST", `/api/admin/chatbots/${bot}/diagnose`, { question: "What are the prices?" }],
            ["PUT", `/api/admin/chatbots/${bot}/owner`, { accountId: null }],
            ["PUT", `/api/admin/chatbots/${bot}/button-discovery`, { enabled: true }],
            ["POST", "/api/website", { chatbotId: bot }]
        ];
        const snapshotB = async () => JSON.stringify({
            bot: (await pool.query("SELECT display_name, support_email, owner_account_id, status FROM chatbots WHERE id = $1", [B1])).rows,
            docs: (await pool.query("SELECT id, status, visitor_access FROM documents WHERE chatbot_id = $1 ORDER BY id", [B1])).rows,
            enquiries: (await pool.query("SELECT id, status, email_status, recipient FROM enquiries WHERE chatbot_id = $1 ORDER BY id", [B1])).rows
        });
        const beforeB = await snapshotB();
        const unknown = crypto.randomUUID();
        const unknownRoutes = routesFor(unknown, DOC_B, ENQ_B);
        const crossRoutes = routesFor(B1, DOC_B, ENQ_B);
        let crossOk = 0;
        for (let i = 0; i < crossRoutes.length; i++) {
            const [method, route, body] = crossRoutes[i];
            const cross = await call(method, route, body, { cookie: COOKIE_A });
            const asUnknown = await call(method, unknownRoutes[i][1], unknownRoutes[i][2], { cookie: COOKIE_A });
            const same = cross.status === 404 && cross.text === NOT_FOUND_BODY && asUnknown.status === 404 && asUnknown.text === cross.text;
            if (same) crossOk++;
            check(`cross-access as A: ${method} ${route.replace(B1, "<B1>").replace(DOC_B, "<docB>").replace(ENQ_B, "<enqB>")} -> 404, same as an unknown ID`, same, `${cross.status} ${cross.text} | unknown ${asUnknown.status} ${asUnknown.text}`);
        }
        check(`cross-access: all ${crossRoutes.length} routes refused`, crossOk === crossRoutes.length, `${crossOk}/${crossRoutes.length}`);
        check("cross-access: nothing of B1 changed (settings, support email, owner, documents, enquiries); no email sent",
            (await snapshotB()) === beforeB && require(path.join(projectDir, "supportMail"))._testOutbox.length === 0);
        r = await call("GET", `/api/admin/chatbots/${A1}/documents/${DOC_B}/file`, undefined, { cookie: COOKIE_A });
        const docMix = await call("PATCH", `/api/admin/chatbots/${A1}/documents/${DOC_B}`, { visitorAccess: true }, { cookie: COOKIE_A });
        const enquiryMix = await call("PATCH", `/api/admin/chatbots/${A1}/enquiries/${ENQ_B}`, { status: "handled" }, { cookie: COOKIE_A });
        check("own chatbot + B's document / enquiry ID -> 404, nothing changed", r.status === 404 && docMix.status === 404 && enquiryMix.status === 404 && (await snapshotB()) === beforeB, `${r.status} ${docMix.status} ${enquiryMix.status}`);
        r = await call("GET", `/api/admin/chatbots/${U}`, undefined, { cookie: COOKIE_A });
        const uB = await call("GET", `/api/admin/chatbots/${U}`, undefined, { cookie: COOKIE_B });
        check("unassigned chatbot U: 404 for both customers", r.status === 404 && uB.status === 404, `${r.status} ${uB.status}`);

        // ================= crawl-live (problem 2) and the customer's own chatbot =================
        r = await call("GET", `/api/admin/chatbots/${B1}/crawl-live`, undefined, { cookie: COOKIE_A });
        const ownLive = await call("GET", `/api/admin/chatbots/${A1}/crawl-live`, undefined, { cookie: COOKIE_A });
        check("crawl-live: another customer's chatbot -> 404; own chatbot -> 200", r.status === 404 && ownLive.status === 200 && ownLive.json?.success === true, `${r.status} ${ownLive.status}`);
        r = await call("GET", "/api/admin/chatbots", undefined, { cookie: COOKIE_A });
        const listA = (r.json?.chatbots || []).map(bot => bot.id);
        check("list as A: only A1 (not B1, not U)", r.status === 200 && listA.length === 1 && listA[0] === A1, JSON.stringify(listA));
        r = await call("GET", `/api/admin/chatbots/${A1}`, undefined, { cookie: COOKIE_A });
        check("own chatbot: detail 200 with its owner", r.status === 200 && r.json.chatbot.ownerAccountId === A, r.text.slice(0, 200));
        r = await call("PATCH", `/api/admin/chatbots/${A1}`, { displayName: "Shop A", supportEmail: "help@accounts-test.example" }, { cookie: COOKIE_A });
        check("own chatbot: settings and support email can be changed", r.status === 200 && r.json.chatbot.settings.displayName === "Shop A" && r.json.chatbot.settings.supportEmail === "help@accounts-test.example", r.text.slice(0, 200));
        r = await call("GET", `/api/admin/chatbots/${A1}/enquiries`, undefined, { cookie: COOKIE_A });
        check("own chatbot: enquiries listed (only its own)", r.status === 200 && r.json.total === 1 && r.json.enquiries[0].id === ENQ_A, r.text.slice(0, 200));
        r = await call("POST", `/api/admin/chatbots/${A1}/diagnose`, {}, { cookie: COOKIE_A });
        check("own chatbot: diagnose reachable for its owner (input checked, 400 for an empty question)", r.status === 400, r.text);

        // ================= Cross-site Origin =================
        r = await call("PATCH", `/api/admin/chatbots/${A1}`, { displayName: "Changed from elsewhere" }, { cookie: COOKIE_A, origin: "https://evil.example" });
        const afterForeign = (await pool.query("SELECT display_name FROM chatbots WHERE id = $1", [A1])).rows[0].display_name;
        check("cross-site Origin: cookie PATCH from another website -> 403, nothing changed", r.status === 403 && afterForeign === "Shop A", `${r.status} ${afterForeign}`);
        r = await call("PATCH", `/api/admin/chatbots/${A1}`, { welcomeMessage: "Hello" }, { cookie: COOKIE_A, origin: BASE });
        check("same-site Origin: cookie PATCH from this server's own page -> 200", r.status === 200, r.text.slice(0, 200));
        r = await call("POST", "/api/auth/login", { email: EMAIL_A, password: PASSWORD_A }, { origin: "https://evil.example" });
        check("cross-site Origin: login from another website -> 403, no cookie", r.status === 403 && !r.setCookie, r.text);

        // ================= Platform-only routes =================
        r = await call("POST", "/api/admin/accounts", { email: "x@accounts-test.example", password: "long-enough-pass" }, { cookie: COOKIE_A });
        const listAccountsAsA = await call("GET", "/api/admin/accounts", undefined, { cookie: COOKIE_A });
        const ownOwner = await call("PUT", `/api/admin/chatbots/${A1}/owner`, { accountId: B }, { cookie: COOKIE_A });
        check("platform-only: create/list accounts and change an owner -> 404 for a customer (even on its own chatbot)",
            r.status === 404 && listAccountsAsA.status === 404 && ownOwner.status === 404 && (await pool.query("SELECT owner_account_id FROM chatbots WHERE id = $1", [A1])).rows[0].owner_account_id === A,
            `${r.status} ${listAccountsAsA.status} ${ownOwner.status}`);
        const clicksOf = async id => (await pool.query("SELECT button_discovery FROM chatbots WHERE id = $1", [id])).rows[0].button_discovery;
        r = await call("PUT", `/api/admin/chatbots/${A1}/button-discovery`, { enabled: true }, { cookie: COOKIE_A });
        check("platform-only: menu-button clicking -> 404 for a customer, even on its own chatbot (stays off)", r.status === 404 && (await clicksOf(A1)) === false, `${r.status} ${r.text}`);
        r = await call("PUT", `/api/admin/chatbots/${A1}/button-discovery`, { enabled: "yes" }, { key: KEY });
        check("platform: menu-button clicking accepts only true/false (400)", r.status === 400 && (await clicksOf(A1)) === false, r.text);
        r = await call("PUT", `/api/admin/chatbots/${A1}/button-discovery`, { enabled: true }, { key: KEY });
        const clicksOn = r.status === 200 && r.json.chatbot.settings.buttonDiscovery === true && (await clicksOf(A1)) === true;
        r = await call("PUT", `/api/admin/chatbots/${A1}/button-discovery`, { enabled: false }, { key: KEY });
        check("platform: menu-button clicking off by default, turned on and off again", clicksOn && r.status === 200 && r.json.chatbot.settings.buttonDiscovery === false && (await clicksOf(A1)) === false, r.text.slice(0, 200));
        r = await call("GET", "/api/admin/accounts", undefined, { key: KEY });
        check("platform: lists the accounts without password hashes", r.status === 200 && r.json.accounts.length === 2 && !/scrypt|password/i.test(r.text), r.text.slice(0, 200));

        // ================= Same website registered by two customers =================
        const SITE = "https://shop.accounts-test.example/";
        const regA = await call("POST", "/api/register", { websiteUrl: SITE }, { cookie: COOKIE_A });
        const regB = await call("POST", "/api/register", { websiteUrl: SITE }, { cookie: COOKIE_B });
        const regA2 = await call("POST", "/api/register", { websiteUrl: SITE }, { cookie: COOKIE_A });
        const regPlatform = await call("POST", "/api/register", { websiteUrl: SITE }, { key: KEY });
        for (const reg of [regA, regB, regPlatform]) if (reg.json?.chatbotId) chatbotIds.push(reg.json.chatbotId);
        const owners = Object.fromEntries((await pool.query("SELECT id, owner_account_id FROM chatbots WHERE id = ANY($1::uuid[])",
            [[regA.json?.chatbotId, regB.json?.chatbotId, regPlatform.json?.chatbotId].filter(Boolean)])).rows.map(row => [row.id, row.owner_account_id]));
        check("same website, two customers: two separate chatbots (201 each), each owned by its customer",
            regA.status === 201 && regB.status === 201 && regA.json.chatbotId !== regB.json.chatbotId && owners[regA.json.chatbotId] === A && owners[regB.json.chatbotId] === B, `${regA.text} | ${regB.text}`);
        check("same website again by A: A's existing chatbot is returned (de-duplicated per owner)", regA2.status === 200 && regA2.json.existing === true && regA2.json.chatbotId === regA.json?.chatbotId, regA2.text);
        check("same website by the platform admin: a third, unassigned chatbot", regPlatform.status === 201 && ![regA.json?.chatbotId, regB.json?.chatbotId].includes(regPlatform.json.chatbotId) && owners[regPlatform.json.chatbotId] === null, regPlatform.text);
        r = await call("GET", `/api/admin/chatbots/${regB.json?.chatbotId}`, undefined, { cookie: COOKIE_A });
        check("same website: A cannot open B's chatbot for it (404)", r.status === 404, r.text);

        // ================= Platform assigns U to A =================
        r = await call("PUT", `/api/admin/chatbots/${U}/owner`, { accountId: A }, { key: KEY });
        const uAsA = await call("GET", `/api/admin/chatbots/${U}`, undefined, { cookie: COOKIE_A });
        const uAsB = await call("GET", `/api/admin/chatbots/${U}`, undefined, { cookie: COOKIE_B });
        check("platform: assigning U to A -> A can open it, B still gets 404", r.status === 200 && r.json.chatbot.ownerAccountId === A && uAsA.status === 200 && uAsB.status === 404, `${r.status} ${uAsA.status} ${uAsB.status}`);
        r = await call("PUT", `/api/admin/chatbots/${U}/owner`, { accountId: crypto.randomUUID() }, { key: KEY });
        check("platform: assigning to an unknown account -> 404", r.status === 404, r.text);

        // ================= Logged out -> 401 on every admin route =================
        const everyAdminRoute = [...routesFor(B1, DOC_B, ENQ_B), ["GET", "/api/admin/chatbots"], ["POST", "/api/register", { websiteUrl: SITE }],
            ["GET", "/api/admin/accounts"], ["POST", "/api/admin/accounts", { email: "z@accounts-test.example", password: "long-enough-pass" }], ["GET", "/api/auth/me"]];
        let unauthenticatedOk = 0;
        for (const [method, route, body] of everyAdminRoute) {
            const none = await call(method, route, body);
            const garbage = await call(method, route, body, { cookie: "cb_session=not-a-valid-token" });
            const unknownToken = await call(method, route, body, { cookie: `cb_session=${crypto.randomBytes(32).toString("base64url")}` });
            if (none.status === 401 && garbage.status === 401 && unknownToken.status === 401) unauthenticatedOk++;
            else check(`logged out: ${method} ${route} -> 401`, false, `${none.status} ${garbage.status} ${unknownToken.status}`);
        }
        check(`logged out (no cookie, malformed cookie, unknown token): all ${everyAdminRoute.length} admin routes -> 401`, unauthenticatedOk === everyAdminRoute.length, `${unauthenticatedOk}/${everyAdminRoute.length}`);
        r = await call("GET", "/api/admin/chatbots", undefined, { key: "wrong-" + "0".repeat(60) });
        check("a wrong admin key is still 403 (unchanged)", r.status === 403, r.text);

        // ================= The admin key still works everywhere (B1, no customer restriction) =================
        const adminRoutes = routesFor(B1, DOC_B, ENQ_B).map(([method, route, body]) => {
            // Bodies that pass authentication but stop before changing or crawling anything.
            if (/\/owner$/.test(route)) return [method, route, { accountId: "not-an-id" }];
            if (/\/button-discovery$/.test(route)) return [method, route, { enabled: "not-a-boolean" }];
            if (method === "DELETE" && !/documents/.test(route)) return [method, route, {}];
            if (method === "PATCH" && /\/chatbots\/[^/]+$/.test(route)) return [method, route, { accentColor: "not-a-colour" }];
            if (/diagnose$/.test(route)) return [method, route, {}];
            return [method, route, body];
        });
        let adminOk = 0;
        for (const [method, route, body] of adminRoutes) {
            const res = await call(method, route, body, { key: KEY });
            // The test document has no stored file: its download reaches the handler and reports exactly that.
            const missingFile = /\/file$/.test(route) && res.status === 500 && res.json?.error === "Unable to open the document.";
            const passed = ![401, 403].includes(res.status) && res.text !== NOT_FOUND_BODY && (res.status < 500 || missingFile);
            if (passed) adminOk++;
            else check(`admin key: ${method} ${route.replace(B1, "<B1>")} passes authentication`, false, `${res.status} ${res.text.slice(0, 160)}`);
        }
        check(`admin key: all ${adminRoutes.length} routes reach their handler for B1 (no 401/403/404-not-found; no 5xx except the missing test file)`, adminOk === adminRoutes.length, `${adminOk}/${adminRoutes.length}`);
        r = await call("GET", "/api/admin/chatbots", undefined, { key: KEY });
        const allIds = (r.json?.chatbots || []).map(bot => bot.id);
        check("admin key: the list shows every customer's chatbots and the unassigned ones", [A1, B1, U, regPlatform.json?.chatbotId].every(id => allIds.includes(id)), JSON.stringify(allIds));
        check("admin key: nothing of B1 was deleted by the authentication checks", (await pool.query("SELECT count(*)::int AS n FROM chatbots WHERE id = $1", [B1])).rows[0].n === 1);

        // ================= Session expiry (idle 2 h, max 12 h) =================
        const idle = await login(EMAIL_B, PASSWORD_B);
        tokens.push(idle.token);
        await pool.query("UPDATE sessions SET last_seen_at = NOW() - interval '119 minutes' WHERE token_hash = $1", [tokenHash(idle.token)]);
        r = await call("GET", "/api/auth/me", undefined, { cookie: idle.cookie });
        const touched = await sessionRow(idle.token);
        check("session idle 1 h 59 min: still valid, and the request refreshes last_seen", r.status === 200 && touched && Date.now() - new Date(touched.last_seen_at).getTime() < 60000, `${r.status}`);
        await pool.query("UPDATE sessions SET last_seen_at = NOW() - interval '121 minutes' WHERE token_hash = $1", [tokenHash(idle.token)]);
        r = await call("GET", "/api/auth/me", undefined, { cookie: idle.cookie });
        check("session idle over 2 h: 401 and the session row is deleted", r.status === 401 && !(await sessionRow(idle.token)), `${r.status}`);
        const maxed = await login(EMAIL_B, PASSWORD_B);
        tokens.push(maxed.token);
        const fresh = await sessionRow(maxed.token);
        check("session maximum: expires 12 h after login", fresh && Math.abs(new Date(fresh.expires_at).getTime() - Date.now() - 12 * 3600 * 1000) < 120000, fresh && fresh.expires_at);
        await pool.query("UPDATE sessions SET expires_at = NOW() - interval '1 second' WHERE token_hash = $1", [tokenHash(maxed.token)]);
        r = await call("GET", "/api/auth/me", undefined, { cookie: maxed.cookie });
        check("session past its 12 h maximum (recently active): 401 and the row is deleted", r.status === 401 && !(await sessionRow(maxed.token)), `${r.status}`);

        // ================= Logout =================
        r = await call("POST", "/api/auth/logout", undefined, { cookie: COOKIE_B });
        check("logout: 200, cookie cleared (Max-Age=0), session row deleted", r.status === 200 && /cb_session=;/.test(r.setCookie) && /Max-Age=0/.test(r.setCookie) && !(await sessionRow(lb.token)), r.setCookie);
        r = await call("GET", "/api/admin/chatbots", undefined, { cookie: COOKIE_B });
        check("logout: the old cookie is refused (401)", r.status === 401, r.text);

        // ================= Login rate limits =================
        // A already has 1 failed login (the wrong-password check above): 4 more make 5.
        const victim = "owner-a@accounts-test.example";
        const perEmail = [];
        for (let i = 0; i < 4; i++) perEmail.push((await call("POST", "/api/auth/login", { email: victim, password: `wrong-${i}-password` })).status);
        r = await call("POST", "/api/auth/login", { email: victim, password: PASSWORD_A });
        check("login limit per email: 5 failures (from different addresses), then 429 even with the right password, no cookie",
            perEmail.every(status => status === 401) && r.status === 429 && !r.setCookie, `${perEmail.join(",")} then ${r.status}`);
        const oneAddress = "203.0.113.77";
        const perAddress = [];
        for (let i = 0; i < 10; i++) perAddress.push((await call("POST", "/api/auth/login", { email: `nobody-${i}@accounts-test.example`, password: "wrong-password-123" }, { visitor: oneAddress })).status);
        r = await call("POST", "/api/auth/login", { email: EMAIL_B, password: PASSWORD_B }, { visitor: oneAddress });
        check("login limit per address: 10 failures, then 429 (also for valid credentials)", perAddress.every(status => status === 401) && r.status === 429 && !r.setCookie, `${perAddress.join(",")} then ${r.status}`);
        r = await call("POST", "/api/auth/login", { email: EMAIL_B, password: PASSWORD_B });
        if (r.token) tokens.push(r.token);
        check("login limits are per email / per address: B can still log in from another address", r.status === 200, r.text);

        // ================= Dashboard in a real browser (375 px) =================
        const { chromium } = require("playwright");
        browser = await chromium.launch({ headless: true });
        const pageErrors = [];
        const openPage = async () => {
            const context = await browser.newContext({ viewport: { width: 375, height: 760 } });
            const page = await context.newPage();
            page.on("pageerror", failure => pageErrors.push(failure.message));
            await page.goto(BASE + "/");
            await page.waitForLoadState("networkidle");
            return { context, page };
        };
        const UI1 = crypto.randomUUID(), UI2 = crypto.randomUUID();
        chatbotIds.push(UI1, UI2);
        await pool.query(
            `INSERT INTO chatbots (id, website_url, allowed_domain, status, display_name) VALUES
             ($1, 'http://127.0.0.1:1/ui1', '127.0.0.1', 'ready', 'Bright UI One'), ($2, 'http://127.0.0.1:1/ui2', '127.0.0.1', 'ready', 'Bright UI Two')`, [UI1, UI2]);
        const EMAIL_C = "ui-c@accounts-test.example", EMAIL_D = "ui-d@accounts-test.example";
        const PASSWORD_C = `pw-C-${crypto.randomBytes(12).toString("base64url")}`, PASSWORD_D = `pw-D-${crypto.randomBytes(12).toString("base64url")}`, PASSWORD_C2 = `pw-C2-${crypto.randomBytes(12).toString("base64url")}`;
        uiSecrets.push(PASSWORD_C, PASSWORD_D, PASSWORD_C2);
        const noSideScroll = page => page.evaluate(() => document.documentElement.scrollWidth <= 375);
        const noStoredSecrets = page => page.evaluate(() => localStorage.length === 0 && sessionStorage.length === 0);
        const customerLogin = async (page, email, password) => {
            await page.fill("#loginEmail", email);
            await page.fill("#loginPassword", password);
            const [response] = await Promise.all([page.waitForResponse(res => res.url().endsWith("/api/auth/login")), page.click("#loginForm button")]);
            return response.status();
        };
        const loginError = async page => {
            await page.waitForSelector("#loginForm button:not([disabled])");
            await page.waitForSelector("#globalMessage .message");
            return (await page.textContent("#globalMessage")).trim();
        };

        // --- The admin-key flow, as before ---
        const { page: admin } = await openPage();
        check("dashboard, not connected: the login form and the admin-key link are offered; platform section hidden",
            await admin.isVisible("#loginForm") && await admin.isVisible("#showAdminKey") && !(await admin.isVisible("#platformSection")) && (await admin.textContent("#keyState")) === "Not connected");
        await admin.click("#showAdminKey");
        await admin.fill("#adminKey", "wrong-" + "0".repeat(60));
        await admin.click("#keyForm button");
        await admin.waitForSelector("#globalMessage .message");
        check("admin key flow: a wrong key shows 'not accepted', the field is cleared, not connected, no platform section",
            /not accepted/.test(await admin.textContent("#globalMessage")) && (await admin.inputValue("#adminKey")) === "" && (await admin.textContent("#keyState")) === "Not connected" && !(await admin.isVisible("#platformSection")));
        await admin.fill("#adminKey", KEY);
        await admin.click("#keyForm button");
        await admin.waitForSelector("#chatbotList .bot >> text=Bright UI One");
        await admin.waitForSelector("#accountList .account");
        const adminList = await admin.textContent("#chatbotList");
        check("admin key flow: Connected; every chatbot listed (customers' and unassigned)", (await admin.textContent("#keyState")) === "Connected" && ["Bright UI One", "Bright UI Two", "Shop A"].every(name => adminList.includes(name)), adminList.slice(0, 200));
        check("admin key flow: platform section shown, login form hidden, key field cleared, nothing in browser storage",
            await admin.isVisible("#platformSection") && !(await admin.isVisible("#loginForm")) && (await admin.inputValue("#adminKey")) === "" && await noStoredSecrets(admin));
        await admin.locator("#chatbotList .bot", { hasText: "Bright UI One" }).locator("button", { hasText: "Manage" }).click();
        await admin.click("#t-enquiries");
        await admin.waitForSelector("#enquiryList .empty");
        check("admin key flow: Manage and the Enquiries tab work", await admin.isVisible("#detail"));

        // --- Platform section: create, assign ---
        const createAccount = async (email, password) => {
            await admin.fill("#newAccountEmail", email);
            await admin.fill("#newAccountPassword", password);
            await admin.click("#createAccountButton");
            await admin.waitForSelector(`#accountList .account >> text=${email}`);
        };
        await admin.fill("#newAccountEmail", "short@accounts-test.example");
        await admin.fill("#newAccountPassword", "too-short");
        await admin.click("#createAccountButton");
        await admin.waitForSelector("#platformMessage .message.error");
        check("platform section: a too-short password shows the server's message", /12 to 200/.test(await admin.textContent("#platformMessage")), await admin.textContent("#platformMessage"));
        await createAccount(EMAIL_C, PASSWORD_C);
        await createAccount(EMAIL_D, PASSWORD_D);
        accountIds.push(...(await pool.query("SELECT id FROM accounts WHERE email = ANY($1::text[])", [[EMAIL_C, EMAIL_D]])).rows.map(row => row.id));
        check("platform section: creates accounts; the password field is cleared; the password is stored only as a hash",
            accountIds.length === 4 && (await admin.inputValue("#newAccountPassword")) === "" &&
            (await pool.query("SELECT password_hash FROM accounts WHERE email = $1", [EMAIL_C])).rows[0].password_hash.startsWith("scrypt$"));
        const assign = async (botId, email) => {
            await admin.selectOption("#assignChatbot", botId);
            await admin.selectOption("#assignAccount", { label: email });
            await admin.click("#assignButton");
            await admin.waitForFunction(([id, mail]) => document.querySelector(`#assignChatbot option[value="${id}"]`).textContent.includes(mail), [botId, email]);
        };
        await assign(UI1, EMAIL_C);
        await assign(UI2, EMAIL_D);
        const uiOwners = (await pool.query("SELECT a.email FROM chatbots c JOIN accounts a ON a.id = c.owner_account_id WHERE c.id = ANY($1::uuid[]) ORDER BY a.email", [[UI1, UI2]])).rows.map(row => row.email);
        check("platform section: assigns each chatbot to its owner", uiOwners.join() === `${EMAIL_C},${EMAIL_D}`, uiOwners.join());
        check("platform section at 375 px: no sideways scrolling", await noSideScroll(admin));

        // --- Customer login ---
        const { page: customer, context: customerContext } = await openPage();
        await customerLogin(customer, EMAIL_C, "wrong-password-123");
        const wrongMessage = await loginError(customer);
        await customerLogin(customer, "nobody-ui@accounts-test.example", "wrong-password-123");
        const unknownMessage = await loginError(customer);
        check("login form: a wrong password and an unknown email show the same message", wrongMessage === "Email or password is incorrect." && unknownMessage === wrongMessage, `${wrongMessage} | ${unknownMessage}`);
        check("login form: the password field is cleared after a failure", (await customer.inputValue("#loginPassword")) === "");
        await customerLogin(customer, EMAIL_C, PASSWORD_C);
        await customer.waitForSelector("#chatbotList .bot");
        const customerList = await customer.textContent("#chatbotList");
        check("customer: 'Logged in as <email>' and a logout button", (await customer.textContent("#sessionState")) === `Logged in as ${EMAIL_C}` && await customer.isVisible("#logoutButton"), await customer.textContent("#sessionState"));
        check("customer: sees ONLY their own chatbot", (await customer.locator("#chatbotList .bot").count()) === 1 && customerList.includes("Bright UI One") && !/Bright UI Two|Shop A/.test(customerList), customerList.slice(0, 200));
        check("customer: platform controls and the admin-key box are hidden",
            !(await customer.isVisible("#platformSection")) && !(await customer.isVisible("#keyForm")) && !(await customer.isVisible("#createAccountForm")) && !(await customer.isVisible("#assignForm")) && !(await customer.isVisible("#loginForm")));
        const customerCookie = (await customerContext.cookies()).find(cookie => cookie.name === "cb_session");
        check("customer: session only in an HttpOnly, SameSite=Strict cookie; nothing in localStorage or sessionStorage; page script cannot read it",
            customerCookie?.httpOnly === true && customerCookie.sameSite === "Strict" && await noStoredSecrets(customer) && !(await customer.evaluate(() => document.cookie)).includes("cb_session"), JSON.stringify({ httpOnly: customerCookie?.httpOnly, sameSite: customerCookie?.sameSite }));
        check("customer at 375 px: no sideways scrolling; logged-in header fits", await noSideScroll(customer));
        await customer.reload();
        await customer.waitForSelector("#chatbotList .bot");
        check("customer: a page reload stays logged in (through /api/auth/me)", (await customer.textContent("#sessionState")) === `Logged in as ${EMAIL_C}`);
        await customer.locator("#chatbotList .bot").locator("button", { hasText: "Manage" }).click();
        await customer.click("#t-documents");
        await customer.setInputFiles("#documentFiles", { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("not a document") });
        await customer.click("#uploadDocuments");
        await customer.waitForFunction(() => /notes\.txt:/.test(document.querySelector("#documentMessage").textContent));
        const uploadMessage = await customer.textContent("#documentMessage");
        check("customer: document upload is authenticated by the cookie (the file TYPE is refused, not the login)", /notes\.txt:/.test(uploadMessage) && !/HTTP 401|admin key/i.test(uploadMessage), uploadMessage);

        // --- 429 and 403: clear messages, the customer stays logged in ---
        const answerList = async (status, expected) => {
            await customer.route("**/api/admin/chatbots", route => route.fulfill({ status, contentType: "application/json", body: JSON.stringify({ success: false, error: "simulated" }) }));
            await customer.click("#refreshButton");
            await customer.waitForFunction(text => document.querySelector("#globalMessage").textContent.includes(text), expected);
            await customer.unroute("**/api/admin/chatbots");
            return await customer.isVisible("#sessionBar");
        };
        check("customer: 429 shows a clear message, still logged in", await answerList(429, "Too many requests"));
        check("customer: 403 shows a clear message, still logged in", await answerList(403, "This request was refused"));

        // --- Second customer, then expiry, logout, disable, reset ---
        const { page: customerD } = await openPage();
        await customerLogin(customerD, EMAIL_D, PASSWORD_D);
        await customerD.waitForSelector("#chatbotList .bot");
        const listD = await customerD.textContent("#chatbotList");
        check("second customer: sees only their own chatbot", (await customerD.locator("#chatbotList .bot").count()) === 1 && listD.includes("Bright UI Two") && !listD.includes("Bright UI One"), listD.slice(0, 200));

        await pool.query("UPDATE sessions SET expires_at = NOW() - interval '1 second' WHERE account_id = (SELECT id FROM accounts WHERE email = $1)", [EMAIL_C]);
        await customer.click("#refreshButton");
        await customer.waitForSelector("#loginForm:not([hidden])");
        await customer.waitForSelector("#globalMessage .message");
        check("expired session: back to the login form with a clear message; the chatbot is gone from the page",
            /session has ended/.test(await customer.textContent("#globalMessage")) && !(await customer.isVisible("#sessionBar")) && (await customer.locator("#chatbotList .bot").count()) === 0 && !(await customer.content()).includes("Bright UI One") && !customer.url().includes("session="), customer.url());

        await customerLogin(customer, EMAIL_C, PASSWORD_C);
        await customer.waitForSelector("#sessionBar:not([hidden])");
        await customer.click("#logoutButton");
        await customer.waitForSelector("#loginForm:not([hidden])");
        await customer.waitForLoadState("networkidle");
        const meAfterLogout = await customer.evaluate(async () => (await fetch("/api/auth/me")).status);
        const sessionsLeft = (await pool.query("SELECT count(*)::int AS n FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE a.email = $1", [EMAIL_C])).rows[0].n;
        check("logout: back to the login form, the admin-key box is offered again, no chatbots shown, session gone",
            meAfterLogout === 401 && sessionsLeft === 0 && await customer.isVisible("#showAdminKey") && (await customer.locator("#chatbotList .bot").count()) === 0, `me ${meAfterLogout}, sessions ${sessionsLeft}`);

        admin.once("dialog", dialog => dialog.accept());
        await admin.locator("#accountList .account", { hasText: EMAIL_D }).locator("button", { hasText: "Disable" }).click();
        await admin.waitForSelector(`#accountList .account >> text=${EMAIL_D} (disabled)`);
        await customerD.click("#refreshButton");
        await customerD.waitForSelector("#loginForm:not([hidden])");
        check("disable account: the logged-in customer is sent back to the login form", /session has ended/.test(await customerD.textContent("#globalMessage")));
        const disabledStatus = await customerLogin(customerD, EMAIL_D, PASSWORD_D);
        check("disable account: the right password now gets the same message as a wrong one", disabledStatus === 401 && (await loginError(customerD)) === "Email or password is incorrect.", disabledStatus);

        await admin.selectOption("#resetAccount", { label: EMAIL_C });
        await admin.fill("#resetPassword", PASSWORD_C2);
        await admin.click("#resetButton");
        await admin.waitForFunction(() => /password was reset/.test(document.querySelector("#platformMessage").textContent));
        const oldPassword = await customerLogin(customer, EMAIL_C, PASSWORD_C);
        const newPassword = await customerLogin(customer, EMAIL_C, PASSWORD_C2);
        await customer.waitForSelector("#sessionBar:not([hidden])");
        check("reset password: the old password is refused, the new one works, the field is cleared", oldPassword === 401 && newPassword === 200 && (await admin.inputValue("#resetPassword")) === "", `${oldPassword} ${newPassword}`);
        check("dashboard: no script errors on any page", pageErrors.length === 0, pageErrors.join(" | "));
        await browser.close();
        browser = null;

        // --- The same routes on the API: platform only ---
        r = await call("PATCH", `/api/admin/accounts/${B}`, { status: "disabled" }, { cookie: (await login(EMAIL_B, PASSWORD_B)).cookie });
        const resetAsCustomer = await call("POST", `/api/admin/accounts/${A}/password`, { password: "long-enough-password" }, { cookie: (await login(EMAIL_B, PASSWORD_B)).cookie });
        check("disable / reset: 404 for a customer, nothing changed", r.status === 404 && resetAsCustomer.status === 404 && (await pool.query("SELECT status FROM accounts WHERE id = $1", [B])).rows[0].status === "active", `${r.status} ${resetAsCustomer.status}`);
        r = await call("PATCH", `/api/admin/accounts/${crypto.randomUUID()}`, { status: "disabled" }, { key: KEY });
        const badStatus = await call("PATCH", `/api/admin/accounts/${B}`, { status: "paused" }, { key: KEY });
        const shortReset = await call("POST", `/api/admin/accounts/${B}/password`, { password: "short" }, { key: KEY });
        const unauthenticated = await call("PATCH", `/api/admin/accounts/${B}`, { status: "disabled" });
        check("disable / reset as platform admin: unknown account 404, bad status 400, short password 400; logged out 401", r.status === 404 && badStatus.status === 400 && shortReset.status === 400 && unauthenticated.status === 401, `${r.status} ${badStatus.status} ${shortReset.status} ${unauthenticated.status}`);

        // ================= Public routes need no login =================
        r = await call("GET", `/api/chatbots/${A1}/config`);
        const health = await call("GET", "/api/health");
        check("public: widget config and health need no login", r.status === 200 && health.status === 200, `${r.status} ${health.status}`);

        // ================= Logs =================
        const allLogs = logged.join("\n");
        const secrets = [PASSWORD_A, PASSWORD_B, ...uiSecrets, ...tokens.filter(Boolean)];
        check("logs: no password, session token or customer email", !secrets.some(secret => allLogs.includes(secret)) && !/owner-a@|owner-b@|ui-[cd]@/i.test(allLogs), allLogs.slice(0, 300));
        check("logs: customer requests are audited by account (short ID), not by email", /key=account:[0-9a-f]{8}/.test(allLogs));
    } catch (failure) {
        check("test run finished without an unexpected error", false, failure.stack || failure.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
        // Cleanup by the exact IDs of this run only, in the isolated database (chatbots first: owners are RESTRICT).
        for (const id of chatbotIds) await pool.query("DELETE FROM chatbots WHERE id = $1", [id]).catch(() => {});
        for (const id of accountIds.filter(Boolean)) await pool.query("DELETE FROM accounts WHERE id = $1", [id]).catch(() => {});
        const left = (await pool.query(`SELECT (SELECT count(*) FROM chatbots WHERE id = ANY($1::uuid[])) + (SELECT count(*) FROM accounts WHERE id = ANY($2::uuid[]))
            + (SELECT count(*) FROM sessions WHERE account_id = ANY($2::uuid[])) + (SELECT count(*) FROM enquiries WHERE chatbot_id = ANY($1::uuid[]))
            + (SELECT count(*) FROM documents WHERE chatbot_id = ANY($1::uuid[])) AS n`, [chatbotIds, accountIds.filter(Boolean)])).rows[0].n;
        const totals = (await pool.query("SELECT (SELECT count(*) FROM chatbots) + (SELECT count(*) FROM accounts) + (SELECT count(*) FROM sessions) AS n")).rows[0].n;
        check("cleanup: nothing of this run left; test database has no chatbots, accounts or sessions", Number(left) === 0 && Number(totals) === 0, `left ${left}, totals ${totals}`);
        console.log = log; console.warn = warn; console.error = error;
        console.table(results);
        const failed = results.filter(x => x.result !== "PASS").length;
        console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
        process.exit(failed ? 1 : 0);
    }
})();
