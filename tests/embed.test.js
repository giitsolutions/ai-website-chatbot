// End-to-end customer installation of the REAL embeddable widget (public/widget.js), as a website
// owner would do it: dashboard -> Customise (save) -> Install (copy snippet) -> paste the snippet into
// a separate website -> visitors ask questions there. Real browser, real chat API, real model.
// Needs a running server and Ollama. ~2-4 min, run alone.
// Run: npm run test:embed   (TEST_BASE_URL defaults to http://localhost:3000;
//                            the admin key comes from ADMIN_API_KEY / .env and is never printed)
// Uses a TEMPORARY chatbot indexed from a small synthetic website served locally (its row and
// vectors are removed at the end); no existing chatbot is read, changed or re-indexed.
// Test-only change: the synthetic site's origin (127.0.0.1:<random port>) is allow-listed inside
// assertPublicHttpUrl for indexing; every other URL still goes through the real SSRF checks.
const http = require("http"), path = require("path"), fs = require("fs"), crypto = require("crypto"), Module = require("module"), { spawn } = require("child_process");
const projectDir = path.join(__dirname, "..");
require(path.join(projectDir, "node_modules", "dotenv")).config({ path: path.join(projectDir, ".env"), quiet: true });
const { chromium } = require(require.resolve("playwright", { paths: [projectDir] }));

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const KEY = process.env.ADMIN_API_KEY || "";
const BOT = crypto.randomUUID(); // temporary chatbot, removed at the end
const NOT_FOUND = "I could not find this information on the website.";
const SETTINGS = { displayName: "Bakery Assistant", welcomeMessage: "Hi! Ask me about our bread and opening hours.", accentColor: "#0f766e" };
const pool = require(path.join(projectDir, "dbPool"));
const QDRANT = "http://localhost:6333/collections/website_content/points";

// The website the temporary chatbot knows (synthetic).
function knowledgeSite() {
    const html = `<!doctype html><html><head><title>Harbor Bakery</title></head><body><main><h1>Harbor Bakery</h1>
<p>A family bakery by the harbour, baking bread every morning with flour from a local mill.</p>
<h2 id="bread">Bread</h2><p>Our sourdough loaf costs €6 and is baked fresh every morning.</p>
<h2 id="hours">Opening hours</h2><p>The bakery is open Monday to Saturday from 07:00 to 18:00 and closed on Sundays.</p></main></body></html>`;
    const server = http.createServer((req, res) => {
        if (req.url === "/robots.txt") { res.setHeader("Content-Type", "text/plain"); return res.end("User-agent: *\nAllow: /\n"); }
        if (req.url !== "/") { res.writeHead(404); return res.end(); }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const results = [];
const record = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 120) });
const admin = (method, route, body) => fetch(BASE + route, {
    method, headers: { "x-admin-api-key": KEY, ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined
}).then(r => r.json());

// The "customer website": serves one page containing exactly the snippet copied from the dashboard.
function customerSite(snippet) {
    const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Customer site</title></head>
<body><h1>Customer website</h1><p>Installed chatbot below.</p>\n${snippet}\n</body></html>`;
    const server = http.createServer((req, res) => { res.setHeader("Content-Type", "text/html"); res.end(html); });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const inWidget = (page, fn, arg) => page.evaluate(([source, value]) => {
    const root = document.querySelector("#ai-website-chatbot-widget")?.shadowRoot;
    return root ? new Function("root", "value", source)(root, value) : null;
}, [fn, arg]);

async function askInWidget(page, question) {
    const before = await inWidget(page, "return root.querySelectorAll('.bubble.ai').length;");
    await inWidget(page, "root.querySelector('textarea').value = value; root.querySelector('.composer').requestSubmit();", question);
    const started = Date.now();
    // Done when "Thinking..." has been replaced by the answer, or an error is shown.
    await page.waitForFunction(count => {
        const root = document.querySelector("#ai-website-chatbot-widget").shadowRoot;
        const bubbles = root.querySelectorAll(".bubble.ai");
        const last = bubbles[bubbles.length - 1]?.textContent || "";
        return root.querySelector(".error").textContent.trim() !== "" || (bubbles.length > count && !/^(Thinking|Still working)/.test(last));
    }, before, { timeout: 280000, polling: 500 });
    return {
        seconds: ((Date.now() - started) / 1000).toFixed(1),
        answer: await inWidget(page, "const b = root.querySelectorAll('.bubble.ai'); return b[b.length - 1].textContent;"),
        error: await inWidget(page, "return root.querySelector('.error').textContent.trim();"),
        // Source cards follow the answer they belong to, as the last element of the message list.
        links: await inWidget(page, "const last = root.querySelector('.msgs').lastElementChild; return last && last.matches('.sources') ? [...last.querySelectorAll('a.src')].map(a => ({ href: a.href, title: a.querySelector('.src-title').textContent, target: a.target })) : [];")
    };
}

(async () => {
    if (KEY.length < 32) { console.error("ADMIN_API_KEY is not configured."); process.exit(1); }
    // Index the synthetic website under the temporary chatbot.
    const knowledge = await knowledgeSite();
    const KNOWLEDGE = `http://127.0.0.1:${knowledge.address().port}`;
    let src = fs.readFileSync(path.join(projectDir, "ingest.js"), "utf8");
    const marker = "async function assertPublicHttpUrl(rawUrl) {";
    src = src.replace(marker, `${marker}\n    try { if (new URL(rawUrl).origin === ${JSON.stringify(KNOWLEDGE)}) return new URL(rawUrl); } catch {}`);
    const ingestModule = new Module(path.join(projectDir, "ingest.js")); ingestModule.filename = path.join(projectDir, "ingest.js"); ingestModule.paths = Module._nodeModulePaths(projectDir);
    ingestModule._compile(src, ingestModule.filename);
    await pool.query("INSERT INTO chatbots (id, website_url, allowed_domain, status) VALUES ($1, $2, '127.0.0.1', 'indexing')", [BOT, `${KNOWLEDGE}/`]);
    const log = console.log; console.log = () => {};
    try { await ingestModule.exports.ingestWebsite(`${KNOWLEDGE}/`, BOT, { maxPages: 2 }); } finally { console.log = log; }
    await pool.query("UPDATE chatbots SET status = 'ready' WHERE id = $1", [BOT]);
    const original = (await admin("GET", `/api/admin/chatbots/${BOT}`)).chatbot;
    const browser = await chromium.launch({ headless: true });
    let site, demoHost;
    try {
        // ---- 1. Owner: dashboard -> Manage -> Customise -> Install ----
        site = await customerSite("<!-- snippet goes here -->");
        const siteOrigin = `http://localhost:${site.address().port}`;
        const page = await browser.newPage();
        const pageErrors = [];
        page.on("pageerror", e => pageErrors.push(e.message));
        await page.goto(BASE + "/");
        await page.fill("#adminKey", KEY);
        await page.click("#keyForm button");
        await page.waitForFunction(() => document.querySelectorAll("#chatbotList .bot").length > 0, null, { timeout: 15000 });
        const card = page.locator("#chatbotList .bot", { hasText: original.websiteUrl });
        await card.first().locator("button", { hasText: "Manage" }).click();
        await page.waitForSelector("#detail:not([hidden])");

        await page.click("#t-customize");
        await page.fill("#setName", SETTINGS.displayName);
        await page.fill("#setWelcome", SETTINGS.welcomeMessage);
        await page.fill("#setColor", SETTINGS.accentColor);
        await page.fill("#setOrigins", siteOrigin);
        await page.click("#saveSettings");
        await page.waitForFunction(() => /saved/i.test(document.querySelector("#settingsMessage").textContent), null, { timeout: 10000 });
        record("owner: settings saved in the dashboard (name, welcome, colour, allowed website)", true, siteOrigin);

        await page.click("#t-install");
        const snippet = (await page.textContent("#embedCode")).trim();
        record("owner: Install tab gives a one-line snippet for this chatbot (no admin key)",
            snippet === `<script src="${BASE}/widget.js" data-chatbot-id="${BOT}" async></script>` && !snippet.includes(KEY), snippet);
        // The demo page holds an install snippet (for whichever chatbot the owner pasted).
        const demoPage = fs.readFileSync(path.join(projectDir, "demo", "customer-site.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
        const SNIPPET_FORMAT = /<script src="https?:\/\/[^"]+\/widget\.js" data-chatbot-id="[0-9a-f-]{36}" async><\/script>/;
        record("demo/customer-site.html contains an install snippet in the dashboard's format", SNIPPET_FORMAT.test(demoPage) && SNIPPET_FORMAT.test(snippet));
        record("dashboard: no JavaScript errors", pageErrors.length === 0, pageErrors.join(" | "));
        site.close();

        // ---- 2. The snippet pasted into a separate customer website ----
        site = await customerSite(snippet);
        const port = site.address().port;
        // The allowed website must be this exact origin (the port changed when the site restarted).
        await admin("PATCH", `/api/admin/chatbots/${BOT}`, { allowedOrigins: [`http://localhost:${port}`] });
        const visitor = await browser.newPage();
        const consoleErrors = [];
        visitor.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });
        visitor.on("pageerror", e => consoleErrors.push(e.message));
        await visitor.goto(`http://localhost:${port}/`);
        await visitor.waitForSelector("#ai-website-chatbot-widget", { state: "attached", timeout: 15000 });
        record("visitor: floating launcher appears on the customer website",
            await inWidget(visitor, "const b = root.querySelector('.launcher').getBoundingClientRect(); return b.width > 30 && b.right > innerWidth - 120 && b.bottom > innerHeight - 120;"));
        await inWidget(visitor, "root.querySelector('.launcher').click();");
        await visitor.waitForTimeout(1500); // remote settings load
        const shown = {
            title: await inWidget(visitor, "return root.querySelector('.head-title').textContent;"),
            welcome: await inWidget(visitor, "return root.querySelector('.bubble.ai').textContent;"),
            accent: await visitor.evaluate(() => document.querySelector("#ai-website-chatbot-widget").style.getPropertyValue("--accent")),
            open: await inWidget(visitor, "return root.querySelector('.panel').classList.contains('open');")
        };
        record("visitor: panel opens with the saved name, welcome message and colour",
            shown.open && shown.title === SETTINGS.displayName && shown.welcome === SETTINGS.welcomeMessage && shown.accent === SETTINGS.accentColor, JSON.stringify(shown));

        let r = await askInWidget(visitor, "How much is a sourdough loaf?");
        console.log(`supported (${r.seconds}s): ${r.answer.slice(0, 200)}\n  sources: ${JSON.stringify(r.links)}`);
        record("visitor: supported question answered from the indexed site", !r.error && r.answer !== NOT_FOUND && /€\s?6\b/.test(r.answer), `${r.seconds}s ${r.error || r.answer.slice(0, 80)}`);
        record("visitor: source link opens the original page (bread section) in a new tab",
            r.links.length > 0 && r.links.every(l => l.href.startsWith(`${KNOWLEDGE}/`) && l.target === "_blank") && r.links.some(l => /#bread$/.test(l.href)), JSON.stringify(r.links).slice(0, 120));

        r = await askInWidget(visitor, "Do you sell wedding cakes?");
        console.log(`unsupported (${r.seconds}s): ${r.answer}`);
        record("visitor: unsupported question -> exact fallback, no sources", r.answer === NOT_FOUND && r.links.length === 0 && !r.error, `${r.seconds}s ${r.answer}`);
        record("visitor: no console errors on the customer website", consoleErrors.length === 0, consoleErrors.join(" | "));

        // ---- 3. Mobile visitor ----
        const mobile = await browser.newPage({ viewport: { width: 375, height: 700 } });
        await mobile.goto(`http://localhost:${port}/`);
        await mobile.waitForSelector("#ai-website-chatbot-widget", { state: "attached", timeout: 15000 });
        await inWidget(mobile, "root.querySelector('.launcher').click();");
        await mobile.waitForTimeout(500);
        const box = await inWidget(mobile, "const b = root.querySelector('.panel').getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, width: b.width };");
        record("mobile 375 px: chat panel fits the screen", box && box.left >= 0 && box.right <= 375 && box.top >= 0, JSON.stringify(box));

        // ---- 4. The same snippet copied onto a website the owner did NOT allow ----
        const other = await browser.newPage();
        await other.goto(`http://127.0.0.1:${port}/`); // same page, different origin
        await other.waitForSelector("#ai-website-chatbot-widget", { state: "attached", timeout: 15000 });
        await inWidget(other, "root.querySelector('.launcher').click();");
        r = await askInWidget(other, "How much is a sourdough loaf?");
        record("not-allowed website: refused with a clear message (403)", /not enabled for this website/i.test(r.error), r.error || r.answer);

        // ---- 5. The prepared demo host (demo/serve.js) serves the demo page on its own origin ----
        demoHost = spawn(process.execPath, [path.join(projectDir, "demo", "serve.js"), "5059"], { stdio: "ignore" });
        await new Promise(resolve => setTimeout(resolve, 1200));
        const demoHtml = await (await fetch("http://localhost:5059/")).text().catch(() => "");
        const hidden = await fetch("http://localhost:5059/serve.js").then(res => res.status).catch(() => 0);
        record("demo host: serves customer-site.html, not its own script", /widget\.js/.test(demoHtml) && demoHtml === fs.readFileSync(path.join(projectDir, "demo", "customer-site.html"), "utf8") && hidden === 404, `serve.js -> ${hidden}`);
    } catch (error) {
        record("unexpected test error", false, error.message);
    } finally {
        if (demoHost) demoHost.kill();
        if (site) site.close();
        await browser.close();
        knowledge.close();
        // Only the temporary chatbot created by this run (checked by ID and its local address).
        await pool.query("DELETE FROM chatbots WHERE id = $1 AND website_url LIKE 'http://127.0.0.1:%'", [BOT]);
        await fetch(`${QDRANT}/delete?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "chatbotId", match: { value: BOT } }] } }) });
        const left = (await (await fetch(`${QDRANT}/count`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exact: true, filter: { must: [{ key: "chatbotId", match: { value: BOT } }] } }) })).json()).result.count
            + (await pool.query("SELECT count(*)::int n FROM chatbots WHERE id = $1", [BOT])).rows[0].n;
        record("cleanup: temporary chatbot and its vectors removed", left === 0, BOT);
        await pool.end();
    }

    console.table(results);
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})();
