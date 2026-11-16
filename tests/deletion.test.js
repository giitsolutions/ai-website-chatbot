// Removing knowledge and chatbots, end to end (DELETE .../pages, .../website-content, chatbot,
// documents, and the deletion preview): only the chosen page, document, website content or
// chatbot disappears; everything else - including a second chatbot - stays; cached answers are
// not served after a removal; a removal that fails half-way is reported and can be repeated;
// repeated and simultaneous requests are harmless; unauthorised requests are refused.
// ISOLATED: runs only through tests/run-isolated.js (separate test database and Qdrant collection,
// temporary upload folder, fake email). It refuses to start otherwise. The real server.js runs IN
// THIS PROCESS on a free port (never 3000-3005 or 5050). Synthetic websites (127.0.0.1) and PDFs.
// Needs PostgreSQL, Qdrant and Ollama (embeddings, a few answers). ~3-6 min.
// Run: npm run test:deletion
"use strict";
const fs = require("fs"), path = require("path"), http = require("http"), net = require("net"), crypto = require("crypto"), Module = require("module");
const { makePdf } = require("./fixtures/documents.js");
const { assertIsolated } = require("./support/isolated-env");

const projectDir = path.join(__dirname, "..");
const RESERVED_PORTS = new Set([3000, 3001, 3002, 3003, 3004, 3005, 5050]);
const NOT_FOUND = "I could not find this information on the website.";
const QDRANT = `http://localhost:6333/collections/${process.env.QDRANT_COLLECTION}/points`;

const results = [];
function check(name, ok, note = "") {
    results.push({ test: name, result: ok ? "PASS" : "FAIL" });
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${note && !ok ? `\n     ${String(note).replace(/\s+/g, " ").slice(0, 400)}` : ""}\n`);
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

// ---------- two synthetic websites ----------
function startSite(pages) {
    const server = http.createServer((req, res) => {
        if (req.url === "/robots.txt") { res.setHeader("Content-Type", "text/plain"); return res.end("User-agent: *\nAllow: /\n"); }
        const page = pages[req.url.replace(/\/$/, "") || "/"];
        if (!page) { res.writeHead(404); return res.end(); }
        const links = Object.keys(pages).map(href => `<a href="${href}">${pages[href].title}</a>`).join(" ");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html><html><head><title>${page.title}</title></head><body><nav>${links}</nav><main><h1>${page.title}</h1>${page.body}</main></body></html>`);
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}
const SITE_A_PAGES = {
    "/": { title: "Lumen Bikes", body: "<p>Lumen Bikes rents city bicycles in Utrecht to visitors and students.</p>" },
    "/pricing": { title: "Lumen Bikes rental prices", body: "<h2>Rental prices</h2><p>A day rental of a city bicycle costs €18. A week rental costs €75.</p>" },
    "/workshop": { title: "Lumen Bikes workshop", body: "<h2>Workshop hours</h2><p>The bicycle workshop is open Monday to Saturday from 9:00 to 18:00.</p>" }
};
const SITE_B_PAGES = {
    "/": { title: "Harbor Yoga", body: "<p>Harbor Yoga offers yoga classes by the sea in Porto.</p>" },
    "/schedule": { title: "Harbor Yoga schedule", body: "<h2>Schedule</h2><p>Sunrise yoga starts at 6:30 every Tuesday and Thursday.</p>" }
};
const HELMET_PDF = makePdf([["Helmet Policy SOP", "1. Helmets", "Every rider must wear a helmet during the rental.", "Helmets are lent free of charge at the front desk."]]);
const DAMAGE_PDF = makePdf([["Damage SOP", "1. Reporting Damage", "Report a damaged bicycle within 24 hours.", "A flat tyre repair costs €12."]]);
const KEY_PDF = makePdf([["Lost Key SOP", "1. Lost Keys", "A lost lock key is replaced for €8."]]);
const MAT_PDF = makePdf([["Mat Cleaning SOP", "1. Cleaning", "Yoga mats are disinfected after every class."]]);

(async () => {
    const siteA = await startSite(SITE_A_PAGES), siteB = await startSite(SITE_B_PAGES);
    const SITE_A = `http://127.0.0.1:${siteA.address().port}`, SITE_B = `http://127.0.0.1:${siteB.address().port}`;
    const KEY = crypto.randomBytes(32).toString("hex");
    process.env.ADMIN_API_KEY = KEY;
    process.env.ADMIN_API_KEYS = "";
    const port = await freePort();
    process.env.PORT = String(port);

    const pool = require(path.join(projectDir, "dbPool"));
    const isolation = await assertIsolated(pool); // throws (nothing written) unless isolated
    console.log(`isolated environment: database ${isolation.database}, collection ${isolation.collection}`);

    const { ingestWebsite } = loadPatched("ingest.js", src => src.replace("async function assertPublicHttpUrl(rawUrl) {",
        match => `${match}\n    try { const o = new URL(String(rawUrl)).origin; if (o === ${JSON.stringify(SITE_A)} || o === ${JSON.stringify(SITE_B)}) return new URL(String(rawUrl)); } catch {}`));
    const { recordIndexingResult } = require(path.join(projectDir, "chatbotRegistry"));
    const log = console.log, warn = console.warn, error = console.error;
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    // Test-only fault: global.__failNextVectorRemoval makes the next vector removal fail once.
    loadPatched("server.js", src => src.replace("async function removeVectors(filter) {",
        match => `${match}\n    if (global.__failNextVectorRemoval) { global.__failNextVectorRemoval = false; throw new Error("simulated Qdrant failure"); }`));
    const BASE = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(BASE + "/api/health")).ok) break; } catch {}
        await sleep(100);
    }
    console.log = log;

    const A = crypto.randomUUID(), B = crypto.randomUUID(), C = crypto.randomUUID(), D = crypto.randomUUID();
    const TEMP_IDS = [A, B, C, D];
    const call = async (method, route, body, { key = KEY } = {}) => {
        const headers = {};
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (key) headers["x-admin-api-key"] = key;
        const r = await fetch(BASE + route, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { status: r.status, json, text };
    };
    const upload = async (bot, name, buffer) => {
        const r = await fetch(`${BASE}/api/admin/chatbots/${bot}/documents`, {
            method: "POST", headers: { "x-admin-api-key": KEY, "X-File-Name": encodeURIComponent(name), "Content-Type": "application/pdf" }, body: buffer
        });
        return { status: r.status, json: await r.json().catch(() => null) };
    };
    const documentsOf = async bot => (await call("GET", `/api/admin/chatbots/${bot}/documents`)).json?.documents || [];
    async function waitForDocuments(bot) {
        for (let i = 0; i < 240; i++) {
            const docs = await documentsOf(bot);
            if (docs.length && docs.every(doc => doc.status !== "processing")) return docs;
            await sleep(1000);
        }
        throw new Error("documents still processing after 4 minutes");
    }
    const count = async must => (await (await fetch(`${QDRANT}/count`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exact: true, filter: { must } })
    })).json()).result.count;
    const byChatbot = id => ({ key: "chatbotId", match: { value: id } });
    const byDocument = id => ({ key: "documentId", match: { value: id } });
    const byUrl = urls => ({ key: "url", match: { any: urls } });
    const websiteCount = async id => (await count([byChatbot(id)])) - (await count([byChatbot(id), { key: "sourceType", match: { value: "document" } }]));
    const folder = id => path.join(process.env.UPLOAD_DIR, id);
    const storedFiles = id => (fs.existsSync(folder(id)) ? fs.readdirSync(folder(id)).length : 0);
    const chat = async (bot, question) => (await call("POST", "/api/chat", { chatbotId: bot, question }, { key: "" })).json || {};
    const cites = (answer, text) => (answer.sources || []).some(source => JSON.stringify(source).includes(text));
    // Everything of chatbot B, to prove it is unchanged by A's removals.
    const stateOfB = async () => JSON.stringify({
        vectors: await count([byChatbot(B)]),
        rows: (await pool.query("SELECT id, website_url, status, display_name FROM chatbots WHERE id = $1", [B])).rows,
        documents: (await pool.query("SELECT id, filename, status, sections FROM documents WHERE chatbot_id = $1 ORDER BY id", [B])).rows,
        reportRows: (await pool.query("SELECT count(*)::int AS n FROM crawl_urls WHERE chatbot_id = $1", [B])).rows[0].n,
        files: storedFiles(B)
    });

    try {
        // ================= Setup: A (website + 3 PDFs), B (website + 1 PDF), C (empty) =================
        await pool.query(
            "INSERT INTO chatbots (id, website_url, allowed_domain, status) VALUES ($1, $2, '127.0.0.1', 'indexing'), ($3, $4, '127.0.0.1', 'indexing'), ($5, 'https://empty.example/', 'empty.example', 'pending'), ($6, 'https://ui-delete.example/', 'ui-delete.example', 'pending')",
            [A, `${SITE_A}/`, B, `${SITE_B}/`, C, D]);
        console.log = () => {};
        for (const [id, site] of [[A, SITE_A], [B, SITE_B]]) {
            const indexed = await ingestWebsite(`${site}/`, id, { maxPages: 5 });
            await recordIndexingResult(id, indexed);
            await pool.query("UPDATE chatbots SET status = 'ready' WHERE id = $1", [id]);
        }
        console.log = log;
        await call("PATCH", `/api/admin/chatbots/${A}`, { displayName: "Lumen test bot", supportEmail: "help@lumen.example" });
        for (const [bot, name, pdf] of [[A, "Helmet-Policy-SOP.pdf", HELMET_PDF], [A, "Damage-SOP.pdf", DAMAGE_PDF], [A, "Lost-Key-SOP.pdf", KEY_PDF], [B, "Mat-Cleaning-SOP.pdf", MAT_PDF]]) {
            const u = await upload(bot, name, pdf);
            if (u.status !== 202) throw new Error(`setup upload of ${name} failed: HTTP ${u.status}`);
        }
        const docsA = await waitForDocuments(A);
        await waitForDocuments(B);
        const doc = name => docsA.find(d => d.filename === name);
        const HELMET = doc("Helmet-Policy-SOP.pdf").id, DAMAGE = doc("Damage-SOP.pdf").id, LOSTKEY = doc("Lost-Key-SOP.pdf").id;
        check("setup: every document indexed", docsA.every(d => d.status === "indexed") && (await documentsOf(B)).every(d => d.status === "indexed"), JSON.stringify(docsA.map(d => [d.filename, d.status, d.error])));
        const aPages = { pricing: [`${SITE_A}/pricing`], workshop: [`${SITE_A}/workshop`], home: [SITE_A, `${SITE_A}/`] };
        const pricingBefore = await count([byChatbot(A), byUrl(aPages.pricing)]), workshopBefore = await count([byChatbot(A), byUrl(aPages.workshop)]);
        const homeBefore = await count([byChatbot(A), byUrl(aPages.home)]);
        check("setup: A has sections for each page", pricingBefore > 0 && workshopBefore > 0 && homeBefore > 0, `pricing ${pricingBefore}, workshop ${workshopBefore}, home ${homeBefore}`);
        const bBefore = await stateOfB();

        // ================= Authorisation and validation =================
        for (const [method, route, body] of [
            ["DELETE", `/api/admin/chatbots/${C}`, { confirm: C }],
            ["DELETE", `/api/admin/chatbots/${A}/website-content`, { confirm: A }],
            ["DELETE", `/api/admin/chatbots/${A}/pages`, { url: `${SITE_A}/pricing` }],
            ["DELETE", `/api/admin/chatbots/${A}/documents/${HELMET}`, undefined],
            ["GET", `/api/admin/chatbots/${A}/deletion-preview`, undefined]
        ]) {
            const none = await call(method, route, body, { key: "" });
            const wrong = await call(method, route, body, { key: "wrong-" + "0".repeat(60) });
            check(`auth: ${method} ${route.replace(/[0-9a-f-]{36}/g, "<id>")} refused without (401) and with a wrong key (403)`, none.status === 401 && wrong.status === 403, `${none.status} ${wrong.status}`);
            check(`auth: refusal does not reveal the key or internals`, !none.text.includes(KEY) && !wrong.text.includes(KEY) && !/node_modules|at .+:\d+:\d+|C:\\/i.test(none.text + wrong.text));
        }
        let r = await call("DELETE", "/api/admin/chatbots/not-a-uuid", { confirm: "not-a-uuid" });
        check("validation: malformed chatbot ID -> 400", r.status === 400, r.text);
        r = await call("DELETE", `/api/admin/chatbots/${crypto.randomUUID()}`, { confirm: "x" });
        check("validation: unknown chatbot -> 404", r.status === 404, r.text);
        r = await call("DELETE", `/api/admin/chatbots/${C}`, {});
        check("confirmation: chatbot deletion without confirm -> 400, nothing removed", r.status === 400 && (await pool.query("SELECT 1 FROM chatbots WHERE id = $1", [C])).rowCount === 1, r.text);
        r = await call("DELETE", `/api/admin/chatbots/${C}`, { confirm: B });
        check("confirmation: another chatbot's ID does not confirm -> 400", r.status === 400, r.text);
        r = await call("DELETE", `/api/admin/chatbots/${A}/website-content`, { confirm: B });
        check("confirmation: website content removal with the wrong ID -> 400", r.status === 400 && (await websiteCount(A)) > 0, r.text);
        r = await call("DELETE", `/api/admin/chatbots/${A}/documents/${(await documentsOf(B))[0].id}`);
        check("scope: a document of chatbot B cannot be deleted through chatbot A (404)", r.status === 404 && (await count([byChatbot(B), { key: "sourceType", match: { value: "document" } }])) > 0, r.text);
        r = await call("DELETE", `/api/admin/chatbots/${A}/pages`, { url: `${SITE_B}/schedule` });
        check("scope: a page of chatbot B cannot be removed through chatbot A (404)", r.status === 404 && (await count([byChatbot(B), byUrl([`${SITE_B}/schedule`])])) > 0, r.text);
        r = await call("DELETE", `/api/admin/chatbots/${A}/pages`, { url: "javascript:alert(1)" });
        check("validation: page removal needs a page address (400)", r.status === 400, r.text);

        // ================= Preview =================
        r = await call("GET", `/api/admin/chatbots/${A}/deletion-preview`);
        const preview = r.json || {};
        check("preview: website sections, documents, files and report rows of A",
            r.status === 200 && preview.websiteContent.sections === await websiteCount(A) && preview.documents.count === 3 &&
            preview.documents.storedFiles === 3 && preview.websiteContent.reportRows > 0 && preview.confirmWith === A, r.text);
        check("preview: never reveals file paths", !/uploads|[A-Za-z]:\\|\.pdf"/.test(JSON.stringify(preview).replace(/"websiteUrl":"[^"]*"/, "")), r.text);

        // ================= Cached answer before a removal =================
        const before = await chat(A, "Do I have to pay for a helmet?");
        check("answer (before removal) uses the Helmet SOP", cites(before, "Helmet-Policy-SOP.pdf") && before.answer !== NOT_FOUND, JSON.stringify(before).slice(0, 300));

        // ================= 1. One page =================
        r = await call("DELETE", `/api/admin/chatbots/${A}/pages`, { url: `${SITE_A}/pricing#prices` });
        check("page: removed (200) with its section count", r.status === 200 && r.json.removed.sections === pricingBefore, r.text);
        check("page: its sections are gone", (await count([byChatbot(A), byUrl(aPages.pricing)])) === 0);
        check("page: A's other pages keep their sections", (await count([byChatbot(A), byUrl(aPages.workshop)])) === workshopBefore && (await count([byChatbot(A), byUrl(aPages.home)])) === homeBefore);
        check("page: A's documents keep their sections", (await count([byChatbot(A), byDocument(HELMET)])) > 0 && (await count([byChatbot(A), byDocument(DAMAGE)])) > 0);
        const pricingRow = (await pool.query("SELECT status, reason FROM crawl_urls WHERE chatbot_id = $1 AND url = $2", [A, `${SITE_A}/pricing`])).rows[0];
        check("page: report row marked skipped, 'removed by an administrator'", pricingRow?.status === "skipped" && pricingRow?.reason === "removed by an administrator", JSON.stringify(pricingRow));
        check("page: chatbot B unchanged", (await stateOfB()) === bBefore);
        r = await call("DELETE", `/api/admin/chatbots/${A}/pages`, { url: `${SITE_A}/pricing` });
        check("page: repeating the removal finds nothing to remove (404) and changes nothing", r.status === 404 && (await count([byChatbot(A), byUrl(aPages.workshop)])) === workshopBefore, r.text);
        const price = await chat(A, "How much does a day rental cost?");
        check("page: answers no longer cite the removed page", !cites(price, "/pricing"), JSON.stringify(price).slice(0, 300));

        // ================= 2. One document =================
        const damageSections = await count([byDocument(DAMAGE)]);
        const websiteA = await websiteCount(A);
        r = await call("DELETE", `/api/admin/chatbots/${A}/documents/${HELMET}`);
        check("document: removed (200)", r.status === 200 && r.json.removed.filename === "Helmet-Policy-SOP.pdf", r.text);
        check("document: its sections, record and file are gone",
            (await count([byDocument(HELMET)])) === 0 && (await pool.query("SELECT 1 FROM documents WHERE id = $1", [HELMET])).rowCount === 0 && storedFiles(A) === 2);
        check("document: the other PDFs are untouched", (await count([byDocument(DAMAGE)])) === damageSections && (await count([byDocument(LOSTKEY)])) > 0);
        check("document: the website content is untouched", (await websiteCount(A)) === websiteA);
        check("document: chatbot B unchanged", (await stateOfB()) === bBefore);
        const after = await chat(A, "Do I have to pay for a helmet?");
        check("cache: the answer citing the removed SOP is not served again", !cites(after, "Helmet-Policy-SOP.pdf"), JSON.stringify(after).slice(0, 300));
        r = await call("DELETE", `/api/admin/chatbots/${A}/documents/${HELMET}`);
        check("document: repeating the removal -> 404, nothing else changes", r.status === 404 && (await count([byDocument(DAMAGE)])) === damageSections, r.text);
        const [d1, d2] = await Promise.all([call("DELETE", `/api/admin/chatbots/${A}/documents/${LOSTKEY}`), call("DELETE", `/api/admin/chatbots/${A}/documents/${LOSTKEY}`)]);
        const statuses = [d1.status, d2.status].sort();
        check("document: two simultaneous removals -> one succeeds, the other is refused (409/404)", statuses[0] === 200 && [404, 409].includes(statuses[1]), JSON.stringify(statuses));
        check("document: after them only the Damage SOP remains, intact", (await documentsOf(A)).map(d => d.id).join() === DAMAGE && (await count([byDocument(DAMAGE)])) === damageSections && storedFiles(A) === 1);

        // ================= 3. Isolation in answers =================
        const fromB = await chat(B, "How much does a flat tyre repair cost?");
        check("isolation: chatbot B never answers from chatbot A's documents", !cites(fromB, "Damage-SOP.pdf") && !/€\s?12/.test(fromB.answer || ""), JSON.stringify(fromB).slice(0, 300));

        // ================= 4. Website content (A) =================
        r = await call("DELETE", `/api/admin/chatbots/${A}/website-content`, { confirm: A });
        check("website content: removed (200), documents and settings kept", r.status === 200 && r.json.kept.documents === 1 && r.json.status === "ready", r.text);
        check("website content: no website sections and no report rows left",
            (await websiteCount(A)) === 0 && (await pool.query("SELECT count(*)::int AS n FROM crawl_urls WHERE chatbot_id = $1", [A])).rows[0].n === 0);
        const rowA = (await pool.query("SELECT display_name, support_email, website_url, pages_indexed, crawl_report FROM chatbots WHERE id = $1", [A])).rows[0];
        check("website content: chatbot settings stay, crawl summary cleared",
            rowA.display_name === "Lumen test bot" && rowA.support_email === "help@lumen.example" && rowA.website_url === `${SITE_A}/` && rowA.pages_indexed === null && rowA.crawl_report === null, JSON.stringify(rowA));
        check("website content: the remaining PDF still answers", (await count([byDocument(DAMAGE)])) === damageSections && storedFiles(A) === 1);
        check("website content: chatbot B unchanged", (await stateOfB()) === bBefore);

        // ================= 5. Chatbot deletion that fails half-way, then is repeated =================
        global.__failNextVectorRemoval = true;
        r = await call("DELETE", `/api/admin/chatbots/${A}`, { confirm: A });
        check("partial failure: reported (502) with the finished steps", r.status === 502 && JSON.stringify(r.json.completedSteps) === JSON.stringify(["marked as deleting"]), r.text);
        check("partial failure: error text has no internal detail", !/simulated|qdrant|node_modules|[A-Za-z]:\\/i.test(r.json?.error || ""), r.json?.error);
        const statusA = (await pool.query("SELECT status FROM chatbots WHERE id = $1", [A])).rows[0]?.status;
        check("partial failure: chatbot kept, visibly 'deleting'", statusA === "deleting", statusA);
        const chatStatus = (await call("POST", "/api/chat", { chatbotId: A, question: "hello" }, { key: "" })).status;
        check("partial failure: the chatbot no longer answers (409)", chatStatus === 409, String(chatStatus));
        const blocked = await upload(A, "Late.pdf", KEY_PDF);
        check("partial failure: uploads refused while 'deleting' (409)", blocked.status === 409 && storedFiles(A) === 1, JSON.stringify(blocked));
        r = await call("PATCH", `/api/admin/chatbots/${A}`, { displayName: "renamed" });
        check("partial failure: settings changes refused while 'deleting' (409)", r.status === 409, r.text);
        r = await call("DELETE", `/api/admin/chatbots/${A}`, { confirm: A });
        check("retry: the repeated deletion finishes (200)", r.status === 200 && r.json.removed.documents === 1 && r.json.removed.storedFiles === 1, r.text);
        check("retry: no row, documents, report rows, vectors or files of A left",
            (await pool.query("SELECT (SELECT count(*) FROM chatbots WHERE id = $1) + (SELECT count(*) FROM documents WHERE chatbot_id = $1) + (SELECT count(*) FROM crawl_urls WHERE chatbot_id = $1) AS n", [A])).rows[0].n === "0" &&
            (await count([byChatbot(A)])) === 0 && !fs.existsSync(folder(A)));
        check("chatbot deletion: chatbot B completely unchanged", (await stateOfB()) === bBefore);
        r = await call("DELETE", `/api/admin/chatbots/${A}`, { confirm: A });
        check("chatbot deletion: repeating it -> 404", r.status === 404, r.text);

        // ================= 6. Simultaneous deletions of one chatbot (C) =================
        const [c1, c2] = await Promise.all([call("DELETE", `/api/admin/chatbots/${C}`, { confirm: C }), call("DELETE", `/api/admin/chatbots/${C}`, { confirm: C })]);
        const cStatuses = [c1.status, c2.status].sort();
        check("double deletion: one succeeds, the other is refused (409/404)", cStatuses[0] === 200 && [404, 409].includes(cStatuses[1]), JSON.stringify(cStatuses));
        check("double deletion: chatbot B unchanged", (await stateOfB()) === bBefore);

        // ================= 7. The dashboard (real browser): typed confirmation =================
        const { chromium } = require("playwright");
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage();
            let typed = "wrong.example";
            page.on("dialog", dialog => (dialog.type() === "prompt" ? dialog.accept(typed) : dialog.accept()));
            await page.goto(`${BASE}/index.html`);
            await page.click("#showAdminKey");
            await page.fill("#adminKey", KEY);
            await page.click("#keyForm button");
            await page.waitForSelector("#chatbotList .bot");
            await page.locator("#chatbotList .bot", { hasText: "ui-delete.example" }).locator("button", { hasText: "Manage" }).click();
            await page.waitForSelector("#deleteChatbotButton:visible");
            await page.click("#deleteChatbotButton");
            await page.waitForFunction(() => document.querySelector("#removalMessage").textContent.trim().length > 0);
            const refusedText = (await page.textContent("#removalMessage")).trim();
            check("dashboard: a wrong typed confirmation deletes nothing", /Nothing was deleted/.test(refusedText) && (await pool.query("SELECT 1 FROM chatbots WHERE id = $1", [D])).rowCount === 1, refusedText);
            typed = "ui-delete.example";
            await page.click("#deleteChatbotButton");
            await page.waitForFunction(() => /Deleted the chatbot/.test(document.querySelector("#listMessage").textContent));
            check("dashboard: typing the domain deletes the chatbot and updates the list",
                (await pool.query("SELECT 1 FROM chatbots WHERE id = $1", [D])).rowCount === 0 && !(await page.textContent("#chatbotList")).includes("ui-delete.example"));
            check("dashboard: chatbot B unchanged", (await stateOfB()) === bBefore);
        } finally {
            await browser.close();
        }

        // ================= 8. B through the API (normal path) =================
        r = await call("DELETE", `/api/admin/chatbots/${B}`, { confirm: B });
        check("chatbot deletion: B removed (200) with its vectors and files", r.status === 200 && (await count([byChatbot(B)])) === 0 && !fs.existsSync(folder(B)), r.text);
    } catch (failure) {
        check(`test run finished without an unexpected error`, false, failure.message);
    } finally {
        // Fallback cleanup, by the exact IDs of this run only, in the isolated database/collection.
        for (const id of TEMP_IDS) {
            await pool.query("DELETE FROM chatbots WHERE id = $1", [id]).catch(() => {});
            await fetch(`${QDRANT}/delete?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [byChatbot(id)] } }) }).catch(() => {});
            fs.rmSync(folder(id), { recursive: true, force: true });
        }
        let left = 0;
        for (const id of TEMP_IDS) {
            left += await count([byChatbot(id)]);
            left += Number((await pool.query("SELECT (SELECT count(*) FROM chatbots WHERE id = $1) + (SELECT count(*) FROM documents WHERE chatbot_id = $1) + (SELECT count(*) FROM crawl_urls WHERE chatbot_id = $1) AS n", [id])).rows[0].n);
            left += fs.existsSync(folder(id)) ? 1 : 0;
        }
        check("cleanup: nothing of this run left in the test database, collection or folder", left === 0, `left ${left}`);
        siteA.close();
        siteB.close();
        console.log = log; console.warn = warn; console.error = error;
        console.table(results);
        const failed = results.filter(x => x.result !== "PASS").length;
        console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
        process.exit(failed ? 1 : 0);
    }
})().catch(failure => { console.error("deletion test error:", failure.message); process.exit(2); });
