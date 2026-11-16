// HTTP checks that need no LLM call. Needs a running server.
// Run: npm run test:http   (TEST_BASE_URL defaults to http://localhost:3000;
// the admin key is read from ADMIN_API_KEY / .env and never printed).
// Note: uses 1 of the 3-per-10-minutes crawl requests allowed per IP.
// Uses TEMPORARY chatbots only (registered by this test and removed at the end); no existing
// chatbot is changed or re-indexed.
const fs = require("fs"), path = require("path");
const projectDir = path.resolve(__dirname, "..");
require(path.join(projectDir, "node_modules", "dotenv")).config({ path: path.join(projectDir, ".env"), quiet: true });
const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const KEY = process.env.ADMIN_API_KEY || "";
if (KEY.length < 32) { console.error("ADMIN_API_KEY is not configured."); process.exit(1); }
const pool = require(path.join(projectDir, "dbPool"));
// A unique public test address (example.com is reserved for documentation and resolves publicly).
const RUN = require("crypto").randomUUID().slice(0, 8);
const ORG_URL = `https://example.com/http-test-${RUN}/`;
const PENDING = require("crypto").randomUUID();
let ORG = "00000000-0000-4000-8000-000000000000"; // replaced by the chatbot registered below

async function snap() {
    const rows = (await pool.query("SELECT count(*)::int n FROM chatbots")).rows[0].n;
    const q = await (await fetch(`http://localhost:6333/collections/${process.env.QDRANT_COLLECTION || "website_content"}/points/count`, { method: "POST", headers: { "Content-Type": "application/json" }, body: '{"exact":true}' })).json();
    return { rows, qdrantPoints: q.result.count };
}
async function call(method, route, { body, raw, key, headers = {} } = {}) {
    const h = { ...headers };
    if (body !== undefined || raw !== undefined) h["Content-Type"] = "application/json";
    if (key !== undefined) h["x-admin-api-key"] = key;
    const r = await fetch(BASE + route, { method, headers: h, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    return { status: r.status, text, h: r.headers };
}
const rows = [];
function check(name, r, ok, extra = "") {
    const leaks = [];
    if (r.text.includes(KEY)) leaks.push("ADMIN KEY");
    if (/at .+\(.*:\d+:\d+\)|C:\\\\|C:\\Users|node_modules|SyntaxError|invalid input syntax|Ollama generation|LLM API error|Embedding API/i.test(r.text)) leaks.push("INTERNAL DETAIL");
    if (/"details"/.test(r.text) && !name.startsWith("ADMIN")) leaks.push("details field");
    const pass = ok && !leaks.length;
    rows.push({ test: name, http: r.status, result: pass ? "PASS" : "FAIL", note: (leaks.length ? "LEAK: " + leaks.join(",") + " " : "") + extra + " " + r.text.slice(0, 70).replace(/\s+/g, " ") });
}
const json = r => { try { return JSON.parse(r.text); } catch { return null; } };

(async () => {
    const before = await snap();
    let r;

    // ---- temporary chatbots ----
    r = await call("POST", "/api/register", { body: { websiteUrl: ORG_URL }, key: KEY });
    ORG = json(r)?.chatbotId || ORG;
    check("ADMIN register: new URL creates a chatbot", r, r.status === 201 || (r.status === 200 && json(r)?.existing === false), ORG_URL);
    // "Already indexed": ready, with one synthetic start-page section of its own.
    await pool.query("UPDATE chatbots SET status = 'ready' WHERE id = $1 AND website_url = $2", [ORG, ORG_URL]);
    await fetch(`http://localhost:6333/collections/${process.env.QDRANT_COLLECTION || "website_content"}/points?wait=true`, {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: [{ id: require("crypto").randomUUID(), vector: Array.from({ length: 768 }, (_, i) => (i === 0 ? 1 : 0)),
            payload: { chatbotId: ORG, url: ORG_URL.replace(/\/$/, ""), title: "HTTP test", heading: "Test", chunk: "Test:\nSynthetic section for the HTTP test.", isStartPage: true, pageType: "content" } }] })
    });
    await pool.query("INSERT INTO chatbots (id, website_url, allowed_domain, status) VALUES ($1, $2, 'example.com', 'pending')", [PENDING, `https://example.com/http-test-${RUN}-pending/`]);

    // ---- health / headers / CORS ----
    r = await call("GET", "/api/health"); const hj = json(r);
    check("health: all dependencies ok", r, r.status === 200 && hj?.qdrant === "ok" && hj?.ollama === "ok" && hj?.database === "ok");
    check("no X-Powered-By header", r, !r.h.get("x-powered-by"));
    check("nosniff header", r, r.h.get("x-content-type-options") === "nosniff");
    r = await call("OPTIONS", "/api/chat", { headers: { Origin: "https://customer.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } });
    check("CORS preflight /api/chat allowed (any origin)", r, r.status === 204 && r.h.get("access-control-allow-origin") === "*");
    r = await call("OPTIONS", "/api/register", { headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,x-admin-api-key" } });
    check("CORS preflight /api/register: no CORS headers", r, r.status === 204 && !r.h.get("access-control-allow-origin") && !r.h.get("access-control-allow-headers"));
    r = await call("OPTIONS", "/api/website", { headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
    check("CORS preflight /api/website: no CORS headers", r, r.status === 204 && !r.h.get("access-control-allow-origin"));

    // ---- static allowlist ----
    for (const [route, expect, extraCheck] of [
        ["/", 200, x => x.h.get("x-frame-options") === "DENY"],
        ["/index.html", 200, x => x.h.get("x-frame-options") === "DENY"],
        ["/widget.js", 200, x => x.h.get("access-control-allow-origin") === "*" && !x.h.get("x-frame-options") && /javascript/.test(x.h.get("content-type"))],
        ["/widget.html", 200, x => !x.h.get("x-frame-options")],
        ["/widget.before-chatbot-id.js", 404], ["/widget.before-chatbot-id.html", 404],
        ["/index.before-admin-auth-20261015-012519.html", 404], ["/index.before-hardening-20261015-015103.html", 404],
        ["/widget-test.html", 404], ["/.env", 404], ["/server.js", 404], ["/%2e%2e/.env", 404], ["/backups/qdrant-2026-10-15/points.json", 404],
    ]) {
        r = await call("GET", route);
        check(`GET ${route}`, r, r.status === expect && (!extraCheck || extraCheck(r)) && (expect !== 404 || json(r)?.error === "Not found."));
    }

    // ---- malformed / oversized bodies ----
    r = await call("POST", "/api/chat", { raw: '{"chatbotId":' }); check("chat: malformed JSON -> safe JSON 400", r, r.status === 400 && json(r)?.error === "Request body must be valid JSON.");
    r = await call("POST", "/api/register", { raw: "{" }); check("register: malformed JSON -> safe JSON 400", r, r.status === 400 && !!json(r));
    r = await call("POST", "/api/chat", { raw: JSON.stringify({ chatbotId: ORG, question: "x".repeat(40000) }) }); check("chat: 40 KB body -> 413", r, r.status === 413 && !!json(r));

    // ---- chat validation (all before any DB/embedding/LLM work) ----
    const chatCases = [
        ["chat: missing chatbotId", { question: "hi" }, 400],
        ["chat: chatbotId not a UUID", { chatbotId: "abc", question: "hi" }, 400],
        ["chat: chatbotId is an object", { chatbotId: { x: 1 }, question: "hi" }, 400],
        ["chat: SQL-ish chatbotId", { chatbotId: ORG + "' OR 1=1", question: "hi" }, 400],
        ["chat: missing question", { chatbotId: ORG }, 400],
        ["chat: question is an object", { chatbotId: ORG, question: { a: 1 } }, 400],
        ["chat: question is a number", { chatbotId: ORG, question: 42 }, 400],
        ["chat: whitespace-only question", { chatbotId: ORG, question: "   \n " }, 400],
        ["chat: 501-char question", { chatbotId: ORG, question: "a".repeat(501) }, 400],
        ["chat: unknown chatbot", { chatbotId: "00000000-0000-0000-0000-000000000000", question: "hi" }, 404],
        ["chat: chatbot not ready (pending)", { chatbotId: PENDING, question: "hi" }, 409],
    ];
    for (const [name, body, status] of chatCases) { r = await call("POST", "/api/chat", { body }); check(name, r, r.status === status); }
    r = await call("POST", "/api/chat", { raw: "[1,2]" }); check("chat: JSON array body", r, r.status === 400);
    r = await call("GET", "/api/nope"); check("unknown route -> JSON 404", r, r.status === 404 && json(r)?.error === "Not found.");

    // ---- admin ----
    r = await call("POST", "/api/register", { body: { websiteUrl: "https://example.org/" } }); check("ADMIN register: no key", r, r.status === 401);
    r = await call("POST", "/api/register", { body: { websiteUrl: "https://example.org/" }, key: "wrong-" + "0".repeat(60) }); check("ADMIN register: wrong key", r, r.status === 403);
    r = await call("POST", "/api/register", { body: { websiteUrl: ORG_URL }, key: KEY });
    check("ADMIN register: existing URL returns existing chatbot (no insert)", r, r.status === 200 && json(r)?.existing === true && json(r)?.chatbotId === ORG);
    r = await call("POST", "/api/register", { body: { websiteUrl: "https://example.org:8080/" }, key: KEY }); check("ADMIN register: port 8080 rejected", r, r.status === 400 && /standard ports/.test(r.text));
    r = await call("POST", "/api/register", { body: { websiteUrl: "http://[64:ff9b::7f00:1]/" }, key: KEY }); check("ADMIN register: NAT64 loopback rejected", r, r.status === 400);
    r = await call("POST", "/api/register", { body: { websiteUrl: 12345 }, key: KEY }); check("ADMIN register: non-string URL", r, r.status === 400);
    r = await call("POST", "/api/website", { body: { chatbotId: "nope" }, key: KEY }); check("ADMIN website: bad chatbotId", r, r.status === 400);
    r = await call("POST", "/api/website", { body: {}, key: KEY }); check("ADMIN website: empty body", r, r.status === 400);
    // Background indexing: 202 at once, then the job is visible in the dashboard API.
    // (An already-indexed chatbot without "reindex": the job finishes immediately.)
    r = await call("POST", "/api/website", { body: { chatbotId: ORG, async: true }, key: KEY });
    check("ADMIN website: async indexing returns 202", r, r.status === 202 && json(r)?.started === true);
    await new Promise(resolve => setTimeout(resolve, 1500));
    r = await call("GET", `/api/admin/chatbots/${ORG}`, { key: KEY });
    check("ADMIN job progress visible (reused existing knowledge)", r, r.status === 200 && json(r)?.chatbot?.progress?.state === "done" && /reused/i.test(json(r)?.chatbot?.progress?.message || ""));
    // Rejected crawl requests (400/404/409) start no work and do not use up the 3-per-10-minutes crawl quota.
    const rejected = [];
    for (let i = 0; i < 3; i++) rejected.push((await call("POST", "/api/website", { body: { chatbotId: "nope" }, key: KEY })).status);
    check("ADMIN website: rejected requests do not use the crawl quota", r, rejected.every(status => status === 400), rejected.join(","));

    // ---- Dashboard API ----
    r = await call("GET", "/api/admin/chatbots"); check("ADMIN list chatbots: no key", r, r.status === 401);
    r = await call("GET", "/api/admin/chatbots", { key: "wrong-" + "0".repeat(60) }); check("ADMIN list chatbots: wrong key", r, r.status === 403);
    r = await call("GET", "/api/admin/chatbots", { key: KEY });
    const listed = json(r)?.chatbots || [];
    const org = listed.find(bot => bot.id === ORG);
    check("ADMIN list chatbots: stats and status included", r, r.status === 200 && !!org && typeof org.stats?.chunks === "number" && typeof org.displayStatus === "string" && Array.isArray(org.settings?.allowedOrigins));
    r = await call("GET", "/api/admin/chatbots/nope", { key: KEY }); check("ADMIN chatbot detail: bad ID", r, r.status === 400);
    r = await call("GET", "/api/admin/chatbots/00000000-0000-0000-0000-000000000000", { key: KEY }); check("ADMIN chatbot detail: unknown ID", r, r.status === 404);
    r = await call("PATCH", `/api/admin/chatbots/${ORG}`, { body: { displayName: "x" } }); check("ADMIN settings: no key", r, r.status === 401);

    // Settings and origin checks use a temporary chatbot (removed below).
    const TEMP = require("crypto").randomUUID();
    await pool.query("INSERT INTO chatbots (id, website_url, allowed_domain, status) VALUES ($1, 'https://example.net/', 'example.net', 'ready')", [TEMP]);
    try {
        r = await call("PATCH", `/api/admin/chatbots/${TEMP}`, { body: { accentColor: "red" }, key: KEY }); check("ADMIN settings: bad colour rejected", r, r.status === 400);
        r = await call("PATCH", `/api/admin/chatbots/${TEMP}`, { body: { allowedOrigins: ["javascript:alert(1)"] }, key: KEY }); check("ADMIN settings: bad origin rejected", r, r.status === 400);
        r = await call("PATCH", `/api/admin/chatbots/${TEMP}`, { body: { displayName: "x".repeat(61) }, key: KEY }); check("ADMIN settings: name too long rejected", r, r.status === 400);
        r = await call("PATCH", `/api/admin/chatbots/${TEMP}`, { body: { displayName: "Help Bot", welcomeMessage: "Hi there!", accentColor: "#0F766E", allowedOrigins: ["https://allowed.example/some/path"] }, key: KEY });
        const saved = json(r)?.chatbot?.settings;
        check("ADMIN settings saved (origin normalised)", r, r.status === 200 && saved?.displayName === "Help Bot" && saved?.accentColor === "#0F766E" && saved?.allowedOrigins?.[0] === "https://allowed.example");

        r = await call("GET", `/api/chatbots/${TEMP}/config`, { headers: { Origin: "https://anywhere.example" } });
        check("widget config: public, CORS, settings only", r, r.status === 200 && r.h.get("access-control-allow-origin") === "*" && json(r)?.displayName === "Help Bot" && json(r)?.welcomeMessage === "Hi there!" && !/allowed\.example|website_url|example\.net/.test(r.text));
        r = await call("GET", "/api/chatbots/nope/config"); check("widget config: bad ID", r, r.status === 400);
        r = await call("GET", "/api/chatbots/00000000-0000-0000-0000-000000000000/config"); check("widget config: unknown ID", r, r.status === 404);

        r = await call("POST", "/api/chat", { body: { chatbotId: TEMP, question: "hello" }, headers: { Origin: "https://evil.example" } });
        check("chat: website not in allowed list -> 403", r, r.status === 403 && /not enabled for this website/.test(r.text));
        r = await call("POST", "/api/chat", { body: { chatbotId: TEMP, question: "hello" }, headers: { Origin: "https://allowed.example" } });
        check("chat: allowed website accepted", r, r.status === 200);
        r = await call("POST", "/api/chat", { body: { chatbotId: TEMP, question: "hello" } });
        check("chat: no Origin (not a browser embed) accepted", r, r.status === 200);
    } finally {
        await pool.query("DELETE FROM chatbots WHERE id = $1", [TEMP]);
    }

    // Only what this run created: its two temporary chatbots (checked by ID and address) and their points.
    await pool.query("DELETE FROM chatbots WHERE id = ANY($1::uuid[]) AND website_url LIKE $2", [[ORG, PENDING], `https://example.com/http-test-${RUN}%`]);
    await fetch(`http://localhost:6333/collections/${process.env.QDRANT_COLLECTION || "website_content"}/points/delete?wait=true`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filter: { must: [{ key: "chatbotId", match: { value: ORG } }] } })
    });
    const after = await snap();
    rows.push({ test: "no DB rows / Qdrant points added or removed", http: "-", result: JSON.stringify(before) === JSON.stringify(after) ? "PASS" : "FAIL", note: `before ${JSON.stringify(before)} after ${JSON.stringify(after)}` });
    console.table(rows);
    const failed = rows.filter(x => x.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${rows.length}` : `ALL ${rows.length} PASSED`);
    await pool.end();
    process.exitCode = failed ? 1 : 0;
})().catch(e => { console.error(e); process.exit(2); });
