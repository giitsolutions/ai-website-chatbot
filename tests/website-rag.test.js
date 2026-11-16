// End-to-end: URL-level crawl report + grounded answers and citations on a synthetic website
// ("FitHome"): one generic <title> on every page (as on many small sites), price cards that do
// not name their product, a second page with similar "Packages", treadmill rental and sale
// pages, and pages that must be skipped or fail. Indexed under TEMPORARY chatbot IDs (rows,
// crawl reports and vectors removed at the end) and questioned through the real chat API.
// Needs a running server (TEST_BASE_URL, default http://localhost:3000), Qdrant and Ollama.
// ~6-12 min, run alone. Run: npm run test:website-rag
//
// Test-only change: the local site's origin (127.0.0.1:<random port>) is allow-listed inside
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
const SITE_BOT = crypto.randomUUID(), PARTIAL_BOT = crypto.randomUUID(), HEAVY_BOT = crypto.randomUUID();
const TEMP_IDS = [SITE_BOT, PARTIAL_BOT, HEAVY_BOT];
console.log("temporary chatbot IDs (removed at the end):", TEMP_IDS.join(", "));

// ---------- the website ----------
const TITLE = "Gym Equipment on rent, Delhi, Noida - FitHome";
const NAV = `<nav><a href="/">Home</a> <a href="/online_coaching.php">Online training</a> <a href="/dietitian_service.html">Dietitian</a>
<a href="/treadmill-on-rent.html">Treadmill on rent</a> <a href="/treadmills-for-sale.html">Buy a treadmill</a> <a href="/rent-equipment.html">Rent equipment</a>
<a href="/exercise-bikes.html">Exercise bikes</a> <a href="/contact.html">Contact</a></nav>`;
const page = body => `<!doctype html><html><head><title>${TITLE}</title><script src="/js/app.js"></script></head><body>${NAV}<main>${body}</main><footer>© FitHome</footer></body></html>`;
const BLOG = Array.from({ length: 6 }, (_, i) => `/blog-${i + 1}.html`);
const pages = {
    "/": page(`<h1>FitHome</h1><p>Home fitness equipment on rent and for sale in Delhi and Noida, with free delivery and installation for every order.</p>
<p>See also <a href="/old-coaching">our coaching</a>, <a href="/missing-page.html">last year's offers</a>, <a href="https://social.example/fithome">our social page</a>,
<a href="/brochure.pdf">the brochure</a>, <a href="/account/login">your account</a> and <a href="/private/notes.html">staff notes</a>.</p>`),
    "/online_coaching.php": page(`<div class="slide"><h2>Introducing online Training Programme</h2><p>Train at home with live video sessions led by a certified fitness trainer.</p></div>
<div class="slide"><h2>Online Fitness Training Programme</h2><p>Train at home with live video sessions led by a certified fitness trainer.</p></div>
<h2>45 Minutes Training</h2><p>Each live session lasts 45 minutes and the trainer corrects your posture on the video call.</p>
<h2>OUR PACKAGES</h2><p>we offer 3 packages, choose the one that suits you</p>
<h3>₹900</h3><p>Weekly plan worth ₹900 only.</p>
<h3>₹2,800</h3><p>Monthly plan for ₹2,800.</p>
<h3>₹7,000</h3><p>3 months plan worth ₹7,000.</p>`),
    "/dietitian_service.html": page(`<h1>Dietitian service</h1><p>Personal diet plans prepared by a qualified dietitian after a consultation about your goals and routine.</p>
<h2>Packages</h2><ul><li>Weekly diet consultation: ₹1,500</li><li>Monthly diet plan: ₹4,000</li></ul>`),
    "/treadmill-on-rent.html": page(`<h1>Treadmill on rent</h1><p>Rent a treadmill by the month. Delivery, installation and servicing are included in the rent.</p>
<h2>TR-200</h2><p>Monthly rent ₹1,800. Maximum user weight 100 kg. Motor 2 HP.</p>
<h2>TR-500</h2><p>Monthly rent ₹2,600. Maximum user weight 130 kg. Motor 3 HP with automatic incline.</p>`),
    "/treadmills-for-sale.html": page(`<h1>Treadmills for sale</h1><p>Buy a new treadmill with a one-year warranty and free installation at your home.</p>
<h2>TR-200</h2><p>Purchase price ₹38,000.</p><h2>TR-500</h2><p>Purchase price ₹62,000.</p>`),
    "/rent-equipment.html": page(`<h1>Rent equipment</h1><p>We rent out treadmills, exercise bikes, cross trainers and rowing machines for homes and offices, by the month.</p>`),
    "/exercise-bikes.html": page(`<h1>Exercise bikes</h1><p>Our EB-10 exercise bike has a magnetic resistance system with eight levels and a comfortable adjustable seat.</p>
<h2>EB-10</h2><p>Monthly rent ₹900.</p>`),
    "/contact.html": page(`<h1>Contact</h1><p>Call or message us any day between 9:00 and 20:00 and we will arrange delivery at a time that suits you.</p>`)
};
for (const [i, blogPath] of BLOG.entries()) {
    pages[blogPath] = page(`<h1>Fitness tip ${i + 1}</h1><p>Tip ${i + 1}: warm up for five minutes, keep a steady pace and drink water regularly during every workout at home.</p>`);
}
pages["/heavy.html"] = `<!doctype html><html><head><title>${TITLE}</title>${Array.from({ length: 300 }, (_, i) => `<script src="/js/heavy-${i}.js"></script>`).join("")}</head>
<body>${NAV}<main><h1>News</h1><p>New cross trainers arrive next month and can be reserved by calling the store or visiting us in Noida.</p></main></body></html>`;

function startSite() {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url, "http://x");
        const origin = `http://127.0.0.1:${server.address().port}`;
        if (url.pathname === "/robots.txt") { res.setHeader("Content-Type", "text/plain"); return res.end(`User-agent: *\nDisallow: /private/\nSitemap: ${origin}/sitemap.xml\n`); }
        if (url.pathname === "/sitemap.xml") {
            // The online-training page is NOT in the sitemap: it is only linked from the menu.
            const list = ["/", "/contact.html", "/dietitian_service.html", "/treadmills-for-sale.html", ...BLOG];
            res.setHeader("Content-Type", "application/xml");
            return res.end(`<?xml version="1.0"?><urlset>${list.map(p => `<url><loc>${origin}${p}</loc></url>`).join("")}</urlset>`);
        }
        if (url.pathname.startsWith("/js/")) { res.setHeader("Content-Type", "text/javascript"); return res.end("window.ok = 1;"); }
        if (url.pathname === "/old-coaching") { res.writeHead(301, { Location: "/online_coaching.php" }); return res.end(); }
        const html = pages[url.pathname];
        if (!html) { res.writeHead(404, { "Content-Type": "text/html" }); return res.end("<h1>Not found</h1>"); }
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
async function ask(chatbotId, question) {
    const started = Date.now();
    const r = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatbotId, question }) });
    const j = await r.json();
    return { status: r.status, answer: String(j.answer || j.error || ""), sources: j.sources || [], seconds: ((Date.now() - started) / 1000).toFixed(1) };
}
const paths = r => r.sources.map(s => (s.url ? new URL(s.url).pathname : `doc:${s.title}`));
// "₹2,800", "₹2800", "Rs. 2800", "2,800 rupees"
const hasAmount = (text, amount) => new RegExp(`(₹|rs\\.?|inr)\\s?${amount.replace(",", ",?")}\\b|\\b${amount.replace(",", ",?")}\\s?(₹|rupees|inr)`, "i").test(text);
// Amounts written as prices (after ₹ / Rs / INR); model names such as "TR-500" are not prices.
const amountsIn = text => [...String(text).matchAll(/(?:₹|rs\.?|inr)\s?(\d{1,3}(?:,\d{3})+|\d+)/gi)].map(match => match[1].replace(/,/g, ""));
const note = r => `${r.seconds}s ${r.answer} | ${paths(r).join(" ")}`;
async function admin(route) {
    const r = await fetch(BASE + route, { headers: { "x-admin-api-key": KEY } });
    return { status: r.status, json: await r.json().catch(() => null) };
}
async function diagnose(chatbotId, body) {
    const r = await fetch(`${BASE}/api/admin/chatbots/${chatbotId}/diagnose`, { method: "POST", headers: { "Content-Type": "application/json", "x-admin-api-key": KEY }, body: JSON.stringify(body) });
    return r.json().catch(() => null);
}
async function vectorCount(chatbotId) {
    const r = await fetch(`${QDRANT}/count`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exact: true, filter: { must: [{ key: "chatbotId", match: { value: chatbotId } }] } }) });
    return (await r.json()).result.count;
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

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
        for (const id of TEMP_IDS) {
            await pool.query("INSERT INTO chatbots (id, website_url, allowed_domain, status) VALUES ($1, $2, '127.0.0.1', 'indexing')", [id, `${SITE}/`]);
        }

        // ================= Crawl report =================
        const indexed = await quiet(() => ingestWebsite(`${SITE}/`, SITE_BOT, { maxPages: 20 }));
        await recordIndexingResult(SITE_BOT, indexed);
        await pool.query("UPDATE chatbots SET status = 'ready' WHERE id = $1", [SITE_BOT]);
        const c = indexed.crawlCounts;
        console.log("counts:", JSON.stringify(c), "stop:", indexed.stopReason);
        const byPath = new Map(indexed.urlReport.map(entry => {
            const parsed = new URL(entry.url);
            return [parsed.origin === SITE ? parsed.pathname.replace(/\/$/, "") || "/" : entry.url, entry];
        }));
        const status = p => byPath.get(p) || {};
        check("counts reconcile: found = indexed + failed + skipped + not processed", c.discovered === c.indexed + c.failed + c.skipped + c.notProcessed + c.notListed, JSON.stringify(c));
        check("counts: pages read = indexed + pages skipped after reading", c.read === c.indexed + indexed.urlReport.filter(e => e.status === "skipped" && e.fetched).length, JSON.stringify(c));
        check("every recorded address has a final status (none left 'queued' or 'read')", indexed.urlReport.every(e => ["indexed", "failed", "skipped", "not-processed"].includes(e.status)));
        check("menu page missing from the sitemap: found via link and indexed with its sections", status("/online_coaching.php").status === "indexed" && status("/online_coaching.php").source === "link" && status("/online_coaching.php").sections > 0, JSON.stringify(status("/online_coaching.php")));
        check("redirect to a page already indexed: skipped, not counted twice", status("/old-coaching").status === "skipped" && /redirects/.test(status("/old-coaching").reason || ""), JSON.stringify(status("/old-coaching")));
        check("broken link: failed with HTTP 404", status("/missing-page.html").status === "failed" && status("/missing-page.html").httpStatus === 404, JSON.stringify(status("/missing-page.html")));
        check("another website: skipped as outside the crawl scope", /outside the crawl scope/.test(status("https://social.example/fithome").reason || ""), JSON.stringify(status("https://social.example/fithome")));
        check("PDF link: skipped as not a web page (never queued)", status("/brochure.pdf").status === "skipped" && /\.pdf file/.test(status("/brochure.pdf").reason || ""), JSON.stringify(status("/brochure.pdf")));
        check("login page: skipped with a reason", status("/account/login").status === "skipped" && /account|login/.test(status("/account/login").reason || ""), JSON.stringify(status("/account/login")));
        check("robots.txt-blocked page: skipped with a reason", status("/private/notes.html").status === "skipped" && /robots/.test(status("/private/notes.html").reason || ""), JSON.stringify(status("/private/notes.html")));
        check("stored section count equals the sum of per-page sections", indexed.chunksStored === indexed.urlReport.reduce((sum, e) => sum + (e.sections || 0), 0), `${indexed.chunksStored} stored`);

        const row = (await pool.query("SELECT pages_discovered, pages_indexed, pages_failed, pages_read, pages_skipped, pages_not_processed, crawl_stop_reason, crawl_complete FROM chatbots WHERE id = $1", [SITE_BOT])).rows[0];
        const dbRows = (await pool.query("SELECT status, count(*)::int n FROM crawl_urls WHERE chatbot_id = $1 GROUP BY status", [SITE_BOT])).rows;
        const dbCount = s => dbRows.find(r => r.status === s)?.n || 0;
        check("database: chatbot counts and URL rows agree with the crawl", row.pages_discovered === c.discovered && row.pages_indexed === c.indexed && row.pages_failed === c.failed && row.pages_skipped === c.skipped && row.pages_read === c.read &&
            dbCount("indexed") === c.indexed && dbCount("failed") === c.failed && dbCount("skipped") === c.skipped && dbCount("not-processed") === c.notProcessed, JSON.stringify({ row, dbRows }));

        let api = await admin(`/api/admin/chatbots/${SITE_BOT}/crawl-urls?status=failed`);
        check("admin API: filter by status", api.status === 200 && api.json.total === c.failed && api.json.urls.every(u => u.status === "failed") && api.json.urls.some(u => /missing-page/.test(u.url) && u.http_status === 404), JSON.stringify(api.json?.urls?.slice(0, 2)));
        api = await admin(`/api/admin/chatbots/${SITE_BOT}/crawl-urls?search=coaching`);
        check("admin API: search by address", api.status === 200 && api.json.urls.some(u => /online_coaching\.php/.test(u.url)) && api.json.urls.every(u => /coaching/i.test(u.url + (u.reason || ""))), JSON.stringify(api.json?.urls?.map(u => u.url)));
        api = await fetch(`${BASE}/api/admin/chatbots/${SITE_BOT}/crawl-urls`);
        check("admin API: refused without the admin key", api.status === 401, `HTTP ${api.status}`);

        // Page limit: sitemap pages left unread are reported as not processed (page limit).
        const partial = await quiet(() => ingestWebsite(`${SITE}/`, PARTIAL_BOT, { maxPages: 3 }));
        await recordIndexingResult(PARTIAL_BOT, partial);
        const unread = partial.urlReport.filter(e => e.status === "not-processed");
        check("page limit reached: incomplete, unread pages listed with reason 'page-limit'", partial.crawlComplete === false && partial.stopReason === "page-limit" && unread.length > 0 && unread.every(e => e.reason === "page-limit") &&
            partial.crawlCounts.discovered === partial.crawlCounts.indexed + partial.crawlCounts.failed + partial.crawlCounts.skipped + partial.crawlCounts.notProcessed + partial.crawlCounts.notListed, JSON.stringify(partial.crawlCounts));
        // Request limit.
        const heavy = await quiet(() => ingestWebsite(`${SITE}/heavy.html`, HEAVY_BOT, { maxPages: 5 }));
        check("network-request limit reached: incomplete, reason 'request-limit', counts reconcile", heavy.crawlComplete === false && heavy.stopReason === "request-limit" && heavy.urlReport.filter(e => e.status === "not-processed").every(e => e.reason === "request-limit") &&
            heavy.crawlCounts.discovered === heavy.crawlCounts.indexed + heavy.crawlCounts.failed + heavy.crawlCounts.skipped + heavy.crawlCounts.notProcessed + heavy.crawlCounts.notListed, JSON.stringify(heavy.crawlCounts));

        // Diagnostics distinguish the cases.
        let trace = await diagnose(SITE_BOT, { question: "What were last year's offers?", url: `${SITE}/missing-page.html` });
        check("diagnostics: failed page explained", /could not be read: HTTP 404/.test(trace?.trace?.steps?.find(s => s.step === "page")?.status || ""), trace?.trace?.steps?.find(s => s.step === "page")?.status);
        const unreadUrl = unread[0]?.url;
        trace = await diagnose(PARTIAL_BOT, { question: "test", url: unreadUrl });
        check("diagnostics: page not processed because of the page limit explained", /not read: the crawl stopped at the page limit/.test(trace?.trace?.steps?.find(s => s.step === "page")?.status || ""), `${unreadUrl}: ${trace?.trace?.steps?.find(s => s.step === "page")?.status}`);
        trace = await diagnose(SITE_BOT, { question: "test", url: `${SITE}/brochure.pdf` });
        check("diagnostics: skipped page explained", /skipped: not a web page/.test(trace?.trace?.steps?.find(s => s.step === "page")?.status || ""), trace?.trace?.steps?.find(s => s.step === "page")?.status);
        trace = await diagnose(SITE_BOT, { question: "test", url: `${SITE}/never-linked.html` });
        check("diagnostics: page never discovered explained", /not found by the last crawl/.test(trace?.trace?.steps?.find(s => s.step === "page")?.status || ""), trace?.trace?.steps?.find(s => s.step === "page")?.status);

        // ================= Answers and citations =================
        const coaching = ["900", "2,800", "7,000"];
        let r = await ask(SITE_BOT, "What are the online fitness training packages and their prices?");
        check("online training packages: all three prices", r.status === 200 && coaching.every(a => hasAmount(r.answer, a)), note(r));
        check("online training packages: dietitian prices not mixed in", !hasAmount(r.answer, "1,500") && !hasAmount(r.answer, "4,000"), note(r));
        check("online training packages: cited from the online-training page only", paths(r).includes("/online_coaching.php") && !paths(r).includes("/dietitian_service.html"), note(r));
        await pause(1500);
        r = await ask(SITE_BOT, "How much does the monthly online training plan cost?");
        check("monthly online training price, cited from the online-training page", hasAmount(r.answer, "2,800") && !hasAmount(r.answer, "4,000") && paths(r).includes("/online_coaching.php"), note(r));
        r = await ask(SITE_BOT, "What equipment can I rent?");
        const rentable = ["treadmill", "exercise bike", "cross trainer", "rowing"].filter(word => new RegExp(word, "i").test(r.answer));
        check("equipment for rent: listed from the rental pages", rentable.length >= 3 && paths(r).some(p => /rent/.test(p)), note(r));
        r = await ask(SITE_BOT, "What is the price of this treadmill?");
        const treadmillAmounts = ["1800", "2600", "38000", "62000"];
        check("'this treadmill' (ambiguous): fallback, or only real treadmill prices from treadmill pages", r.answer === NOT_FOUND ||
            (amountsIn(r.answer).filter(n => Number(n) >= 100).every(n => treadmillAmounts.includes(n)) && r.sources.length > 0 && paths(r).every(p => /treadmill/.test(p))), note(r));
        r = await ask(SITE_BOT, "My weight is 110 kg. Which treadmill is suitable?");
        check("110 kg: TR-500 recommended (130 kg), from the page that states the weights", /TR-500/.test(r.answer) && (!/TR-200/.test(r.answer) || /100 ?kg/i.test(r.answer)) && paths(r).includes("/treadmill-on-rent.html"), note(r));
        r = await ask(SITE_BOT, "My weight is 110 kg. Which exercise bike is suitable?");
        check("110 kg exercise bike (no weight limit published): no invented capacity", r.answer === NOT_FOUND || !/\b(1[0-9]{2}|[5-9][0-9]) ?kg\b/i.test(r.answer.replace(/110 ?kg/gi, "")), note(r));
        r = await ask(SITE_BOT, "What does the TR-500 treadmill cost to buy?");
        check("purchase price from the sale page, not the rent page", hasAmount(r.answer, "62,000") && paths(r).includes("/treadmills-for-sale.html"), note(r));
        r = await ask(SITE_BOT, "What is the monthly rent of the TR-500 treadmill, and how much is the monthly online training plan?");
        check("two claims: each cited from its own page", hasAmount(r.answer, "2,600") && hasAmount(r.answer, "2,800") && paths(r).includes("/treadmill-on-rent.html") && paths(r).includes("/online_coaching.php"), note(r));
        r = await ask(SITE_BOT, "Do you offer swimming lessons?");
        check("absent information: exact fallback, no citation", r.answer === NOT_FOUND && r.sources.length === 0, note(r));
    } catch (error) {
        check("unexpected test error", false, error.message);
    } finally {
        // Only the chatbots created by this run (rows cascade to crawl_urls).
        for (const id of TEMP_IDS) {
            await pool.query("DELETE FROM chatbots WHERE id = $1 AND website_url LIKE 'http://127.0.0.1:%'", [id]);
            await fetch(`${QDRANT}/delete?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "chatbotId", match: { value: id } }] } }) });
        }
        let left = 0;
        for (const id of TEMP_IDS) {
            left += await vectorCount(id);
            left += (await pool.query("SELECT (SELECT count(*) FROM chatbots WHERE id = $1) + (SELECT count(*) FROM crawl_urls WHERE chatbot_id = $1) AS n", [id])).rows[0].n * 1;
        }
        check("cleanup: temporary chatbots, crawl reports and vectors removed", left === 0, `${TEMP_IDS.length} temporary chatbots`);
        await pool.end();
        site.close();
    }
    console.table(results);
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})();
