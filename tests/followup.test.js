// Short questions after a previous question: a new topic must not be forced into the previous one,
// and a genuine follow-up must keep using the previous question. Calls the model (~2-4 min).
// Two small local fake websites are indexed under TEMPORARY chatbot IDs (rows + vectors, removed at
// the end, also on failure) and questioned through the real chat and diagnostics APIs.
// Needs a running server (TEST_BASE_URL, default http://localhost:3000), Qdrant and Ollama.
// Run: npm run test:followup
//
// Test-only change: the fake sites' origins (127.0.0.1:<random port>) are allow-listed inside
// assertPublicHttpUrl for indexing; every other URL still goes through the real SSRF checks.
const fs = require("fs"), path = require("path"), http = require("http"), crypto = require("crypto"), Module = require("module");
const projectDir = path.join(__dirname, "..");
require(path.join(projectDir, "node_modules", "dotenv")).config({ path: path.join(projectDir, ".env"), quiet: true });
const pool = require(path.join(projectDir, "dbPool"));
const { recordIndexingResult } = require(path.join(projectDir, "chatbotRegistry"));

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const KEY = process.env.ADMIN_API_KEY || "";
// QDRANT_COLLECTION: set by tests/run-isolated.js (isolated test collection); default as before.
const QDRANT = `http://localhost:6333/collections/${process.env.QDRANT_COLLECTION || "website_content"}/points`;
const NOT_FOUND = "I could not find this information on the website.";
const SHOP_BOT = crypto.randomUUID();
const DOCS_BOT = crypto.randomUUID();
const results = [];
const check = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).replace(/\s+/g, " ").slice(0, 160) });

const filler = "Every visitor is welcome, and our team is happy to answer questions in person or by phone.";
const page = (title, body, links = "") => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1>${body}<p>${filler}</p>${links}</main></body></html>`;
// Site 1: a small shop (prices on one page, opening days on another).
const SHOP = {
    "/": page("Sunrise Bakery", "<p>Sunrise Bakery bakes fresh bread and cakes in Pune every morning.</p>", `<a href="/about">About us</a> <a href="/menu">Menu and prices</a> <a href="/hours">Opening hours</a>`),
    "/about": page("About Sunrise Bakery", "<p>Sunrise Bakery was founded in 1998 by Meera Kulkarni. It is a family-run bakery that uses stone-ground flour.</p>"),
    "/menu": page("Menu and prices", "<ul><li>Croissant: ₹60</li><li>Sourdough loaf: ₹180</li><li>Chocolate cake (1 kg): ₹750</li><li>Masala bun: ₹40</li></ul>"),
    "/hours": page("Opening hours", "<p>We are open Wednesday to Monday, from 7:00 am to 8:00 pm. We are closed on Tuesdays.</p>")
};
// Site 2: documentation where the answer depends on the previous question.
const DOCS = {
    "/": page("Script Runner Guide", "<p>How to run and install Script Runner scripts.</p>", `<a href="/unix">Unix</a> <a href="/windows">Windows</a> <a href="/install">Install</a>`),
    "/unix": page("Using scripts on Unix", "<h2>How do I make a script executable on Unix?</h2><p>Add a #! line naming the interpreter as the first line of the script, then run chmod +x on the file.</p>"),
    "/windows": page("Using scripts on Windows", "<h2>How do I make a script executable on Windows?</h2><p>The installer associates the .sr extension with the interpreter. To run a script by typing only its name, add .sr to the PATHEXT environment variable.</p><h2>Where are scripts installed on Windows?</h2><p>Scripts are installed in the Scripts folder of the installation directory.</p>"),
    "/install": page("Installing Script Runner", "<p>Download the installer and follow the steps. The installation takes about five minutes.</p>")
};

function serve(pages) {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, "http://x").pathname;
        if (pathname === "/robots.txt") { res.writeHead(200, { "Content-Type": "text/plain" }); return res.end("User-agent: *\nAllow: /\n"); }
        if (pages[pathname]) { res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }); return res.end(pages[pathname]); }
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}
async function chat(chatbotId, question, previousQuestion) {
    const r = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatbotId, question, ...(previousQuestion ? { previousQuestion } : {}) }) });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, answer: String(json.answer || json.error || ""), sources: (json.sources || []).map(source => source.url || source.link || "") };
}
async function diagnose(chatbotId, body) {
    const r = await fetch(`${BASE}/api/admin/chatbots/${chatbotId}/diagnose`, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-api-key": KEY }, body: JSON.stringify(body) });
    const text = await r.text();
    if (KEY && text.includes(KEY)) throw new Error("admin key echoed in a response");
    return JSON.parse(text);
}
const pathOf = url => { try { return new URL(url).pathname; } catch { return ""; } };

(async () => {
    if (KEY.length < 32) { console.error("ADMIN_API_KEY is not configured."); process.exit(1); }
    // Do not create anything if a dependency is down (a half-finished run could not clean up).
    const health = await fetch(`${BASE}/api/health`).then(r => r.json()).catch(() => null);
    if (!health || health.qdrant !== "ok" || health.ollama !== "ok" || health.database !== "ok") {
        console.error("Server, Qdrant, Ollama or the database is not available; nothing was created.", JSON.stringify(health));
        process.exit(1);
    }
    const shop = await serve(SHOP), docs = await serve(DOCS);
    const SHOP_SITE = `http://127.0.0.1:${shop.address().port}`, DOCS_SITE = `http://127.0.0.1:${docs.address().port}`;
    let src = fs.readFileSync(path.join(projectDir, "ingest.js"), "utf8");
    const marker = "async function assertPublicHttpUrl(rawUrl) {";
    src = src.replace(marker, `${marker}\n    try { if (${JSON.stringify([SHOP_SITE, DOCS_SITE])}.includes(new URL(rawUrl).origin)) return new URL(rawUrl); } catch {}`);
    const m = new Module(path.join(projectDir, "ingest.js")); m.filename = path.join(projectDir, "ingest.js"); m.paths = Module._nodeModulePaths(projectDir);
    m._compile(src, m.filename);
    const { ingestWebsite } = m.exports;
    const quiet = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

    try {
        for (const [id, site] of [[SHOP_BOT, SHOP_SITE], [DOCS_BOT, DOCS_SITE]]) {
            await pool.query("INSERT INTO chatbots (id, website_url, allowed_domain, status) VALUES ($1, $2, '127.0.0.1', 'indexing')", [id, `${site}/`]);
            const indexed = await quiet(() => ingestWebsite(`${site}/`, id, { maxPages: 10 }));
            await recordIndexingResult(id, indexed);
            await pool.query("UPDATE chatbots SET status = 'ready' WHERE id = $1", [id]);
        }

        // 1. A new topic after an unrelated question (the reported failure).
        const closed = await chat(SHOP_BOT, "When is the bakery closed?", "How much is a masala bun?");
        check("new topic after another question: 'When is the bakery closed?' after 'How much is a masala bun?' -> Tuesdays, from /hours",
            closed.status === 200 && /tuesday/i.test(closed.answer) && closed.sources.some(url => pathOf(url) === "/hours"), `${closed.answer} | ${closed.sources.join(" ")}`);
        // Diagnostics show the same thing (both readings, and /hours sent to the model).
        const trace = await diagnose(SHOP_BOT, { question: "When is the bakery closed?", previousQuestion: "How much is a masala bun?", generate: false });
        const steps = trace.trace?.steps || [];
        const followUp = steps.find(step => step.step === "follow-up");
        const retrieval = steps.find(step => step.step === "retrieval");
        check("diagnostics: both readings shown, and /hours sent to the model like in the chat",
            followUp && followUp.withPrevious && followUp.onItsOwn && retrieval?.results?.some(result => pathOf(result.url) === "/hours" && result.decision === "sent to the model"),
            JSON.stringify({ addedFromOnItsOwn: followUp?.addedFromOnItsOwn, sent: retrieval?.results?.filter(result => result.decision === "sent to the model").map(result => pathOf(result.url)) }));

        // 2. The same question on its own (unchanged standalone behaviour).
        const alone = await chat(SHOP_BOT, "When is the bakery closed?");
        check("standalone: 'When is the bakery closed?' -> Tuesdays, from /hours", alone.status === 200 && /tuesday/i.test(alone.answer) && alone.sources.some(url => pathOf(url) === "/hours"), `${alone.answer} | ${alone.sources.join(" ")}`);
        const price = await chat(SHOP_BOT, "How much is a masala bun?");
        check("standalone: 'How much is a masala bun?' -> ₹40, from /menu", price.status === 200 && /40/.test(price.answer) && price.sources.some(url => pathOf(url) === "/menu"), `${price.answer} | ${price.sources.join(" ")}`);

        // 3. A genuine follow-up keeps the previous question's meaning.
        const windows = await chat(DOCS_BOT, "What about on Windows?", "How do I make a script executable on Unix?");
        check("genuine follow-up: 'What about on Windows?' after the Unix question -> PATHEXT, from /windows",
            windows.status === 200 && /PATHEXT|\.sr/i.test(windows.answer) && windows.sources.some(url => pathOf(url) === "/windows"), `${windows.answer} | ${windows.sources.join(" ")}`);

        // 4. Fallback is kept: information that is not on the website, after a previous question.
        const delivery = await chat(SHOP_BOT, "Do you deliver to Mumbai?", "How much is a masala bun?");
        check("fallback after a previous question: 'Do you deliver to Mumbai?' -> exact fallback, no sources", delivery.status === 200 && delivery.answer === NOT_FOUND && delivery.sources.length === 0, `${delivery.answer} | ${delivery.sources.join(" ")}`);
        const ceo = await chat(SHOP_BOT, "Who is the current CEO?");
        check("fallback standalone: 'Who is the current CEO?' -> exact fallback", ceo.status === 200 && ceo.answer === NOT_FOUND, ceo.answer);
        const otherSite = await chat(SHOP_BOT, "What about on Windows?", "How much is a masala bun?");
        check("follow-up whose topic is on no page of this website -> exact fallback", otherSite.status === 200 && otherSite.answer === NOT_FOUND, otherSite.answer);
    } catch (error) {
        check("unexpected test error", false, error.message);
    } finally {
        // Remove only this test's temporary chatbots (vectors, then rows; each step on its own).
        for (const id of [SHOP_BOT, DOCS_BOT]) {
            await fetch(`${QDRANT}/delete?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "chatbotId", match: { value: id } }] } }) }).catch(() => {});
            await pool.query("DELETE FROM chatbots WHERE id = $1 AND website_url LIKE 'http://127.0.0.1:%'", [id]).catch(() => {});
        }
        const leftRows = (await pool.query("SELECT count(*)::int n FROM chatbots WHERE id = ANY($1::uuid[])", [[SHOP_BOT, DOCS_BOT]])).rows[0].n;
        const leftPoints = await fetch(`${QDRANT}/count`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exact: true, filter: { should: [SHOP_BOT, DOCS_BOT].map(id => ({ key: "chatbotId", match: { value: id } })) } }) }).then(r => r.json()).then(j => j.result.count).catch(() => -1);
        check("cleanup: temporary chatbots and their vectors removed", leftRows === 0 && leftPoints === 0, `rows ${leftRows}, points ${leftPoints}`);
        shop.close();
        docs.close();
        await pool.end();
    }
    console.table(results);
    const failed = results.filter(row => row.result === "FAIL").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})();
