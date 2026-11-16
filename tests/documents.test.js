// End-to-end: uploaded documents (PDF, DOCX) as knowledge, through the real admin and chat APIs.
// Two TEMPORARY chatbots (A with a small synthetic website + documents, B with one document);
// rows, documents, stored files and vectors are removed at the end. Synthetic files only.
// Needs a running server (TEST_BASE_URL, default http://localhost:3000), Qdrant and Ollama.
// ~5-10 min, run alone. Run: npm run test:documents
const fs = require("fs"), path = require("path"), http = require("http"), crypto = require("crypto"), Module = require("module");
const projectDir = path.join(__dirname, "..");
require(path.join(projectDir, "node_modules", "dotenv")).config({ path: path.join(projectDir, ".env"), quiet: true });
const pool = require(path.join(projectDir, "dbPool"));
const { makePdf, makeImageOnlyPdf, makeDocx } = require("./fixtures/documents.js");

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const KEY = process.env.ADMIN_API_KEY || "";
const NOT_FOUND = "I could not find this information on the website.";
// QDRANT_COLLECTION: set by tests/run-isolated.js (isolated test collection); default as before.
const QDRANT = `http://localhost:6333/collections/${process.env.QDRANT_COLLECTION || "website_content"}/points`;
const BOT_A = crypto.randomUUID(), BOT_B = crypto.randomUUID();
const TEMP_IDS = [BOT_A, BOT_B];
console.log("temporary chatbot IDs (removed at the end):", TEMP_IDS.join(", "));

// ---------- synthetic documents ----------
const RETURNS_PDF = makePdf([
    ["Returns Procedure", "Open the Returns screen in the warehouse system and scan the parcel barcode.", "Choose a reason code before printing the returns label."],
    ["Damaged Parcels", "Damaged parcels must be photographed and reported to the claims team within 48 hours.", "Keep the damaged parcel until the claim is closed."]
]);
const MANUAL_DOCX = makeDocx([
    { heading: "R2 Rowing Machine Manual", level: 1 },
    { text: "This manual covers assembly, use and maintenance of the R2 rowing machine for home use." },
    { heading: "Warranty", level: 2 },
    { text: "The R2 rowing machine has a 5-year frame warranty and a 1-year warranty on the seat rail and monitor." },
    { heading: "Support", level: 2 },
    { text: "Standard support costs €120 per year and includes one service visit." }
]);
const SCAN_PDF = makeImageOnlyPdf();
const PRICING_B_PDF = makePdf([["Support Plans", "The premium support plan costs €480 per year and includes four service visits."]]);

// ---------- synthetic website for chatbot A ----------
function startSite() {
    const html = `<!doctype html><html><head><title>RowShop</title></head><body><main><h1>Rowing machines</h1>
<p>Our best-selling home rower is the R2 rowing machine, with magnetic resistance and a folding frame.</p>
<h2>Prices</h2><p>The R2 rowing machine costs ₹42,000, delivered and installed.</p></main></body></html>`;
    const server = http.createServer((req, res) => {
        if (req.url === "/robots.txt") { res.setHeader("Content-Type", "text/plain"); return res.end("User-agent: *\nAllow: /\n"); }
        if (req.url !== "/" && req.url !== "/rowing.html") { res.writeHead(404); return res.end(); }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------- helpers ----------
const results = [];
function check(name, ok, note = "") {
    results.push({ test: name, result: ok ? "PASS" : "FAIL" });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${note ? `\n     ${String(note).replace(/\s+/g, " ").slice(0, 360)}` : ""}`);
}
async function upload(chatbotId, filename, buffer, key = KEY) {
    const r = await fetch(`${BASE}/api/admin/chatbots/${chatbotId}/documents`, {
        method: "POST",
        headers: { ...(key ? { "x-admin-api-key": key } : {}), "X-File-Name": encodeURIComponent(filename), "Content-Type": "application/octet-stream" },
        body: buffer
    });
    return { status: r.status, json: await r.json().catch(() => null) };
}
async function admin(method, route) {
    const r = await fetch(BASE + route, { method, headers: { "x-admin-api-key": KEY } });
    return { status: r.status, json: await r.json().catch(() => null) };
}
async function waitForDocuments(chatbotId) {
    for (let i = 0; i < 240; i++) {
        const list = await admin("GET", `/api/admin/chatbots/${chatbotId}/documents`);
        const docs = list.json?.documents || [];
        if (docs.length && docs.every(doc => doc.status !== "processing")) return docs;
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error("documents still processing after 4 minutes");
}
async function ask(chatbotId, question) {
    const started = Date.now();
    const r = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatbotId, question }) });
    const j = await r.json();
    return { status: r.status, answer: String(j.answer || j.error || ""), sources: j.sources || [], seconds: ((Date.now() - started) / 1000).toFixed(1) };
}
const sourceNames = r => r.sources.map(s => (s.type === "document" ? `${s.title}${s.page ? `#p${s.page}` : ""}` : new URL(s.url).pathname));
const note = r => `${r.seconds}s ${r.answer} | ${sourceNames(r).join(" ")}`;
async function count(filter) {
    const r = await fetch(`${QDRANT}/count`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exact: true, filter: { must: filter } }) });
    return (await r.json()).result.count;
}
const byChatbot = id => ({ key: "chatbotId", match: { value: id } });
const byDocument = id => ({ key: "documentId", match: { value: id } });

(async () => {
    if (KEY.length < 32) { console.error("ADMIN_API_KEY is not configured."); process.exit(1); }
    const site = await startSite();
    const SITE = `http://127.0.0.1:${site.address().port}`;
    let src = fs.readFileSync(path.join(projectDir, "ingest.js"), "utf8");
    const marker = "async function assertPublicHttpUrl(rawUrl) {";
    src = src.replace(marker, `${marker}\n    try { if (new URL(rawUrl).origin === ${JSON.stringify(SITE)}) return new URL(rawUrl); } catch {}`);
    const m = new Module(path.join(projectDir, "ingest.js")); m.filename = path.join(projectDir, "ingest.js"); m.paths = Module._nodeModulePaths(projectDir);
    m._compile(src, m.filename);
    const { ingestWebsite } = m.exports;
    const quiet = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

    try {
        await pool.query("INSERT INTO chatbots (id, website_url, allowed_domain, status) VALUES ($1, $2, '127.0.0.1', 'indexing'), ($3, $4, '127.0.0.1', 'pending')", [BOT_A, `${SITE}/`, BOT_B, `${SITE}/b/`]);
        await quiet(() => ingestWebsite(`${SITE}/`, BOT_A, { maxPages: 3 }));
        await pool.query("UPDATE chatbots SET status = 'ready' WHERE id = $1", [BOT_A]);
        const websiteSections = await count([byChatbot(BOT_A)]);

        // ================= Upload =================
        let u = await upload(BOT_A, "Returns-SOP.pdf", RETURNS_PDF);
        check("upload PDF: accepted (202)", u.status === 202 && u.json?.document?.status === "processing", JSON.stringify(u.json));
        check("upload response never reveals the server file name or path", !JSON.stringify(u.json).includes("storage") && !/data[\\/]uploads/.test(JSON.stringify(u.json)));
        u = await upload(BOT_A, "Rowing Manual.docx", MANUAL_DOCX);
        check("upload DOCX: accepted (202)", u.status === 202, JSON.stringify(u.json));
        u = await upload(BOT_A, "scan.pdf", SCAN_PDF);
        check("upload image-only PDF: accepted for processing (fails during extraction)", u.status === 202, JSON.stringify(u.json));
        u = await upload(BOT_A, "fake.pdf", Buffer.from("this is plain text, not a PDF"));
        check("upload with a false extension: refused (415)", u.status === 415, JSON.stringify(u.json));
        u = await upload(BOT_A, "notes.doc", Buffer.from("legacy"));
        check("upload legacy .doc: refused with advice (415)", u.status === 415 && /\.docx/.test(u.json?.error || ""), u.json?.error);
        u = await upload(BOT_A, "Returns-SOP copy.pdf", RETURNS_PDF);
        check("upload of the same file again: refused (409)", u.status === 409, u.json?.error);
        u = await upload(BOT_A, "x.pdf", RETURNS_PDF, "");
        check("upload without the admin key: refused (401)", u.status === 401, `HTTP ${u.status}`);
        u = await upload(BOT_B, "Pricing-B.pdf", PRICING_B_PDF);
        check("upload to chatbot B: accepted", u.status === 202, JSON.stringify(u.json));

        const docsA = await waitForDocuments(BOT_A);
        const docsB = await waitForDocuments(BOT_B);
        const returnsDoc = docsA.find(d => d.filename === "Returns-SOP.pdf");
        const manualDoc = docsA.find(d => d.filename === "Rowing Manual.docx");
        const scanDoc = docsA.find(d => d.filename === "scan.pdf");
        check("PDF indexed with its page count and sections", returnsDoc?.status === "indexed" && returnsDoc.pages === 2 && returnsDoc.sections === 2, JSON.stringify(returnsDoc));
        check("DOCX indexed with sections", manualDoc?.status === "indexed" && manualDoc.sections >= 3, JSON.stringify(manualDoc));
        check("image-only PDF: failed with a visible reason, nothing stored", scanDoc?.status === "failed" && /scanned images/.test(scanDoc.error || "") && (await count([byChatbot(BOT_A), byDocument(scanDoc.id)])) === 0, JSON.stringify(scanDoc));
        check("chatbot B: document indexed and the chatbot became ready", docsB[0]?.status === "indexed" && (await pool.query("SELECT status FROM chatbots WHERE id = $1", [BOT_B])).rows[0].status === "ready", JSON.stringify(docsB[0]));
        const stored = (await pool.query("SELECT storage_name FROM documents WHERE id = $1", [returnsDoc.id])).rows[0].storage_name;
        check("stored under a generated name, not the uploaded name", /^[0-9a-f-]{36}\.pdf$/.test(stored) && !stored.includes("Returns"), stored);
        let r = await fetch(`${BASE}/data/uploads/${BOT_A}/${stored}`);
        check("stored files are not reachable over HTTP", r.status === 404, `HTTP ${r.status}`);
        r = await admin("DELETE", `/api/admin/chatbots/${BOT_B}/documents/${returnsDoc.id}`);
        check("another chatbot cannot manage this document (404)", r.status === 404, `HTTP ${r.status}`);

        // ================= Answers and citations =================
        let a = await ask(BOT_A, "Within how many hours must damaged parcels be reported?");
        check("fact only in the PDF: answered, cited with the file name and page", /48/.test(a.answer) && a.sources.some(s => s.type === "document" && s.title === "Returns-SOP.pdf" && s.page === 2), note(a));
        a = await ask(BOT_A, "How long is the frame warranty on the R2 rowing machine?");
        check("fact only in the DOCX: answered, cited with the file name", /5[- ]year/i.test(a.answer) && a.sources.some(s => s.type === "document" && s.title === "Rowing Manual.docx"), note(a));
        a = await ask(BOT_A, "How much does the R2 rowing machine cost, and how long is its frame warranty?");
        check("website + document: both facts, each cited from its own source", /42,?000/.test(a.answer) && /5[- ]year/i.test(a.answer) && a.sources.some(s => s.type === "webpage") && a.sources.some(s => s.type === "document" && s.title === "Rowing Manual.docx"), note(a));
        a = await ask(BOT_A, "Do you ship rowing machines to Antarctica?");
        check("absent from website and documents: exact fallback, no citation", a.answer === NOT_FOUND && a.sources.length === 0, note(a));
        a = await ask(BOT_A, "How much is the premium support plan?");
        check("similar price in ANOTHER chatbot's document is never used (no €480)", !/480/.test(a.answer), note(a));
        a = await ask(BOT_B, "How long is the frame warranty on the R2 rowing machine?");
        check("isolation: chatbot B cannot see chatbot A's documents", a.answer === NOT_FOUND, note(a));
        a = await ask(BOT_B, "How much is the premium support plan?");
        check("chatbot B answers from its own document", /€\s?480/.test(a.answer) && a.sources.some(s => s.type === "document" && s.title === "Pricing-B.pdf"), note(a));

        // ================= Management =================
        const returnsBefore = await count([byChatbot(BOT_A), byDocument(returnsDoc.id)]);
        r = await admin("POST", `/api/admin/chatbots/${BOT_A}/documents/${returnsDoc.id}/reindex`);
        await waitForDocuments(BOT_A);
        check("re-index one document: same number of sections, no duplicates", r.status === 202 && (await count([byChatbot(BOT_A), byDocument(returnsDoc.id)])) === returnsBefore, `before ${returnsBefore}, after ${await count([byChatbot(BOT_A), byDocument(returnsDoc.id)])}`);

        // A website re-index must not touch the documents.
        const documentSections = await count([byChatbot(BOT_A), { key: "sourceType", match: { value: "document" } }]);
        await quiet(() => ingestWebsite(`${SITE}/`, BOT_A, { maxPages: 3 }));
        check("website re-index keeps every document section", (await count([byChatbot(BOT_A), { key: "sourceType", match: { value: "document" } }])) === documentSections && (await count([byChatbot(BOT_A)])) === websiteSections + documentSections,
            `documents ${documentSections} -> ${await count([byChatbot(BOT_A), { key: "sourceType", match: { value: "document" } }])}`);

        const manualSections = await count([byChatbot(BOT_A), byDocument(manualDoc.id)]);
        r = await admin("DELETE", `/api/admin/chatbots/${BOT_A}/documents/${manualDoc.id}`);
        check("remove one document: only its sections, file and record are removed", r.status === 200 && r.json.removed.sections === manualSections &&
            (await count([byChatbot(BOT_A), byDocument(manualDoc.id)])) === 0 &&
            (await count([byChatbot(BOT_A), byDocument(returnsDoc.id)])) === returnsBefore &&
            (await count([byChatbot(BOT_A)])) === websiteSections + documentSections - manualSections &&
            (await count([byChatbot(BOT_B)])) > 0, JSON.stringify(r.json?.removed));
        a = await ask(BOT_A, "How long is the frame warranty on the R2 rowing machine?");
        check("after removal the document's facts are no longer answered", a.answer === NOT_FOUND || !/5[- ]year/i.test(a.answer), note(a));
    } catch (error) {
        check("unexpected test error", false, error.message);
    } finally {
        // Only what this run created: the two temporary chatbots (rows cascade to documents),
        // their vectors and their stored files.
        for (const id of TEMP_IDS) {
            await pool.query("DELETE FROM chatbots WHERE id = $1 AND website_url LIKE 'http://127.0.0.1:%'", [id]);
            await fetch(`${QDRANT}/delete?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [byChatbot(id)] } }) });
            await fs.promises.rm(path.join(process.env.UPLOAD_DIR || path.join(projectDir, "data", "uploads"), id), { recursive: true, force: true });
        }
        let left = 0;
        for (const id of TEMP_IDS) {
            left += await count([byChatbot(id)]);
            left += Number((await pool.query("SELECT (SELECT count(*) FROM chatbots WHERE id = $1) + (SELECT count(*) FROM documents WHERE chatbot_id = $1) AS n", [id])).rows[0].n);
            left += fs.existsSync(path.join(process.env.UPLOAD_DIR || path.join(projectDir, "data", "uploads"), id)) ? 1 : 0;
        }
        check("cleanup: temporary chatbots, documents, files and vectors removed", left === 0);
        await pool.end();
        site.close();
    }
    console.table(results);
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})();
