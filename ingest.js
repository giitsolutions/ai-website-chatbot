const crypto = require("crypto");
const dns = require("dns").promises;
const net = require("net");
const http = require("http");
const https = require("https");
const zlib = require("zlib");
const { chromium } = require("playwright");
const cheerio = require("cheerio");
const { QdrantClient } = require("@qdrant/js-client-rest");


// --------------------------------------------------
// QDRANT
// --------------------------------------------------

const qdrant = new QdrantClient({
    url: "http://localhost:6333"
});

// QDRANT_COLLECTION (optional): another collection, e.g. an isolated one for tests.
const COLLECTION_NAME =
    process.env.QDRANT_COLLECTION || "website_content";


// --------------------------------------------------
// OUTBOUND URL SAFETY (SSRF DEFENSE-IN-DEPTH)
// --------------------------------------------------

const blockedNetworks = new net.BlockList();
for (const [subnet, prefix, family] of [
    ["0.0.0.0", 8, "ipv4"], ["10.0.0.0", 8, "ipv4"],
    ["100.64.0.0", 10, "ipv4"], ["127.0.0.0", 8, "ipv4"],
    ["169.254.0.0", 16, "ipv4"], ["172.16.0.0", 12, "ipv4"],
    ["192.0.0.0", 24, "ipv4"], ["192.0.2.0", 24, "ipv4"],
    ["192.168.0.0", 16, "ipv4"], ["198.18.0.0", 15, "ipv4"],
    ["198.51.100.0", 24, "ipv4"], ["203.0.113.0", 24, "ipv4"],
    ["224.0.0.0", 4, "ipv4"], ["240.0.0.0", 4, "ipv4"],
    ["::", 128, "ipv6"], ["::1", 128, "ipv6"],
    ["fc00::", 7, "ipv6"], ["fe80::", 10, "ipv6"],
    ["ff00::", 8, "ipv6"], ["2001:db8::", 32, "ipv6"],
    ["192.88.99.0", 24, "ipv4"], ["64:ff9b::", 96, "ipv6"],
    ["64:ff9b:1::", 48, "ipv6"], ["100::", 64, "ipv6"],
    ["2001::", 23, "ipv6"], ["2002::", 16, "ipv6"]
]) blockedNetworks.addSubnet(subnet, prefix, family);

const publicHostCache = new Map();
const HOST_CACHE_TTL_MS = 60_000;

async function assertPublicHttpUrl(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); }
    catch { throw new Error("Invalid website URL."); }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error("Only HTTP and HTTPS URLs are supported.");
    }
    if (parsed.username || parsed.password) {
        throw new Error("Website URLs must not contain credentials.");
    }
    if (!['', '80', '443'].includes(parsed.port)) {
        throw new Error("Only the standard web ports (80 and 443) are allowed.");
    }
    if (parsed.hostname.endsWith('.internal')) {
        throw new Error("Local and private network destinations are not allowed.");
    }
    if (!parsed.hostname || parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') || parsed.hostname.endsWith('.local')) {
        throw new Error("Local and private network destinations are not allowed.");
    }

    const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const checkAddress = (address) => {
        const family = net.isIP(address);
        if (!family) return false;
        // Only globally-routable IPv6 global-unicast space is eligible.
        if (family === 6 && !/^([23][0-9a-f]{3}):/.test(address.toLowerCase())) return false;
        return !blockedNetworks.check(address, family === 4 ? 'ipv4' : 'ipv6');
    };

    if (net.isIP(hostname)) {
        if (!checkAddress(hostname)) throw new Error("Private or reserved IP destinations are not allowed.");
        parsed.publicAddresses = [{ address: hostname, family: net.isIP(hostname) }];
        return parsed;
    }

    const cached = publicHostCache.get(hostname);
    if (cached && cached.expires > Date.now()) {
        if (!cached.ok) throw new Error("Website hostname resolves to a private or reserved address.");
        parsed.publicAddresses = cached.addresses;
        return parsed;
    }

    let addresses;
    try { addresses = await dns.lookup(hostname, { all: true, verbatim: true }); }
    catch { throw new Error("Website hostname could not be resolved."); }
    const ok = addresses.length > 0 && addresses.every(({ address }) => checkAddress(address));
    publicHostCache.set(hostname, {
        ok,
        addresses: addresses.map(({ address, family }) => ({ address, family })),
        expires: Date.now() + HOST_CACHE_TTL_MS
    });
    if (!ok) throw new Error("Private or reserved network destinations are not allowed.");
    parsed.publicAddresses = publicHostCache.get(hostname).addresses;
    return parsed;
}

// --------------------------------------------------
// PINNED HTTP CLIENT (DNS-REBINDING PROTECTION)
// --------------------------------------------------

/*
    Every request the crawler makes goes through this client. It validates the
    URL, then connects ONLY to the IP addresses that passed validation (they are
    handed to the socket as the DNS lookup result). A second, different DNS
    answer between validation and connection (DNS rebinding) therefore has no
    effect. The size limit is enforced while downloading.
*/
const PINNED_REQUEST_TIMEOUT_MS = 30000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DROPPED_REQUEST_HEADERS = new Set([
    "host", "connection", "content-length", "transfer-encoding", "accept-encoding",
    "cookie", "proxy-authorization", "upgrade"
]);
const DROPPED_RESPONSE_HEADERS = new Set([
    "content-encoding", "content-length", "transfer-encoding", "connection", "set-cookie", "keep-alive"
]);

async function pinnedRequest(targetUrl, { method = "GET", headers = {}, body = null } = {}) {
    const validated = await assertPublicHttpUrl(targetUrl);
    const url = new URL(targetUrl);
    const addresses = validated.publicAddresses;

    const requestHeaders = { "accept-encoding": "gzip, deflate, br" };
    for (const [name, value] of Object.entries(headers)) {
        if (!DROPPED_REQUEST_HEADERS.has(name.toLowerCase())) {
            requestHeaders[name.toLowerCase()] = value;
        }
    }

    // Connect only to validated addresses. (Only the test harness, which
    // allow-lists its own fake site, returns no addresses.)
    const lookup = addresses && addresses.length
        ? (hostname, options, callback) => {
            if (options && options.all) {
                callback(null, addresses.map(({ address, family }) => ({ address, family })));
            } else {
                callback(null, addresses[0].address, addresses[0].family);
            }
        }
        : undefined;

    const client = url.protocol === "https:" ? https : http;

    return new Promise((resolve, reject) => {
        const request = client.request(url, {
            method,
            headers: requestHeaders,
            lookup,
            timeout: PINNED_REQUEST_TIMEOUT_MS
        }, response => {
            const encoding = String(response.headers["content-encoding"] || "").toLowerCase();
            let stream = response;
            if (encoding === "gzip" || encoding === "x-gzip") stream = response.pipe(zlib.createGunzip());
            else if (encoding === "deflate") stream = response.pipe(zlib.createInflate());
            else if (encoding === "br") stream = response.pipe(zlib.createBrotliDecompress());

            const chunks = [];
            let size = 0;

            stream.on("data", chunk => {
                size += chunk.length;
                if (size > MAX_RESPONSE_BYTES) {
                    request.destroy(new Error("Response too large."));
                    return;
                }
                chunks.push(chunk);
            });

            stream.on("end", () => {
                const responseHeaders = {};
                for (const [name, value] of Object.entries(response.headers)) {
                    if (!DROPPED_RESPONSE_HEADERS.has(name)) {
                        responseHeaders[name] = Array.isArray(value) ? value.join(", ") : String(value);
                    }
                }
                resolve({
                    status: response.statusCode,
                    headers: responseHeaders,
                    body: Buffer.concat(chunks),
                    url: url.toString()
                });
            });

            stream.on("error", reject);
        });

        request.on("timeout", () => request.destroy(new Error("Request timed out.")));
        request.on("error", reject);
        if (body && body.length) request.write(body);
        request.end();
    });
}


// --------------------------------------------------
// CRAWLER SETTINGS
// --------------------------------------------------

/*
    Keep this at 5 for a single-machine setup.

    We improve WHICH pages are crawled instead of
    simply increasing the number of pages.
*/
// Pages indexed per crawl: CRAWL_MAX_PAGES in .env (default 8), overridable per
// indexing request, never above MAX_PAGES_LIMIT.
const MAX_PAGES_LIMIT = 50;

function clampPageLimit(value, fallback) {
    const number = Math.floor(Number(value));
    if (!Number.isFinite(number) || number < 1) return fallback;
    return Math.min(number, MAX_PAGES_LIMIT);
}

const MAX_PAGES = clampPageLimit(process.env.CRAWL_MAX_PAGES, 8);


/*
    Maximum number of candidate URLs kept in memory.

    This prevents very large websites from filling
    your laptop memory with thousands of links.
*/
const MAX_CANDIDATE_URLS = 60;


/*
    DOMContentLoaded timeout.

    We deliberately do not wait for networkidle because
    modern websites can keep network connections open
    indefinitely.
*/
const PAGE_TIMEOUT = 45000;
// Bounded retries for transient page failures (the request budget still applies).
const TRANSIENT_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const TRANSIENT_NETWORK_ERROR = /request timed out|timeout \d+ms exceeded|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|socket hang up|ERR_CONNECTION_(?:RESET|CLOSED|REFUSED|TIMED_OUT)|ERR_EMPTY_RESPONSE|ERR_NETWORK_CHANGED|ERR_TIMED_OUT/i;
const MAX_PAGE_ATTEMPTS_HTTP = 3;
const MAX_PAGE_ATTEMPTS_NETWORK = 2;
const RETRY_BASE_DELAY_MS = 1000;


/*
    Small delay for JavaScript-rendered content.

    This is much cheaper than waiting up to 10 seconds
    for networkidle on every page.
*/
const DYNAMIC_CONTENT_WAIT = 1500;

// Pages with at least this much visible text after loading are not given the
// extra wait for script-rendered content.
const STATIC_PAGE_MIN_TEXT = 600;

// App shells (the server's HTML has almost no text and loads a script: React, Vue, ...): wait until
// no request is open and the visible text has not changed for APP_SHELL_STABLE_MS, at most
// APP_SHELL_MAX_WAIT_MS (a hung request or a page that never settles only costs this much).
const APP_SHELL_MAX_TEXT = 200;
const APP_SHELL_STABLE_MS = 1000;
const APP_SHELL_MAX_WAIT_MS = 10000;
const APP_SHELL_POLL_MS = 250;

// Crawl report warnings: fewer words than this in all pages read is "thin content"; a start page
// with fewer same-site links than this and at least MENU_BUTTONS_MIN buttons in its menus and
// footer "uses buttons, not links".
const THIN_CONTENT_WORDS = 500;
const MENU_LINKS_MAX = 3;
const MENU_BUTTONS_MIN = 3;

// Clicking menu buttons (per-chatbot setting, default off): only on the start page of a full crawl
// with fewer than MENU_LINKS_MAX links, at most MAX_BUTTON_CLICKS clicks, each waiting at most
// BUTTON_CLICK_WAIT_MS for the view to settle. Labels of actions are never clicked.
const MAX_BUTTON_CLICKS = 30;
const BUTTON_CLICK_WAIT_MS = 10000;
const ACTION_BUTTON_LABEL = /\b(sign ?up|sign ?in|sign ?out|register|log ?in|log ?out|account|profile|admin|cart|basket|buy|pay|payment|checkout|order|book|rent now|subscribe|submit|send|delete|remove|cancel|confirm|download|install)\b/i;

// Crawl report: at most this many addresses are listed per category.
const MAX_REPORTED_URLS = 100;

// URL-level crawl report: at most this many addresses are recorded per crawl (the counts
// say how many more were found).
const MAX_REPORTED_CRAWL_URLS = 5000;

// Memory for scripts reused between pages within one crawl.
const MAX_SCRIPT_CACHE_BYTES = 30 * 1024 * 1024;

// Sections shorter than this (in words) are merged with neighbouring short sections
// into one chunk: price cards, plan tiles and feature boxes are usually one short
// heading + one sentence each, and lose their meaning when embedded one by one.
const SHORT_SECTION_WORDS = 40;
// A heading of level 1 or 2 starts its own section unless both sides are as small as a price card.
const CARD_SECTION_WORDS = 20;


// --------------------------------------------------
// CHUNK SETTINGS
// --------------------------------------------------

const CHUNK_SIZE = 280;

const CHUNK_OVERLAP = 50;

// Short sections (a 3-step procedure, a one-line FAQ answer) are often the most
// useful help content, so only near-empty sections are skipped.
const MIN_CHUNK_WORDS = 8;


// --------------------------------------------------
// TRACKING QUERY PARAMETERS
// --------------------------------------------------

const TRACKING_PARAMETERS = new Set([
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
    "utm_id",
    "gclid",
    "fbclid",
    "msclkid",
    "mc_cid",
    "mc_eid",
    "ref",
    "referrer"
]);


// --------------------------------------------------
// CONTENT PAGE KEYWORDS
// --------------------------------------------------

const POSITIVE_PATH_KEYWORDS = [
    "about",
    "about-us",
    "company",

    "services",
    "service",
    "solutions",

    "products",
    "product",
    "categories",
    "category",
    "features",
    "feature",

    "pricing",
    "price",
    "plans",
    "plan",

    "return",
    "returns",
    "refund",
    "refunds",
    "exchange",
    "exchanges",
    "cancellation",
    "cancel",
    "shipping",
    "delivery",
    "policy",
    "policies",
    "terms",
    "privacy",

    "contact",
    "support",
    "help",
    "faq",
    "faqs",

    "blog",
    "blogs",
    "article",
    "articles",
    "news",

    "resources",
    "resource",
    "documentation",
    "docs",

    "technology",
    "technologies",
    "industries",
    "careers",
    "training"
];


// --------------------------------------------------
// PAGES THAT ARE GENERALLY NOT KNOWLEDGE PAGES
// --------------------------------------------------

const NEGATIVE_PATH_KEYWORDS = [
    "login",
    "signin",
    "sign-in",
    "signup",
    "sign-up",
    "register",
    "account",
    "profile",
    "cart",
    "checkout",
    "wishlist",
    "orders",
    "order",
    "notification",
    "notifications",
    "logout",
    "log-out",
    "auth",
    "authenticate",
    "password",
    "forgot-password",
    "reset-password",
    "search",
    "searchsuggestion",
    "suggestion",
    "captcha",
    "compare",
    "tracking",
    "track-order",
    "payment"
];


// --------------------------------------------------
// FILE EXTENSIONS TO IGNORE
// --------------------------------------------------

const SKIP_EXTENSIONS = [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".avif",
    ".heic",
    ".tif",
    ".tiff",
    ".svg",
    ".ico",
    ".bmp",
    ".webm",
    ".ogg",
    // Documents are not read (only HTML pages are); queueing them wastes the crawl budget.
    ".pdf",
    ".doc",
    ".docx",
    ".xls",
    ".xlsx",
    ".ppt",
    ".pptx",
    ".mp3",
    ".mp4",
    ".avi",
    ".mov",
    ".wav",
    ".zip",
    ".rar",
    ".7z",
    ".exe",
    ".dmg",
    ".iso",
    ".css",
    ".js",
    ".json",
    ".xml"
];


// --------------------------------------------------
// CLEAN TEXT
// --------------------------------------------------

function cleanText(text) {

    return String(text || "")
        .replace(/\s+/g, " ")
        .trim();
}


// --------------------------------------------------
// NORMALIZE URL
// --------------------------------------------------

function normalizeUrl(url) {

    const parsed =
        new URL(url);


    parsed.hash = "";


    /*
        Remove tracking parameters so that:

        /page?utm_source=x
        /page?utm_campaign=y

        become the same logical page.
    */

    const params =
        new URLSearchParams(
            parsed.search
        );


    for (
        const key of Array.from(
            params.keys()
        )
    ) {

        if (
            TRACKING_PARAMETERS.has(
                key.toLowerCase()
            )
        ) {

            params.delete(
                key
            );
        }
    }


    const query =
        params.toString();


    parsed.search =
        query
            ? `?${query}`
            : "";


    /*
        Remove a trailing slash except
        for the domain root.
    */

    if (
        parsed.pathname.length > 1 &&
        parsed.pathname.endsWith("/")
    ) {

        parsed.pathname =
            parsed.pathname.slice(
                0,
                -1
            );
    }


    return parsed.toString();
}


// --------------------------------------------------
// CHECK SAME WEBSITE
// --------------------------------------------------

// --------------------------------------------------
// HELP-CENTRE / DOCUMENTATION URLS
// --------------------------------------------------

/*
    Help articles are often about the very things the crawler otherwise avoids:
    "/help/sign-in", "/support/reset-password", "/docs/payment-methods". Inside a
    documentation area these are articles, not login or checkout forms, so the
    negative URL rules do not apply and the page is typed "help".
*/
const DOCUMENTATION_SEGMENTS = new Set([
    "help", "support", "docs", "doc", "documentation", "faq", "faqs", "kb",
    "knowledge-base", "knowledgebase", "knowledge", "guide", "guides", "tutorial",
    "tutorials", "article", "articles", "learn", "how-to", "howto", "manual",
    "manuals", "hc", "help-center", "helpcenter", "support-center"
]);
const DOCUMENTATION_HOST = /^(help|support|docs|doc|kb|knowledge|learn|faq|guide|guides|hc|helpcenter)\./i;

function stripWww(hostname) {
    const host = String(hostname || "").toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
}

// One key per page for duplicate detection: "www." and the bare domain are the same
// website, and host names are case-insensitive (paths are not).
function pageKey(url) {
    const parsed = new URL(normalizeUrl(url));
    parsed.hostname = stripWww(parsed.hostname);
    return parsed.toString();
}

// The two forms of one page's address that pageKey() treats as the same page: with and
// without "www." on the same host name. No other host is added (help.example.com/a gives only
// help.example.com/a and www.help.example.com/a); path, query and encoding are kept as they are.
function pageUrlForms(url) {
    const other = new URL(url);
    other.hostname = other.hostname.startsWith("www.") ? other.hostname.slice(4) : `www.${other.hostname}`;
    return [String(url), other.toString()];
}

// Crawl report: a page that was read is "indexed" (with its number of stored sections) only if
// at least one of its sections is stored; otherwise it was read but had no usable text.
// Entries and stored sections are matched by page key, because an entry keeps the first form of
// the address that was found (a link to example.com/a) while the page is stored under the
// address it was read at (www.example.com/a, after a redirect or through another link).
function markIndexedPages(urlReport, chunks) {
    const keyOf = url => {
        try {
            return pageKey(url);
        } catch {
            return String(url);
        }
    };
    const sectionsPerPage = new Map();
    const storedAt = new Map();
    for (const item of chunks) {
        const key = keyOf(item.url);
        sectionsPerPage.set(key, (sectionsPerPage.get(key) || 0) + 1);
        if (!storedAt.has(key)) storedAt.set(key, item.url);
    }
    for (const entry of urlReport) {
        if (entry.status !== "read") continue;
        const key = keyOf(entry.url);
        const sections = sectionsPerPage.get(key) || 0;
        if (!sections) {
            Object.assign(entry, { status: "skipped", reason: "no text long enough to store" });
            continue;
        }
        Object.assign(entry, { status: "indexed", sections });
        // Stored under another form of the address: the report says which.
        let sameForm = false;
        try {
            sameForm = normalizeUrl(entry.url) === storedAt.get(key);
        } catch {
            sameForm = false;
        }
        if (!sameForm && !entry.finalUrl) entry.finalUrl = storedAt.get(key);
    }
}

function isDocumentationUrl(url) {
    try {
        const parsed = new URL(url);
        if (DOCUMENTATION_HOST.test(parsed.hostname)) return true;
        const segments = parsed.pathname.toLowerCase().split("/").filter(Boolean);
        // The documentation area must contain the page: "/help/sign-in" yes, "/sign-in" no.
        return segments.length === 1
            ? DOCUMENTATION_SEGMENTS.has(segments[0])
            : segments.slice(0, -1).some(segment => DOCUMENTATION_SEGMENTS.has(segment));
    } catch {
        return false;
    }
}

/*
    Same website: the same host (with or without "www."), or a documentation
    subdomain (help., support., docs., ...) of the registered domain, e.g.
    help.example.com for example.com. Other subdomains and domains are not
    crawled. Every request is still SSRF-checked.
*/
function isSameDomain(
    url,
    baseHostname
) {
    try {
        const host = stripWww(new URL(url).hostname);
        const base = stripWww(baseHostname);
        if (host === base) return true;

        const baseParent = DOCUMENTATION_HOST.test(base) ? base.replace(/^[^.]+\./, "") : base;
        return DOCUMENTATION_HOST.test(host) && host.replace(/^[^.]+\./, "") === baseParent && baseParent.includes(".");
    } catch (error) {
        return false;
    }
}


// --------------------------------------------------
// CHECK WHETHER URL SHOULD BE SKIPPED
// --------------------------------------------------

// Why shouldSkipUrl() rejects an address, for the crawl report (same rules, in the same order).
function skipReason(url) {
    try {
        const parsed = new URL(url);
        const pathname = parsed.pathname.toLowerCase();
        if (!["http:", "https:"].includes(parsed.protocol)) return "not a web address";
        const extension = SKIP_EXTENSIONS.find(item => pathname.endsWith(item));
        if (extension) return `not a web page (${extension} file)`;
        if (!isDocumentationUrl(url) && pathname.split("/").filter(Boolean).some(segment => NEGATIVE_PATH_KEYWORDS.includes(segment))) {
            return "account, login, cart or checkout page";
        }
        if (/\/search[\/?]|searchsuggestion/.test(pathname)) return "search results page";
        if (pathname.startsWith("/api/") || pathname.endsWith("/api")) return "API address";
        return "not a content page";
    } catch {
        return "invalid address";
    }
}

// Current state of crawl-report rows compared with the website sections actually stored for the
// chatbot (uploaded documents never count). Rows and sections are matched by page key, so a row
// recorded under one form of an address (example.com/a) finds sections stored under the other
// (www.example.com/a); different paths, subdomains and queries stay separate. Nothing is changed:
// the recorded status is kept and current_status says what is true now:
//   "indexed-elsewhere"  recorded as not indexed, but its content is stored under an equivalent
//                        address form (reports written before the address-form fix);
//   "kept-earlier"       the latest attempt failed or was skipped, and the sections indexed
//                        earlier are still stored and used;
//   "skipped"            (with current_reason) an e-mail address recorded as pending or failed
//                        before e-mail links were filtered: it is not a web page.
// storedPoints: [{ url, sourceType }] of the chatbot's points.
function reconcileCrawlRows(rows, storedPoints) {
    const keyOf = url => {
        try {
            return pageKey(url);
        } catch {
            return String(url);
        }
    };
    const formOf = url => {
        try {
            return normalizeUrl(url);
        } catch {
            return String(url);
        }
    };
    const stored = new Map();
    for (const point of storedPoints) {
        if (!point || point.sourceType === "document" || !point.url) continue;
        const key = keyOf(point.url);
        const page = stored.get(key) || { url: point.url, sections: 0 };
        page.sections += 1;
        stored.set(key, page);
    }
    const counts = {};
    const reconciled = rows.map(row => {
        const page = stored.get(keyOf(row.url));
        let current = row.status;
        let currentReason = null;
        if (page && row.status !== "indexed") {
            const keptEarlier = row.status === "failed" || /indexed earlier are still used/.test(row.reason || "") || formOf(row.url) === formOf(page.url);
            current = keptEarlier ? "kept-earlier" : "indexed-elsewhere";
        } else if (!page && ["not-processed", "failed"].includes(row.status) && isEmailAddressPath(row.url)) {
            current = "skipped";
            currentReason = EMAIL_ADDRESS_REASON;
        }
        counts[current] = (counts[current] || 0) + 1;
        return { ...row, current_status: current, current_reason: currentReason, stored_sections: page ? page.sections : 0, stored_url: page ? page.url : null };
    });
    return { rows: reconciled, counts };
}

// Why a discovered address is outside the crawl, or null. Another website is checked first, so a
// link to another site is reported as such even when it uses http on an https website.
function scopeSkipReason(url, baseHostname, baseProtocol) {
    if (!isSameDomain(url, baseHostname)) return "outside the crawl scope (another website)";
    try {
        if (baseProtocol === "https:" && new URL(url).protocol === "http:") return "http address on an https website";
    } catch {
        return "outside the crawl scope (another website)";
    }
    return null;
}

// An e-mail address written as a link without "mailto:" (href="info@example.com"): no scheme,
// no path, no query, and a domain that ends in a name. Resolved as a relative link it would
// become ".../info@example.com" and be requested as a page. Addresses such as "/@team/news",
// "badge@2x.html" or "/share?from=a@b.com" are pages and are not matched.
const EMAIL_ADDRESS_REASON = "e-mail address, not a web page";
const WEB_PAGE_EXTENSION = /\.(?:html?|xhtml|shtml|php\d?|aspx?|jsp|cfm)$/i;
function isEmailAddressHref(href) {
    const value = String(href || "").trim().replace(/^\.\//, "");
    return /^[^\s/?#:@]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(value) && !WEB_PAGE_EXTENSION.test(value);
}

// A full address whose last path segment is an e-mail address ("https://site/name@example.com"):
// what an e-mail link without "mailto:" becomes once resolved. Same rule as isEmailAddressHref().
function isEmailAddressPath(url) {
    try {
        const parsed = new URL(url);
        if (parsed.search) return false;
        const last = decodeURIComponent(parsed.pathname.split("/").pop() || "");
        return isEmailAddressHref(last);
    } catch {
        return false;
    }
}

function shouldSkipUrl(url) {

    try {

        const parsed =
            new URL(url);


        if (
            parsed.protocol !== "http:" &&
            parsed.protocol !== "https:"
        ) {

            return true;
        }


        const pathname =
            parsed.pathname
                .toLowerCase();


        const fullUrl =
            url.toLowerCase();


        /*
            Skip files that cannot provide useful
            webpage knowledge.
        */

        for (
            const extension of
            SKIP_EXTENSIONS
        ) {

            if (
                pathname.endsWith(
                    extension
                )
            ) {

                return true;
            }
        }


        /*
            Exact negative path matching.
        */

        const segments =
            pathname
                .split("/")
                .filter(Boolean);


        // Not applied inside documentation areas (help articles about sign-in etc.).
        if (!isDocumentationUrl(url)) {
            for (const segment of segments) {
                if (NEGATIVE_PATH_KEYWORDS.includes(segment)) {
                    return true;
                }
            }
        }


        /*
            Also catch common search-like
            URL structures.
        */

        if (
            pathname.includes(
                "/search/"
            ) ||
            pathname.includes(
                "/search?"
            ) ||
            pathname.includes(
                "searchsuggestion"
            )
        ) {

            return true;
        }


        /*
            Do not crawl obvious API endpoints.
        */

        if (
            pathname.startsWith(
                "/api/"
            ) ||
            pathname.endsWith(
                "/api"
            )
        ) {

            return true;
        }


        /*
            Skip javascript and mailto links
            even if they reached this function.
        */

        if (
            fullUrl.startsWith(
                "javascript:"
            ) ||
            fullUrl.startsWith(
                "mailto:"
            ) ||
            fullUrl.startsWith(
                "tel:"
            )
        ) {

            return true;
        }


        return false;

    } catch (error) {

        return true;
    }
}


// --------------------------------------------------
// SCORE URL
// --------------------------------------------------

function scoreUrl(
    url,
    anchorText = ""
) {

    let score = 0;


    try {

        const parsed =
            new URL(url);


        const pathname =
            parsed.pathname
                .toLowerCase();


        const text =
            cleanText(
                anchorText
            )
                .toLowerCase();


        const combined =
            `${pathname} ${text}`;


        /*
            Root homepage gets high priority.
        */

        if (
            pathname === "/" ||
            pathname === ""
        ) {

            score += 20;
        }


        /*
            Useful content keywords.
        */

        for (
            const keyword of
            POSITIVE_PATH_KEYWORDS
        ) {

            if (
                combined.includes(
                    keyword
                )
            ) {

                score += 4;
            }
        }


        // Help articles are crawled first; account/checkout pages elsewhere last.
        if (isDocumentationUrl(url)) {
            score += 8;
        } else {
            for (const keyword of NEGATIVE_PATH_KEYWORDS) {
                if (combined.includes(keyword)) {
                    score -= 12;
                }
            }
        }


        /*
            URLs with very long query strings
            are often dynamic navigation/state pages.
        */

        if (
            parsed.search.length > 100
        ) {

            score -= 2;
        }


        /*
            Prefer shorter, cleaner content URLs.
        */

        const pathParts =
            pathname
                .split("/")
                .filter(Boolean);


        if (
            pathParts.length <= 2
        ) {

            score += 2;
        }


        /*
            Slightly reward readable anchor text.
        */

        if (
            text.length >= 8 &&
            text.length <= 80
        ) {

            score += 1;
        }


        // Give policy/support pages a stronger priority because
        // these pages often contain direct customer questions such as
        // return, refund, exchange, shipping and cancellation details.
        const priorityWords = [
            "return",
            "returns",
            "refund",
            "refunds",
            "exchange",
            "exchanges",
            "shipping",
            "delivery",
            "cancellation",
            "policy",
            "policies",
            "terms",
            "support",
            "help",
            "faq"
        ];

        for (const keyword of priorityWords) {

            if (combined.includes(keyword)) {

                score += 8;
            }
        }

    } catch (error) {

        return -100;
    }


    return score;
}


// --------------------------------------------------
// DETERMINE PAGE TYPE
// --------------------------------------------------

function getPageType(url) {

    try {

        if (isDocumentationUrl(url)) {
            return "help";
        }


        const pathname =
            new URL(url)
                .pathname
                .toLowerCase();


        const segments =
            pathname
                .split("/")
                .filter(Boolean);


        for (
            const segment of segments
        ) {

            if (
                [
                    "login",
                    "signin",
                    "sign-in",
                    "signup",
                    "sign-up",
                    "register",
                    "account",
                    "profile",
                    "logout",
                    "auth"
                ].includes(segment)
            ) {

                return "account";
            }


            if (
                [
                    "search",
                    "searchsuggestion",
                    "suggestion"
                ].includes(segment)
            ) {

                return "search";
            }


            if (
                [
                    "cart",
                    "checkout",
                    "wishlist",
                    "orders",
                    "payment"
                ].includes(segment)
            ) {

                return "transaction";
            }
        }


        return "content";

    } catch (error) {

        return "unknown";
    }
}


// --------------------------------------------------
// EXTRACT WEBSITE SECTIONS
// --------------------------------------------------

// Word count of a text.
function countTextWords(value) {
    return String(value).split(/\s+/).filter(Boolean).length;
}

// An element's text with a space between its parts: script-rendered pages put words in neighbouring
// divs and spans, which plain .text() would glue together ("01TREADMILLS").
function spacedText($, element) {
    const copy = $(element).clone();
    copy.find("*").append(" ");
    return cleanText(copy.text());
}

// Sections that contain ALL the text of root, still split at its headings.
function allTextSections($, root, pageTitle) {
    const sections = [];
    let current = { heading: pageTitle || "Website", anchor: "", blocks: [] };
    const walk = element => {
        for (const node of $(element).contents().toArray()) {
            if (node.type === "text") {
                const text = cleanText(node.data);
                if (text) current.blocks.push(text);
            } else if (node.type === "tag") {
                if (/^h[1-6]$/i.test(node.tagName)) {
                    const heading = spacedText($, node);
                    if (!heading) continue;
                    if (current.blocks.length) sections.push(current);
                    current = { heading, anchor: $(node).attr("id") || "", blocks: [], level: Number(node.tagName[1]) };
                } else {
                    walk(node);
                }
            }
        }
    };
    walk(root);
    if (current.blocks.length) sections.push(current);
    return sections.map(section => ({ ...section, blocks: [cleanText(section.blocks.join(" "))] }));
}

// Text in these tags belongs with the text next to it.
const INLINE_TAGS = new Set(["a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "del", "dfn", "em", "font", "i", "img", "ins", "kbd", "label", "mark", "picture", "q", "s", "samp", "small", "source", "span", "strike", "strong", "sub", "sup", "time", "u", "var", "wbr"]);
const STRUCTURED_TAGS = "h1, h2, h3, h4, h5, h6, p, li, dt, dd, th, td, pre, button";
const HIDDEN_STYLE = /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i;
const NOT_READ_TAGS = new Set(["template", "video", "audio", "object", "embed", "map"]);
const COOKIE_CONTROL = /^(?:accept|agree|allow|got it|i agree|i understand|ok|okay|decline|reject|deny|manage|preferences|settings)\b/i;
const COOKIE_PART = /(?:^|[\s_-])(?:cookies?|consent|gdpr)(?:[\s_-]|$)|onetrust|cookiebot/i;
const COOKIE_WORDING = /\b(?:accept|agree|allow|consent|decline|reject|preferences|privacy)\b/i;
const COOKIE_BANNER_MAX_WORDS = 150;
// Footer lines that say nothing about the business.
const FOOTER_NOISE = /©|\bcopyright\b|all rights reserved|\b(?:powered|designed|developed|built) by\b|\bmade with\b/i;
const FOOTER_NOISE_MAX_WORDS = 20;
const FOOTER_HEADING = "Contact and company information";
const FOOTER_LABELLED_LINE = /^\p{L}[\p{L}\s&./-]{1,40}:\s*\S/u;
const FOOTER_RIGHTS = /©|\ball rights reserved\b\.?/gi;
const FOOTER_COPYRIGHT = /©|\bcopyright\b|\ball rights reserved\b/i;

// At least this many different short buttons side by side are a grid of cards, not stray buttons.
const CARD_LIST_MIN = 3;
// Whole words of a class or id ("filter-panel", "side_menu"), so that "canvas" or "resort" do not count.
const NOT_A_CARD_LIST = /(?:^|[\s_-])(?:nav|navbar|navigation|menu|menus|tab|tabs|tablist|pagination|pager|breadcrumb|breadcrumbs|toolbar|dropdown|filter|filters|facet|facets|sort|sorting|refine|sidebar|widget)(?:[\s_-]|$)/i;
// Controls that choose or switch something, whatever their container is called.
const NOT_A_CARD = "[aria-pressed], [aria-selected], [aria-checked], [role='tab'], [role='radio'], [role='checkbox'], [role='menuitem'], [role='option'], [role='switch']";
// Footers and sidebars that themes build from divs.
const FOOTER_PARTS = "footer, [role='contentinfo'], #footer, #colophon, .footer, .site-footer";
const SIDEBAR_PARTS = ".sidebar, #sidebar, .widget-area, #secondary, .tagcloud, .tag-cloud";
const LINK_MENU_NAME = /(?:^|[\s_-])(?:nav|navbar|navigation|menu|menus)(?:[\s_-]|$)/i;
// What a website builder fills in by itself says nothing about the business.
const DEFAULT_META = /just another\b|welcome to (?:my|our) (?:web)?site|lorem ipsum|^(?:home|index|untitled|default|my site|my website)(?:\s*[|\-–—:]\s*(?:home|index|untitled|my site|my website))*\s*$/i;
const PHONE_IN_TEXT = /\+?\d[\d\s()-]{7,}\d/g;
const EMAIL_IN_TEXT = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const ABOUT_HEADING = "About this website";
// How far a business reaches: the metadata may say "worldwide" where the page says one city.
const WIDE_REACH = /\b(?:world-?wide|global(?:ly)?|international(?:ly)?|nation-?wide|all over|everywhere|across the (?:world|country|globe))\b/i;
const ONLY_IN_PLACE = /\b(?:only|exclusively|solely)\s+(?:in|within|around)\s+((?:the\s+)?[A-Z][\p{L}-]+)/gu;
const LIMITED_REACH = /\b(?:no longer|do not|don't|does not|doesn't|cannot|can't)\b[^.\n]{0,40}\b(?:ship|post|deliver|serve|work|travel)\b[^.\n]{0,40}\b(?:outside|other|abroad|overseas|international)/i;
const ABOUT_MAX_LINE = 300;
const ABOUT_MAX_JSON_CHARS = 100000;
// What the website says about itself in JSON-LD. Pages about something else (a product, an article,
// a person) are not facts about the business.
const ABOUT_FIELDS = [["name", "Name"], ["legalName", "Legal name"], ["description", "Description"], ["slogan", "Slogan"], ["areaServed", "Areas served"], ["serviceArea", "Areas served"], ["address", "Address"], ["telephone", "Phone"], ["email", "Email"], ["openingHours", "Opening hours"], ["openingHoursSpecification", "Opening hours"], ["servesCuisine", "Cuisine"], ["priceRange", "Price range"], ["paymentAccepted", "Payment accepted"], ["foundingDate", "Founded"]];
const NOT_ABOUT_THE_BUSINESS = /^(?:Person|Product|Offer|AggregateOffer|Review|AggregateRating|Article|NewsArticle|BlogPosting|FAQPage|Question|Answer|BreadcrumbList|ListItem|ImageObject|VideoObject|Event|Recipe)$/i;

// A JSON-LD value as plain text: lists are joined and objects give their readable parts.
function jsonLdText(value, depth = 0) {
    if (depth > 4 || value === null || value === undefined) return "";
    if (typeof value === "string" || typeof value === "number") return cleanText(String(value).replace(/<[^>]*>/g, " "));
    if (Array.isArray(value)) return value.map(item => jsonLdText(item, depth + 1)).filter(Boolean).join(", ");
    if (typeof value !== "object") return "";
    if (value.opens || value.closes) return cleanText(`${jsonLdText(value.dayOfWeek, depth + 1)} ${jsonLdText(value.opens, depth + 1)}-${jsonLdText(value.closes, depth + 1)}`);
    if (value.streetAddress || value.addressLocality || value.addressRegion) {
        return ["streetAddress", "addressLocality", "addressRegion", "postalCode", "addressCountry"].map(key => jsonLdText(value[key], depth + 1)).filter(Boolean).join(", ");
    }
    return jsonLdText(value.name || value.address, depth + 1);
}

// Title, description and JSON-LD facts as one small section marked isAbout. crawlWebsite() stores it
// for the start page only. Without a description or a JSON-LD fact there is nothing the page text lacks.
function aboutSection($) {
    const lines = [];
    const add = (label, value) => {
        const text = String(value || "").slice(0, ABOUT_MAX_LINE);
        const line = `${label}: ${text}`;
        if (text && !DEFAULT_META.test(text) && !lines.some(other => other.endsWith(`: ${text}`))) lines.push(line);
    };
    const meta = selector => cleanText($(selector).first().attr("content") || "");
    add("Description", meta('meta[name="description" i]') || meta('meta[property="og:description" i]'));
    const visit = (node, depth) => {
        if (depth > 4 || !node || typeof node !== "object") return;
        if (Array.isArray(node)) return node.forEach(item => visit(item, depth + 1));
        if (Array.isArray(node["@graph"])) visit(node["@graph"], depth + 1);
        const types = [].concat(node["@type"] || []);
        if (!types.length || types.some(type => NOT_ABOUT_THE_BUSINESS.test(String(type)))) return;
        for (const [field, label] of ABOUT_FIELDS) add(label, jsonLdText(node[field]));
        for (const point of [].concat(node.contactPoint || [])) {
            if (point && typeof point === "object") {
                add("Phone", jsonLdText(point.telephone));
                add("Email", jsonLdText(point.email));
            }
        }
    };
    $('script[type="application/ld+json" i]').each((_, element) => {
        const json = $(element).text();
        if (json.length > ABOUT_MAX_JSON_CHARS) return;
        try { visit(JSON.parse(json), 0); } catch { /* a broken block says nothing */ }
    });
    if (!lines.length) return null;
    const title = cleanText($("title").first().text());
    if (title && !DEFAULT_META.test(title)) lines.unshift(`Website title: ${title.slice(0, ABOUT_MAX_LINE)}`);
    return { heading: ABOUT_HEADING, anchor: "", blocks: lines, isAbout: true };
}

// Times in a text as minutes of the day: "9 am", "18:00".
function timesInText(text) {
    return [...String(text).matchAll(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(\d{1,2}):(\d{2})\b/gi)].map(match => {
        const hour = Number(match[1] || match[4]) % (match[3] ? 12 : 24) + (/pm/i.test(match[3] || "") ? 12 : 0);
        return hour * 60 + Number(match[2] || match[5] || 0);
    });
}

// A fact in the metadata that the visible page contradicts: the page is what visitors see, so its own
// details stand. Compared: phone numbers, email addresses, opening times, and how far the business reaches.
function withoutContradictedFacts(about, visibleText) {
    const digits = value => value.replace(/\D/g, "");
    const phones = (visibleText.match(PHONE_IN_TEXT) || []).map(digits);
    const emails = (visibleText.match(EMAIL_IN_TEXT) || []).map(value => value.toLowerCase());
    const onlyPlaces = [...visibleText.matchAll(ONLY_IN_PLACE)].map(match => match[1]);
    const limitedReach = onlyPlaces.length > 0 || LIMITED_REACH.test(visibleText);
    const hours = visibleText.split("\n").filter(line => /\b(?:open|opening|hours|timings?)\b/i.test(line)).flatMap(timesInText);
    const blocks = about.blocks.filter(line => {
        if (limitedReach && WIDE_REACH.test(line)) return false;
        if (line.startsWith("Areas served: ") && onlyPlaces.length && !onlyPlaces.some(place => line.includes(place))) return false;
        if (line.startsWith("Opening hours: ") && hours.length && timesInText(line).length && !timesInText(line).some(time => hours.includes(time))) return false;
        if (line.startsWith("Phone: ")) return !phones.length || phones.some(phone => phone.includes(digits(line)) || digits(line).includes(phone));
        if (line.startsWith("Email: ")) return !emails.length || emails.includes(line.slice(7).trim().toLowerCase());
        return true;
    });
    return blocks.some(line => !line.startsWith("Website title: ")) ? { ...about, blocks } : null;
}

// A grid of short buttons (or linked pictures) names what a site offers, so it stays as a list in its
// section. Menus and footers are not grids: they are removed as before.
function keepCardLabels($) {
    const groups = new Map();
    $("button, [role='button'], a").each((_, element) => {
        const $element = $(element);
        if ($element.is(NOT_A_CARD) || ($element.is("a") && !$element.find("img").length)) return;
        const label = spacedText($, element);
        if (!/\p{L}/u.test(label) || countTextWords(label) >= 4) return;
        // A card may be wrapped in one element of its own.
        const parent = element.parent;
        const key = $(parent).children().length === 1 ? parent.parent : parent;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ element, label });
    });
    for (const [parent, cards] of groups) {
        if (new Set(cards.map(card => card.label.toLowerCase())).size < CARD_LIST_MIN) continue;
        const $parent = $(parent);
        const inPageFrame = $parent.closest(FOOTER_PARTS).length ||
            ($parent.closest("header").length && !$parent.closest("header").parents("main, article, section").length);
        const named = [$parent, ...$parent.parents().toArray().map(element => $(element))]
            .some($item => NOT_A_CARD_LIST.test(`${$item.attr("class") || ""} ${$item.attr("id") || ""}`));
        if (inPageFrame || named) continue;
        const list = $("<ul></ul>");
        const seen = new Set();
        for (const { label } of cards) {
            if (!seen.has(label.toLowerCase())) list.append($("<li></li>").text(label));
            seen.add(label.toLowerCase());
        }
        $(cards[0].element).before(list);
        for (const { element } of cards) $(element).remove();
    }
}

// Forms and app controls hold facts: what can be chosen, and what a tool asks for. Only the labels and
// the listed options are read, never what is in a field.
const FORM_HEADING = "Form options";
const FORM_MAX_OPTIONS = 50;
const FORM_MAX_ACTIONS = 8;
const FORM_LABEL_MAX_WORDS = 5;
// A row of 2 to 6 short buttons or tabs is a choice between modes or options. A longer row is cards.
const FORM_MAX_ROW = 6;
const FORM_BUTTON_MAX_WORDS = 4;
const FORM_SECRET = /pass|pwd|token|csrf|captcha|otp|cvv|cvc|card|cc-|iban|ssn|secret|account.?n|upi.?pin/i;
const FORM_NO_FIELD = new Set(["hidden", "password", "submit", "button", "image", "reset", "file", "search", "radio", "checkbox"]);
const FORM_PLACEHOLDER_OPTION = /^(?:-+|please\s+)?(?:select|choose|pick)\b/i;
const FORM_PLAIN_ACTION = /^(?:submit|send|go|ok|search|reset|clear|close|cancel|next|back|previous|menu|login|log in|sign in|sign up|subscribe|join)$/i;
const FORM_LOGIN_OR_SEARCH = /(?:^|[\s_-])(?:login|log-in|signin|sign-in|signup|register|search|newsletter|subscribe)(?:[\s_-]|$)/i;

function formControlLabel($, element) {
    const $element = $(element);
    const clean = text => cleanText(text).replace(/\s*[:*]+\s*$/, "");
    const byId = id => (id ? $(`[id="${String(id).replace(/["\\]/g, "")}"]`).first() : $());
    const id = $element.attr("id");
    const forLabel = id ? $("label").filter((_, label) => $(label).attr("for") === id).first() : $();
    if (forLabel.length) return clean(spacedText($, forLabel[0]));
    const wrapped = $element.closest("label");
    if (wrapped.length) {
        const copy = wrapped.clone();
        copy.find("select, option, textarea").remove();
        return clean(copy.text());
    }
    const named = $element.attr("aria-label") || byId($element.attr("aria-labelledby")).text();
    if (named) return clean(named);
    // A label written just before the control, or before the block holding it.
    let node = $element;
    for (let level = 0; level < 3 && node.length; level++, node = node.parent()) {
        const before = node.prev();
        if (before.length) {
            // A heading names the whole part, and another control has labels of its own.
            const text = before.is("h1, h2, h3, h4, h5, h6, select, input, textarea, button") || before.find("select, input, textarea, button").length ? "" : clean(spacedText($, before[0]));
            if (/\p{L}/u.test(text) && countTextWords(text) <= FORM_LABEL_MAX_WORDS) return text;
            break;
        }
    }
    const placeholder = $element.attr("placeholder") || "";
    return /[\d@]|^e\.?g\b|^ex(?:ample)?\b/i.test(placeholder) ? "" : clean(placeholder);
}

// Rows of buttons on a page that holds a tool: [{ label, options }]. Tabs count even as a row of two.
function buttonRows($, usable) {
    const rows = new Map();
    $("main button, main [role='button'], main [role='tab'], body > * button, body > * [role='tab']").each((_, button) => {
        if (!usable(button)) return;
        const text = spacedText($, button).replace(/^\+\s*/, "");
        if (!/\p{L}/u.test(text) || countTextWords(text) > FORM_BUTTON_MAX_WORDS || FORM_PLAIN_ACTION.test(text)) return;
        const row = button.parent;
        if (!rows.has(row)) rows.set(row, new Set());
        rows.get(row).add(text);
    });
    // Buttons next to fields are that form's actions, not a row of their own.
    return [...rows].map(([row, names]) => ({ row, options: [...names] }))
        .filter(({ row, options }) => options.length >= 2 && options.length <= FORM_MAX_ROW && !$(row).children("select, input, textarea, label").length);
}

function formFacts($) {
    const visible = element => ![element, ...$(element).parents().toArray()].some(item => isHiddenElement($, item));
    const inPageFrame = element => {
        const $element = $(element);
        if ($element.closest(`nav, aside, [role='search'], [role='navigation'], ${FOOTER_PARTS}, ${SIDEBAR_PARTS}`).length) return true;
        if ($element.closest("header").length && !$element.closest("header").parents("main, article, section").length) return true;
        // A container called "tabs" is not a frame here: a tool's tabs are what is being read.
        return [$element, ...$element.parents().toArray().map(item => $(item))]
            .some($item => NOT_A_CARD_LIST.test(`${$item.attr("class") || ""} ${$item.attr("id") || ""}`.replace(/(?:^|[\s_-])(?:tab|tabs|tablist)(?=[\s_-]|$)/gi, " ")));
    };
    const isSecret = element => {
        const $element = $(element);
        return FORM_SECRET.test(`${$element.attr("name") || ""} ${$element.attr("id") || ""} ${$element.attr("autocomplete") || ""} ${formControlLabel($, element)}`);
    };
    // Reading order, to name each form after the heading before it.
    const order = $("h1, h2, h3, h4, form, select, input, textarea, [role='listbox']").toArray();
    const headingBefore = element => {
        const at = order.indexOf(element);
        for (let index = at - 1; index >= 0; index--) if (/^h[1-4]$/i.test(order[index].tagName)) return cleanText($(order[index]).text());
        return "";
    };

    // One scope per <form>, and one for the controls of an app that uses no form tag.
    const forms = $("form").toArray().filter(form => {
        const $form = $(form);
        if (inPageFrame(form) || !visible(form) || $form.find("input[type='password' i]").length) return false;
        return !FORM_LOGIN_OR_SEARCH.test(`${$form.attr("class") || ""} ${$form.attr("id") || ""} ${$form.attr("name") || ""} ${$form.attr("action") || ""}`);
    });
    const controlsOf = root => $(root).find("select, input, textarea, [role='listbox']").toArray()
        .filter(element => (root === "body" ? !$(element).closest("form").length : true) && visible(element) && !inPageFrame(element));
    const facts = [];
    const rows = buttonRows($, button => visible(button) && !inPageFrame(button));
    const inRows = new Set(rows.flatMap(({ options }) => options));
    for (const root of [...forms, "body"]) {
        const controls = controlsOf(root);
        const lines = [];
        const fields = [];
        const groups = new Map();
        for (const control of controls) {
            const $control = $(control);
            if (isSecret(control)) continue;
            const type = String($control.attr("type") || "").toLowerCase();
            if ($control.is("select, [role='listbox']")) {
                const options = $control.find("option, [role='option']").toArray()
                    .filter(option => $(option).attr("value") !== "" && !FORM_PLACEHOLDER_OPTION.test(cleanText($(option).text())))
                    .map(option => cleanText($(option).text())).filter(Boolean);
                const placeholder = $control.find("option, [role='option']").toArray().map(option => cleanText($(option).text())).find(text => FORM_PLACEHOLDER_OPTION.test(text)) || "";
                const unique = [...new Set(options)];
                if (unique.length >= 2 && unique.length <= FORM_MAX_OPTIONS) {
                    const label = formControlLabel($, control) || placeholder.replace(FORM_PLACEHOLDER_OPTION, "").replace(/^[\s:a-]*(?=\p{L})/u, "").trim() || "Options";
                    lines.push(`${label}: options ${unique.join(", ")}`);
                }
            } else if (type === "radio" || type === "checkbox") {
                const key = $control.closest("fieldset")[0] || $control.attr("name") || control;
                if (!groups.has(key)) groups.set(key, { first: control, names: [] });
                const name = formControlLabel($, control);
                if (name) groups.get(key).names.push(name);
            } else if (!FORM_NO_FIELD.has(type)) {
                const label = formControlLabel($, control);
                if (label) fields.push(label);
            }
        }
        for (const { first, names } of groups.values()) {
            if (new Set(names).size < 2) continue;
            const fieldset = $(first).closest("fieldset");
            const legend = fieldset.length ? cleanText(fieldset.find("legend").first().text()) || fieldset.attr("aria-label") : "";
            const group = $(first).closest("[role='radiogroup'], [role='group']").attr("aria-label");
            lines.push(`${legend || group || "Choices"}: options ${[...new Set(names)].join(", ")}`);
        }
        // A single field with a button is a search box or a newsletter, not a tool.
        if (!lines.length && fields.length < 2) continue;
        if (fields.length) lines.push(`Fields: ${[...new Set(fields)].join(", ")}`);
        const nearControls = root === "body" ? [...new Set(controls.flatMap(control => $(control).parents().slice(0, 3).toArray()))] : [root];
        const actions = nearControls.flatMap(part => $(part).find("button, input[type='submit' i], [role='button']").toArray())
            .filter(button => (root !== "body" || !$(button).closest("form").length) && visible(button) && !$(button).is(NOT_A_CARD) && !inPageFrame(button))
            .map(button => cleanText($(button).is("input") ? $(button).attr("value") : spacedText($, button)).replace(/^\+\s*/, ""))
            .filter(label => /\p{L}/u.test(label) && countTextWords(label) <= 5 && !FORM_PLAIN_ACTION.test(label) && !inRows.has(label));
        if (actions.length) lines.push(`Actions: ${[...new Set(actions)].slice(0, FORM_MAX_ACTIONS).join(", ")}`);
        const before = controls.length ? headingBefore(root === "body" ? controls[0] : root) : "";
        facts.push({ heading: before ? `${before}: ${FORM_HEADING.toLowerCase()}` : FORM_HEADING, anchor: "", blocks: lines, isForm: true });
    }
    // Rows that switch a tool between modes or options; on a page without a tool they are only page parts.
    if (facts.length) {
        for (const { row, options } of [...rows].reverse()) {
            const label = formControlLabel($, row);
            facts[0].blocks.unshift(label ? `${label}: options ${options.join(", ")}` : `Modes: ${options.join(", ")}`);
        }
    }
    return facts;
}

function isHiddenElement($, element) {
    const $element = $(element);
    return NOT_READ_TAGS.has(element.tagName.toLowerCase()) ||
        $element.attr("hidden") !== undefined ||
        $element.attr("aria-hidden") === "true" ||
        HIDDEN_STYLE.test($element.attr("style") || "");
}

// Cookie banners: the smallest part of the page holding a consent button and the word "cookie", or a
// part named after cookies that talks about accepting them. A bakery's "cookie-card" is neither.
function removeCookieBanners($) {
    const short = element => countTextWords(spacedText($, element)) <= COOKIE_BANNER_MAX_WORDS;
    $("button, a, [role='button']").filter((_, element) => COOKIE_CONTROL.test(cleanText($(element).text()))).each((_, control) => {
        const banner = $(control).parents().filter((_, element) => /cookie/i.test($(element).text())).first();
        if (banner.length && !banner.is("body, html, main") && short(banner[0])) banner.remove();
    });
    $("div, section, aside, dialog").filter((_, element) => {
        const name = `${$(element).attr("class") || ""} ${$(element).attr("id") || ""} ${$(element).attr("aria-label") || ""}`;
        return COOKIE_PART.test(name) && COOKIE_WORDING.test($(element).text()) && short(element);
    }).remove();
}

// Visits the page in reading order. Tags that isStructured() accepts go to onStructured; all other
// text goes to onLoose, one call for each run of text and inline tags.
function walkPageText($, parent, isStructured, onStructured, onLoose, skip = () => false) {
    let run = [];
    const flush = () => {
        if (run.length) onLoose(run);
        run = [];
    };
    const isInlineOnly = element => INLINE_TAGS.has(element.tagName.toLowerCase()) &&
        $(element).find("*").toArray().every(child => INLINE_TAGS.has(child.tagName.toLowerCase()));
    for (const node of $(parent).contents().toArray()) {
        if (node.type === "text") {
            if (cleanText(node.data)) run.push(node);
        } else if (node.type === "tag" && !isHiddenElement($, node) && !skip(node)) {
            if (isInlineOnly(node)) {
                run.push(node);
            } else {
                flush();
                if (isStructured(node)) onStructured(node);
                else walkPageText($, node, isStructured, onStructured, onLoose, skip);
            }
        }
    }
    flush();
}

// The readable text of one run, or "" when it is only menu links or decoration.
function looseRunText($, run) {
    const text = cleanText(run.map(node => node.type === "text" ? node.data : spacedText($, node)).join(" "));
    // Icons, initials and step numbers are not worth a block; a rating ("4.8") is.
    if ((text.match(/[\p{L}\p{N}]/gu) || []).length < 3 && !/\d\.\d/.test(text)) return "";
    // A card built as one big link is content; a short link inside it, or a row of them, is a menu.
    const inLink = $(run[0]).closest("a");
    if (inLink.length) return countTextWords(spacedText($, inLink[0])) < 4 ? "" : text;
    const outsideLinks = run.map(node => {
        if (node.type === "text") return node.data;
        if (node.tagName.toLowerCase() === "a") return "";
        const copy = $(node).clone();
        copy.find("a").remove();
        return copy.text();
    }).join(" ");
    if (/[\p{L}\p{N}]/u.test(outsideLinks)) return text;
    const links = run.flatMap(node => node.type === "text" ? [] : $(node).is("a") ? [node] : $(node).find("a").toArray());
    return links.every(link => countTextWords(spacedText($, link)) < 4) ? "" : text;
}

// A site-wide footer holds contact and policy text, so it is read, without its menus and legal lines.
// It is one section marked isFooter; crawlWebsite() stores the same footer only once per crawl.
function footerSection($) {
    const blocks = [];
    // "© 2026 Acme. All rights reserved • Technical Partner: Zentrix": the labelled part is a fact.
    const labelledParts = text => text.split(/\s*[•·|\n]\s*|\s+[–—-]\s+|(?<=[.!?])\s+/)
        .map(part => part.replace(FOOTER_RIGHTS, "").trim())
        .filter(part => FOOTER_LABELLED_LINE.test(part) && !FOOTER_NOISE.test(part));
    // A <footer> inside <main> is still the page's footer; one inside an article belongs to the article.
    const isPageFooter = (_, element) => !$(element).parents("article").length && !$(element).parents(FOOTER_PARTS).length &&
        ($(element).is("footer, [role='contentinfo']") || !$(element).parents("main").length);
    $(FOOTER_PARTS).filter(isPageFooter).each((_, footer) => {
        walkPageText($, footer, () => false, () => {}, run => {
            const text = looseRunText($, run);
            // "Grievance officer:" with its value in a link of its own.
            if (!text && blocks.at(-1)?.endsWith(":")) {
                blocks[blocks.length - 1] += ` ${cleanText(run.map(node => node.type === "text" ? node.data : spacedText($, node)).join(" "))}`;
                return;
            }
            if (!text || blocks.includes(text)) return;
            if (FOOTER_NOISE.test(text) && countTextWords(text) <= FOOTER_NOISE_MAX_WORDS) {
                blocks.push(...labelledParts(text));
                return;
            }
            blocks.push(text);
        }, node => /^h[1-6]$/i.test(node.tagName));
    });
    // A copyright line in a plain block after <main>, which nothing else reads.
    if ($("main").length) {
        $("body *").filter((_, element) => !$(element).closest(`main, article, nav, aside, ${FOOTER_PARTS}`).length && FOOTER_COPYRIGHT.test($(element).text()) && countTextWords(spacedText($, element)) <= FOOTER_NOISE_MAX_WORDS).each((_, element) => {
            for (const part of labelledParts(spacedText($, element))) if (!blocks.includes(part)) blocks.push(part);
        });
    }
    return blocks.length ? { heading: FOOTER_HEADING, anchor: "", blocks, isFooter: true } : null;
}

function extractSections(
    $,
    pageTitle
) {
    // A line break separates words ("EQUIPMENTS<br>AT HOME"); it stays a line break inside <pre>.
    $("br").replaceWith("\n");

    // Read before the scripts that hold JSON-LD are removed.
    const about = aboutSection($);

    removeCookieBanners($);

    // Read before forms, fields and short buttons are removed.
    const forms = formFacts($);
    // Their labels are now part of those facts; alone they are a row of loose words.
    if (forms.length) $("label, legend").remove();

    // Remove elements that normally do not belong to website knowledge.
    $(
        "script, style, noscript, nav, aside, " +
        "form, svg, iframe, canvas, input, " +
        "textarea, select, " +
        "[role='navigation'], [role='menu'], [role='menubar'], " +
        ".breadcrumb, .breadcrumbs, [aria-label*='breadcrumb' i], " +
        SIDEBAR_PARTS
    ).remove();

    // A list named as a menu, holding only links. A restaurant's "menu" list has prices: it stays.
    $("ul, ol").filter((_, element) => {
        const $list = $(element);
        const named = [$list, $list.parent()].some($item => LINK_MENU_NAME.test(`${$item.attr("class") || ""} ${$item.attr("id") || ""}`));
        if (!named) return false;
        const items = $list.children("li").toArray();
        return items.length > 0 && items.every(item => { const copy = $(item).clone(); copy.find("a").remove(); return !cleanText(copy.text()); });
    }).remove();

    keepCardLabels($);

    // Buttons: short labels ("View all") are removed. Longer ones are content, because
    // script-rendered sites build cards from them.
    $("button, [role='button']").filter((_, element) => countTextWords(spacedText($, element)) < 4).remove();

    // A crossed-out price is the old price, not a second price.
    $("del, s, strike").each((_, element) => {
        const crossedOut = cleanText($(element).text());
        if (/\d/.test(crossedOut)) $(element).text(`was ${crossedOut}`);
    });

    const footer = footerSection($);
    $("footer").remove();
    $(FOOTER_PARTS).filter((_, element) => !$(element).parents("main, article, section").length).remove();

    // Prefer the main content area, then article / role=main / body.
    let root = $("main").first();
    if (!root.length) root = $("article").first();
    if (!root.length) root = $('[role="main"]').first();
    if (!root.length) root = $("body");

    /*
        Help articles depend on structure, so it is kept as separate lines:
        - ordered-list items get their number ("1. ", respecting start=),
          bullet items get "- ", nested items are indented;
        - <pre> code (e.g. DNS records) keeps its line breaks;
        - text inside note/warning/tip boxes is prefixed "Note:" / "Warning:";
        - each heading starts a section and keeps its id as an anchor so
          source links can point to the section.
    */
    const CALLOUT_CLASS = /\b(note|notice|warning|caution|important|tip|alert|callout|admonition)\b/i;
    const calloutPrefix = element => {
        const box = $(element).parents().filter((_, el) => CALLOUT_CLASS.test($(el).attr("class") || "")).first();
        if (!box.length) return "";
        return /warning|caution|important|alert/i.test(box.attr("class")) ? "Warning: " : "Note: ";
    };
    const headingAnchor = element => {
        const $heading = $(element);
        return $heading.attr("id") ||
            $heading.find("[id]").first().attr("id") ||
            $heading.parent("section[id]").attr("id") ||
            "";
    };

    const sections = [];
    let currentSection = { heading: pageTitle || "Website", anchor: "", blocks: [] };
    const seenInSection = new Set();

    // Text outside the structured tags (prices and cards built from divs and spans) is read in its place.
    const items = [];
    const isStructured = element => {
        const $element = $(element);
        return $element.is(STRUCTURED_TAGS) && !($element.is("button") && $element.find(STRUCTURED_TAGS).length);
    };
    walkPageText($, root, isStructured, element => {
        items.push(element, ...$(element).find(STRUCTURED_TAGS).toArray());
    }, run => {
        const text = looseRunText($, run);
        if (text) items.push(calloutPrefix(run[0]) + text);
    });

    for (const item of items) {
        if (typeof item === "string") {
            const key = item.toLowerCase();
            if (!seenInSection.has(key)) {
                seenInSection.add(key);
                currentSection.blocks.push(item);
            }
            continue;
        }
        const element = item;
        const tag = element.tagName ? element.tagName.toLowerCase() : "";
        const $element = $(element);

        // A button's text is read as one block, unless its parts are headings or paragraphs
        // of their own (those are read on their own in this loop).
        if (tag === "button" && ($element.find("h1, h2, h3, h4, h5, h6, p, li, dt, dd, th, td, pre").length || $element.parents("p, li, dt, dd, th, td, pre").length)) continue;

        // Text inside a list item or code block is taken with that item or block.
        if (tag !== "li" && tag !== "pre" && $element.parents("li").length) continue;
        if (tag !== "pre" && $element.parents("pre").length) continue;

        if (/^h[1-6]$/.test(tag)) {
            const headingText = cleanText($element.text());
            if (!headingText) continue;
            if (currentSection.blocks.length > 0) sections.push(currentSection);
            currentSection = { heading: headingText, anchor: headingAnchor(element), blocks: [], level: Number(tag[1]) };
            seenInSection.clear();
            continue;
        }

        let blockText;
        if (tag === "pre") {
            blockText = $element.text()
                .split(/\r?\n/)
                .map(line => line.replace(/\s+/g, " ").trim())
                .filter(Boolean)
                .join("\n");
        } else if (tag === "li") {
            const own = $element.clone();
            own.find("ul, ol, pre").remove();
            const itemText = cleanText(own.text());
            if (!itemText) continue;
            const list = $element.parent();
            let marker = "- ";
            if (list.is("ol")) {
                const start = parseInt(list.attr("start"), 10);
                marker = `${(Number.isFinite(start) ? start : 1) + list.children("li").index(element)}. `;
            }
            blockText = "  ".repeat($element.parents("li").length) + marker + calloutPrefix(element) + itemText;
        } else {
            const plain = tag === "button" ? spacedText($, element) : cleanText($element.text());
            if (!plain) continue;
            blockText = calloutPrefix(element) + plain;
        }

        if (!blockText || blockText.replace(/[\s\d.\-:]/g, "").length < 2) continue;

        // Skip exact repeats within the same section only: identical steps in
        // different procedures ("Click Save") must be kept.
        const key = blockText.toLowerCase();
        if (seenInSection.has(key)) continue;
        seenInSection.add(key);

        currentSection.blocks.push(blockText);
    }

    if (currentSection.blocks.length > 0) sections.push(currentSection);

    // Fallback for sites that put text in plain divs: use the whole main/body
    // text only when it is clearly richer than the structured extraction.
    const countWords = countTextWords;
    const structuredWords = countWords(sections.map(section => section.blocks.join(" ")).join(" "));
    const allWords = countWords(spacedText($, root));
    // Most of the text is outside those tags (cards built from divs and spans): read all of it,
    // keeping the headings so that long pages are still split into sections.
    const finished = list => {
        const visible = [...list, ...(footer ? [footer] : [])].map(section => section.blocks.join("\n")).join("\n");
        return [...list, ...forms, footer, about && withoutContradictedFacts(about, visible)].filter(Boolean);
    };
    if ((sections.length === 0 && !forms.length) || (structuredWords < 80 && allWords > structuredWords * 2) || structuredWords < 0.4 * allWords) {
        const allText = allTextSections($, root, pageTitle);
        if (allText.length) return finished(allText);
    }

    return finished(sections);
}


// --------------------------------------------------
// CREATE SECTION-AWARE CHUNKS
// --------------------------------------------------

/*
    Chunks are built from whole blocks (paragraphs, steps, code), so a step is
    never cut in half and steps stay in order on separate lines. A long
    section becomes several chunks; the last short block of one chunk is
    repeated at the start of the next for context. Only a single block longer
    than CHUNK_SIZE words is split by words.
*/
// Readable words from a page address: "https://x.example/Online_Yoga-Classes.php"
// -> "online yoga classes". Host name, file extensions and numbers-only parts are left out.
function urlWords(url) {
    try {
        let path = new URL(url).pathname;
        try {
            path = decodeURIComponent(path);
        } catch {
            // Keep the raw path if it is not valid percent-encoding.
        }
        return path
            .replace(/\.(php|html?|aspx?|jsp|cfm)$/i, "")
            .split(/[\/_\-.+\s]+/)
            .filter(part => /[a-z]/i.test(part))
            .join(" ")
            .toLowerCase()
            .slice(0, 200);
    } catch {
        return "";
    }
}

// What a menu button shows as a list (cards of the same heading level), stored as one section named after
// the button. A card usually does not say which list it is in, and it may already be stored from another
// view, so this is the only record of "these items belong under this button". A view that replaced the page
// lists all it shows; a view that only added to the page lists what it added.
const VIEW_LIST_MIN_ITEMS = 2;
const VIEW_LIST_MAX_ITEMS = 60;
function viewListSection(label, sections, sectionsBefore, keyOf) {
    const before = new Set(sectionsBefore.map(keyOf));
    const after = new Set(sections.map(keyOf));
    const stayed = [...before].filter(key => after.has(key)).length;
    const replacedThePage = stayed * 2 <= before.size;
    const countWords = value => String(value).split(/\s+/).filter(Boolean).length;
    const cards = sections.filter(section => section.heading && section.blocks.length &&
        countWords(`${section.heading} ${section.blocks.join(" ")}`) < SHORT_SECTION_WORDS &&
        (replacedThePage || !before.has(keyOf(section))));
    const perLevel = new Map();
    for (const card of cards) perLevel.set(card.level, (perLevel.get(card.level) || 0) + 1);
    // The most common heading level is the list; on a tie, the deeper one.
    const [level, count] = [...perLevel].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] || [];
    if (!count || count < VIEW_LIST_MIN_ITEMS) return null;
    const blocks = cards.filter(card => card.level === level).slice(0, VIEW_LIST_MAX_ITEMS)
        .map(card => `${card.heading}: ${card.blocks.join(" | ").replace(/\s+/g, " ").trim()}`);
    return { heading: label, anchor: "", blocks, level: 2, isViewList: true };
}

// Before chunking, per page:
// 1. A section whose text repeats an earlier one is dropped (carousel/slider copies,
//    repeated banners), so copies cannot crowd useful sections out of search results.
// 2. Runs of consecutive short sections (price cards, plan tiles, feature boxes: a short
//    heading and one sentence each) are merged into one section, each heading kept inline
//    ("Weekly plan: …"), so related facts are stored and found together. A section of
//    normal length, or a numbered procedure, ends the run; a section with its own anchor
//    starts a new one. The merged section keeps the first heading and anchor.
function prepareSections(sections) {
    const countWords = value => String(value).split(/\s+/).filter(Boolean).length;
    const seen = new Set();
    const prepared = [];
    let previousWasShort = false;
    let previousWords = 0;

    for (const section of sections) {
        const heading = cleanText(section.heading);
        const blocks = section.blocks.map(value => String(value).replace(/\s+$/, "")).filter(value => value.trim());
        const body = blocks.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
        if (!body) continue;

        // Very short texts ("Read more") repeat legitimately under different headings.
        const key = countWords(body) >= 5 ? body : `${heading.toLowerCase()}|${body}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const words = countWords(`${heading} ${body}`);
        // Numbered steps are a complete procedure with its own heading and anchor: never merged.
        const isProcedure = blocks.some(block => /^\s*\d+[.)]\s/.test(block));
        // The footer and the About section keep their own names: the facts in them are found by these.
        const isShort = !isProcedure && !section.isFooter && !section.isAbout && !section.isForm && !section.isViewList && words < SHORT_SECTION_WORDS;
        const last = prepared[prepared.length - 1];
        // A new main heading is a new subject, unless these are tiles that happen to use it.
        const newSubject = section.level <= 2 && (words >= CARD_SECTION_WORDS || previousWords >= CARD_SECTION_WORDS);

        // A section the site gave its own anchor (#plans) starts a new group, so source
        // links still point to it.
        if (isShort && previousWasShort && !section.anchor && !newSubject && last && last.words + words <= CHUNK_SIZE) {
            if (!heading) {
                last.blocks.push(...blocks);
            } else if (/^\s*(?:[-*•]|\d+[.)])\s/.test(blocks[0])) {
                // A list or steps: heading on its own line, items unchanged.
                last.blocks.push(`${heading}:`, ...blocks);
            } else {
                last.blocks.push(`${heading}: ${blocks[0].trim()}`, ...blocks.slice(1));
            }
            last.words += words;
        } else {
            prepared.push({ heading: section.heading, anchor: section.anchor, blocks: [...blocks], words });
        }
        previousWasShort = isShort;
        previousWords = words;
    }

    return prepared;
}

// options.mergeShortSections: false keeps every section separate (PDF pages: a short
// page must not be merged into the previous page, or its page number would be lost).
function createChunks(
    sections,
    options = {}
) {
    const chunks = [];
    const countWords = value => String(value).split(/\s+/).filter(Boolean).length;

    const prepared = options.mergeShortSections === false ? sections : prepareSections(sections);
    for (const section of prepared) {
        const heading = cleanText(section.heading) || "Website information";
        const pieces = [];

        // Trim only line ends, so nested steps keep their indentation.
        for (const block of section.blocks.map(value => String(value).replace(/\s+$/, "")).filter(value => value.trim())) {
            const words = block.split(/\s+/);
            if (words.length <= CHUNK_SIZE) {
                pieces.push(block);
                continue;
            }
            for (let start = 0; start < words.length; start += CHUNK_SIZE - CHUNK_OVERLAP) {
                pieces.push(words.slice(start, start + CHUNK_SIZE).join(" "));
                if (start + CHUNK_SIZE >= words.length) break;
            }
        }

        let group = [];
        let groupWords = 0;
        const flush = () => {
            const content = group.join("\n");
            // The heading counts too: "Reset password: 1. Open... 2. Click Save." is useful.
            if (group.length && countWords(`${heading} ${content}`) >= MIN_CHUNK_WORDS) {
                chunks.push({ heading, anchor: section.anchor || "", chunk: `${heading}:\n${content}` });
            }
        };

        for (const piece of pieces) {
            const words = countWords(piece);
            if (group.length && groupWords + words > CHUNK_SIZE) {
                flush();
                const last = group[group.length - 1];
                group = countWords(last) <= CHUNK_OVERLAP ? [last] : [];
                groupWords = group.length ? countWords(last) : 0;
            }
            group.push(piece);
            groupWords += words;
        }
        flush();
    }

    return chunks;
}


// --------------------------------------------------
// ADD CRAWL CANDIDATE
// --------------------------------------------------

// backlog (optional): candidates pushed out when the candidate map is trimmed; the crawl
// refills its queue from them (refillQueue) instead of losing those pages.
function addCandidate(
    queue,
    candidateMap,
    url,
    score,
    backlog
) {

    const normalizedUrl =
        normalizeUrl(url);


    if (
        shouldSkipUrl(
            normalizedUrl
        )
    ) {

        return;
    }


    const existingScore =
        candidateMap.get(
            normalizedUrl
        );


    /*
        Keep the highest score if the same URL
        is discovered multiple times.
    */

    if (
        existingScore !== undefined &&
        existingScore >= score
    ) {

        return;
    }


    candidateMap.set(
        normalizedUrl,
        score
    );


    /*
        Rebuild queue from the candidate map.

        The queue is intentionally small, so this
        is inexpensive and keeps the crawler simple.
    */

    queue.length = 0;


    const candidates =
        Array.from(
            candidateMap.entries()
        )
            .sort(
                (a, b) =>
                    b[1] - a[1]
            )
            .slice(
                0,
                MAX_CANDIDATE_URLS
            );


    for (
        const [
            candidateUrl,
            candidateScore
        ] of candidates
    ) {

        queue.push({

            url:
                candidateUrl,

            score:
                candidateScore
        });
    }


    /*
        Prevent unbounded candidateMap growth.
    */

    if (
        candidateMap.size >
        MAX_CANDIDATE_URLS * 2
    ) {

        const kept =
            candidates;

        if (backlog) {
            const keptUrls = new Set(kept.map(([candidateUrl]) => candidateUrl));
            for (const [candidateUrl, candidateScore] of candidateMap) {
                if (!keptUrls.has(candidateUrl) && !(backlog.get(candidateUrl) >= candidateScore)) backlog.set(candidateUrl, candidateScore);
            }
        }

        candidateMap.clear();


        for (
            const [
                candidateUrl,
                candidateScore
            ] of kept
        ) {

            candidateMap.set(
                candidateUrl,
                candidateScore
            );
        }
    }
}


// The working queue holds at most MAX_CANDIDATE_URLS addresses. When it runs empty while
// candidates remain (in the candidate map or the backlog), it is rebuilt from the best of
// them, so no discovered page is left unread unless a limit stops the crawl.
function refillQueue(queue, candidateMap, backlog, isVisited) {
    for (const candidateUrl of [...candidateMap.keys()]) {
        if (isVisited(candidateUrl)) candidateMap.delete(candidateUrl);
    }
    if (!candidateMap.size && backlog.size) {
        const best = [...backlog.entries()]
            .filter(([candidateUrl]) => !isVisited(candidateUrl))
            .sort((a, b) => b[1] - a[1])
            .slice(0, MAX_CANDIDATE_URLS);
        for (const [candidateUrl] of best) backlog.delete(candidateUrl);
        for (const [candidateUrl] of [...backlog.entries()]) {
            if (isVisited(candidateUrl)) backlog.delete(candidateUrl);
        }
        for (const [candidateUrl, candidateScore] of best) candidateMap.set(candidateUrl, candidateScore);
    }
    queue.length = 0;
    for (const [candidateUrl, candidateScore] of [...candidateMap.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_CANDIDATE_URLS)) {
        queue.push({ url: candidateUrl, score: candidateScore });
    }
    return queue.length > 0;
}

// --------------------------------------------------
// CRAWL WEBSITE
// --------------------------------------------------

// --------------------------------------------------
// ROBOTS.TXT
// --------------------------------------------------

/*
    Respect the site owner's robots.txt for the "*" user agent:
    Disallow/Allow path rules with "*" and "$" wildcards; the longest
    matching rule wins and Allow wins a tie. If robots.txt is missing or
    cannot be read, every path is allowed.
*/
const ROBOTS_MAX_BYTES = 500000;

function parseRobotsTxt(body) {
    const groups = [];
    let current = null;
    let lastWasAgent = false;

    for (const rawLine of String(body).split(/\r?\n/)) {
        const line = rawLine.replace(/#.*$/, "").trim();
        const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
        if (!match) continue;

        const field = match[1].toLowerCase();
        const value = match[2].trim();

        if (field === "user-agent") {
            if (!lastWasAgent) {
                current = { agents: [], rules: [] };
                groups.push(current);
            }
            current.agents.push(value.toLowerCase());
            lastWasAgent = true;
            continue;
        }

        lastWasAgent = false;
        if (!current) continue;

        if ((field === "allow" || field === "disallow") && value) {
            current.rules.push({ allow: field === "allow", path: value });
        }
    }

    return groups
        .filter(group => group.agents.includes("*"))
        .flatMap(group => group.rules);
}

function robotsPatternMatches(pattern, path) {
    const anchored = pattern.endsWith("$");
    const body = anchored ? pattern.slice(0, -1) : pattern;
    const regex = body
        .split("*")
        .map(part => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
    return new RegExp("^" + regex + (anchored ? "$" : "")).test(path);
}

function isAllowedByRobots(rules, url) {
    const parsed = new URL(url);
    const path = parsed.pathname + parsed.search;
    let best = null;

    for (const rule of rules) {
        if (!robotsPatternMatches(rule.path, path)) continue;
        if (
            !best ||
            rule.path.length > best.path.length ||
            (rule.path.length === best.path.length && rule.allow)
        ) {
            best = rule;
        }
    }

    return !best || best.allow;
}

// Returns the "*" rules and any "Sitemap:" URLs listed in robots.txt.
async function loadRobotsRules(origin) {
    const robotsUrl = `${origin}/robots.txt`;

    try {
        const response = await pinnedRequest(robotsUrl);
        if (response.status < 200 || response.status >= 300) {
            return { rules: [], sitemaps: [] };
        }
        const text = response.body.subarray(0, ROBOTS_MAX_BYTES).toString("utf8");
        const sitemaps = [...text.matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map(match => match[1]);
        return { rules: parseRobotsTxt(text), sitemaps };
    } catch {
        return { rules: [], sitemaps: [] };
    }
}

// --------------------------------------------------
// SITEMAP DISCOVERY
// --------------------------------------------------

/*
    Reads sitemap.xml files (from robots.txt, else /sitemap.xml) to find pages
    that are not linked from the start page. Sitemap index files are followed
    one level deep. Every sitemap is fetched through pinnedRequest() (same SSRF
    and DNS-rebinding protection as page requests).
*/
const MAX_SITEMAP_FILES = 4;
const MAX_SITEMAP_URLS = 2000;

// <loc>https://…</loc>, also wrapped in CDATA as some sitemap plugins write it:
// <loc><![CDATA[https://…]]></loc>
function extractSitemapLocations(xml) {
    return [...String(xml).matchAll(/<loc>\s*(?:<!\[CDATA\[\s*([^\]<\s]+)\s*\]\]>|([^<\s]+))\s*<\/loc>/gi)]
        .map(match => (match[1] || match[2]).replace(/&amp;/g, "&").trim());
}

// Child sitemaps that list media files or attachment pages rather than content pages.
function isMediaSitemap(url) {
    try {
        return /(^|[-_/])(attachment|image|video|media)s?[-_]?sitemap/i.test(new URL(url).pathname);
    } catch {
        return false;
    }
}

async function discoverSitemapUrls(origin, robotsSitemaps) {
    const queue = robotsSitemaps.length ? [...robotsSitemaps] : [`${origin}/sitemap.xml`];
    // robots.txt names a sitemap on another domain: the site's own sitemap is read as well, first.
    // (The caller uses only same-site addresses from any sitemap.)
    if (robotsSitemaps.some(location => !isSameDomain(location, new URL(origin).hostname))) {
        queue.unshift(`${origin}/sitemap.xml`);
    }
    const seenFiles = new Set();
    const pageUrls = new Set();

    while (queue.length && seenFiles.size < MAX_SITEMAP_FILES && pageUrls.size < MAX_SITEMAP_URLS) {
        const sitemapUrl = queue.shift();
        if (seenFiles.has(sitemapUrl) || /\.gz($|\?)/i.test(sitemapUrl)) continue;
        seenFiles.add(sitemapUrl);

        let xml;
        try {
            const response = await pinnedRequest(sitemapUrl);
            if (response.status < 200 || response.status >= 300) continue;
            xml = response.body.toString("utf8");
        } catch {
            continue;
        }

        const locations = extractSitemapLocations(xml);
        if (/<sitemapindex[\s>]/i.test(xml)) {
            queue.push(...locations.filter(location => !isMediaSitemap(location)));
            continue;
        }
        for (const location of locations) {
            if (pageUrls.size >= MAX_SITEMAP_URLS) break;
            pageUrls.add(location);
        }
    }

    return { urls: [...pageUrls], filesRead: seenFiles.size };
}

// An app shell: the server's HTML has (almost) no text and loads a script that builds the page.
function isAppShell(htmlBuffer) {
    if (!htmlBuffer) return false;
    const $ = cheerio.load(htmlBuffer.toString("utf8"));
    if (!$("script[src]").length) return false;
    $("script, style, noscript").remove();
    return cleanText($("body").text()).length < APP_SHELL_MAX_TEXT;
}

// options.onlyUrls: read exactly these addresses of the website (no sitemap, no following
// links), with the same rules as a full crawl (scope, robots.txt, SSRF checks, retries).
// --------------------------------------------------
// SUPPORT EMAIL SUGGESTIONS
// --------------------------------------------------

// Addresses a website shows itself, offered in the Customise tab. Only suggestions: nothing is sent
// to them here, and the owner has to choose one and save it.
const MAX_SUPPORT_EMAIL_CANDIDATES = 5;
const MAX_SUPPORT_EMAILS_PER_PAGE = 50;
const MAX_EMAIL_SCAN_CHARS = 200000;
const PLAIN_EMAIL = /[a-z0-9._+-]{1,64}@(?:[a-z0-9-]{1,63}\.){1,8}[a-z]{2,24}/gi;
// "info [at] site.com", "info (at) site [dot] com". Only with brackets: "visit us at site.com" is ordinary text.
const BRACKETED_EMAIL = /([a-z0-9._+-]{1,64})\s*[[({]\s*at\s*[\])}]\s*((?:[a-z0-9-]{1,63}(?:\.|\s*[[({]\s*dot\s*[\])}]\s*)){1,8}[a-z]{2,24})/gi;
const VALID_FOUND_EMAIL = /^[a-z0-9_+-](?:[a-z0-9._+-]{0,62}[a-z0-9_+-])?@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
// Nobody reads these, or they are samples and file names rather than a contact address.
const NOT_A_CONTACT_LOCAL = /^(?:no-?reply|do-?not-?reply|mailer-daemon|bounces?|you|yourname|your\.name|your-?email|username|john\.?doe|jane\.?doe|[0-9a-f]{24,})$/i;
const NOT_A_CONTACT_DOMAIN = /(?:^|\.)(?:example\.(?:com|org|net)|domain\.com|email\.com|your(?:domain|site|company|website)\.com|sentry\.io|wixpress\.com)$|\.(?:example|invalid|localhost|png|jpe?g|gif|svg|webp|css|js)$/i;
const CONTACT_PAGE_NAME = /^(?:contact|contacts|contact-us|contactus|get-in-touch|reach-us|support|customer-support|enquiry|enquiries)(?:\.\w{2,5})?$/i;
const ABOUT_PAGE_NAME = /^(?:about|about-us|aboutus|company|who-we-are)(?:\.\w{2,5})?$/i;
const SUPPORT_EMAIL_ROLES = ["support", "help", "contact", "info"];
// Which evidence counts most when two addresses are otherwise equal (first = strongest).
const SUPPORT_EMAIL_SOURCES = ["structured-data", "mailto", "contact-page", "contact-section", "about-page", "about-section", "footer"];

function cleanFoundEmail(raw) {
    const value = String(raw || "").trim();
    if (value.length > 254 || !VALID_FOUND_EMAIL.test(value)) return null;
    const at = value.lastIndexOf("@");
    const local = value.slice(0, at), domain = value.slice(at + 1).toLowerCase();
    if (NOT_A_CONTACT_LOCAL.test(local) || NOT_A_CONTACT_DOMAIN.test(domain)) return null;
    return `${local}@${domain}`;
}

// Every address one page shows: { address, source, url }. Reads the untouched document (footers
// included) and never changes it.
function findSupportEmails($, pageUrl) {
    const found = [];
    const note = (raw, source) => {
        const address = cleanFoundEmail(raw);
        if (address && found.length < MAX_SUPPORT_EMAILS_PER_PAGE) found.push({ address, source, url: pageUrl });
    };

    $('a[href^="mailto:" i]').each((_, element) => {
        const target = String($(element).attr("href")).slice(7).split("?")[0];
        let decoded = target;
        try { decoded = decodeURIComponent(target); } catch { /* used as written */ }
        for (const part of decoded.split(/[,;]/)) note(part, "mailto");
    });

    // The site's own organisation and its contactPoint; never a person such as an article's author.
    const readStructured = (node, depth = 0) => {
        if (!node || typeof node !== "object" || depth > 5) return;
        if (Array.isArray(node)) {
            node.forEach(item => readStructured(item, depth + 1));
            return;
        }
        if ([].concat(node["@type"] || []).map(String).includes("Person")) return;
        const noteValue = value => {
            for (const email of [].concat(value || [])) note(String(email).replace(/^mailto:/i, ""), "structured-data");
        };
        noteValue(node.email);
        for (const point of [].concat(node.contactPoint || [])) noteValue(point?.email);
        for (const key of ["@graph", "mainEntity", "publisher", "provider"]) readStructured(node[key], depth + 1);
    };
    $('script[type="application/ld+json" i]').each((_, element) => {
        try { readStructured(JSON.parse($(element).html())); } catch { /* not valid JSON: ignored */ }
    });

    const scanText = (element, source) => {
        const copy = $(element).clone();
        copy.find("script, style, noscript, template, textarea, select").remove();
        copy.find("*").append(" ");
        const text = copy.text().slice(0, MAX_EMAIL_SCAN_CHARS);
        for (const match of text.matchAll(PLAIN_EMAIL)) note(match[0], source);
        for (const match of text.matchAll(BRACKETED_EMAIL)) {
            note(`${match[1]}@${match[2].replace(/\s*[[({]\s*dot\s*[\])}]\s*/gi, ".")}`, source);
        }
    };
    let pageName = "";
    try { pageName = new URL(pageUrl).pathname.split("/").filter(Boolean).pop() || ""; } catch { /* no page name */ }
    if (CONTACT_PAGE_NAME.test(pageName)) scanText($("body"), "contact-page");
    else if (ABOUT_PAGE_NAME.test(pageName)) scanText($("body"), "about-page");
    const scanRegions = (selector, source) => $(selector).not("html, body").slice(0, 20).each((_, element) => scanText(element, source));
    scanRegions('footer, [role="contentinfo" i], [id*="footer" i], [class*="footer" i]', "footer");
    scanRegions('[id*="contact" i], [class*="contact" i]', "contact-section");
    scanRegions('[id*="about" i], [class*="about" i]', "about-section");
    return found;
}

// The website's own domain (subdomains and parent domain included) comes first.
function isOwnEmailDomain(domain, baseHostname) {
    const base = stripWww(String(baseHostname || "").toLowerCase());
    return domain === base || domain.endsWith(`.${base}`) || (base.endsWith(`.${domain}`) && domain.includes("."));
}

// One entry per address, with its strongest evidence: own domain first, then support@, help@,
// contact@, info@, then the evidence, then the order found. At most 5.
function rankSupportEmails(found, baseHostname) {
    const roleRank = local => {
        const rank = SUPPORT_EMAIL_ROLES.indexOf(local.toLowerCase());
        return rank === -1 ? SUPPORT_EMAIL_ROLES.length : rank;
    };
    const sourceRank = source => SUPPORT_EMAIL_SOURCES.indexOf(source);
    const unique = new Map();
    found.forEach(item => {
        const key = item.address.toLowerCase();
        const known = unique.get(key);
        if (!known) unique.set(key, { ...item, order: unique.size });
        else if (sourceRank(item.source) < sourceRank(known.source)) Object.assign(known, { source: item.source, url: item.url });
    });
    return [...unique.values()].map(item => {
        const at = item.address.lastIndexOf("@");
        return { ...item, ownDomain: isOwnEmailDomain(item.address.slice(at + 1), baseHostname), role: roleRank(item.address.slice(0, at)) };
    }).sort((a, b) => Number(b.ownDomain) - Number(a.ownDomain) || a.role - b.role || sourceRank(a.source) - sourceRank(b.source) || a.order - b.order)
        .slice(0, MAX_SUPPORT_EMAIL_CANDIDATES)
        .map(({ address, source, url, ownDomain }) => ({ address, source, url, ownDomain }));
}

async function crawlWebsite(
    startUrl,
    maxPages = MAX_PAGES,
    onProgress = () => {},
    options = {}
) {
    const onlyUrls = Array.isArray(options.onlyUrls) && options.onlyUrls.length ? options.onlyUrls : null;
    if (onlyUrls) maxPages = onlyUrls.length;

    let browser = null;


    try {

        browser =
            await chromium.launch({
                headless: true
            });


        const page =
            await browser.newPage({
                // Service workers can make requests that page.route() never sees.
                serviceWorkers: "block",
                acceptDownloads: false
            });
        const clickButtons = options.buttonDiscovery === true && !onlyUrls;
        if (clickButtons) {
            // A window opened by a click is not covered by page.route(): it is closed, and every
            // request it makes is refused (page.route() takes precedence for the crawled page).
            await page.context().route("**/*", route => route.abort());
            page.context().on("page", opened => opened.close().catch(() => {}));
        }

        // page.route() does not intercept WebSockets. Close every WebSocket
        // without connecting to the target server; the crawler needs none.
        await page.routeWebSocket(/.*/, ws => ws.close());


        /*
            Reduce local laptop load.

            Images, fonts and videos aren't needed
            for text extraction, so don't download them.

            We still allow HTML, CSS and JavaScript
            because some sites need JS to render content.
        */

        let interceptedRequests = 0;
        // Final address (after redirects) of the latest page navigation; relative
        // links on that page are resolved against it.
        let lastNavigationUrl = null;
        // The real reason the last page navigation failed inside the request handler.
        let lastNavigationError = null;
        // The HTML the server sent for the latest page navigation, before any script ran.
        let lastNavigationBody = null;
        // Requests still being fetched for the current page (the app-shell wait looks at this).
        let openRequests = 0;
        let requestGeneration = 0;
        const MAX_INTERCEPTED_REQUESTS = 250;
        const MAX_REDIRECTS = 5;
        // Set when the request budget runs out; the crawl then stops and is reported as partial.
        let requestBudgetExhausted = false;
        // Scripts already downloaded in this crawl (the same files are loaded by every page
        // of a site). They are reused from memory and neither re-downloaded nor counted.
        const scriptCache = new Map();
        let scriptCacheBytes = 0;
        let reusedRequests = 0;
        // While a menu button is clicked: nothing may be sent (GET and HEAD only), and the page
        // may not move to another website.
        let clickingButton = false;
        let blockedWhileClicking = 0;
        await page.route("**/*", async route => {
            let countedGeneration = null;
            try {
                const request = route.request();
                const resourceType = request.resourceType();
                const requestUrl = request.url();
                // Text extraction needs neither images/media/fonts nor stylesheets.
                if (["image", "media", "font", "stylesheet"].includes(resourceType)) {
                    await route.abort();
                    return;
                }

                // Only the main page's text is indexed, so embedded frames (videos, maps,
                // ads, chat widgets) and everything they load are never fetched.
                if (request.frame() !== page.mainFrame()) {
                    await route.abort();
                    return;
                }

                if (clickingButton && (!["GET", "HEAD"].includes(request.method()) ||
                    (request.isNavigationRequest() && !isSameDomain(requestUrl, baseHostname)))) {
                    blockedWhileClicking += 1;
                    await route.abort();
                    return;
                }

                const isCacheableScript = resourceType === "script" && request.method() === "GET";
                if (isCacheableScript && scriptCache.has(requestUrl)) {
                    reusedRequests += 1;
                    await route.fulfill(scriptCache.get(requestUrl));
                    return;
                }

                // The budget counts only requests that are actually fetched.
                interceptedRequests += 1;
                if (interceptedRequests > MAX_INTERCEPTED_REQUESTS) {
                    requestBudgetExhausted = true;
                    await route.abort();
                    return;
                }

                // This runs for each navigation and subresource request. Every hop is
                // validated and fetched through pinnedRequest(), which connects only to
                // validated IP addresses (DNS-rebinding protection).

                // Do not use route.continue() or route.fetch(): Chromium / Playwright
                // would resolve DNS again and follow redirects themselves.
                const requestBody = request.postDataBuffer();
                countedGeneration = requestGeneration;
                openRequests += 1;
                let response = await pinnedRequest(requestUrl, {
                    method: request.method(),
                    headers: request.headers(),
                    body: requestBody
                });
                let redirects = 0;
                while (
                    response.status >= 300 &&
                    response.status < 400 &&
                    response.headers["location"]
                ) {
                    if (++redirects > MAX_REDIRECTS) {
                        throw new Error("Too many redirects.");
                    }
                    const nextUrl = new URL(
                        response.headers["location"],
                        response.url
                    ).toString();
                    // 307/308 keep the method and body; other redirects become GET.
                    const keepMethod = response.status === 307 || response.status === 308;
                    response = await pinnedRequest(nextUrl, {
                        method: keepMethod ? request.method() : "GET",
                        headers: request.headers(),
                        body: keepMethod ? requestBody : null
                    });
                }

                // The page being crawled must be HTML; never treat a PDF,
                // image or binary download as a web page. HTTP error responses (400 and
                // above) are passed to the browser as they are, whatever their content
                // type: the crawl loop then reports the real status ("HTTP 404") and
                // retries temporary errors (500, 503, ...) by its usual rules.
                const isPageNavigation =
                    request.isNavigationRequest() &&
                    request.frame() === page.mainFrame();
                const contentType = String(response.headers["content-type"] || "").toLowerCase();
                if (isPageNavigation && response.status < 400 && !/html/.test(contentType)) {
                    throw new Error("Not an HTML page.");
                }
                if (isPageNavigation) {
                    lastNavigationUrl = response.url;
                    lastNavigationBody = response.body;
                    // Redirected to a page that was already read (e.g. many template URLs
                    // redirecting to the homepage): stop here, before its scripts load.
                    // The crawl loop recognises the address and skips the page.
                    // A redirect to the same page under another form of its address (trailing
                    // slash, www.) is the page being read now: the crawl loop has already marked
                    // its key as visited, so it must not get the stub.
                    if (redirects > 0 && !isSameDomain(response.url, baseHostname)) {
                        await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title></title>" });
                        return;
                    }
                    if (redirects > 0 && pageKey(response.url) !== pageKey(requestUrl) && visitedUrls.has(pageKey(response.url))) {
                        await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title></title>" });
                        return;
                    }
                }
                const fulfilment = {
                    status: response.status,
                    headers: response.headers,
                    body: response.body
                };
                if (
                    isCacheableScript &&
                    response.status === 200 &&
                    scriptCacheBytes + response.body.length <= MAX_SCRIPT_CACHE_BYTES
                ) {
                    scriptCache.set(requestUrl, fulfilment);
                    scriptCacheBytes += response.body.length;
                }
                await route.fulfill(fulfilment);
            } catch (error) {
                // The browser only sees "blocked by client"; keep the real reason for the page
                // itself, so the crawl report shows it and transient failures can be retried.
                try {
                    const failed = route.request();
                    if (failed.isNavigationRequest() && failed.frame() === page.mainFrame()) {
                        lastNavigationError = String(error && error.message || "request failed").split("\n")[0].slice(0, 160);
                    }
                } catch {
                    // the request is gone; nothing to record
                }
                await route.abort("blockedbyclient").catch(() => {});
            } finally {
                // A request left over from an earlier page no longer counts for the current one.
                if (countedGeneration !== null && countedGeneration === requestGeneration) openRequests -= 1;
            }
        });


        const start =
            new URL(
                startUrl
            );


        const baseHostname =
            start.hostname;

        // Prefer the same protocol as the original website.
        // This prevents https sites from wasting crawl slots on
        // duplicate http versions of the same pages.
        const baseProtocol =
            start.protocol;


        const normalizedStartUrl =
            normalizeUrl(
                startUrl
            );


        /*
            Candidate queue.

            Higher-scored URLs are crawled first.
        */

        const queue = [];


        const candidateMap =
            new Map();
        const candidateBacklog = new Map();


        if (!onlyUrls) {
            addCandidate(
                queue,
                candidateMap,
                normalizedStartUrl,
                100
            );
        }


        const visitedUrls =
            new Set();

        /*
            The real address to open for each queued page. Queue keys are
            normalised (e.g. without a trailing slash) only to detect
            duplicates. Opening the normalised form can return a different
            page and breaks relative links: "general.html" on "/docs/faq/"
            means "/docs/faq/general.html", but on "/docs/faq" it means
            "/docs/general.html".
        */
        const startNavigationUrl = new URL(startUrl);
        startNavigationUrl.hash = "";
        const navigationUrls = new Map([
            [normalizedStartUrl, startNavigationUrl.toString()]
        ]);


        const pages = [];

        // URL-level crawl report: every address found (links, sitemap, redirects) and what
        // happened to it. One entry per page (www./trailing-slash variants are one page).
        // status: queued -> read | failed | skipped | not-processed; ingestWebsite later turns
        // "read" into "indexed" (with its section count) or "skipped" (no text left).
        const urlReport = new Map();
        let urlReportOverflow = 0;
        const reportKey = url => {
            try {
                return pageKey(url);
            } catch {
                return String(url);
            }
        };
        const noteUrl = (url, fields) => {
            const key = reportKey(url);
            // "source" (start / sitemap / link / redirect) says how the address was first found.
            const { source, ...update } = fields;
            let entry = urlReport.get(key);
            if (!entry) {
                if (urlReport.size >= MAX_REPORTED_CRAWL_URLS) {
                    urlReportOverflow++;
                    return null;
                }
                entry = { url: String(url), status: "queued", source: source || "link", discoveredAt: new Date().toISOString() };
                urlReport.set(key, entry);
            } else if (fields.status === "queued") {
                return entry;
            }
            Object.assign(entry, update);
            if (fields.status && fields.status !== "queued") entry.processedAt = new Date().toISOString();
            return entry;
        };
        if (onlyUrls) {
            for (const address of onlyUrls) {
                const requested = new URL(address);
                requested.hash = "";
                const cleanUrl = normalizeUrl(requested.toString());
                if (candidateMap.has(cleanUrl)) continue;
                noteUrl(cleanUrl, { source: "manual", status: "queued" });
                navigationUrls.set(cleanUrl, requested.toString());
                addCandidate(queue, candidateMap, cleanUrl, 100);
            }
        } else {
            noteUrl(normalizedStartUrl, { source: "start", status: "queued" });
        }
        // The live report: the job that runs this crawl shows it while the crawl is running.
        onProgress({ stage: "crawling", liveReport: urlReport, currentUrl: null, phase: "starting" });
        // Text fingerprint -> address, so the same page under two addresses
        // (/About-Us and /about-us, /faq and /faq/index.html) is stored once.
        const pageContent = new Map();
        // Number of read pages that link to each address (navigation links appear on every page).
        const inboundLinks = new Map();

        let pagesFailed = 0;
        // Addresses that could not be read, with the first line of the reason (crawl report).
        const failedPages = [];

        let pagesBlockedByRobots = 0;

        const robots =
            await loadRobotsRules(
                start.origin
            );
        const robotsRules = robots.rules;

        if (robotsRules.length) {
            console.log(
                `robots.txt: ${robotsRules.length} rule(s) for all crawlers`
            );
        }

        // Seed the queue from sitemaps. Pages inside the registered section
        // (the start URL's folder) are preferred over the rest of the site.
        let pagesFromSitemap = 0;
        const startFolder = startNavigationUrl.pathname.replace(/[^/]*$/, "");
        const sitemap = onlyUrls ? { urls: [], filesRead: 0 } : await discoverSitemapUrls(start.origin, robots.sitemaps);
        // Warnings for the crawl report, from what the site itself says and shows.
        const otherDomains = list => [...new Set(list.map(address => {
            try { return isSameDomain(address, baseHostname) ? null : new URL(address).hostname; } catch { return null; }
        }).filter(Boolean))];
        const warnings = [];
        const warn = (code, message) => warnings.push({ code, message });
        const supportEmailsFound = [];
        // Footers already stored in this crawl, and pages where the app-shell wait ran out.
        const footersStored = new Set();
        const pagesRequestOpen = [];
        const pagesStillChanging = [];
        if (!onlyUrls) {
            const robotsHosts = otherDomains(robots.sitemaps);
            if (robotsHosts.length) warn("robots-sitemap-other-domain", `robots.txt names a sitemap on another domain (${robotsHosts.join(", ")}). Only addresses of this website are used from it, and this website's own /sitemap.xml was read too.`);
            const sitemapHosts = otherDomains(sitemap.urls);
            if (sitemapHosts.length) warn("sitemap-other-domain", `The sitemap lists addresses on another domain (${sitemapHosts.join(", ")}). They were not crawled.`);
        }
        let startPageChecked = false;
        // Same-site links on the start page (set when it is read), and what each menu button showed.
        let startPageLinks = null;
        const buttonClicks = [];
        let appShellPages = 0;
        for (const location of sitemap.urls) {
            try {
                const candidate = new URL(location);
                candidate.hash = "";
                if (!["http:", "https:"].includes(candidate.protocol)) continue;
                const sitemapScopeReason = scopeSkipReason(candidate.toString(), baseHostname, baseProtocol);
                if (sitemapScopeReason) {
                    noteUrl(candidate.toString(), { source: "sitemap", status: "skipped", reason: sitemapScopeReason });
                    continue;
                }
                if (isEmailAddressPath(candidate.toString())) {
                    noteUrl(candidate.toString(), { source: "sitemap", status: "skipped", reason: EMAIL_ADDRESS_REASON });
                    continue;
                }
                if (!isAllowedByRobots(robotsRules, candidate.toString())) {
                    noteUrl(candidate.toString(), { source: "sitemap", status: "skipped", reason: "blocked by robots.txt" });
                    pagesBlockedByRobots++;
                    continue;
                }
                const cleanUrl = normalizeUrl(candidate.toString());
                if (shouldSkipUrl(cleanUrl)) {
                    noteUrl(cleanUrl, { source: "sitemap", status: "skipped", reason: skipReason(cleanUrl) });
                    continue;
                }
                if (candidateMap.has(cleanUrl)) continue;
                noteUrl(cleanUrl, { source: "sitemap", status: "queued" });
                if (!navigationUrls.has(cleanUrl)) {
                    navigationUrls.set(cleanUrl, candidate.toString());
                }
                const inSection = candidate.pathname.startsWith(startFolder);
                addCandidate(queue, candidateMap, cleanUrl, scoreUrl(cleanUrl) + (inSection ? 20 : -20), candidateBacklog);
                pagesFromSitemap++;
            } catch {
                // Ignore malformed sitemap entries.
            }
        }
        if (sitemap.urls.length) {
            console.log(`sitemap: ${sitemap.urls.length} URL(s) in ${sitemap.filesRead} file(s), ${pagesFromSitemap} queued`);
        }


        // Waits until no request is open and the visible text has not changed for APP_SHELL_STABLE_MS.
        const waitUntilSettled = async maxMs => {
            const started = Date.now();
            let lastLength = -1;
            let changedAt = started;
            while (Date.now() - started < maxMs) {
                await page.waitForTimeout(APP_SHELL_POLL_MS);
                const length = await page.evaluate(() => (document.body ? document.body.innerText.length : 0)).catch(() => 0);
                if (length !== lastLength || openRequests > 0) {
                    lastLength = length;
                    changedAt = Date.now();
                } else if (Date.now() - changedAt >= APP_SHELL_STABLE_MS) {
                    return true;
                }
            }
            return false;
        };

        // Lists the visible menu buttons (nav, header, footer) by label; with a label, clicks the first one.
        // Buttons in a form, submit buttons and disabled buttons are left out.
        const menuButtonsInPage = clickLabel => {
            const labelOf = element => (element.innerText || element.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
            const found = [...document.querySelectorAll('button, [role="button"], [role="link"]')].filter(element =>
                element.closest('nav, header, footer, [role="navigation"]') && !element.closest("form") &&
                !element.matches("a[href]") && element.getAttribute("type") !== "submit" &&
                !element.disabled && element.getAttribute("aria-disabled") !== "true" && element.getClientRects().length > 0);
            if (clickLabel === null) return [...new Set(found.map(labelOf).filter(label => label && label.length <= 60))];
            const target = found.find(element => labelOf(element) === clickLabel);
            if (!target) return false;
            target.click();
            return true;
        };

        // Each menu button of the start page, from a fresh load: a new address on this website is queued
        // like a link; new text on the same address is added to the start page's sections.
        const clickMenuButtons = async (openUrl, entryUrl, title) => {
            const labels = await page.evaluate(menuButtonsInPage, null).catch(() => []);
            const sectionKey = section => `${section.heading}\n${section.blocks.join("\n")}`;
            let clicks = 0;
            for (const label of labels) {
                if (ACTION_BUTTON_LABEL.test(label)) {
                    buttonClicks.push({ label, outcome: "not clicked: looks like an action" });
                    continue;
                }
                if (clicks >= MAX_BUTTON_CLICKS || requestBudgetExhausted) {
                    buttonClicks.push({ label, outcome: requestBudgetExhausted ? "not clicked: request limit" : `not clicked: at most ${MAX_BUTTON_CLICKS} clicks` });
                    continue;
                }
                clicks += 1;
                const clickStarted = Date.now();
                try {
                    requestGeneration += 1;
                    openRequests = 0;
                    await page.goto(openUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
                    await waitUntilSettled(APP_SHELL_MAX_WAIT_MS);
                    const beforeUrl = page.url();
                    const beforeText = await page.evaluate(() => (document.body ? document.body.innerText : ""));
                    const inTheView = section => !section.isFooter && !section.isAbout;
                    const sectionsBefore = extractSections(cheerio.load(await page.content()), title).filter(inTheView);
                    clickingButton = true;
                    if (!(await page.evaluate(menuButtonsInPage, label).catch(() => false))) {
                        buttonClicks.push({ label, outcome: "not found after reloading" });
                        continue;
                    }
                    await waitUntilSettled(BUTTON_CLICK_WAIT_MS);
                    const afterUrl = page.url();
                    if (pageKey(afterUrl) !== pageKey(beforeUrl)) {
                        const address = new URL(afterUrl);
                        address.hash = "";
                        const cleanUrl = normalizeUrl(address.toString());
                        const reason = scopeSkipReason(address.toString(), baseHostname, baseProtocol) ||
                            (shouldSkipUrl(cleanUrl) ? skipReason(cleanUrl) : "") ||
                            (isAllowedByRobots(robotsRules, cleanUrl) ? "" : "blocked by robots.txt");
                        if (reason) {
                            noteUrl(cleanUrl, { source: "button", status: "skipped", reason });
                            buttonClicks.push({ label, outcome: `new address skipped: ${reason}`, url: cleanUrl });
                        } else {
                            if (!visitedUrls.has(pageKey(cleanUrl))) {
                                if (!navigationUrls.has(cleanUrl)) navigationUrls.set(cleanUrl, address.toString());
                                noteUrl(cleanUrl, { source: "button", status: "queued" });
                                addCandidate(queue, candidateMap, cleanUrl, 100, candidateBacklog);
                            }
                            buttonClicks.push({ label, outcome: "new address", url: cleanUrl });
                        }
                        continue;
                    }
                    const afterText = await page.evaluate(() => (document.body ? document.body.innerText : ""));
                    if (afterText === beforeText) {
                        buttonClicks.push({ label, outcome: "nothing changed" });
                        continue;
                    }
                    let entry = pages.find(item => item.url === entryUrl);
                    const known = new Set((entry ? entry.sections : []).map(sectionKey));
                    const sectionsAfter = extractSections(cheerio.load(await page.content()), title).filter(inTheView);
                    const shown = sectionsAfter.filter(section => !known.has(sectionKey(section)));
                    const viewList = viewListSection(label, sectionsAfter, sectionsBefore, sectionKey);
                    if (viewList && !known.has(sectionKey(viewList))) shown.push(viewList);
                    if (!shown.length) {
                        buttonClicks.push({ label, outcome: "no new text" });
                        continue;
                    }
                    if (!entry) {
                        entry = { url: entryUrl, title, sections: [], isStartPage: true, pageType: getPageType(entryUrl) };
                        pages.push(entry);
                        noteUrl(entryUrl, { status: "read", title, reason: undefined });
                    }
                    entry.sections.push(...shown);
                    buttonClicks.push({ label, outcome: "new text", sections: shown.length });
                } catch (error) {
                    buttonClicks.push({ label, outcome: `error: ${String(error.message || "click failed").split("\n")[0].slice(0, 120)}` });
                } finally {
                    clickingButton = false;
                    buttonClicks[buttonClicks.length - 1].durationMs = Date.now() - clickStarted;
                }
            }
            await page.goto("about:blank").catch(() => {});
        };

        while (
            pages.length < maxPages &&
            !requestBudgetExhausted &&
            (queue.length > 0 || refillQueue(queue, candidateMap, candidateBacklog, url => visitedUrls.has(pageKey(url))))
        ) {

            /*
                Because queue is already sorted,
                the first element is the best candidate.
            */

            const candidate =
                queue.shift();


            if (!candidate) {
                continue;
            }


            const currentUrl =
                candidate.url;

            onProgress({ stage: "crawling", pagesCrawled: pages.length, pagesFailed, pageLimit: maxPages, pagesDiscovered: visitedUrls.size + candidateMap.size, currentUrl, phase: "fetching" });


            if (visitedUrls.has(pageKey(currentUrl))) {
                continue;
            }
            visitedUrls.add(pageKey(currentUrl));


            /*
                Don't retry the same candidate.
            */

            candidateMap.delete(
                currentUrl
            );


            if (
                shouldSkipUrl(
                    currentUrl
                )
            ) {

                console.log(
                    `Skipping: ${currentUrl}`
                );

                noteUrl(currentUrl, { status: "skipped", reason: skipReason(currentUrl) });
                continue;
            }

            if (
                !isAllowedByRobots(
                    robotsRules,
                    currentUrl
                )
            ) {

                console.log(
                    `Skipping (robots.txt): ${currentUrl}`
                );

                pagesBlockedByRobots++;

                noteUrl(currentUrl, { status: "skipped", reason: "blocked by robots.txt" });
                continue;
            }


            /*
                A URL must belong to the same website.
            */

            if (
                !isSameDomain(
                    currentUrl,
                    baseHostname
                )
            ) {

                noteUrl(currentUrl, { status: "skipped", reason: "outside the crawl scope (another website)" });
                continue;
            }

            // Time spent on this address (crawl report).
            const pageStartedAt = Date.now();

            try {

                console.log(
                    `Opening: ${currentUrl}`
                );


                /*
                    Do NOT wait for networkidle.

                    That is one of the reasons modern,
                    dynamic websites can take a long time.
                */

                lastNavigationUrl = null;
                lastNavigationBody = null;
                requestGeneration += 1;
                openRequests = 0;

                const targetUrl =
                    navigationUrls.get(currentUrl) || currentUrl;

                const open = async () => {
                    lastNavigationError = null;
                    try {
                        return await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
                    } catch (navigationError) {
                        // The browser was still finishing the previous (failed) page: try this page once more.
                        if (!/interrupted by another navigation/i.test(navigationError.message)) throw navigationError;
                        await page.waitForTimeout(500);
                        return page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
                    }
                };

                // Error pages ("Page not found", server errors) are not content. Transient
                // failures (timeouts, dropped connections, 408/425/429/5xx) are retried with a
                // growing pause; permanent ones (404, 403, blocked or non-HTML addresses) are not.
                // Retries are ordinary requests: they count against the request budget.
                let navigationResponse = null;
                let httpStatus = 0;
                let attempts = 0;
                for (;;) {
                    attempts += 1;
                    let failure;
                    try {
                        navigationResponse = await open();
                        httpStatus = navigationResponse ? navigationResponse.status() : 0;
                        if (navigationResponse && httpStatus < 400) break;
                        failure = new Error(`HTTP ${httpStatus || "no response"}`);
                        failure.transient = TRANSIENT_HTTP_STATUSES.has(httpStatus);
                    } catch (navigationError) {
                        // Prefer the real reason recorded by the request handler over the
                        // browser's generic "blocked by client".
                        failure = new Error(lastNavigationError || String(navigationError.message || "navigation failed").split("\n")[0]);
                        failure.transient = TRANSIENT_NETWORK_ERROR.test(failure.message);
                    }
                    const maxAttempts = /^HTTP /.test(failure.message) ? MAX_PAGE_ATTEMPTS_HTTP : MAX_PAGE_ATTEMPTS_NETWORK;
                    if (!failure.transient || attempts >= maxAttempts || requestBudgetExhausted) {
                        if (attempts > 1) failure.message = `${failure.message} (after ${attempts} attempts)`;
                        failure.attempts = attempts;
                        throw failure;
                    }
                    await page.goto("about:blank").catch(() => {});
                    await page.waitForTimeout(RETRY_BASE_DELAY_MS * attempts);
                }

                const pageUrl = lastNavigationUrl || targetUrl;

                // Redirected to another website (full crawls, chosen pages, retries and batches all
                // pass here): that content is not this website's. Nothing is stored; sections
                // indexed earlier for this address are kept by single-page and incomplete crawls.
                if (!isSameDomain(pageUrl, baseHostname)) {
                    console.log(`Redirects to another website: ${currentUrl} -> ${pageUrl}`);
                    noteUrl(currentUrl, { status: "skipped", reason: "redirects to another website", finalUrl: pageUrl, httpStatus, attempts });
                    continue;
                }

                // After redirects (e.g. www.example.com/ -> example.com/) this can be a
                // page that was already read under another address.
                const finalKey = pageKey(pageUrl);
                if (finalKey !== pageKey(currentUrl)) {
                    if (visitedUrls.has(finalKey)) {
                        console.log(`Same page as one already read (redirect): ${currentUrl} -> ${pageUrl}`);
                        noteUrl(currentUrl, { status: "skipped", reason: "redirects to a page already read", finalUrl: pageUrl });
                        continue;
                    }
                    visitedUrls.add(finalKey);
                }
                // Store pages under their final address when it is on the same website.
                const storedUrl = isSameDomain(pageUrl, baseHostname) ? normalizeUrl(pageUrl) : currentUrl;
                // The address that redirected is not a separate page: the page is reported once,
                // under the address it was stored with.
                if (reportKey(storedUrl) !== reportKey(currentUrl)) {
                    noteUrl(currentUrl, { status: "skipped", reason: "redirects to another address", finalUrl: storedUrl });
                }
                const readFields = { fetched: true, httpStatus, source: "redirect", attempts };
                onProgress({ currentUrl: storedUrl, phase: "extracting" });


                /*
                    Pages that already show real text (most help centres and
                    documentation) are read immediately. Pages that look
                    script-rendered get a short delay for their text to appear.
                */

                const readVisibleText = () => page.evaluate(
                    () => (document.body ? document.body.innerText.length : 0)
                ).catch(() => 0);
                const visibleTextLength = await readVisibleText();

                if (isAppShell(lastNavigationBody)) {
                    appShellPages += 1;
                    const waitStarted = Date.now();
                    let lastLength = visibleTextLength;
                    let changedAt = waitStarted;
                    let settled = false;
                    while (Date.now() - waitStarted < APP_SHELL_MAX_WAIT_MS) {
                        await page.waitForTimeout(APP_SHELL_POLL_MS);
                        const length = await readVisibleText();
                        if (length !== lastLength || openRequests > 0) {
                            lastLength = length;
                            changedAt = Date.now();
                        } else if (length > 0 && Date.now() - changedAt >= APP_SHELL_STABLE_MS) {
                            settled = true;
                            break;
                        }
                    }
                    if (!settled) (openRequests > 0 ? pagesRequestOpen : pagesStillChanging).push(storedUrl);
                } else if (visibleTextLength < STATIC_PAGE_MIN_TEXT) {
                    await page.waitForTimeout(
                        DYNAMIC_CONTENT_WAIT
                    );
                }


                const html =
                    await page.content();


                // Keep two separate Cheerio documents.
                // extractSections() removes nav/footer elements from
                // its document for clean knowledge extraction.
                // Link discovery must use the untouched document so
                // footer/navigation links such as Return Policy, FAQ,
                // Shipping and Support are still available to the crawler.
                const $content =
                    cheerio.load(
                        html
                    );

                const $links =
                    cheerio.load(
                        html
                    );

                // Relative links resolve against <base href> if the page sets one,
                // otherwise against the page's real address.
                let linkBase = pageUrl;
                try {
                    const baseHref = $links("base[href]").first().attr("href");
                    if (baseHref) {
                        linkBase = new URL(baseHref, pageUrl).toString();
                    }
                } catch {
                    linkBase = pageUrl;
                }

                // Pages of other websites never get here (see the redirect check above). A problem in
                // this optional step must not cost the page.
                if (!onlyUrls) {
                    try { supportEmailsFound.push(...findSupportEmails($links, storedUrl)); } catch { /* no suggestions from this page */ }
                }

                // The start page shows how the site is built (read before extraction changes anything).
                if (!onlyUrls && !startPageChecked && normalizeUrl(currentUrl) === normalizedStartUrl) {
                    startPageChecked = true;
                    const canonicalHosts = otherDomains($links('link[rel="canonical"]').map((_, element) => {
                        try { return new URL($links(element).attr("href"), pageUrl).toString(); } catch { return ""; }
                    }).get().filter(Boolean));
                    if (canonicalHosts.length) warn("canonical-other-domain", `The page's canonical address points to another domain (${canonicalHosts.join(", ")}). It was not crawled.`);
                    const samePageKey = pageKey(pageUrl);
                    const sameSiteLinks = new Set();
                    $links("a[href]").each((_, element) => {
                        try {
                            const link = new URL($links(element).attr("href"), linkBase);
                            link.hash = "";
                            if (["http:", "https:"].includes(link.protocol) && isSameDomain(link.toString(), baseHostname) && pageKey(link.toString()) !== samePageKey) {
                                sameSiteLinks.add(pageKey(link.toString()));
                            }
                        } catch {
                            // Ignore malformed links.
                        }
                    });
                    startPageLinks = sameSiteLinks.size;
                    const menuButtonElements = $links('nav button, header button, footer button, [role="navigation"] button');
                    const menuButtons = menuButtonElements.length;
                    if (sameSiteLinks.size < MENU_LINKS_MAX && menuButtons >= MENU_BUTTONS_MIN) {
                        const labels = [...new Set(menuButtonElements.map((_, element) => cleanText($links(element).text())).get().filter(label => label && label.length <= 40))];
                        const named = labels.length ? `: ${labels.slice(0, 8).join(", ")}${labels.length > 8 ? ", …" : ""}` : "";
                        warn("menu-uses-buttons", clickButtons
                            ? `The menu uses buttons, not links (${sameSiteLinks.size} link(s) to other pages, ${menuButtons} menu buttons). Its buttons were clicked to read what they show${named}.`
                            : `The menu uses buttons, not links (${sameSiteLinks.size} link(s) to other pages, ${menuButtons} menu buttons). The crawler follows links only, so what these buttons show was not read${named}. The platform admin can turn on "Click menu buttons" in Overview and re-index.`);
                    }
                }


                const title =
                    cleanText(
                        $content("title").text()
                    );


                const extracted =
                    extractSections(
                        $content,
                        title
                    );
                // The footer and metadata alone do not make a page readable, or two pages different.
                const sections = extracted.filter(section => !section.isFooter && !section.isAbout);
                const newFooters = extracted.filter(section => section.isFooter && !footersStored.has(section.blocks.join("\n")));
                const aboutSite = normalizeUrl(currentUrl) === normalizedStartUrl ? extracted.filter(section => section.isAbout) : [];


                /*
                    Keep only pages that produced
                    meaningful sections.
                */

                const contentKey = sections.length
                    ? crypto.createHash("sha256").update(sections.map(section => `${section.heading}\n${section.blocks.join("\n")}`).join("\n\n")).digest("hex")
                    : null;

                if (contentKey && pageContent.has(contentKey)) {
                    console.log(`Same content as ${pageContent.get(contentKey)}: ${storedUrl} (not stored twice)`);
                    noteUrl(storedUrl, { ...readFields, status: "skipped", reason: `same content as ${pageContent.get(contentKey)}` });
                } else if (
                    sections.length > 0
                ) {
                    pageContent.set(contentKey, storedUrl);
                    noteUrl(storedUrl, { ...readFields, status: "read", title, durationMs: Date.now() - pageStartedAt });
                    for (const section of newFooters) footersStored.add(section.blocks.join("\n"));

                    const isStartPage =
                        normalizeUrl(
                            currentUrl
                        ) ===
                        normalizedStartUrl;


                    const pageType =
                        getPageType(
                            storedUrl
                        );


                    pages.push({

                        url:
                            storedUrl,

                        title:
                            title,

                        sections:
                            [...sections, ...newFooters, ...aboutSite],

                        isStartPage:
                            isStartPage,

                        pageType:
                            pageType
                    });


                    console.log(
                        `Successfully extracted content from: ${storedUrl}`
                    );

                    console.log(
                        `Page type: ${pageType}`
                    );

                } else {

                    console.log(
                        `No useful sections found: ${currentUrl}`
                    );
                    noteUrl(storedUrl, { ...readFields, status: "skipped", reason: "no readable content on the page" });
                }


                // ----------------------------------------------
                // FIND SAME-DOMAIN LINKS
                // ----------------------------------------------

                // Each page counts once per linked address.
                const linkedFromThisPage = new Set();
                // Single-URL mode reads exactly the requested pages: links are not followed.
                if (!onlyUrls) $links("a[href]").each(
                    (_, element) => {

                        const href =
                            $links(element)
                                .attr("href");


                        if (!href) {
                            return;
                        }


                        /*
                            Anchor text helps prioritize
                            useful links.
                        */

                        const anchorText =
                            cleanText(
                                $links(element)
                                    .text()
                            );


                        try {

                            const absoluteUrl =
                                new URL(
                                    href,
                                    linkBase
                                );

                            if (isEmailAddressHref(href) || (["http:", "https:"].includes(absoluteUrl.protocol) && isEmailAddressPath(absoluteUrl.toString()))) {
                                absoluteUrl.hash = "";
                                noteUrl(absoluteUrl.toString(), { status: "skipped", reason: EMAIL_ADDRESS_REASON });
                                return;
                            }


                            if (
                                (
                                    absoluteUrl.protocol !==
                                    "http:" &&
                                    absoluteUrl.protocol !==
                                    "https:"
                                )
                            ) {

                                return;
                            }


                            // Another website, or (for an HTTPS starting site) an HTTP duplicate.
                            const linkScopeReason = scopeSkipReason(absoluteUrl.toString(), baseHostname, baseProtocol);
                            if (linkScopeReason) {
                                noteUrl(absoluteUrl.toString().split("#")[0], { status: "skipped", reason: linkScopeReason });
                                return;
                            }


                            absoluteUrl.hash =
                                "";


                            const cleanUrl =
                                normalizeUrl(
                                    absoluteUrl.toString()
                                );


                            if (
                                shouldSkipUrl(
                                    cleanUrl
                                )
                            ) {

                                noteUrl(cleanUrl, { status: "skipped", reason: skipReason(cleanUrl) });
                                return;
                            }
                            // As for sitemap entries: a disallowed link is reported at once,
                            // not left waiting in the queue (where a limit could hide why).
                            if (!visitedUrls.has(pageKey(cleanUrl)) && !isAllowedByRobots(robotsRules, cleanUrl)) {
                                const known = urlReport.get(reportKey(cleanUrl));
                                if (!known || known.status === "queued") {
                                    if (!known) pagesBlockedByRobots++;
                                    noteUrl(cleanUrl, { source: "link", status: "skipped", reason: "blocked by robots.txt" });
                                }
                                return;
                            }


                            if (visitedUrls.has(pageKey(cleanUrl))) {
                                return;
                            }


                            /*
                                Higher score =
                                higher crawl priority.
                            */

                            if (!navigationUrls.has(cleanUrl)) {
                                navigationUrls.set(cleanUrl, absoluteUrl.toString());
                            }

                            // Same section bonus as sitemap pages: a page linked from the
                            // site's own navigation must not wait behind every sitemap entry.
                            noteUrl(cleanUrl, { source: "link", status: "queued" });
                            const linkInSection = absoluteUrl.pathname.startsWith(startFolder);
                            // Pages linked from many pages (the site's menu) are its main
                            // pages: +3 for each further page linking to it, at most +12.
                            const linkKey = pageKey(cleanUrl);
                            if (!linkedFromThisPage.has(linkKey)) {
                                linkedFromThisPage.add(linkKey);
                                inboundLinks.set(linkKey, (inboundLinks.get(linkKey) || 0) + 1);
                            }
                            const navigationBonus = Math.min(12, 3 * ((inboundLinks.get(linkKey) || 1) - 1));
                            const linkScore =
                                scoreUrl(
                                    cleanUrl,
                                    anchorText
                                ) + (linkInSection ? 20 : -20) + navigationBonus;


                            addCandidate(
                                queue,
                                candidateMap,
                                cleanUrl,
                                linkScore,
                                candidateBacklog
                            );

                        } catch (
                            error
                        ) {

                            // Ignore malformed links.
                        }
                    }
                );

                if (clickButtons && startPageLinks !== null && startPageLinks < MENU_LINKS_MAX && !buttonClicks.length && normalizeUrl(currentUrl) === normalizedStartUrl) {
                    await clickMenuButtons(targetUrl, storedUrl, title);
                }


            } catch (error) {

                pagesFailed++;
                // First line only: never stack traces or long browser call logs.
                failedPages.push({ url: currentUrl, reason: String(error.message || "").split("\n")[0].slice(0, 160) });
                const failedStatus = String(error.message || "").match(/^HTTP (\d{3})/);
                if (requestBudgetExhausted) {
                    // Our own request limit stopped this page, not the website.
                    failedPages.pop();
                    pagesFailed--;
                    noteUrl(currentUrl, { status: "not-processed", reason: "request-limit" });
                } else {
                    noteUrl(currentUrl, {
                        status: "failed",
                        reason: failedPages[failedPages.length - 1].reason,
                        attempts: error.attempts || 1,
                        durationMs: Date.now() - pageStartedAt,
                        ...(failedStatus ? { httpStatus: Number(failedStatus[1]) } : {})
                    });
                }
                // After a blocked or failed navigation the browser is still moving to its own
                // error page, which would interrupt the NEXT page's navigation. Settle first.
                await page.goto("about:blank").catch(() => {});
                console.log(
                    `Could not crawl: ${currentUrl}`
                );


                console.log(
                    error.message
                );


                /*
                    One failed page must not stop
                    the entire website crawl.
                */
            }
        }


        // The crawl is complete only if no candidate pages were left when it
        // stopped; otherwise the page limit (or the request budget) cut it short.
        if (requestBudgetExhausted) {
            console.log(`Request budget (${MAX_INTERCEPTED_REQUESTS}) used up: crawl stopped early.`);
        }

        // Pages found (links + sitemap) but never opened because the crawl stopped.
        const stillQueued = [...urlReport.values()].filter(entry => entry.status === "queued");
        const stopReason = requestBudgetExhausted
            ? "request-limit"
            : stillQueued.length ? "page-limit" : "complete";
        for (const entry of stillQueued) {
            Object.assign(entry, { status: "not-processed", reason: stopReason });
        }
        const entries = [...urlReport.values()];
        const notProcessed = entries.filter(entry => entry.status === "not-processed").map(entry => entry.url);

        if (!onlyUrls) {
            if (appShellPages) warn("js-rendered", `JS-rendered site: ${appShellPages} page(s) get their text from scripts, not from the server's HTML.`);
            const wordsRead = pages.reduce((sum, item) => sum + item.sections.reduce((n, section) => n + countTextWords(section.blocks.join(" ")), 0), 0);
            if (wordsRead < THIN_CONTENT_WORDS) warn("thin-content", `Thin content: only ${wordsRead} words were read from ${pages.length} page(s), so many questions cannot be answered.`);
            const waitLimit = `the ${APP_SHELL_MAX_WAIT_MS / 1000} s wait limit`;
            if (pagesRequestOpen.length) warn("request-timeout", `A request did not answer in time on ${pagesRequestOpen.length} page(s), so what it would have shown may be missing. They were read after ${waitLimit}. First: ${pagesRequestOpen[0]}`);
            const clicked = buttonClicks.filter(click => !/^not clicked/.test(click.outcome));
            if (clicked.length) {
                const withText = buttonClicks.filter(click => click.outcome === "new text").map(click => click.label);
                const withAddress = buttonClicks.filter(click => click.outcome === "new address").map(click => click.label);
                const skipped = buttonClicks.length - clicked.length;
                warn("menu-buttons-clicked", `Menu buttons clicked: ${clicked.length}. New text from ${withText.length}${withText.length ? ` (${withText.slice(0, 8).join(", ")})` : ""}, new page addresses from ${withAddress.length}${skipped ? `, not clicked: ${skipped}` : ""}.` +
                    (blockedWhileClicking ? ` ${blockedWhileClicking} request(s) that would have sent something or left the website were blocked.` : ""));
            }
            if (pagesStillChanging.length) warn("content-still-changing", `Content was still changing after ${waitLimit} on ${pagesStillChanging.length} page(s), so some of it may be missing. First: ${pagesStillChanging[0]}`);
        }

        const supportEmailCandidates = rankSupportEmails(supportEmailsFound, baseHostname);
        // The domain only: never a full address in the logs.
        if (supportEmailCandidates.length) console.log(`Support email candidates: ${supportEmailCandidates.length} (${[...new Set(supportEmailCandidates.map(item => item.address.slice(item.address.lastIndexOf("@") + 1)))].join(", ")})`);

        return {
            warnings,
            supportEmailCandidates,
            buttonClicks,
            blockedWhileClicking,
            pages,
            pagesFailed: entries.filter(entry => entry.status === "failed").length,
            failedPages: entries.filter(entry => entry.status === "failed").map(entry => ({ url: entry.url, reason: entry.reason })),
            pagesBlockedByRobots,
            pagesFromSitemap,
            // Every address found: indexed + failed + skipped + not processed (+ any beyond the
            // report's size limit, counted in urlReportOverflow).
            pagesDiscovered: entries.length + urlReportOverflow,
            pagesNotProcessed: notProcessed.length,
            notProcessedUrls: notProcessed.slice(0, MAX_REPORTED_URLS),
            urlReport: entries,
            urlReportOverflow,
            stopReason,
            requestsUsed: Math.min(interceptedRequests, MAX_INTERCEPTED_REQUESTS),
            requestLimit: MAX_INTERCEPTED_REQUESTS,
            requestsReused: reusedRequests,
            crawlComplete: stopReason === "complete",
            pageLimit: maxPages
        };

    } finally {

        if (browser) {

            await browser.close();
        }
    }
}


// --------------------------------------------------
// CREATE EMBEDDING
// --------------------------------------------------

async function createEmbedding(
    text
) {

    const response =
        await fetch(
            "http://localhost:11434/api/embed",
            {
                method:
                    "POST",

                headers: {
                    "Content-Type":
                        "application/json"
                },

                body:
                    JSON.stringify({
                        model: "nomic-embed-text",
                        input: text,
                        ...embeddingRequestOptions(),
                        ...(process.env.OLLAMA_KEEP_ALIVE ? { keep_alive: process.env.OLLAMA_KEEP_ALIVE } : {})
                    }),
                signal: AbortSignal.timeout(30000)
            }
        );


    if (
        !response.ok
    ) {

        const errorText =
            await response.text();


        throw new Error(
            `Embedding API error: ${response.status} ${errorText}`
        );
    }


    const data =
        await response.json();


    if (
        !data.embeddings ||
        !data.embeddings[0]
    ) {

        throw new Error(
            "Embedding API returned no embedding."
        );
    }


    return data.embeddings[0];
}


// --------------------------------------------------
// INGEST WEBSITE
// --------------------------------------------------

const EMBEDDING_MODEL = "nomic-embed-text";
const EMBEDDING_BATCH_SIZE = 16;

// Where Ollama runs the embedding model (crawling, documents and the chat question all use this).
// Measured on the development laptop (GTX 1650, 4 GB): the answer model fits completely on the GPU
// only when the embedding model runs on the CPU. Then answers are written ~2.8x faster (43 vs 15
// tokens/s) and neither model is reloaded between questions; a question's embedding still takes
// ~80 ms, a batch of 16 sections ~6 s instead of ~4.7 s, and the vectors are the same (cosine
// 0.9999997 between CPU and GPU). EMBED_NUM_GPU=auto lets Ollama decide; a number sets the GPU
// layers (0 = CPU, the default).
const EMBED_NUM_GPU = String(process.env.EMBED_NUM_GPU ?? "0").trim().toLowerCase();
function embeddingRequestOptions() {
    if (EMBED_NUM_GPU === "auto" || !/^\d+$/.test(EMBED_NUM_GPU)) return {};
    return { options: { num_gpu: Number(EMBED_NUM_GPU) } };
}

// Several texts in one Ollama request (verified identical to one-by-one embeddings).
async function createEmbeddings(texts) {
    const response = await fetch("http://localhost:11434/api/embed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            model: EMBEDDING_MODEL,
            input: texts,
            ...embeddingRequestOptions(),
            ...(process.env.OLLAMA_KEEP_ALIVE ? { keep_alive: process.env.OLLAMA_KEEP_ALIVE } : {})
        }),
        signal: AbortSignal.timeout(120000)
    });
    if (!response.ok) {
        throw new Error(`Embedding API error: ${response.status}`);
    }
    const data = await response.json();
    if (!Array.isArray(data.embeddings) || data.embeddings.length !== texts.length) {
        throw new Error("Embedding API returned an unexpected number of embeddings.");
    }
    return data.embeddings;
}

// Vectors already stored for this chatbot, keyed by content hash (for reuse).
// Single-page mode: new pages whose text is exactly the text of ANOTHER page already stored for
// this chatbot (e.g. /index.html and /). Compared: all of a page's section texts (whitespace
// normalised, order ignored, same number of sections); a page that only shares some sections is
// not a duplicate. Only this chatbot's website sections (never documents or other chatbots).
// Returns Map(new page url -> stored page url).
async function findStoredDuplicates(chatbotId, chunks) {
    const keyOf = url => {
        try {
            return pageKey(url);
        } catch {
            return String(url);
        }
    };
    const signature = texts => texts.map(text => String(text || "").replace(/\s+/g, " ").trim()).sort().join("\n\u0000\n");
    const newPages = new Map();
    for (const item of chunks) newPages.set(item.url, [...(newPages.get(item.url) || []), item.chunk]);
    const stored = new Map();
    let offset = null;
    do {
        const page = await qdrant.scroll(COLLECTION_NAME, {
            limit: 1000,
            offset: offset || undefined,
            with_payload: ["url", "chunk"],
            with_vector: false,
            filter: {
                must: [{ key: "chatbotId", match: { value: chatbotId } }],
                must_not: [{ key: "sourceType", match: { value: "document" } }]
            }
        });
        for (const point of page.points || []) {
            const url = point.payload?.url;
            if (!url) continue;
            const entry = stored.get(keyOf(url)) || { url, texts: [] };
            entry.texts.push(point.payload.chunk);
            stored.set(keyOf(url), entry);
        }
        offset = page.next_page_offset;
    } while (offset);
    const bySignature = new Map();
    for (const [key, entry] of stored) {
        if (!bySignature.has(signature(entry.texts))) bySignature.set(signature(entry.texts), { key, url: entry.url });
    }
    const duplicates = new Map();
    for (const [url, texts] of newPages) {
        const match = bySignature.get(signature(texts));
        if (match && match.key !== keyOf(url)) duplicates.set(url, match.url);
    }
    return duplicates;
}

async function loadExistingVectors(chatbotId) {
    const vectors = new Map();
    let offset = null;
    do {
        const page = await qdrant.scroll(COLLECTION_NAME, {
            filter: { must: [{ key: "chatbotId", match: { value: chatbotId } }] },
            limit: 256,
            offset: offset ?? undefined,
            with_payload: ["contentHash"],
            with_vector: true
        });
        for (const point of page.points || []) {
            if (point.payload?.contentHash && Array.isArray(point.vector)) {
                vectors.set(point.payload.contentHash, point.vector);
            }
        }
        offset = page.next_page_offset ?? null;
    } while (offset !== null);
    return vectors;
}

async function ingestWebsite(
    url,
    chatbotId,
    options = {}
) {
    const maxPages = clampPageLimit(options.maxPages, MAX_PAGES);
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};    
    if (!chatbotId) {
        throw new Error(
            "A registered chatbot ID is required for ingestion."
        );
    }

    if (!url) {

        throw new Error(
            "Website URL is required."
        );
    }


    const parsedUrl =
        new URL(
            url
        );


    if (
        parsedUrl.protocol !==
            "http:" &&
        parsedUrl.protocol !==
            "https:"
    ) {

        throw new Error(
            "Only HTTP and HTTPS URLs are supported."
        );
    }


    await assertPublicHttpUrl(url);

    const normalizedUrl =
        normalizeUrl(
            url
        );


    const siteId =
        parsedUrl.hostname;


    console.log(
        `Site ID: ${siteId}`
    );


    // --------------------------------------------------
    // CRAWL WEBSITE FIRST
    // --------------------------------------------------

    console.log(
        `\nStarting website crawl: ${normalizedUrl}`
    );


    const crawlStarted = Date.now();
    const crawl =
        await crawlWebsite(
            url,
            maxPages,
            options.onProgress,
            { onlyUrls: options.onlyUrls, buttonDiscovery: options.buttonDiscovery === true }
        );


    const { pages, pagesFailed, pagesBlockedByRobots, pagesFromSitemap, crawlComplete, pageLimit } = crawl;
    const crawlMs = Date.now() - crawlStarted;

    console.log(
        `\nPages crawled: ${pages.length}`
    );


    // --------------------------------------------------
    // CREATE CHUNKS
    // --------------------------------------------------

    const allChunks = [];


    const globalChunkSet =
        new Set();


    let usefulPages = 0;


    pages.forEach(
        page => {

            const chunks =
                createChunks(
                    page.sections
                );


            if (
                chunks.length === 0
            ) {

                return;
            }


            usefulPages++;


            chunks.forEach(
                item => {

                    /*
                        Include URL + heading in
                        duplicate detection.

                        This prevents identical global
                        text from being duplicated while
                        still allowing the same text on
                        different pages when appropriate.
                    */

                    const normalizedChunk =
                        item.chunk
                            .replace(/\s+/g, " ")
                            .trim()
                            .toLowerCase();


                    const duplicateKey =
                        `${normalizeUrl(page.url)}|${normalizedChunk}`;


                    if (
                        globalChunkSet.has(
                            duplicateKey
                        )
                    ) {

                        return;
                    }


                    globalChunkSet.add(
                        duplicateKey
                    );


                    allChunks.push({

                        url:
                            normalizeUrl(
                                page.url
                            ),

                        title:
                            page.title,

                        heading:
                            item.heading,

                        chunk:
                            item.chunk,
                        anchor:
                            item.anchor || "",
                        isStartPage:
                            page.isStartPage,

                        pageType:
                            page.pageType
                    });
                }
            );
        }
    );


    console.log(
        `Useful pages: ${usefulPages}`
    );


    console.log(
        `Total chunks: ${allChunks.length}`
    );


    // --------------------------------------------------
    // IMPORTANT:
    // DO NOT DELETE OLD DATA IF CRAWL FAILED
    // --------------------------------------------------

    const onlyUrls = Array.isArray(options.onlyUrls) && options.onlyUrls.length ? options.onlyUrls : null;
    if (onlyUrls && allChunks.length) {
        // A chosen page with exactly the text of another stored page is not stored again; the
        // stored page is not touched.
        const duplicates = await findStoredDuplicates(chatbotId, allChunks);
        if (duplicates.size) {
            const kept = allChunks.filter(item => !duplicates.has(item.url));
            allChunks.length = 0;
            allChunks.push(...kept);
            for (const [url, storedUrl] of duplicates) {
                const entry = crawl.urlReport.find(item => item.status === "read" && pageKey(item.url) === pageKey(url));
                if (entry) Object.assign(entry, { status: "skipped", reason: `same content as ${storedUrl}` });
            }
        }
    }
    if (onlyUrls && allChunks.length === 0) {
        // Single-URL mode: the requested pages failed or had no usable text. Their existing
        // sections are kept; the report says what happened to each page.
        for (const entry of crawl.urlReport) {
            if (entry.status === "read") Object.assign(entry, { status: "skipped", reason: "no text long enough to store" });
        }
        return {
            chatbotId, onlyUrls: true, pagesCrawled: pages.length, usefulPages: 0, pagesFailed, chunksStored: 0,
            urlReport: crawl.urlReport, crawlCounts: null, stopReason: crawl.stopReason, embeddingsReused: 0,
            timings: { crawlMs, embedMs: 0, storeMs: 0 }
        };
    }
    if (
        allChunks.length === 0
    ) {

        throw new Error(
            pagesBlockedByRobots > 0
                ? "No useful content could be indexed: the website's robots.txt does not allow crawling these pages. Existing indexed data was not deleted."
                : "No useful content found on the website. Existing indexed data was not deleted."
        );
    }


    // --------------------------------------------------
    // CREATE EMBEDDINGS
    // --------------------------------------------------

    /*
        Unchanged chunks reuse the vector already stored for this chatbot
        (matched by a hash of the exact text that was embedded). New or changed
        chunks are embedded in batches, one request at a time.
    */
    const embedStarted = Date.now();
    // Crawl report: final status of every page that was read (indexed with its sections, or
    // skipped when no usable text was left).
    markIndexedPages(crawl.urlReport, allChunks);
    const countStatus = status => crawl.urlReport.filter(entry => entry.status === status).length;
    const crawlCounts = {
        discovered: crawl.pagesDiscovered,
        read: crawl.urlReport.filter(entry => entry.fetched).length,
        indexed: countStatus("indexed"),
        failed: countStatus("failed"),
        skipped: countStatus("skipped"),
        notProcessed: countStatus("not-processed"),
        notListed: crawl.urlReportOverflow
    };

    // The page address often names the topic better than a generic site-wide <title>
    // (".../online-yoga-classes.php" vs "Home | Studio"), so its words are embedded too.
    const embeddingTextFor = item => `
Page title:
${item.title}

Page address:
${urlWords(item.url)}

Page type:
${item.pageType}

Section:
${item.heading}

Content:
${item.chunk}
`;
    const hashFor = value => crypto.createHash("sha256").update(`${EMBEDDING_MODEL}\n${value}`).digest("hex");

    onProgress({ stage: "embedding", pagesCrawled: pages.length, pagesFailed, embedded: 0, toEmbed: 0 });
    const existingVectors = await loadExistingVectors(chatbotId);
    const vectors = new Array(allChunks.length);
    const hashes = allChunks.map(item => hashFor(embeddingTextFor(item)));
    const toEmbed = [];

    hashes.forEach((hash, index) => {
        if (existingVectors.has(hash)) {
            vectors[index] = existingVectors.get(hash);
        } else {
            toEmbed.push(index);
        }
    });

    for (let start = 0; start < toEmbed.length; start += EMBEDDING_BATCH_SIZE) {
        const batch = toEmbed.slice(start, start + EMBEDDING_BATCH_SIZE);
        console.log(`Creating embeddings ${start + 1}-${start + batch.length}/${toEmbed.length}...`);
        const embeddings = await createEmbeddings(batch.map(index => embeddingTextFor(allChunks[index])));
        onProgress({ stage: "embedding", embedded: start + batch.length, toEmbed: toEmbed.length });
        batch.forEach((index, position) => {
            vectors[index] = embeddings[position];
        });
    }

    const points = allChunks.map((item, index) => ({
        id: crypto.randomUUID(),
        vector: vectors[index],
        payload: {
            siteId,
            url: item.url,
            title: item.title,
            heading: item.heading,
            anchor: item.anchor || "",
            chunk: item.chunk,
            isStartPage: item.isStartPage,
            pageType: item.pageType,
            sourceType: "website",
            chatbotId,
            contentHash: hashes[index]
        }
    }));

    const embedMs = Date.now() - embedStarted;
    const embeddingsReused = allChunks.length - toEmbed.length;
    console.log(`Embeddings: ${toEmbed.length} created, ${embeddingsReused} reused (unchanged).`);

    // --------------------------------------------------
    // ONLY NOW REPLACE OLD DATA
    // --------------------------------------------------

    // Write the new points first, then delete this chatbot's older points.
    // If the write fails, the previous knowledge is still intact.
    console.log(
        `\nStoring ${points.length} points for: ${siteId}`
    );

    onProgress({ stage: "saving" });
    const storeStarted = Date.now();
    // Single-URL mode: only the pages that produced new sections are replaced; the rest of the
    // website, requested pages that failed now, and uploaded documents keep their sections.
    // Sections stored earlier under the other form of a page's address (www. or not) are the
    // same page: they are counted and replaced too.
    // Stale sections of pages this crawl did not store are removed only after a COMPLETE full
    // crawl. Single-page crawls and full crawls stopped by a limit replace only the pages they
    // stored; every other page keeps its sections.
    const replaceStoredPagesOnly = Boolean(onlyUrls) || !crawl.crawlComplete;
    const replacedPages = replaceStoredPagesOnly ? [...new Set(allChunks.map(item => item.url))] : null;
    const replacedUrls = replacedPages ? [...new Set(replacedPages.flatMap(pageUrlForms))] : null;
    if (onlyUrls) {
        for (const pageUrl of replacedPages) {
            const before = await qdrant.count(COLLECTION_NAME, {
                exact: true,
                filter: {
                    must: [{ key: "chatbotId", match: { value: chatbotId } }, { key: "url", match: { any: pageUrlForms(pageUrl) } }],
                    must_not: [{ key: "sourceType", match: { value: "document" } }]
                }
            });
            const indexes = allChunks.map((item, index) => (item.url === pageUrl ? index : -1)).filter(index => index >= 0);
            const unchanged = before.count === indexes.length && indexes.every(index => existingVectors.has(hashes[index]));
            const entry = crawl.urlReport.find(item => pageKey(item.url) === pageKey(pageUrl));
            if (entry) entry.upToDate = unchanged;
        }
    }

    await qdrant.upsert(
        COLLECTION_NAME,
        {
            wait: true,
            points
        }
    );

    await qdrant.delete(
        COLLECTION_NAME,
        {
            wait: true,
            filter: {
                must: [
                    { key: "chatbotId", match: { value: chatbotId } },
                    ...(replacedUrls ? [{ key: "url", match: { any: replacedUrls } }] : [])
                ],
                // Only this chatbot's stale WEBSITE sections: uploaded documents are managed
                // separately and must survive a website re-index.
                must_not: [
                    { has_id: points.map(point => point.id) },
                    { key: "sourceType", match: { value: "document" } }
                ]
            }
        }
    );

    const storeMs = Date.now() - storeStarted;
    // Website sections in the index after this run (kept pages included).
    const sectionsInIndex = (await qdrant.count(COLLECTION_NAME, {
        exact: true,
        filter: {
            must: [{ key: "chatbotId", match: { value: chatbotId } }],
            must_not: [{ key: "sourceType", match: { value: "document" } }]
        }
    })).count;

    console.log(
        `Stale data removed for: ${siteId}`
    );

    // --------------------------------------------------
    // RETURN RESULT
    // --------------------------------------------------

    return {
        siteId,
        chatbotId,
        pagesCrawled: pages.length,
        usefulPages,
        pagesFailed,
        pagesBlockedByRobots,
        pagesFromSitemap,
        crawlComplete,
        pageLimit,
        // Crawl report: what was found, what was read, and why the crawl stopped.
        pagesDiscovered: crawl.pagesDiscovered,
        pagesNotProcessed: crawl.pagesNotProcessed,
        stopReason: crawl.stopReason,
        requestsUsed: crawl.requestsUsed,
        requestLimit: crawl.requestLimit,
        requestsReused: crawl.requestsReused,
        // Separate, reconciling counts: discovered = indexed + failed + skipped + notProcessed
        // (+ notListed); read = pages actually fetched (indexed + skipped-after-reading).
        pagesIndexed: crawlCounts.indexed,
        crawlCounts,
        urlReport: crawl.urlReport,
        crawlReport: {
            counts: crawlCounts,
            indexedUrls: crawl.urlReport.filter(entry => entry.status === "indexed").map(entry => entry.url).slice(0, 100),
            failedPages: crawl.failedPages.slice(0, 100),
            notProcessedUrls: crawl.notProcessedUrls,
            warnings: crawl.warnings,
            supportEmailCandidates: crawl.supportEmailCandidates,
            ...(crawl.buttonClicks.length ? { buttonClicks: crawl.buttonClicks.slice(0, 40) } : {})
        },
        chunksStored: allChunks.length,
        sectionsInIndex,
        onlyUrls: Boolean(onlyUrls),
        embeddingsReused,
        timings: { crawlMs, embedMs, storeMs }
    };
}

// --------------------------------------------------
// EXPORT
// --------------------------------------------------

module.exports = {
    ingestWebsite,
    MAX_PAGES_LIMIT,
    // The dashboard's single-URL crawl checks addresses with the crawler's own website rule.
    isSameDomain,
    pageKey,
    pageUrlForms,
    markIndexedPages,
    reconcileCrawlRows,
    isEmailAddressHref,
    isEmailAddressPath,
    findSupportEmails,
    rankSupportEmails,
    scopeSkipReason,
    // The chat question is embedded with the same model placement as the indexed text.
    embeddingRequestOptions,
    // Shared with documents.js: uploaded documents use the same extraction, chunking and embeddings.
    extractSections,
    ABOUT_HEADING,
    createChunks,
    createEmbeddings,
    cleanText
};


// --------------------------------------------------
// DIRECT COMMAND-LINE USAGE
// --------------------------------------------------

if (
    require.main === module
) {

    const url =
        process.argv[2];


    if (!url) {

        console.error(
            "Usage: node ingest.js \"WEBSITE_URL\""
        );

        process.exit(
            1
        );
    }


    ingestWebsite(
        url
    )

        .then(
            result => {

                console.log(
                    "\nIngestion complete!"
                );


                console.log(
                    result
                );
            }
        )

        .catch(
            error => {

                console.error(
                    "\nIngestion error:"
                );


                console.error(
                    error.message
                );


                process.exit(
                    1
                );
            }
        );
}