// End-to-end regression test for "information is on the website but the chatbot cannot find it".
// Two synthetic websites are served locally, indexed under TEMPORARY chatbot IDs (rows + vectors,
// removed at the end) and questioned through the real chat and diagnostics APIs.
// Needs a running server (TEST_BASE_URL, default http://localhost:3000), Qdrant and Ollama. ~5-10 min, run alone.
// Run: npm run test:retrieval
//
// Test-only change: the two local sites' origins (127.0.0.1:<random port>) are allow-listed inside
// assertPublicHttpUrl for indexing; every other URL still goes through the real SSRF checks.
const fs = require("fs"), path = require("path"), http = require("http"), crypto = require("crypto"), Module = require("module");

const projectDir = path.join(__dirname, "..");
require(path.join(projectDir, "node_modules", "dotenv")).config({ path: path.join(projectDir, ".env"), quiet: true });
const pool = require(path.join(projectDir, "dbPool"));
const { recordIndexingResult } = require(path.join(projectDir, "chatbotRegistry"));

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const KEY = process.env.ADMIN_API_KEY || "";
const NOT_FOUND = "I could not find this information on the website.";
// QDRANT_COLLECTION: set by tests/run-isolated.js (isolated test collection); default as before.
const QDRANT = `http://localhost:6333/collections/${process.env.QDRANT_COLLECTION || "website_content"}/points`;
const STUDIO = crypto.randomUUID(), BAKERY = crypto.randomUUID(), PARTIAL = crypto.randomUUID(), HEAVY = crypto.randomUUID();
const TEMP_IDS = [STUDIO, BAKERY, PARTIAL, HEAVY];

// ---------- website 1: a yoga studio ----------
const SCRIPTS = Array.from({ length: 20 }, (_, i) => `<script src="/js/lib-${i}.js"></script>`).join("");
const NAV = `<nav><a href="/">Home</a> <a href="/classes.html">Classes</a> <a href="/timetable.html">Timetable</a>
<a href="/membership-plans.php">Membership</a> <a href="/gift-cards.html">Gift cards</a> <a href="/about.html">About</a></nav>`;
const SLIDER = `<div class="slide"><h2>Welcome to Lotus Studio</h2><p>Yoga for every level, in the studio and online, every day of the week.</p></div>
<div class="slide"><h2>Lotus Studio Yoga</h2><p>Yoga for every level, in the studio and online, every day of the week.</p></div>
<div class="slide"><h2>Welcome to Lotus Studio</h2><p>Yoga for every level, in the studio and online, every day of the week.</p></div>`;
// Every page has the same generic title (as on many small sites), so the address has to carry the topic.
const page = body => `<!doctype html><html><head><title>Lotus Studio</title>${SCRIPTS}</head><body>${NAV}<main>${body}</main><footer>© Lotus Studio</footer></body></html>`;
const BLOG = Array.from({ length: 14 }, (_, i) => `/blog/post-${i + 1}.html`);

const studioPages = {
    "/": page(`${SLIDER}<h1>Lotus Studio</h1><p>A friendly yoga studio in the old town. Beginners are always welcome and mats are provided free of charge for every class.</p>`),
    "/membership-plans.php": page(`${SLIDER}
<h2>Why practise with us</h2><p>Our teachers have many years of experience and keep every class small, so that everyone gets personal attention, gentle corrections and a calm space to learn at their own pace, without pressure or competition, whether they are complete beginners or have practised for a long time.</p>
<h2>Our plans</h2><p>Choose what suits your week.</p>
<h3>€15</h3><p>Single drop-in class.</p>
<h3>€59</h3><p>Monthly unlimited membership.</p>
<h3>€149</h3><p>Three-month membership with one free private session.</p>`),
    "/timetable.html": page(`<h1>Timetable and opening hours</h1><h2>Opening hours</h2><ul><li>Monday to Friday: 06:30 to 21:00</li><li>Saturday: 08:00 to 14:00</li><li>Sunday: closed</li></ul>
<p>Classes start on the hour. Please arrive ten minutes early so that the class can begin on time for everyone.</p>`),
    "/gift-cards.html": page(`<h1>Gift cards</h1><p>Gift cards are available in any amount from €20 to €200. They can be used for classes and memberships and are valid for one year from the date of purchase.</p>`),
    "/classes.html": page(`<h1>Classes</h1><p>We teach Hatha, Vinyasa, Yin and prenatal yoga. Every class lasts 60 minutes and is suitable for beginners unless the timetable says otherwise.</p>`),
    "/about.html": page(`<h1>About Lotus Studio</h1><p>Lotus Studio was founded by two teachers who wanted a quiet place for yoga in the middle of the city, with small classes and a warm community.</p>`),
    // Heavy page (request limit): 300 different scripts.
    "/heavy.html": `<!doctype html><html><head><title>Lotus Studio</title>${Array.from({ length: 300 }, (_, i) => `<script src="/js/heavy-${i}.js"></script>`).join("")}</head>
<body>${NAV}<main><h1>Studio news</h1><p>New evening classes start next month, and the reading corner now has books about yoga philosophy for members to borrow.</p></main></body></html>`
};
for (const [i, blogPath] of BLOG.entries()) {
    studioPages[blogPath] = page(`<h1>Yoga tip ${i + 1}</h1><p>Tip number ${i + 1}: breathe slowly through the nose, keep the shoulders relaxed and move only as far as feels comfortable. Small daily practice helps more than long sessions once a month.</p>`);
}
// The sitemap lists the blog and some pages, but NOT the membership page: it is only linked from the menu.
const STUDIO_SITEMAP = paths => `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${paths.map(p => `<url><loc>${p}</loc></url>`).join("")}</urlset>`;

let studioDown = false;
let scriptRequests = 0;
function startStudio() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://x");
        const origin = `http://127.0.0.1:${server.address().port}`;
        if (studioDown) { res.writeHead(500); return res.end("down"); }
        if (url.pathname === "/robots.txt") { res.setHeader("Content-Type", "text/plain"); return res.end(`User-agent: *\nAllow: /\nSitemap: ${origin}/sitemap.xml\n`); }
        if (url.pathname === "/sitemap.xml") {
            res.setHeader("Content-Type", "application/xml");
            return res.end(STUDIO_SITEMAP([...BLOG, "/classes.html", "/timetable.html", "/gift-cards.html", "/about.html"].map(p => origin + p)));
        }
        if (url.pathname.startsWith("/js/")) { scriptRequests++; res.setHeader("Content-Type", "text/javascript"); return res.end("window.loaded = (window.loaded || 0) + 1;"); }
        const html = studioPages[url.pathname];
        if (!html) { res.writeHead(404, { "Content-Type": "text/html" }); return res.end("<h1>Not found</h1>"); }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------- website 2: a bakery (isolation) ----------
function startBakery() {
    const html = `<!doctype html><html><head><title>Crumb Bakery</title></head><body><main><h1>Crumb Bakery</h1>
<h2>Bread</h2><p>Our sourdough loaf costs €6 and is baked fresh every morning with flour from a local mill.</p>
<h2>Opening hours</h2><p>The bakery is open Monday to Saturday from 07:00 to 18:00 and closed on Sundays.</p></main></body></html>`;
    const server = http.createServer((req, res) => {
        if (req.url === "/robots.txt") { res.setHeader("Content-Type", "text/plain"); return res.end("User-agent: *\nAllow: /\n"); }
        if (req.url !== "/") { res.writeHead(404); return res.end(); }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

// ---------- helpers ----------
const results = [];
function check(name, ok, note = "") {
    results.push({ test: name, result: ok ? "PASS" : "FAIL", note: String(note).replace(/\s+/g, " ").slice(0, 110) });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${note ? `\n     ${String(note).replace(/\s+/g, " ").slice(0, 300)}` : ""}`);
}
async function ask(chatbotId, question) {
    const started = Date.now();
    const r = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatbotId, question }) });
    const j = await r.json();
    return { status: r.status, answer: String(j.answer || j.error || ""), sources: j.sources || [], seconds: ((Date.now() - started) / 1000).toFixed(1) };
}
const paths = r => r.sources.map(s => new URL(s.url).pathname);
const has = (text, ...amounts) => amounts.every(a => new RegExp(`€\\s?${a}\\b|\\b${a}\\s?(€|eur)`, "i").test(text));
async function vectorCount(chatbotId) {
    const r = await fetch(`${QDRANT}/count`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exact: true, filter: { must: [{ key: "chatbotId", match: { value: chatbotId } }] } }) });
    return (await r.json()).result.count;
}
async function storedChunks(chatbotId) {
    const r = await fetch(`${QDRANT}/scroll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: 500, with_payload: true, with_vector: false, filter: { must: [{ key: "chatbotId", match: { value: chatbotId } }] } }) });
    return (await r.json()).result.points.map(p => p.payload);
}
// When an answer check fails, print the diagnostic trace (retrieval decisions, guards, model reply).
async function explainFailure(chatbotId, question) {
    const d = await diagnose(chatbotId, { question, generate: true });
    for (const step of d.json?.trace?.steps || []) {
        if (step.step === "retrieval") {
            console.log(`     trace retrieval: ${step.retrieved} retrieved, ${step.sentToModel} sent`);
            for (const x of step.results.slice(0, 12)) console.log(`       #${x.rank} v=${x.vectorScore} f=${x.finalScore} ${new URL(x.url).pathname} [${x.section}] -> ${x.decision}`);
        } else if (step.step !== "index") {
            console.log(`     trace ${step.step}: ${JSON.stringify({ ...step, step: undefined }).slice(0, 400)}`);
        }
    }
}
async function diagnose(chatbotId, body, key = KEY) {
    const r = await fetch(`${BASE}/api/admin/chatbots/${chatbotId}/diagnose`, { method: "POST", headers: { "Content-Type": "application/json", ...(key ? { "x-admin-api-key": key } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
}

(async () => {
    if (KEY.length < 32) { console.error("ADMIN_API_KEY is not configured."); process.exit(1); }
    const studio = await startStudio();
    const bakery = await startBakery();
    const STUDIO_SITE = `http://127.0.0.1:${studio.address().port}`;
    const BAKERY_SITE = `http://127.0.0.1:${bakery.address().port}`;

    let src = fs.readFileSync(path.join(projectDir, "ingest.js"), "utf8");
    const marker = "async function assertPublicHttpUrl(rawUrl) {";
    src = src.replace(marker, `${marker}\n    try { if ([${JSON.stringify(STUDIO_SITE)}, ${JSON.stringify(BAKERY_SITE)}].includes(new URL(rawUrl).origin)) return new URL(rawUrl); } catch {}`);
    const m = new Module(path.join(projectDir, "ingest.js")); m.filename = path.join(projectDir, "ingest.js"); m.paths = Module._nodeModulePaths(projectDir);
    m._compile(src, m.filename);
    const { ingestWebsite } = m.exports;
    const quiet = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

    try {
        for (const [id, site] of [[STUDIO, STUDIO_SITE], [BAKERY, BAKERY_SITE], [PARTIAL, STUDIO_SITE], [HEAVY, STUDIO_SITE]]) {
            await pool.query("INSERT INTO chatbots (id, website_url, allowed_domain, status) VALUES ($1, $2, '127.0.0.1', 'indexing')", [id, `${site}/`]);
        }

        // ---- 1-2. Crawl: the menu-only page is reached despite many sitemap pages and repeated scripts ----
        const indexed = await quiet(() => ingestWebsite(`${STUDIO_SITE}/`, STUDIO, { maxPages: 12 }));
        await recordIndexingResult(STUDIO, indexed);
        await pool.query("UPDATE chatbots SET status = 'ready' WHERE id = $1", [STUDIO]);
        const chunks = await storedChunks(STUDIO);
        const storedPaths = [...new Set(chunks.map(c => new URL(c.url).pathname))];
        console.log(`indexed: ${indexed.pagesCrawled} pages, ${indexed.chunksStored} sections, found ${indexed.pagesDiscovered}, not read ${indexed.pagesNotProcessed}, stop ${indexed.stopReason}, requests ${indexed.requestsUsed}/${indexed.requestLimit} (reused ${indexed.requestsReused})`);
        check("crawl: page linked only from the menu (not in the sitemap) is indexed", storedPaths.includes("/membership-plans.php"), storedPaths.join(" "));
        check("crawl: repeated scripts reused instead of downloaded again", indexed.requestsReused > 100 && indexed.requestsUsed < 100, `used ${indexed.requestsUsed}, reused ${indexed.requestsReused}`);
        const plans = chunks.filter(c => new URL(c.url).pathname === "/membership-plans.php");
        const priceSection = plans.find(c => /€15/.test(c.chunk));
        check("extraction: all three plans and prices stored together in one section", Boolean(priceSection) && ["€15: Single drop-in class.", "€59: Monthly unlimited membership.", "€149: Three-month membership"].every(t => priceSection.chunk.includes(t)), priceSection?.chunk);
        check("extraction: repeated slider text stored once per page", plans.filter(c => /Yoga for every level/.test(c.chunk)).length <= 1, `${plans.length} sections on the plans page`);
        check("report: counts are consistent (found >= read + failed, stop reason given)", indexed.pagesDiscovered >= indexed.pagesCrawled + indexed.pagesFailed && ["complete", "page-limit"].includes(indexed.stopReason), JSON.stringify({ found: indexed.pagesDiscovered, read: indexed.pagesCrawled, failed: indexed.pagesFailed, notRead: indexed.pagesNotProcessed, stop: indexed.stopReason }));

        // ---- 3-7. Answers ----
        let r = await ask(STUDIO, "What membership plans do you offer and how much do they cost?");
        check("direct question: all plan prices, from the plans page", r.status === 200 && has(r.answer, 15, 59, 149) && paths(r).includes("/membership-plans.php"), `${r.seconds}s ${r.answer} | ${paths(r)}`);
        check("sources: only pages that support the answer (no gift-card page)", r.sources.length > 0 && !paths(r).includes("/gift-cards.html"), paths(r).join(" "));
        r = await ask(STUDIO, "How much is it per month for unlimited yoga?");
        const reworded = r.status === 200 && has(r.answer, 59) && paths(r).includes("/membership-plans.php");
        check("different wording: monthly price found", reworded, `${r.seconds}s ${r.answer} | ${paths(r)}`);
        if (!reworded) await explainFailure(STUDIO, "How much is it per month for unlimited yoga?");
        r = await ask(STUDIO, "When is the studio open on Saturday?");
        check("other information: opening hours from the timetable", r.status === 200 && /08:00|8:00|8 ?am/i.test(r.answer) && /14:00|2 ?pm/i.test(r.answer) && paths(r).includes("/timetable.html"), `${r.seconds}s ${r.answer} | ${paths(r)}`);
        r = await ask(STUDIO, "What amounts are gift cards available in?");
        check("similar terms on several pages: the gift-card page is used", r.status === 200 && has(r.answer, 20, 200) && paths(r).includes("/gift-cards.html") && !paths(r).includes("/membership-plans.php"), `${r.seconds}s ${r.answer} | ${paths(r)}`);
        r = await ask(STUDIO, "Do you offer swimming lessons?");
        check("absent information: exact fallback, no sources", r.answer === NOT_FOUND && r.sources.length === 0, `${r.seconds}s ${r.answer}`);

        // ---- 8. Isolation between chatbots ----
        const bakeryIndexed = await quiet(() => ingestWebsite(`${BAKERY_SITE}/`, BAKERY, { maxPages: 3 }));
        await recordIndexingResult(BAKERY, bakeryIndexed);
        await pool.query("UPDATE chatbots SET status = 'ready' WHERE id = $1", [BAKERY]);
        r = await ask(BAKERY, "How much is a sourdough loaf?");
        check("isolation: the bakery answers from its own site", has(r.answer, 6) && r.sources.every(s => s.url.startsWith(BAKERY_SITE)), `${r.answer} | ${r.sources.map(s => s.url)}`);
        r = await ask(STUDIO, "How much is a sourdough loaf?");
        check("isolation: the studio cannot see the bakery's content", r.answer === NOT_FOUND, r.answer);
        r = await ask(BAKERY, "What membership plans do you offer and how much do they cost?");
        check("isolation: the bakery cannot see the studio's content", r.answer === NOT_FOUND, r.answer);

        // ---- Diagnostics (admin only) ----
        let d = await diagnose(STUDIO, { question: "What membership plans do you offer and how much do they cost?", url: `${STUDIO_SITE}/membership-plans.php` });
        const steps = d.json?.trace?.steps || [];
        const pageStep = steps.find(s => s.step === "page");
        const retrieval = steps.find(s => s.step === "retrieval");
        check("diagnostics: reports the page as indexed with its sections", d.status === 200 && pageStep?.status === "indexed" && pageStep.sections > 0, JSON.stringify(pageStep));
        check("diagnostics: shows scores and the decision for each retrieved section", Boolean(retrieval?.results?.length) && retrieval.results.every(x => typeof x.vectorScore === "number" && x.decision) && retrieval.results.some(x => x.decision === "sent to the model" && /membership-plans/.test(x.url)), retrieval?.results?.slice(0, 3).map(x => `${x.url} ${x.decision}`).join(" | "));
        d = await diagnose(STUDIO, { question: "Do you offer swimming lessons?", url: `${STUDIO_SITE}/swimming.html` });
        const missing = d.json?.trace?.steps?.find(s => s.step === "page");
        check("diagnostics: explains a page that was never found", d.status === 200 && /not found by the last crawl/.test(missing?.status || ""), missing?.status);
        d = await diagnose(STUDIO, { question: "test" }, "");
        check("diagnostics: refused without the admin key", d.status === 401, `HTTP ${d.status}`);
        d = await diagnose(STUDIO, { question: "test" }, "wrong-" + "0".repeat(60));
        check("diagnostics: refused with a wrong admin key", d.status === 403, `HTTP ${d.status}`);

        // ---- 9. Honest reporting of incomplete crawls ----
        const partial = await quiet(() => ingestWebsite(`${STUDIO_SITE}/`, PARTIAL, { maxPages: 3 }));
        await recordIndexingResult(PARTIAL, partial);
        const partialRow = (await pool.query("SELECT crawl_complete, crawl_stop_reason, pages_not_processed, pages_discovered, crawl_report FROM chatbots WHERE id = $1", [PARTIAL])).rows[0];
        check("partial crawl (page limit): not complete, reason and unread pages recorded", partialRow.crawl_complete === false && partialRow.crawl_stop_reason === "page-limit" && partialRow.pages_not_processed > 0 && partialRow.crawl_report?.notProcessedUrls?.length === partialRow.pages_not_processed, JSON.stringify({ ...partialRow, crawl_report: undefined }));
        const heavy = await quiet(() => ingestWebsite(`${STUDIO_SITE}/heavy.html`, HEAVY, { maxPages: 5 }));
        check("partial crawl (request limit): stop reason is the request limit, never 'complete'", heavy.crawlComplete === false && heavy.stopReason === "request-limit" && heavy.requestsUsed === heavy.requestLimit, JSON.stringify({ read: heavy.pagesCrawled, stop: heavy.stopReason, used: heavy.requestsUsed }));

        // ---- 10. Re-indexing: no duplicates; a failed crawl keeps the knowledge ----
        const before = await vectorCount(STUDIO);
        const again = await quiet(() => ingestWebsite(`${STUDIO_SITE}/`, STUDIO, { maxPages: 12 }));
        check("re-index: same number of sections, nothing duplicated, vectors reused", (await vectorCount(STUDIO)) === before && again.embeddingsReused === again.chunksStored, `before ${before}, after ${await vectorCount(STUDIO)}, reused ${again.embeddingsReused}/${again.chunksStored}`);
        studioDown = true;
        let failedReindex = null;
        try { await quiet(() => ingestWebsite(`${STUDIO_SITE}/`, STUDIO, { maxPages: 12 })); } catch (error) { failedReindex = error.message; }
        studioDown = false;
        check("failed re-index: reported as an error and existing knowledge kept", Boolean(failedReindex) && (await vectorCount(STUDIO)) === before, `${failedReindex} | sections ${await vectorCount(STUDIO)}`);
    } catch (error) {
        check("unexpected test error", false, error.message);
    } finally {
        for (const id of TEMP_IDS) {
            await pool.query("DELETE FROM chatbots WHERE id = $1", [id]);
            await fetch(`${QDRANT}/delete?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "chatbotId", match: { value: id } }] } }) });
        }
        let left = 0;
        for (const id of TEMP_IDS) left += (await vectorCount(id)) + (await pool.query("SELECT count(*)::int n FROM chatbots WHERE id = $1", [id])).rows[0].n;
        check("cleanup: temporary chatbots and their sections removed", left === 0, `${TEMP_IDS.length} temporary chatbots`);
        await pool.end();
        studio.close();
        bakery.close();
    }

    console.table(results.map(({ test, result }) => ({ test, result })));
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})();
