// The real public/widget.js pasted on two different "customer" websites (different origins, very
// different styles), each with its own chatbot. Real browser, real chat API, real model.
// Checks: the right chatbot per site, styles do not leak in or out, allowed websites are enforced,
// unanswered -> form -> enquiry stored for the right chatbot, a 375 px phone, keyboard use and
// screen-reader names. ~2-4 min, run alone. Isolated only:
//   node tests/run-isolated.js --with-server tests/widget-sites.test.js
const fs = require("fs"), path = require("path"), http = require("http"), crypto = require("crypto"), Module = require("module");
const projectDir = path.join(__dirname, "..");
require(path.join(projectDir, "node_modules", "dotenv")).config({ path: path.join(projectDir, ".env"), quiet: true });
const { chromium } = require(require.resolve("playwright", { paths: [projectDir] }));
const pool = require(path.join(projectDir, "dbPool"));
const { assertIsolated } = require(path.join(__dirname, "support", "isolated-env"));

const BASE = process.env.TEST_BASE_URL;
const KEY = process.env.ADMIN_API_KEY || "";
const NOT_FOUND = "I could not find this information on the website.";
const QDRANT = `http://localhost:6333/collections/${process.env.QDRANT_COLLECTION}/points`;

const results = [];
const check = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 170) });

const KNOWLEDGE = {
    bakery: `<!doctype html><html><head><title>Harbor Bakery</title></head><body><main><h1>Harbor Bakery</h1><p>A family bakery by the harbour, baking bread every morning with flour from a local mill.</p><h2>Bread</h2><p>Our sourdough loaf costs €6 and is baked fresh every morning.</p></main></body></html>`,
    garage: `<!doctype html><html><head><title>Ridge Garage</title></head><body><main><h1>Ridge Garage</h1><p>An independent car repair workshop that services petrol and diesel cars of every make.</p><h2>Services</h2><p>A full car service costs €149 and takes about three hours.</p></main></body></html>`
};
// Two styles a real website could have. The first one tries hard to reach into the widget.
const STYLES = {
    bakery: `* { letter-spacing: 3px !important; text-transform: uppercase; text-align: right; font-family: serif; word-spacing: 9px; }
        div { transform: translateX(0); opacity: .9; position: relative; font-size: 40px; color: rgb(1, 2, 3); }
        button { background: rgb(255, 0, 0) !important; border-radius: 0 !important; width: 300px; }
        textarea, input { background: rgb(0, 255, 0) !important; }
        h1 { color: rgb(10, 20, 30); box-sizing: content-box; }`,
    garage: `body { background: rgb(17, 17, 17); color: rgb(238, 238, 238); font: 20px/2 monospace; } h1 { color: rgb(200, 100, 50); margin: 3px; }`
};
const customerPage = (name, chatbotId) => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>${name}</title><style>${STYLES[name]}</style></head>
<body><h1 id="own">${name} website</h1><button id="ownButton">Their button</button><p>Their own page.</p><script src="${BASE}/widget.js" data-chatbot-id="${chatbotId}" async></script></body></html>`;

function startSite(name, botId) {
    const server = http.createServer((req, res) => {
        const pathname = new URL(req.url, "http://x").pathname;
        if (pathname === "/robots.txt") { res.setHeader("Content-Type", "text/plain"); return res.end("User-agent: *\nAllow: /\n"); }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        if (pathname === "/customer") return res.end(customerPage(name, botId));
        if (pathname === "/plain") return res.end(`<!doctype html><html><head><style>${STYLES[name]}</style></head><body><h1 id="own">${name} website</h1><button id="ownButton">Their button</button></body></html>`);
        if (pathname === "/") return res.end(KNOWLEDGE[name]);
        res.writeHead(404); res.end();
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

const widget = (page, source, value) => page.evaluate(([code, arg]) => {
    const root = document.querySelector("#ai-website-chatbot-widget")?.shadowRoot;
    return root ? new Function("root", "value", code)(root, arg) : null;
}, [source, value]);

async function open(browser, url, options) {
    const page = await browser.newPage(options);
    await page.goto(url);
    await page.waitForSelector("#ai-website-chatbot-widget", { state: "attached", timeout: 15000 });
    return page;
}

async function ask(page, question) {
    const before = await widget(page, "return root.querySelectorAll('.bubble.ai').length;");
    await widget(page, "root.querySelector('.composer textarea').value = value; root.querySelector('.composer').requestSubmit();", question);
    await page.waitForFunction(count => {
        const root = document.querySelector("#ai-website-chatbot-widget").shadowRoot;
        const bubbles = root.querySelectorAll(".bubble.ai");
        const last = bubbles[bubbles.length - 1]?.textContent || "";
        return root.querySelector(".error").textContent.trim() !== "" || (bubbles.length > count && !/^(Thinking|Still working)/.test(last));
    }, before, { timeout: 280000, polling: 300 });
    return {
        answer: await widget(page, "const b = root.querySelectorAll('.bubble.ai'); return b[b.length - 1].textContent;"),
        error: await widget(page, "return root.querySelector('.error').textContent.trim();"),
        hasForm: await widget(page, "return Boolean(root.querySelector('.contact-form'));")
    };
}

// Computed styles of the page's own elements, to compare with and without the widget.
const ownStyles = page => page.evaluate(() => ["own", "ownButton"].map(id => {
    const style = getComputedStyle(document.getElementById(id));
    return ["color", "backgroundColor", "fontFamily", "fontSize", "boxSizing", "letterSpacing", "margin", "width"].map(name => style[name]).join("|");
}).join("||") + `||body:${getComputedStyle(document.body).backgroundColor}|${getComputedStyle(document.body).margin}`);

(async () => {
    await assertIsolated(pool);
    if (!BASE || KEY.length < 32) throw new Error("Run through tests/run-isolated.js --with-server, with ADMIN_API_KEY configured.");
    const ids = { bakery: crypto.randomUUID(), garage: crypto.randomUUID() };
    const sites = { bakery: await startSite("bakery", ids.bakery), garage: await startSite("garage", ids.garage) };
    const portOf = name => sites[name].address().port;
    const originOf = name => `http://127.0.0.1:${portOf(name)}`;
    const source = fs.readFileSync(path.join(projectDir, "ingest.js"), "utf8");
    const marker = "async function assertPublicHttpUrl(rawUrl) {";
    const m = new Module(path.join(projectDir, "ingest.js")); m.filename = path.join(projectDir, "ingest.js"); m.paths = Module._nodeModulePaths(projectDir);
    m._compile(source.replace(marker, `${marker}\n    try { if (${JSON.stringify(Object.keys(sites).map(originOf))}.includes(new URL(rawUrl).origin)) return new URL(rawUrl); } catch {}`), m.filename);
    const log = console.log;
    const browser = await chromium.launch({ headless: true });
    try {
        for (const name of Object.keys(sites)) {
            await pool.query("INSERT INTO chatbots (id, website_url, allowed_domain, status) VALUES ($1, $2, '127.0.0.1', 'indexing')", [ids[name], `${originOf(name)}/`]);
            console.log = () => {};
            try { await m.exports.ingestWebsite(`${originOf(name)}/`, ids[name], { maxPages: 2 }); } finally { console.log = log; }
            await pool.query("UPDATE chatbots SET status = 'ready' WHERE id = $1", [ids[name]]);
            const saved = await fetch(`${BASE}/api/admin/chatbots/${ids[name]}`, {
                method: "PATCH", headers: { "Content-Type": "application/json", "x-admin-api-key": KEY },
                body: JSON.stringify({ allowedOrigins: [originOf(name)], displayName: `${name} helper`, accentColor: name === "bakery" ? "#0f766e" : "#7c2d12" })
            });
            if (!saved.ok) throw new Error(`settings not saved: HTTP ${saved.status}`);
        }

        // ---- The right chatbot on each website ----
        const bakery = await open(browser, `${originOf("bakery")}/customer`);
        const garage = await open(browser, `${originOf("garage")}/customer`);
        const errors = [];
        for (const page of [bakery, garage]) { page.on("pageerror", error => errors.push(error.message)); }
        await widget(bakery, "root.querySelector('.launcher').click();");
        await widget(garage, "root.querySelector('.launcher').click();");
        await bakery.waitForTimeout(1200);
        const setting = page => widget(page, "return root.querySelector('.head-title').textContent;");
        check("each site shows its own chatbot's name", await setting(bakery) === "bakery helper" && await setting(garage) === "garage helper", `${await setting(bakery)} / ${await setting(garage)}`);
        const accent = page => page.evaluate(() => document.getElementById("ai-website-chatbot-widget").style.getPropertyValue("--accent"));
        check("each site shows its own chatbot's colour", await accent(bakery) === "#0f766e" && await accent(garage) === "#7c2d12", `${await accent(bakery)} / ${await accent(garage)}`);
        let reply = await ask(bakery, "How much is a sourdough loaf?");
        check("bakery site: answers its own fact", /€\s?6\b/.test(reply.answer) && !reply.error, reply.error || reply.answer);
        reply = await ask(garage, "How much is a full car service?");
        check("garage site: answers its own fact", /€\s?149\b/.test(reply.answer) && !reply.error, reply.error || reply.answer);
        reply = await ask(garage, "How much is a sourdough loaf?");
        check("garage site: the bakery's fact is not available", reply.answer === NOT_FOUND && !/€\s?6\b/.test(reply.answer), reply.error || reply.answer);

        // ---- Styles ----
        for (const name of ["bakery", "garage"]) {
            const plain = await browser.newPage();
            await plain.goto(`${originOf(name)}/plain`);
            const without = await ownStyles(plain);
            await plain.close();
            check(`${name} site: the widget changes none of the page's own styles`, without === await ownStyles(name === "bakery" ? bakery : garage), without.slice(0, 100));
        }
        const inner = page => widget(page, `const pick = (selector, ...names) => { const style = getComputedStyle(root.querySelector(selector)); return names.map(name => style[name]).join("|"); };
            return { launcher: pick(".launcher", "backgroundColor", "width", "borderRadius"), panel: pick(".panel", "fontFamily", "fontSize", "color", "textAlign", "letterSpacing", "wordSpacing", "textTransform", "lineHeight"), bubble: pick(".bubble.ai", "fontFamily", "fontSize", "textAlign", "letterSpacing", "textTransform"), input: pick(".composer textarea", "backgroundColor", "letterSpacing", "textTransform", "textAlign"), send: pick(".send", "backgroundColor", "width") };`);
        const a = await inner(bakery), b = await inner(garage);
        const withoutAccent = value => JSON.stringify(value).replace(/rgb\(15, 118, 110\)|rgb\(124, 45, 18\)/g, "ACCENT");
        check("the page's styles do not reach into the widget (same look on both sites apart from the colour)", withoutAccent(a) === withoutAccent(b), `${withoutAccent(a).slice(0, 80)} <> ${withoutAccent(b).slice(0, 80)}`);
        const placed = await widget(bakery, "const box = root.querySelector('.panel').getBoundingClientRect(); return { right: Math.round(innerWidth - box.right), bottom: Math.round(innerHeight - box.bottom), opacity: getComputedStyle(root.host).opacity };");
        check("a page's rules for div (transform, opacity) do not move or fade the widget", placed.right >= 18 && placed.right <= 22 && placed.bottom >= 86 && placed.bottom <= 90 && placed.opacity === "1", JSON.stringify(placed));

        // ---- Allowed websites ----
        const wrongOrigin = `http://localhost:${portOf("bakery")}`;
        const elsewhere = await open(browser, `${wrongOrigin}/customer`);
        await widget(elsewhere, "root.querySelector('.launcher').click();");
        reply = await ask(elsewhere, "How much is a sourdough loaf?");
        check("the snippet on a website that is not allowed: refused with a clear message", /not enabled for this website/i.test(reply.error) && !/€/.test(reply.answer), reply.error || reply.answer);
        const contactFrom = origin => fetch(`${BASE}/api/chat/contact`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin }, body: JSON.stringify({ chatbotId: ids.bakery, name: "Mallory", email: "m@example.test", question: "From elsewhere", requestId: crypto.randomUUID() }) }).then(r => r.status);
        check("the contact form from a website that is not allowed: refused", await contactFrom(wrongOrigin) === 403);
        const copied = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json", Origin: originOf("garage") }, body: JSON.stringify({ chatbotId: ids.bakery, question: "How much is a sourdough loaf?" }) }).then(r => r.status);
        check("another customer's website cannot use this chatbot", copied === 403, copied);
        await elsewhere.close();

        // ---- Unanswered -> form -> enquiry stored for the right chatbot (with the keyboard only) ----
        const keyboard = await open(browser, `${originOf("garage")}/customer`);
        const activeIn = () => widget(keyboard, "const a = root.activeElement; return a ? (a.getAttribute('aria-label') || a.name || a.className || a.tagName) : '';");
        let reachedLauncher = false;
        for (let i = 0; i < 12 && !reachedLauncher; i++) { await keyboard.keyboard.press("Tab"); reachedLauncher = await activeIn() === "Open chat"; }
        check("keyboard: Tab reaches the launcher", reachedLauncher, await activeIn());
        await keyboard.keyboard.press("Enter");
        check("keyboard: Enter opens the panel and puts the cursor in the question box", await widget(keyboard, "return root.querySelector('.panel').classList.contains('open') && root.activeElement === root.querySelector('.composer textarea');"));
        check("keyboard: the launcher says whether the panel is open", await widget(keyboard, "return root.querySelector('.launcher').getAttribute('aria-expanded');") === "true");
        await keyboard.keyboard.press("Escape");
        check("keyboard: Escape closes the panel and returns to the launcher", await widget(keyboard, "return !root.querySelector('.panel').classList.contains('open') && root.activeElement === root.querySelector('.launcher');"));
        await keyboard.keyboard.press("Enter");

        check("screen reader: the question box has a name", await keyboard.getByRole("textbox", { name: "Ask about this website" }).count() === 1);
        check("screen reader: the launcher and Send button have names", await keyboard.getByRole("button", { name: /chat/i }).count() >= 1 && await keyboard.getByRole("button", { name: "Send" }).count() === 1);
        check("screen reader: new messages are announced", await widget(keyboard, "const m = root.querySelector('.msgs'); return m.getAttribute('role') === 'log' && m.getAttribute('aria-live') === 'polite';"));
        check("keyboard: focus is visible on the question box", await widget(keyboard, "const style = getComputedStyle(root.querySelector('.composer textarea')); return style.outlineStyle !== 'none';"), "outline");

        const QUESTION = "Do you repair electric scooters?";
        await keyboard.keyboard.type(QUESTION);
        await keyboard.keyboard.press("Enter");
        await keyboard.waitForFunction(() => document.querySelector("#ai-website-chatbot-widget").shadowRoot.querySelector(".contact-form"), null, { timeout: 280000, polling: 300 });
        check("unanswered: the exact fallback text and the form appear", await widget(keyboard, "const b = root.querySelectorAll('.bubble.ai'); return b[b.length - 1].textContent;") === NOT_FOUND);
        check("screen reader: the form and its fields have names", await keyboard.getByRole("form", { name: "Send your question to the support team" }).count() === 1
            && await keyboard.getByRole("textbox", { name: "Name" }).count() === 1 && await keyboard.getByRole("textbox", { name: "Email" }).count() === 1 && await keyboard.getByRole("textbox", { name: "Anything else? (optional)" }).count() === 1);
        check("keyboard: after the fallback the cursor goes to the form's first field", await activeIn() === "name", await activeIn());
        const required = await widget(keyboard, "return ['name', 'email'].every(name => root.querySelector(`.contact-form [name=${name}]`).required) && root.querySelector('.contact-form [name=additional]').required === false;");
        check("screen reader: required fields are marked", required);

        // An empty submit: errors are tied to the fields, and the cursor goes to the first one.
        await keyboard.getByRole("button", { name: "Send question" }).focus();
        await keyboard.keyboard.press("Enter");
        const invalid = await widget(keyboard, "const f = root.querySelector('.contact-form [name=name]'); const e = root.getElementById(f.getAttribute('aria-describedby')); return { invalid: f.getAttribute('aria-invalid'), error: e && e.textContent, focused: root.activeElement === f };");
        check("form: an empty name is explained next to the field and read out", invalid.invalid === "true" && /enter your name/i.test(invalid.error) && invalid.focused, JSON.stringify(invalid));
        await keyboard.keyboard.type("Kim Visitor");
        await keyboard.keyboard.press("Tab");
        await keyboard.keyboard.type("kim@example.test");
        await keyboard.keyboard.press("Tab");
        await keyboard.keyboard.type("It is a small scooter.");
        await keyboard.keyboard.press("Tab");
        check("keyboard: Tab moves through the fields to Submit", await widget(keyboard, "return root.activeElement && root.activeElement.className;") === "contact-send");
        await keyboard.keyboard.press("Enter");
        await keyboard.waitForFunction(() => document.querySelector("#ai-website-chatbot-widget").shadowRoot.querySelector(".contact-done"), null, { timeout: 30000, polling: 200 });
        check("form: the visitor sees the saved message", /received and saved/i.test(await widget(keyboard, "return root.querySelector('.contact-done').textContent;")));
        const stored = (await pool.query("SELECT chatbot_id, name, email, question, email_status FROM enquiries WHERE email = 'kim@example.test'")).rows;
        check("enquiry: stored once, for the garage's chatbot, with the original question", stored.length === 1 && stored[0].chatbot_id === ids.garage && stored[0].question === QUESTION && stored[0].name === "Kim Visitor", JSON.stringify(stored).slice(0, 150));
        check("enquiry: nothing was stored for the bakery's chatbot or from the refused site", (await pool.query("SELECT count(*)::int n FROM enquiries WHERE chatbot_id = $1", [ids.bakery])).rows[0].n === 0);
        await keyboard.close();

        // ---- A 375 px phone, on the site with the most hostile styles ----
        const phone = await open(browser, `${originOf("bakery")}/customer`, { viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true });
        const launcherBox = await widget(phone, "const b = root.querySelector('.launcher').getBoundingClientRect(); return { width: b.width, height: b.height, right: b.right, bottom: b.bottom };");
        check("phone: the launcher is big enough to tap and on the screen", launcherBox.width >= 44 && launcherBox.height >= 44 && launcherBox.right <= 375 && launcherBox.bottom <= 667, JSON.stringify(launcherBox));
        await widget(phone, "root.querySelector('.launcher').click();");
        reply = await ask(phone, "Do you sell wedding cakes?");
        check("phone: unanswered shows the form", reply.answer === NOT_FOUND && reply.hasForm, reply.error || reply.answer);
        const fit = await widget(phone, `const panel = root.querySelector('.panel').getBoundingClientRect(); const form = root.querySelector('.contact-form').getBoundingClientRect(); const msgs = root.querySelector('.msgs');
            return { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom, formRight: form.right, overflow: msgs.scrollWidth - msgs.clientWidth, field: getComputedStyle(root.querySelector('.contact-form input')).fontSize, question: getComputedStyle(root.querySelector('.composer textarea')).fontSize };`);
        check("phone: the panel and form fit a 375 px screen", fit.left >= 0 && fit.right <= 375 && fit.top >= 0 && fit.bottom <= 667 && fit.formRight <= fit.right && fit.overflow <= 0, JSON.stringify(fit));
        check("phone: text boxes are 16 px, so the phone does not zoom the page", fit.field === "16px" && fit.question === "16px", JSON.stringify(fit));
        const pageWidth = await phone.evaluate(() => document.documentElement.scrollWidth);
        check("phone: the widget adds no sideways scrolling to the page", pageWidth <= 375, pageWidth);
        await phone.close();

        check("no JavaScript errors on the customer pages", errors.length === 0, errors.join(" | "));
    } catch (error) {
        check("unexpected test error", false, error.message);
    } finally {
        console.log = log;
        await browser.close();
        const list = Object.values(ids);
        await fetch(`${QDRANT}/delete?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "chatbotId", match: { any: list } }] } }) }).catch(() => {});
        await pool.query("DELETE FROM enquiries WHERE chatbot_id = ANY($1)", [list]).catch(() => {});
        await pool.query("DELETE FROM crawl_urls WHERE chatbot_id = ANY($1)", [list]).catch(() => {});
        await pool.query("DELETE FROM chatbots WHERE id = ANY($1)", [list]).catch(() => {});
        for (const server of Object.values(sites)) { server.closeAllConnections(); server.close(); }
    }
    for (const r of results) console.log(`${r.result}  ${r.test}${r.result === "FAIL" && r.note ? `  [${r.note}]` : ""}`);
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    await pool.end();
    process.exit(failed ? 1 : 0);
})().catch(error => {
    console.error("test error:", error.message);
    process.exit(2);
});
