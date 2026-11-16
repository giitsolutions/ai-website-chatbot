// Support email suggestions: two customers, each with a local fixture website crawled for real through
// the real server route (POST /api/website). Proves: mailto, footer text, JSON-LD and a contact page are
// found; ranking; no candidate -> nothing shown; addresses on other websites (linked pages, redirects, iframes),
// in scripts and comments, of an article's author and samples are ignored; at most 5; full addresses are never
// logged; a crawl never changes the support email; customer A never sees B's suggestions or support email (404).
// Dashboard in a real browser at 375 px: "Use this" only fills the field, Save settings stores it.
// ISOLATED: runs only through tests/run-isolated.js. Fixture sites and the server run IN THIS PROCESS on free
// ports (never 3000-3005 or 5050); only the fixture origins are allow-listed and pinned to 127.0.0.1, so
// nothing outside this machine is contacted. Embeddings are stubbed: no model is needed. Email is fake and
// nothing is sent. Run: npm run test:support-email
"use strict";
const fs = require("fs"), path = require("path"), net = require("net"), http = require("http"), crypto = require("crypto"), Module = require("module");
const { assertIsolated } = require("./support/isolated-env");

const projectDir = path.join(__dirname, "..");
const RESERVED_PORTS = new Set([3000, 3001, 3002, 3003, 3004, 3005, 5050]);
const cheerio = require(require.resolve("cheerio", { paths: [projectDir] }));

const results = [];
function check(name, ok, note = "") {
    results.push({ test: name, result: ok ? "PASS" : "FAIL" });
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${note && !ok ? `\n     ${String(note).replace(/\s+/g, " ").slice(0, 500)}` : ""}\n`);
}

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

// Loads a project file with a test-only patch (cached, so server.js uses the patched module).
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

const WORDS = "Ordinary website text that the crawler reads from every page of this fixture website for its visitors. ".repeat(8);
const page = (title, main, { footer = "", head = "" } = {}) => `<!doctype html><html><head><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>${WORDS}</p>${main}</main><footer>${footer}</footer></body></html>`;
const SITE_HOSTS = ["shop-a.test", "shop-b.test", "none.test", "spa-shop.test", "other-site.test"];

(async () => {
    const sitePort = await freePort();
    const origin = host => `http://${host}:${sitePort}`;
    const siteHits = {};
    const site = http.createServer((req, res) => {
        const host = String(req.headers.host || "").split(":")[0];
        const route = new URL(req.url, "http://x").pathname;
        (siteHits[host] = siteHits[host] || []).push(route);
        const html = body => { res.setHeader("Content-Type", "text/html"); res.end(body); };
        if (route === "/robots.txt" || route === "/sitemap.xml") { res.writeHead(404); return res.end(); }
        if (host === "shop-a.test") {
            const jsonLd = `<script type="application/ld+json">${JSON.stringify([
                { "@type": "Organization", name: "Shop A", contactPoint: { "@type": "ContactPoint", email: "mailto:support@shop-a.test" } },
                { "@type": "Person", name: "An author", email: "author@shop-a.test" }
            ])}</script><script type="application/ld+json">{not valid json</script>`;
            const footer = `<p>Write to info@shop-a.test</p><p>noreply@shop-a.test you@example.com logo@2x.png</p><script>var x = "script@shop-a.test";</script><!-- comment@shop-a.test -->`;
            if (route === "/contact") return html(page("Contact", `<p>Ask help@shop-a.test or owner.shop.a@gmail.com.</p><a href="mailto:contact@shop-a.test?subject=Hello">Write</a>`));
            if (route === "/blog") return html(page("Blog", "<p>A reader wrote from reader@shop-a.test about this article.</p>", { footer: "<p>INFO@Shop-A.test</p>" }));
            if (route === "/moved") { res.writeHead(302, { Location: `${origin("other-site.test")}/landing` }); return res.end(); }
            return html(page("Shop A", `<a href="mailto:hello@shop-a.test">Say hello</a><a href="/contact">Contact</a><a href="/blog">Blog</a><a href="/moved">Moved</a><a href="${origin("other-site.test")}/partner">Partner</a><iframe src="${origin("other-site.test")}/frame"></iframe>`, { footer, head: jsonLd }));
        }
        if (host === "shop-b.test") {
            if (route === "/about") return html(page("About", "<p>Our team: team [at] shop-b [dot] test. Visit us at shop-b.test any day.</p>"));
            return html(page("Shop B", `<a href="/about">About</a><section id="contact-us"><span>desk@shop-b.test</span><span>Call us</span></section>`, { footer: "<p>shopb.owner@gmail.com</p>" }));
        }
        if (host === "none.test") return html(page("No Address", `<a href="${origin("other-site.test")}/partner">Partner</a>`, { footer: "<p>All rights reserved.</p>" }));
        if (host === "spa-shop.test") {
            if (route === "/app.js") { res.setHeader("Content-Type", "text/javascript"); return res.end(`document.getElementById("root").innerHTML = ${JSON.stringify(`<main><h1>Spa Shop</h1><p>${WORDS}</p></main><footer><a href="mailto:care@spa-shop.test">Care team</a></footer>`)};`); }
            return html(`<!doctype html><html><head><title>Spa Shop</title></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>`);
        }
        if (host === "other-site.test") return html(page("Another website", `<a href="mailto:stolen@other-site.test">Mail</a><p>stolen2@other-site.test</p>`, { footer: "<p>stolen3@other-site.test</p>" }));
        res.writeHead(404);
        res.end();
    });
    await new Promise(resolve => site.listen(sitePort, "127.0.0.1", resolve));

    const KEY = crypto.randomBytes(32).toString("hex");
    process.env.ADMIN_API_KEY = KEY;
    process.env.ADMIN_API_KEYS = "";
    process.env.TRUST_PROXY = "1"; // each request has its own X-Forwarded-For (own rate-limit budget)
    delete process.env.COOKIE_SECURE;
    const port = await freePort();
    process.env.PORT = String(port);

    const pool = require(path.join(projectDir, "dbPool"));
    const isolation = await assertIsolated(pool); // throws (nothing written) unless isolated
    console.log(`isolated environment: database ${isolation.database}, collection ${isolation.collection}`);
    const allowed = JSON.stringify(SITE_HOSTS.map(origin));
    loadPatched("chatbotRegistry.js", src => src.replace("async function assertPublicWebsiteUrl(parsedUrl) {",
        match => `${match}\r\n    if (/\\.test$/.test(parsedUrl.hostname)) return;`));
    const { findSupportEmails, rankSupportEmails } = loadPatched("ingest.js", src => src
        .replace("async function assertPublicHttpUrl(rawUrl) {", match => `${match}
    try {
        const parsedTestUrl = new URL(rawUrl);
        if (${allowed}.includes(parsedTestUrl.origin)) return Object.assign(parsedTestUrl, { publicAddresses: [{ address: "127.0.0.1", family: 4 }] });
    } catch {}`)
        .replace("async function createEmbeddings(texts) {", match => `${match}
    return texts.map(text => { const digest = crypto.createHash("sha256").update(text).digest(); return Array.from({ length: 768 }, (_, i) => (digest[i % 32] + 1) / 256); });`));
    const log = console.log, warn = console.warn, error = console.error;
    const logged = [];
    const capture = (...args) => logged.push(args.map(String).join(" "));
    console.log = capture; console.warn = capture; console.error = capture;
    require(path.join(projectDir, "server.js"));
    const BASE = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(BASE + "/api/health")).ok) break; } catch {}
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    let ip = 0;
    const call = async (method, route, body, { key, cookie } = {}) => {
        const headers = { "X-Forwarded-For": `198.51.100.${(++ip % 250) + 1}` };
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (key) headers["x-admin-api-key"] = key;
        if (cookie) headers.Cookie = cookie;
        const r = await fetch(BASE + route, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { status: r.status, json, text, setCookie: r.headers.get("set-cookie") || "" };
    };
    const login = async (email, password) => {
        const r = await call("POST", "/api/auth/login", { email, password });
        return r.setCookie.match(/cb_session=[A-Za-z0-9_-]{43}/)?.[0] || null;
    };
    const detail = (id, auth) => call("GET", `/api/admin/chatbots/${id}`, undefined, auth);
    const idle = async (id, auth) => {
        for (let i = 0; i < 240; i++) {
            const r = await detail(id, auth);
            if (r.status === 200 && r.json.chatbot.progress?.state !== "running") return r;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        throw new Error("indexing did not finish in 2 minutes");
    };
    const crawl = async (id, auth) => {
        const r = await call("POST", "/api/website", { chatbotId: id, reindex: true, async: true, maxPages: 10 }, auth);
        if (r.status !== 202) throw new Error(`crawl not started: ${r.status} ${r.text.slice(0, 200)}`);
        return idle(id, auth);
    };
    const supportEmailOf = async id => (await pool.query("SELECT support_email FROM chatbots WHERE id = $1", [id])).rows[0].support_email;
    const addressesOf = response => (response.json.chatbot.crawlReport?.supportEmailCandidates || []).map(item => item.address);

    const A1 = crypto.randomUUID(), A2 = crypto.randomUUID(), B1 = crypto.randomUUID(), B2 = crypto.randomUUID();
    const chatbotIds = [A1, A2, B1, B2];
    const accountIds = [];
    const EMAIL_A = "owner-a@customers-test.example", EMAIL_B = "owner-b@customers-test.example";
    const PASSWORD_A = `pw-A-${crypto.randomBytes(12).toString("base64url")}`, PASSWORD_B = `pw-B-${crypto.randomBytes(12).toString("base64url")}`;
    const KEEP = "keep@spa-shop.test";
    let browser = null;

    try {
        // ================= Reading one page, without a browser =================
        const of = (html, url = "https://site.test/") => findSupportEmails(cheerio.load(html), url);
        const addresses = list => list.map(item => item.address).join(" ");
        check("obfuscated: [at] and (at) with a real dot", addresses(of("<footer>info [at] site.test, sales (at) site.test</footer>")) === "info@site.test sales@site.test", addresses(of("<footer>info [at] site.test, sales (at) site.test</footer>")));
        check("obfuscated: [at] with [dot]", addresses(of("<footer>help [at] my-site [dot] co [dot] test</footer>")) === "help@my-site.co.test", addresses(of("<footer>help [at] my-site [dot] co [dot] test</footer>")));
        check("obfuscated: plain words are NOT read as an address (\"visit us at site.test\", \"info at site dot test\")", of("<footer>Visit us at site.test. Or info at site dot test.</footer>").length === 0, addresses(of("<footer>Visit us at site.test. Or info at site dot test.</footer>")));
        check("text outside the footer, contact and about parts is not read", of("<main><p>person@site.test wrote this.</p></main><footer>Nothing</footer>").length === 0);
        check("neighbouring elements do not glue onto the address", addresses(of("<footer><span>desk@site.test</span><span>Call us</span></footer>")) === "desk@site.test", addresses(of("<footer><span>desk@site.test</span><span>Call us</span></footer>")));
        check("a mailto link with an encoded address and a subject", addresses(of('<a href="MAILTO:desk%40site.test?subject=Hi">x</a>')) === "desk@site.test", addresses(of('<a href="MAILTO:desk%40site.test?subject=Hi">x</a>')));
        check("a page's document is not changed (links are still found afterwards)", (() => { const $ = cheerio.load("<footer><a href='/x'>desk@site.test</a></footer>"); findSupportEmails($, "https://site.test/"); return $("footer a[href='/x']").length === 1; })());
        const item = (address, source = "footer") => ({ address, source, url: "https://site.test/" });
        const ranked = rankSupportEmails(["owner@gmail.com", "sales@site.test", "info@site.test", "contact@site.test", "help@site.test", "support@site.test", "extra@site.test"].map(a => item(a)), "www.site.test");
        check("ranking: own domain support, help, contact, info, then other own addresses; at most 5", ranked.map(x => x.address).join(" ") === "support@site.test help@site.test contact@site.test info@site.test sales@site.test", ranked.map(x => x.address).join(" "));
        const others = rankSupportEmails([item("owner@gmail.com"), item("desk@mail.site.test"), item("x@site.test")], "site.test");
        check("ranking: subdomain counts as the site's own; another domain comes last", others.map(x => x.address).join(" ") === "desk@mail.site.test x@site.test owner@gmail.com" && others[2].ownDomain === false && others[0].ownDomain === true, others.map(x => x.address).join(" "));
        const merged = rankSupportEmails([item("Desk@site.test"), item("desk@site.test", "structured-data")], "site.test");
        check("ranking: one entry per address (any case), with its strongest evidence", merged.length === 1 && merged[0].source === "structured-data", JSON.stringify(merged));

        // ================= Two customers, each with their own chatbots =================
        let r = await call("POST", "/api/admin/accounts", { email: EMAIL_A, password: PASSWORD_A }, { key: KEY });
        const A = r.json?.account?.id;
        r = await call("POST", "/api/admin/accounts", { email: EMAIL_B, password: PASSWORD_B }, { key: KEY });
        const B = r.json?.account?.id;
        accountIds.push(A, B);
        await pool.query(
            `INSERT INTO chatbots (id, website_url, allowed_domain, status, owner_account_id, display_name, support_email) VALUES
             ($1, $5, 'shop-a.test', 'ready', $9, 'Bot Shop A', NULL), ($2, $6, 'none.test', 'ready', $9, 'Bot No Address', NULL),
             ($3, $7, 'shop-b.test', 'ready', $10, 'Bot Shop B', NULL), ($4, $8, 'spa-shop.test', 'ready', $10, 'Bot Spa Shop', $11)`,
            [A1, A2, B1, B2, `${origin("shop-a.test")}/`, `${origin("none.test")}/`, `${origin("shop-b.test")}/`, `${origin("spa-shop.test")}/`, A, B, KEEP]);
        const COOKIE_A = await login(EMAIL_A, PASSWORD_A), COOKIE_B = await login(EMAIL_B, PASSWORD_B);
        check("setup: both customers are logged in", Boolean(COOKIE_A && COOKIE_B));
        const asA = { cookie: COOKIE_A }, asB = { cookie: COOKIE_B }, asAdmin = { key: KEY };

        // ================= Real crawls through the server =================
        const crawledA = await crawl(A1, asA);
        const expectedA = "support@shop-a.test help@shop-a.test contact@shop-a.test info@shop-a.test hello@shop-a.test";
        check("site A: JSON-LD contactPoint, contact page text, mailto and footer found, ranked, at most 5", addressesOf(crawledA).join(" ") === expectedA, addressesOf(crawledA).join(" "));
        const candidatesA = crawledA.json.chatbot.crawlReport.supportEmailCandidates;
        const sourceOf = address => candidatesA.find(x => x.address === address)?.source;
        check("site A: each candidate says where it was found", sourceOf("support@shop-a.test") === "structured-data" && sourceOf("help@shop-a.test") === "contact-page" && sourceOf("contact@shop-a.test") === "mailto" && sourceOf("info@shop-a.test") === "footer" && sourceOf("hello@shop-a.test") === "mailto", JSON.stringify(candidatesA));
        check("site A: each candidate names its page, on this website", candidatesA.every(x => new URL(x.url).hostname === "shop-a.test") && new URL(candidatesA[1].url).pathname === "/contact", JSON.stringify(candidatesA));
        check("site A: the same address in another case is not repeated", addressesOf(crawledA).filter(x => x.toLowerCase() === "info@shop-a.test").length === 1);
        const reportA = crawledA.text;
        check("other websites: a linked page, a redirect target and an iframe add nothing", !/stolen/.test(reportA) && (siteHits["other-site.test"] || []).includes("/landing"), (siteHits["other-site.test"] || []).join(" "));
        check("ignored: an author (Person), article text, scripts, comments, no-reply, samples and file names", !/author@|reader@|script@|comment@|noreply@|you@example|logo@2x/.test(reportA), addressesOf(crawledA).join(" "));

        const crawledB = await crawl(B1, asB);
        const candidatesB = crawledB.json.chatbot.crawlReport.supportEmailCandidates;
        check("site B: own addresses first (contact section, obfuscated on the about page), then the gmail address from the footer",
            addressesOf(crawledB).join(" ") === "desk@shop-b.test team@shop-b.test shopb.owner@gmail.com" && candidatesB.map(x => x.source).join(" ") === "contact-section about-page footer" && candidatesB.map(x => x.ownDomain).join(" ") === "true true false", JSON.stringify(candidatesB));

        const crawledNone = await crawl(A2, asA);
        check("no candidate: an empty list, even with a link to another website", crawledNone.json.chatbot.crawlReport.supportEmailCandidates.length === 0, crawledNone.text.slice(0, 200));

        const crawledSpa = await crawl(B2, asB);
        check("script-rendered footer: its mailto link is found", addressesOf(crawledSpa).join(" ") === "care@spa-shop.test", addressesOf(crawledSpa).join(" "));

        // ================= Set by the first index, never replaced =================
        check("first index: uses the best address on the website's own domain", (await supportEmailOf(A1)) === "support@shop-a.test" && (await supportEmailOf(B1)) === "desk@shop-b.test", `${await supportEmailOf(A1)} ${await supportEmailOf(B1)}`);
        check("no address on the website: stays empty", (await supportEmailOf(A2)) === null);
        check("a crawl never replaces a support email", (await supportEmailOf(B2)) === KEEP);
        // An owner who removes the address keeps it removed. The checks below start from no address.
        await pool.query("UPDATE chatbots SET support_email = NULL WHERE id = ANY($1)", [[A1, B1]]);
        await crawl(A1, asA);
        check("re-index: does not bring back an address that was removed", (await supportEmailOf(A1)) === null, await supportEmailOf(A1));
        check("the chatbot settings show the address after the first index", crawledA.json.chatbot.settings.supportEmail === "support@shop-a.test", crawledA.json.chatbot.settings.supportEmail);

        // ================= Chosen pages do not touch the suggestions =================
        r = await call("POST", `/api/admin/chatbots/${A1}/crawl-urls/index`, { urls: [`${origin("shop-a.test")}/blog`] }, asA);
        check("chosen page crawl accepted", r.status === 202, `${r.status} ${r.text.slice(0, 200)}`);
        const afterChosen = await idle(A1, asA);
        check("chosen page crawl: the suggestions of the last full crawl stay as they were", addressesOf(afterChosen).join(" ") === expectedA, addressesOf(afterChosen).join(" "));

        // ================= Isolation =================
        const addressesA = /@shop-a\.test/, addressesB = /@shop-b\.test|shopb\.owner/;
        await pool.query("UPDATE chatbots SET support_email = 'private-a@shop-a.test' WHERE id = $1", [A1]);
        await pool.query("UPDATE chatbots SET support_email = 'private-b@shop-b.test' WHERE id = $1", [B1]);
        r = await detail(B1, asA);
        check("customer A: B's chatbot answers 404, with none of its addresses", r.status === 404 && !addressesB.test(r.text), `${r.status} ${r.text.slice(0, 200)}`);
        r = await detail(A1, asB);
        check("customer B: A's chatbot answers 404, with none of its addresses", r.status === 404 && !addressesA.test(r.text), `${r.status} ${r.text.slice(0, 200)}`);
        r = await call("GET", `/api/admin/chatbots/${B1}/crawl-urls`, undefined, asA);
        check("customer A: B's crawl report 404", r.status === 404 && !addressesB.test(r.text), `${r.status}`);
        r = await call("GET", `/api/admin/chatbots/${B1}/enquiries`, undefined, asA);
        check("customer A: B's enquiries (they show the support email) 404", r.status === 404 && !addressesB.test(r.text), `${r.status}`);
        r = await call("PATCH", `/api/admin/chatbots/${B1}`, { supportEmail: "attacker@shop-a.test" }, asA);
        check("customer A: cannot change B's support email (404, unchanged)", r.status === 404 && (await supportEmailOf(B1)) === "private-b@shop-b.test", `${r.status}`);
        r = await call("POST", "/api/website", { chatbotId: B1, reindex: true, async: true }, asA);
        check("customer A: cannot crawl B's chatbot (404)", r.status === 404, `${r.status}`);
        r = await call("GET", "/api/admin/chatbots", undefined, asA);
        check("customer A: the chatbot list has only A's chatbots and none of B's addresses", r.status === 200 && r.json.chatbots.map(x => x.id).sort().join() === [A1, A2].sort().join() && !addressesB.test(r.text), r.text.slice(0, 200));
        r = await detail(A1, asA);
        check("customer A: own chatbot shows own suggestions and own support email only", r.status === 200 && r.json.chatbot.settings.supportEmail === "private-a@shop-a.test" && addressesOf(r).join(" ") === expectedA && !addressesB.test(r.text), r.text.slice(0, 200));
        r = await detail(B1, asAdmin);
        const adminA = await detail(A1, asAdmin);
        check("platform admin: sees the suggestions of both customers", addressesOf(r).includes("desk@shop-b.test") && addressesOf(adminA).includes("support@shop-a.test"));
        r = await detail(A1, {});
        check("logged out: 401, no addresses", r.status === 401 && !addressesA.test(r.text), `${r.status}`);
        r = await call("GET", `/api/chatbots/${A1}/config`);
        check("public widget config: neither the suggestions nor the support email", r.status === 200 && !addressesA.test(r.text), r.text.slice(0, 200));
        await pool.query("UPDATE chatbots SET support_email = NULL WHERE id = ANY($1::uuid[])", [[A1, B1]]);

        // ================= Every suggestion can really be saved =================
        for (const candidate of [...candidatesA, ...candidatesB]) {
            r = await call("PATCH", `/api/admin/chatbots/${A2}`, { supportEmail: candidate.address }, asA);
            check(`the settings check accepts a suggestion (${candidate.source})`, r.status === 200 && r.json.chatbot.settings.supportEmail === candidate.address, r.text.slice(0, 200));
        }
        await pool.query("UPDATE chatbots SET support_email = NULL WHERE id = $1", [A2]);

        // ================= Dashboard in a real browser (375 px) =================
        const { chromium } = require("playwright");
        browser = await chromium.launch({ headless: true });
        const pageErrors = [];
        const openPage = async () => {
            const context = await browser.newContext({ viewport: { width: 375, height: 760 } });
            const ui = await context.newPage();
            ui.on("pageerror", failure => pageErrors.push(failure.message));
            await ui.goto(BASE + "/");
            await ui.waitForLoadState("networkidle");
            return ui;
        };
        const customerLogin = async (ui, email, password) => {
            await ui.fill("#loginEmail", email);
            await ui.fill("#loginPassword", password);
            await ui.click("#loginForm button");
            await ui.waitForSelector("#chatbotList .bot");
        };
        // The support email has its own card in Overview. A chatbot being open hides the list: go back to it first.
        const openSupportEmail = async (ui, name) => {
            if (!(await ui.isVisible("#listSection"))) await ui.selectOption("#chatbotSelect", "");
            await ui.locator("#chatbotList .bot", { hasText: name }).locator("button", { hasText: "Manage" }).click();
            await ui.click("#t-overview");
            await ui.waitForLoadState("networkidle");
        };
        const suggestions = ui => ui.$$eval("#supportEmailSuggestions p", rows => rows.map(row => row.textContent));
        const customerA = await openPage();
        await customerLogin(customerA, EMAIL_A, PASSWORD_A);
        await openSupportEmail(customerA, "Bot No Address");
        check("dashboard: no candidate, nothing shown", (await suggestions(customerA)).length === 0 && !/Found on your website/.test(await customerA.textContent("#tab-overview")));
        await openSupportEmail(customerA, "Bot Shop A");
        const shownA = await suggestions(customerA);
        check("dashboard: customer A sees the suggestions in rank order", shownA.length === 5 && shownA[0].startsWith("Found on your website: support@shop-a.test (from the site's structured data on /)"), shownA.join(" | "));
        check("dashboard: the wording names where it was found (contact page, email link, footer)", shownA[1].includes("help@shop-a.test (from the contact page /contact)") && shownA[2].includes("contact@shop-a.test (from an email link on /contact)") && shownA[3].includes("info@shop-a.test (from the footer of /)"), shownA.join(" | "));
        check("dashboard: every suggestion has a Use this button", (await customerA.$$eval("#supportEmailSuggestions button", buttons => buttons.map(b => b.textContent))).join() === Array(5).fill("Use this").join());
        check("dashboard: the field is still empty before Use this", (await customerA.inputValue("#setSupportEmail")) === "");
        check("dashboard: no sideways scrolling at 375 px", await customerA.evaluate(() => document.documentElement.scrollWidth <= 375));
        const writes = [];
        customerA.on("request", request => { if (request.method() !== "GET") writes.push(request.url()); });
        await customerA.click("#supportEmailSuggestions p:nth-child(2) button");
        check("Use this: fills the field", (await customerA.inputValue("#setSupportEmail")) === "help@shop-a.test");
        check("Use this: tells the user it is not saved yet", /Not saved yet/.test(await customerA.textContent("#supportMessage")));
        await new Promise(resolve => setTimeout(resolve, 400));
        check("Use this: sends nothing to the server and saves nothing", writes.length === 0 && (await supportEmailOf(A1)) === null, writes.join(" "));
        await customerA.click("#saveSupportEmail");
        await customerA.waitForFunction(() => /saved/i.test(document.querySelector("#supportMessage").textContent) && !/Not saved/.test(document.querySelector("#supportMessage").textContent));
        check("Save settings: stores the chosen address for this chatbot only", (await supportEmailOf(A1)) === "help@shop-a.test" && (await supportEmailOf(A2)) === null && (await supportEmailOf(B1)) === null);
        await openSupportEmail(customerA, "Bot No Address");
        check("dashboard: switching chatbot removes the other chatbot's suggestions and address", (await suggestions(customerA)).length === 0 && (await customerA.inputValue("#setSupportEmail")) === "");
        await openSupportEmail(customerA, "Bot Shop A");
        check("dashboard: the saved address is no longer suggested; the others are", (await suggestions(customerA)).length === 4 && !(await suggestions(customerA)).join().includes("help@shop-a.test") && (await customerA.inputValue("#setSupportEmail")) === "help@shop-a.test", (await suggestions(customerA)).join(" | "));

        const customerB = await openPage();
        await customerLogin(customerB, EMAIL_B, PASSWORD_B);
        await openSupportEmail(customerB, "Bot Shop B");
        const shownB = await suggestions(customerB);
        check("dashboard: customer B sees B's suggestions only, including the other-domain address last", shownB.length === 3 && shownB[2].includes("shopb.owner@gmail.com (from the footer of /)") && !/shop-a/.test(await customerB.textContent("body")), shownB.join(" | "));

        const admin = await openPage();
        await admin.click("#showAdminKey");
        await admin.fill("#adminKey", KEY);
        await admin.click("#keyForm button");
        await admin.waitForSelector("#chatbotList .bot >> text=Bot Shop B");
        await openSupportEmail(admin, "Bot Shop B");
        const shownAdmin = await suggestions(admin);
        check("dashboard: the platform admin gets the same suggestions and button", shownAdmin.join() === shownB.join(), shownAdmin.join(" | "));
        await admin.click("#supportEmailSuggestions p:nth-child(1) button");
        check("dashboard, admin: Use this only fills the field here too", (await admin.inputValue("#setSupportEmail")) === "desk@shop-b.test" && (await supportEmailOf(B1)) === null);
        check("dashboard: no script errors", pageErrors.length === 0, pageErrors.join(" | "));

        // ================= Logs =================
        const allLogs = logged.join("\n");
        check("logs: never a full found address", !/[a-z0-9._+-]+@(?:[a-z0-9-]+\.)*(?:shop-a|shop-b|spa-shop|other-site)\.test|[a-z0-9._+-]+@gmail\.com/i.test(allLogs), (allLogs.match(/\S+@\S+/g) || []).slice(0, 5).join(" "));
        check("logs: the candidates are reported by domain", /Support email candidates: 5 \(shop-a\.test\)/.test(allLogs) && /Support email candidates: 3 \(shop-b\.test, gmail\.com\)/.test(allLogs), allLogs.split("\n").filter(line => /candidates/.test(line)).join(" | "));

        // ================= Removal =================
        r = await call("DELETE", `/api/admin/chatbots/${B1}/website-content`, { confirm: B1 }, asB);
        const removed = await detail(B1, asB);
        check("removing the website content removes the suggestions too", r.status === 200 && removed.json.chatbot.crawlReport === null, `${r.status} ${r.text.slice(0, 200)}`);
    } catch (failure) {
        check("test run finished without an unexpected error", false, failure.stack || failure.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
        for (const id of chatbotIds) await call("DELETE", `/api/admin/chatbots/${id}`, { confirm: id }, { key: KEY }).catch(() => {});
        for (const id of chatbotIds) await pool.query("DELETE FROM chatbots WHERE id = $1", [id]).catch(() => {});
        for (const id of accountIds.filter(Boolean)) await pool.query("DELETE FROM accounts WHERE id = $1", [id]).catch(() => {});
        const left = (await pool.query("SELECT (SELECT count(*) FROM chatbots) + (SELECT count(*) FROM accounts) + (SELECT count(*) FROM sessions) AS n")).rows[0].n;
        const vectors = (await (await fetch(`http://localhost:6333/collections/${process.env.QDRANT_COLLECTION}/points/count`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ exact: true, filter: { must: [{ key: "chatbotId", match: { any: chatbotIds } }] } })
        })).json()).result?.count;
        check("cleanup: no chatbots, accounts, sessions or vectors of this run left", Number(left) === 0 && vectors === 0, `rows ${left}, vectors ${vectors}`);
        console.log = log; console.warn = warn; console.error = error;
        site.closeAllConnections();
        site.close();
        const failed = results.filter(x => x.result !== "PASS").length;
        console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
        process.exit(failed ? 1 : 0);
    }
})();
