// Answers and privacy for uploaded documents, end to end: a PDF price list with a table and a Word
// file of rental terms (fictional). Checks rates read from a table row, a question that would need a
// calculation (answered with the stated rate, never a computed total), the file/page citation, and
// that a private document can never be opened by a visitor or by another customer (logged-in account).
// ISOLATED: runs only through tests/run-isolated.js. The real server.js runs IN THIS PROCESS on a free
// port (never 3000-3005 or 5050), with EMAIL_TRANSPORT=test and startup recovery off. Two TEMPORARY
// chatbots and two accounts; everything is removed at the end (also on failure).
// Needs PostgreSQL, Qdrant and Ollama. ~5 min, run alone. Run: npm run test:document-answers
"use strict";
const fs = require("fs"), path = require("path"), http = require("http"), net = require("net"), crypto = require("crypto"), Module = require("module");
const { makePdf, makeDocx } = require("./fixtures/documents.js");
const { assertIsolated } = require("./support/isolated-env");

const projectDir = path.join(__dirname, "..");
const QDRANT = `http://localhost:6333/collections/${process.env.QDRANT_COLLECTION || "website_content"}/points`;
const RESERVED_PORTS = new Set([3000, 3001, 3002, 3003, 3004, 3005, 5050]);
const NOT_FOUND = "I could not find this information on the website.";

const results = [];
function check(name, ok, note = "") {
    results.push({ test: name, result: ok ? "PASS" : "FAIL" });
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${note ? `\n     ${String(note).replace(/\s+/g, " ").slice(0, 500)}` : ""}\n`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// ---------- fictional documents ----------
// Page 1 is a table: the PDF text layer gives one line per row, the columns side by side.
const PRICES_PDF = makePdf([
    ["Pedal Point Bike Rentals - Price List", "Bike type        Hourly rate        Late return fee",
        "City bike        Rs 80 per hour        Rs 100 per hour", "Electric bike        Rs 150 per hour        Rs 200 per hour",
        "Kids bike        Rs 50 per hour        Rs 60 per hour"],
    ["Deposits", "A refundable deposit of Rs 2,000 is collected for every electric bike.", "The deposit is returned when the bike is checked in."]
]);
const TERMS_DOCX = makeDocx([
    { heading: "Pedal Point Rental Terms", level: 1 },
    { heading: "Helmets", level: 2 },
    { text: "Helmets are free with every rental and must be returned with the bike." },
    { heading: "Opening hours", level: 2 },
    { text: "The rental counter opens at 7 am and closes at 9 pm every day." }
]);
const OTHER_PDF = makePdf([["Boat Hire", "Rowing boats cost Rs 300 per hour."]]);

function startSite() {
    const html = `<!doctype html><html><head><title>Pedal Point</title></head><body><main><h1>Pedal Point</h1>
<p>Pedal Point rents city bikes, electric bikes and kids bikes by the hour.</p></main></body></html>`;
    const server = http.createServer((req, res) => {
        if (req.url === "/robots.txt") { res.setHeader("Content-Type", "text/plain"); return res.end("User-agent: *\nAllow: /\n"); }
        if (req.url !== "/") { res.writeHead(404); return res.end(); }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

(async () => {
    const site = await startSite();
    const SITE = `http://127.0.0.1:${site.address().port}`;
    const ADMIN_KEY = crypto.randomBytes(32).toString("hex");
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.DOCUMENT_LINK_SECRET = crypto.randomBytes(32).toString("hex");
    process.env.STARTUP_RECOVERY = "off";
    process.env.EMAIL_TRANSPORT = "test";
    process.env.TRUST_PROXY = "1";
    delete process.env.COOKIE_SECURE;
    const port = await freePort();
    process.env.PORT = String(port);
    const pool = require(path.join(projectDir, "dbPool"));
    await assertIsolated(pool); // throws (nothing written) unless isolated
    const { ingestWebsite } = loadPatched("ingest.js", src => src.replace("async function assertPublicHttpUrl(rawUrl) {",
        match => `${match}\n    try { if (new URL(String(rawUrl)).origin === ${JSON.stringify(SITE)}) return new URL(String(rawUrl)); } catch {}`));
    const log = console.log, warn = console.warn, error = console.error;
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    require(path.join(projectDir, "server.js"));
    const BASE = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(BASE + "/api/health")).ok) break; } catch {}
        await sleep(100);
    }

    const BOT = crypto.randomUUID(), OTHER = crypto.randomUUID();
    const TEMP_IDS = [BOT, OTHER];
    const accountIds = [];
    const answers = [];
    process.stdout.write(`temporary chatbot IDs (removed at the end): ${TEMP_IDS.join(", ")}\n`);

    let ip = 0;
    // auth: { key } admin key | { cookie } a customer's session | {} a visitor.
    async function call(method, route, body, { key, cookie } = {}) {
        const headers = { "X-Forwarded-For": `198.51.100.${(++ip % 250) + 1}` };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (key) headers["x-admin-api-key"] = key;
        if (cookie) { headers.Cookie = cookie; headers.Origin = BASE; }
        const r = await fetch(BASE + route, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
        const raw = Buffer.from(await r.arrayBuffer());
        let json = null;
        try { json = JSON.parse(raw.toString("utf8")); } catch {}
        return { status: r.status, json, raw };
    }
    async function upload(chatbotId, filename, buffer) {
        const r = await fetch(`${BASE}/api/admin/chatbots/${chatbotId}/documents`, {
            method: "POST",
            headers: { "x-admin-api-key": ADMIN_KEY, "X-File-Name": encodeURIComponent(filename), "Content-Type": "application/octet-stream" },
            body: buffer
        });
        return { status: r.status, json: await r.json().catch(() => null) };
    }
    async function ask(question) {
        const started = Date.now();
        const r = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.9" }, body: JSON.stringify({ chatbotId: BOT, question }) });
        const j = await r.json();
        const result = { answer: String(j.answer || j.error || ""), sources: j.sources || [], seconds: ((Date.now() - started) / 1000).toFixed(1) };
        answers.push(result.answer);
        if (result.answer === NOT_FOUND) {
            // Why it declined (admin diagnostics), shown only when a check fails.
            const d = await call("POST", `/api/admin/chatbots/${BOT}/diagnose`, { question, generate: true }, { key: ADMIN_KEY });
            const decision = (d.json?.trace?.steps || []).find(step => step.step === "decision") || {};
            result.why = `${decision.reason || ""} ${decision.rejectedModelAnswer || ""}`.trim();
        }
        return result;
    }
    const docSource = (r, filename, page) => r.sources.find(s => s.type === "document" && s.title === filename && (page === undefined || s.page === page));
    const describe = r => `${r.seconds}s ${r.answer} | ${r.sources.map(s => s.type === "document" ? `${s.title}#p${s.page} [${s.section}]${s.link ? " +link" : ""}` : s.url).join(" ; ")}${r.why ? ` | why: ${r.why}` : ""}`;
    async function count(filter) {
        const r = await fetch(`${QDRANT}/count`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exact: true, filter: { must: filter } }) });
        return (await r.json()).result.count;
    }
    const byChatbot = id => ({ key: "chatbotId", match: { value: id } });
    const documentsOf = async id => (await call("GET", `/api/admin/chatbots/${id}/documents`, undefined, { key: ADMIN_KEY })).json?.documents || [];

    try {
        // ================= Two customers, each owning one chatbot =================
        const password = () => `pw-${crypto.randomBytes(12).toString("base64url")}`;
        const PASSWORD_A = password(), PASSWORD_B = password();
        let r = await call("POST", "/api/admin/accounts", { email: "owner-a@document-test.example", password: PASSWORD_A }, { key: ADMIN_KEY });
        const A = r.json?.account?.id;
        r = await call("POST", "/api/admin/accounts", { email: "owner-b@document-test.example", password: PASSWORD_B }, { key: ADMIN_KEY });
        const B = r.json?.account?.id;
        accountIds.push(A, B);
        check("two customer accounts created", Boolean(A && B));
        await pool.query("INSERT INTO chatbots (id, website_url, allowed_domain, status, owner_account_id) VALUES ($1, $2, '127.0.0.1', 'indexing', $3), ($4, $5, '127.0.0.1', 'ready', $6)",
            [BOT, `${SITE}/`, A, OTHER, `${SITE}/other/`, B]);
        await ingestWebsite(`${SITE}/`, BOT, { maxPages: 2 });
        await pool.query("UPDATE chatbots SET status = 'ready' WHERE id = $1", [BOT]);
        const login = async (email, pw) => {
            const response = await fetch(`${BASE}/api/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${(++ip % 250) + 1}` }, body: JSON.stringify({ email, password: pw }) });
            const match = (response.headers.get("set-cookie") || "").match(/cb_session=([A-Za-z0-9_-]{43})/);
            return match ? `cb_session=${match[1]}` : null;
        };
        const COOKIE_A = await login("owner-a@document-test.example", PASSWORD_A), COOKIE_B = await login("owner-b@document-test.example", PASSWORD_B);
        check("both customers log in", Boolean(COOKIE_A && COOKIE_B));

        // ================= Upload: PDF with a table, DOCX; private by default =================
        for (const [name, buffer] of [["Price_List.pdf", PRICES_PDF], ["Rental_Terms.docx", TERMS_DOCX]]) {
            const u = await upload(BOT, name, buffer);
            check(`upload ${name}: accepted, private by default`, u.status === 202 && u.json?.document?.visitorAccess === false, JSON.stringify(u.json));
        }
        check("upload to the other customer's chatbot", (await upload(OTHER, "Boat_Hire.pdf", OTHER_PDF)).status === 202);
        let docs = [];
        for (let i = 0; i < 2400; i++) {
            docs = [...await documentsOf(BOT), ...await documentsOf(OTHER)];
            if (docs.length === 3 && docs.every(d => d.status !== "processing")) break;
            await sleep(100);
        }
        check("all documents indexed", docs.length === 3 && docs.every(d => d.status === "indexed"), JSON.stringify(docs.map(d => [d.filename, d.status, d.error])));
        const prices = docs.find(d => d.filename === "Price_List.pdf"), boat = docs.find(d => d.filename === "Boat_Hire.pdf");

        // ================= Answers =================
        let a = await ask("What is the hourly rate for a city bike?");
        check("table row: city bike Rs 80 per hour, cited as Price_List.pdf page 1", /\b80\b/.test(a.answer) && Boolean(docSource(a, "Price_List.pdf", 1)), describe(a));
        a = await ask("What is the late return fee for a kids bike?");
        check("table row: kids bike late fee Rs 60 per hour", /\b60\b/.test(a.answer) && !/\b100\b|\b200\b/.test(a.answer), describe(a));
        a = await ask("How much will it cost if I return an e-bike 2 hours late?");
        check("calculation: answered with the stated rate (Rs 200 per hour), no computed total",
            /\b200\b/.test(a.answer) && /hour/i.test(a.answer) && !/\b400\b/.test(a.answer) && Boolean(docSource(a, "Price_List.pdf")), describe(a));
        a = await ask("How much do I pay for 3 hours on a city bike?");
        check("calculation: city bike rate Rs 80 per hour, no computed total (240)", /\b80\b/.test(a.answer) && !/\b240\b/.test(a.answer), describe(a));
        a = await ask("How big is the deposit for an electric bike?");
        check("page 2: deposit Rs 2,000, cited as page 2", /2,?000/.test(a.answer) && Boolean(docSource(a, "Price_List.pdf", 2)), describe(a));
        a = await ask("When does the rental counter close?");
        check("DOCX: closes at 9 pm, cited as Rental_Terms.docx", /9\s*pm/i.test(a.answer) && Boolean(docSource(a, "Rental_Terms.docx")), describe(a));
        a = await ask("Do I have to pay for a helmet?");
        check("DOCX: helmets are free", /free/i.test(a.answer), describe(a));
        a = await ask("How much does a rowing boat cost?");
        check("another customer's document is never used", a.answer === NOT_FOUND && !/300/.test(a.answer), describe(a));
        a = await ask("Do you rent scooters?");
        check("not in the documents: exact fallback", a.answer === NOT_FOUND, describe(a));
        check("no answer has a double full stop", !answers.some(text => /(?<!\.)\.\.(?!\.)/.test(text)), answers.find(text => /(?<!\.)\.\.(?!\.)/.test(text)) || "");

        // ================= Privacy: a private document is never downloadable =================
        a = await ask("What is the hourly rate for a city bike?");
        check("private document: the citation has no link", a.sources.length > 0 && a.sources.every(s => !("link" in s) && !("documentId" in s)), describe(a));
        const fileRoute = (bot, doc) => `/api/admin/chatbots/${bot}/documents/${doc}/file`;
        r = await call("GET", fileRoute(BOT, prices.id));
        check("visitor (no login, no key): the admin file route refuses (401)", r.status === 401, `HTTP ${r.status}`);
        r = await call("GET", `/api/admin/chatbots/${BOT}/documents`);
        check("visitor: the document list refuses (401)", r.status === 401, `HTTP ${r.status}`);
        r = await call("GET", fileRoute(BOT, prices.id), undefined, { cookie: COOKIE_B });
        check("another customer: cannot open the document (404)", r.status === 404 && !r.raw.equals(PRICES_PDF), `HTTP ${r.status}`);
        r = await call("GET", fileRoute(OTHER, prices.id), undefined, { cookie: COOKIE_B });
        check("another customer, through their own chatbot: cannot open it (404)", r.status === 404, `HTTP ${r.status}`);
        r = await call("PATCH", `/api/admin/chatbots/${BOT}/documents/${prices.id}`, { visitorAccess: true }, { cookie: COOKIE_B });
        const stillPrivate = (await pool.query("SELECT visitor_access FROM documents WHERE id = $1", [prices.id])).rows[0]?.visitor_access === false;
        check("another customer: cannot make it public (404), still private", r.status === 404 && stillPrivate, `HTTP ${r.status}`);
        r = await call("GET", fileRoute(BOT, prices.id), undefined, { cookie: COOKIE_A });
        check("the owner can open their own private document", r.status === 200 && r.raw.equals(PRICES_PDF), `HTTP ${r.status}`);
        r = await call("GET", fileRoute(BOT, boat.id), undefined, { cookie: COOKIE_A });
        check("the owner cannot open the other customer's document (404)", r.status === 404, `HTTP ${r.status}`);

        // Allowed by the owner: a link that opens the PDF at the cited page; the other customer's file stays closed.
        r = await call("PATCH", `/api/admin/chatbots/${BOT}/documents/${prices.id}`, { visitorAccess: true }, { cookie: COOKIE_A });
        check("the owner allows visitors to open the price list", r.status === 200 && r.json?.document?.visitorAccess === true, `HTTP ${r.status}`);
        a = await ask("What is the hourly rate for a city bike?");
        const cite = docSource(a, "Price_List.pdf", 1);
        check("allowed: the citation link opens the PDF at the cited page (#page=1)", Boolean(cite) && /^\/api\/documents\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+#page=1$/.test(cite.link || ""), describe(a));
        r = await call("GET", String(cite?.link || "/api/documents/x.y").split("#")[0]);
        check("allowed: a visitor opens it with the link", r.status === 200 && r.raw.equals(PRICES_PDF), `HTTP ${r.status}`);
    } catch (e) {
        check("unexpected test error", false, e.stack || e.message);
    } finally {
        const uploads = process.env.UPLOAD_DIR || path.join(projectDir, "data", "uploads");
        for (const id of TEMP_IDS) {
            await pool.query("DELETE FROM chatbots WHERE id = $1 AND website_url LIKE 'http://127.0.0.1:%'", [id]);
            await fetch(`${QDRANT}/delete?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [byChatbot(id)] } }) });
            await fs.promises.rm(path.join(uploads, id), { recursive: true, force: true });
        }
        for (const id of accountIds.filter(Boolean)) await pool.query("DELETE FROM accounts WHERE id = $1", [id]);
        let left = 0;
        for (const id of TEMP_IDS) {
            left += await count([byChatbot(id)]);
            left += Number((await pool.query("SELECT (SELECT count(*) FROM chatbots WHERE id = $1) + (SELECT count(*) FROM documents WHERE chatbot_id = $1) AS n", [id])).rows[0].n);
            left += fs.existsSync(path.join(uploads, id)) ? 1 : 0;
        }
        left += Number((await pool.query("SELECT count(*) AS n FROM accounts WHERE email LIKE '%@document-test.example'")).rows[0].n);
        check("cleanup: temporary chatbots, accounts, documents, files and vectors removed", left === 0, `left ${left}`);
        site.close();
        console.log = log; console.warn = warn; console.error = error;
        const failed = results.filter(x => x.result !== "PASS").length;
        console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
        process.exit(failed ? 1 : 0);
    }
})();
