// Clicking menu buttons (local only: no database, no Qdrant, no model, no live site).
// One local server on a random port answers by host name: menu.test (an app whose menu is buttons),
// many.test (40 menu buttons), links.test (an ordinary site with links and a few menu buttons) and
// other.test (another domain that must never be reached). The SSRF check is allow-listed for exactly
// these origins and pinned to 127.0.0.1, so nothing outside this machine is contacted.
// Covers: off by default; new text added to the start page; a new address queued; actions, form
// buttons, page-content buttons and disabled buttons never clicked; POST requests and moves to another
// website blocked; new windows closed; a hung view; the 30-click limit; chosen pages; ordinary sites.
// Run: npm run test:button-discovery
const fs = require("fs"), path = require("path"), http = require("http"), Module = require("module");

const projectDir = path.join(__dirname, "..");
const ingestPath = path.join(projectDir, "ingest.js");
const RESERVED_PORTS = new Set([3000, 3001, 3002, 3003, 3004, 3005, 5050]);

const results = [];
const record = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 160) });

const SHELL = script => `<!doctype html><html><head><title>Button App</title></head><body><div id="root"></div><script type="module" src="${script}"></script></body></html>`;

(async () => {
    const hits = {};
    const hungResponses = [];
    let port = 0;
    const origin = host => `http://${host}:${port}`;
    const server = http.createServer((req, res) => {
        const host = String(req.headers.host || "").split(":")[0];
        const u = new URL(req.url, "http://x");
        (hits[host] = hits[host] || []).push(`${req.method} ${u.pathname}`);
        const send = (type, body) => { res.setHeader("Content-Type", type); res.end(body); };
        const notFound = () => { res.writeHead(404); res.end(); };
        if (u.pathname === "/robots.txt" || u.pathname === "/sitemap.xml") return notFound();

        if (host === "menu.test") {
            if (u.pathname === "/api/never") { hungResponses.push(res); return; }
            if (u.pathname.startsWith("/api/")) return send("application/json", "{}");
            if (u.pathname === "/assets/app.js") {
                return send("text/javascript", `
                    const $ = id => document.getElementById(id);
                    const OTHER = ${JSON.stringify(origin("other.test"))};
                    const faq = '<h1>FAQ</h1><p>FAQ-MARKER Rentals can be paused once every month at no cost.</p>';
                    document.getElementById("root").innerHTML =
                        '<nav><button id="t">Treadmills</button><button id="f">FAQ</button><button id="s">Sign up</button>' +
                        '<button id="n">Newsletter</button><button id="p">Partner</button><button id="o">Open window</button>' +
                        '<button id="h">Slow view</button><button id="z">Nothing</button><button id="l">Cards view</button><button id="a">Added cards</button></nav>' +
                        (location.pathname === "/faq" ? '<main>' + faq + '</main>'
                            : '<main><h1>Home</h1><p>HOME-MARKER Premium equipment delivered to your door every single day.</p><button id="c">Content button inside the page</button><h3>Shared Card</h3><p>Shared card text.</p></main>') +
                        '<footer><form><button id="j">Join club</button></form><button id="d" disabled>Disabled one</button><p>Call us any day.</p></footer>';
                    const show = html => { document.querySelector("main").innerHTML = html; };
                    const hit = name => fetch("/api/clicked-" + name);
                    $("t").onclick = () => show('<h1>Treadmills</h1><p>TREADMILL-MARKER The T-15 model takes a maximum user weight of 120 Kg.</p>');
                    $("f").onclick = () => { history.pushState({}, "", "/faq"); show(faq); };
                    $("s").onclick = () => hit("signup");
                    $("n").onclick = () => { fetch("/api/track", { method: "POST", body: "x" }).catch(() => {}); show('<h1>Newsletter</h1><p>NEWS-MARKER Our monthly newsletter shares new workout tips.</p>'); };
                    $("p").onclick = () => { location.href = OTHER + "/partner"; };
                    $("o").onclick = () => { window.open(OTHER + "/popup"); };
                    $("h").onclick = () => { fetch("/api/never").catch(() => {}); show('<h1>Slow</h1><p>SLOW-MARKER This view waits for a request that never ends.</p>'); };
                    $("z").onclick = () => {};
                    $("l").onclick = () => show('<h1>Cards view</h1><p>Choose one.</p><h3>Shared Card</h3><p>Shared card text.</p><h3>Card Two</h3><p>Two text.</p>');
                    $("a").onclick = () => { document.querySelector("main").insertAdjacentHTML("beforeend", '<h3>Added One</h3><p>One text.</p><h3>Added Two</h3><p>Two more text.</p>'); };
                    $("j").onclick = event => { event.preventDefault(); hit("form"); };
                    $("d").onclick = () => hit("disabled");
                    if ($("c")) $("c").onclick = () => hit("content");`);
            }
            return send("text/html", SHELL("/assets/app.js"));
        }

        if (host === "many.test") {
            if (u.pathname === "/assets/many.js") {
                return send("text/javascript", `
                    const buttons = Array.from({ length: 40 }, (_, i) => '<button data-i="' + i + '">Section ' + i + '</button>').join("");
                    document.getElementById("root").innerHTML = '<header>' + buttons + '</header><main><h1>Many</h1><p>MANY-HOME-MARKER A start page with a very long menu of buttons.</p></main>';
                    document.querySelectorAll("header button").forEach(button => button.onclick = () => {
                        document.querySelector("main").innerHTML = '<h1>Section ' + button.dataset.i + '</h1><p>MANY-MARKER-' + button.dataset.i + ' words that only this view shows to visitors.</p>';
                    });`);
            }
            return send("text/html", SHELL("/assets/many.js"));
        }

        if (host === "links.test") {
            if (u.pathname.startsWith("/api/")) return send("application/json", "{}");
            const words = "Ordinary website text that the crawler reads from the HTML the server sends. ".repeat(20);
            return send("text/html", `<html><head><title>Links</title></head><body><nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a><button onclick="fetch('/api/clicked-links')">Menu one</button><button onclick="fetch('/api/clicked-links')">Menu two</button><button onclick="fetch('/api/clicked-links')">Menu three</button></nav><main><h1>Links ${u.pathname}</h1><p>${words}</p></main></body></html>`);
        }

        if (host === "other.test") return send("text/html", "<html><body><main><p>OTHER-DOMAIN-MARKER must never be read.</p></main></body></html>");
        return notFound();
    });
    for (;;) {
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        port = server.address().port;
        if (!RESERVED_PORTS.has(port)) break;
        await new Promise(resolve => server.close(resolve));
    }

    // ---- load ingest.js with the test origins allow-listed and pinned to 127.0.0.1 ----
    const allowed = ["menu.test", "many.test", "links.test", "other.test"].map(origin);
    let src = fs.readFileSync(ingestPath, "utf8");
    const marker = "async function assertPublicHttpUrl(rawUrl) {";
    if (!src.includes(marker)) throw new Error("allow-list marker not found in ingest.js");
    src = src.replace(marker, marker + `
    try {
        const parsedTestUrl = new URL(rawUrl);
        if (${JSON.stringify(allowed)}.includes(parsedTestUrl.origin)) return Object.assign(parsedTestUrl, { publicAddresses: [{ address: "127.0.0.1", family: 4 }] });
    } catch {}`);
    src += "\nmodule.exports.__crawlWebsite = crawlWebsite;\n";
    const m = new Module(ingestPath); m.filename = ingestPath; m.paths = Module._nodeModulePaths(projectDir);
    m._compile(src, ingestPath);
    const { __crawlWebsite: crawlWebsite } = m.exports;

    const log = console.log;
    const crawl = async (url, limit, options = {}) => {
        console.log = () => {};
        try { return await crawlWebsite(url, limit, () => {}, options); } finally { console.log = log; }
    };
    const textOf = page => page.sections.map(section => `${section.heading}\n${section.blocks.join("\n")}`).join("\n\n");
    const hitsOf = host => hits[host] || [];
    const clicked = (result, label) => result.buttonClicks.find(click => click.label === label);

    try {
        // ---- 1. Off (the default): nothing is clicked ----
        const off = await crawl(`${origin("menu.test")}/`, 5);
        const offHome = off.pages.find(page => new URL(page.url).pathname === "/");
        record("off: the start page is read as before", offHome && textOf(offHome).includes("HOME-MARKER"), offHome ? textOf(offHome).slice(0, 80) : "no page");
        record("off: no button is clicked (no click request, no view text, no click report)",
            !hitsOf("menu.test").some(hit => /clicked|track|never/.test(hit)) && !off.pages.some(page => /TREADMILL-MARKER|FAQ-MARKER/.test(textOf(page))) && off.buttonClicks.length === 0,
            hitsOf("menu.test").join(" "));
        const offWarning = off.warnings.find(warning => warning.code === "menu-uses-buttons");
        record("off: the warning names the buttons and how to turn clicking on", offWarning && /Treadmills/.test(offWarning.message) && /platform admin/.test(offWarning.message), offWarning?.message);

        // ---- 2. On ----
        hits["menu.test"] = [];
        const on = await crawl(`${origin("menu.test")}/`, 5, { buttonDiscovery: true });
        const onHome = on.pages.find(page => new URL(page.url).pathname === "/");
        const homeText = onHome ? textOf(onHome) : "";
        record("on: text a button shows is added to the start page", homeText.includes("TREADMILL-MARKER") && homeText.includes("HOME-MARKER"), homeText.slice(0, 200));
        record("on: the view's sections are stored once (the start page text is not added twice)", (homeText.match(/HOME-MARKER/g) || []).length === 1, homeText.slice(0, 200));
        const sectionNamed = name => onHome.sections.find(section => section.heading === name && section.isViewList);
        const cardsList = sectionNamed("Cards view");
        record("on: a view of cards is stored under its button's name, also listing a card already stored from another view",
            cardsList && cardsList.blocks.some(line => line.startsWith("Shared Card:")) && cardsList.blocks.some(line => line.startsWith("Card Two:")), JSON.stringify(cardsList));
        const addedList = sectionNamed("Added cards");
        record("on: a button that only adds to the page lists what it added, not what was already there",
            addedList && addedList.blocks.length === 2 && addedList.blocks.every(line => line.startsWith("Added")), JSON.stringify(addedList));
        record("on: a view that is not a list of cards gets no list section", !sectionNamed("Treadmills") && !sectionNamed("Newsletter"), onHome.sections.filter(section => section.isViewList).map(section => section.heading).join(", "));
        const faqPage = on.pages.find(page => new URL(page.url).pathname === "/faq");
        const faqEntry = on.urlReport.find(entry => new URL(entry.url).pathname === "/faq");
        record("on: a button that changes the address queues that page, which is then read normally", faqPage && textOf(faqPage).includes("FAQ-MARKER") && faqEntry?.source === "button" && clicked(on, "FAQ")?.outcome === "new address", JSON.stringify(faqEntry));
        record("on: an action label (Sign up) is never clicked", clicked(on, "Sign up")?.outcome === "not clicked: looks like an action" && !hitsOf("menu.test").includes("GET /api/clicked-signup"), JSON.stringify(clicked(on, "Sign up")));
        record("on: buttons in a form, in the page content and disabled buttons are never clicked",
            !hitsOf("menu.test").some(hit => /clicked-(form|content|disabled)/.test(hit)) && !clicked(on, "Join club") && !clicked(on, "Content button inside the page") && !clicked(on, "Disabled one"),
            on.buttonClicks.map(click => click.label).join(", "));
        record("on: a POST request made by a click never reaches the website, and is reported",
            !hitsOf("menu.test").some(hit => /^POST /.test(hit)) && on.blockedWhileClicking >= 1 && homeText.includes("NEWS-MARKER"), `blocked ${on.blockedWhileClicking}; ${hitsOf("menu.test").filter(hit => /track/.test(hit)).join(" ")}`);
        record("on: a click that moves to another website, or opens a window there, reaches nothing", ["Partner", "Open window"].every(label => clicked(on, label) && !/^not clicked/.test(clicked(on, label).outcome)) && hitsOf("other.test").length === 0 && !on.pages.some(page => /other\.test/.test(page.url) || textOf(page).includes("OTHER-DOMAIN-MARKER")), JSON.stringify([clicked(on, "Partner"), clicked(on, "Open window")]) + " " + hitsOf("other.test").join(" "));
        const slow = clicked(on, "Slow view");
        record("on: a view with a hung request stops at the time limit, its text is still read", slow && slow.durationMs < 16000 && homeText.includes("SLOW-MARKER"), JSON.stringify(slow));
        record("on: a button that does nothing is reported as such", clicked(on, "Nothing")?.outcome === "nothing changed", JSON.stringify(clicked(on, "Nothing")));
        record("on: only the start page's buttons are clicked (not the FAQ page's)", on.buttonClicks.filter(click => click.label === "Treadmills").length === 1, on.buttonClicks.map(click => click.label).join(", "));
        const summary = on.warnings.find(warning => warning.code === "menu-buttons-clicked");
        record("on: the crawl report summarises the clicks", summary && /Menu buttons clicked: \d+/.test(summary.message) && /Treadmills/.test(summary.message) && /blocked/.test(summary.message), summary?.message);

        // ---- 3. Limits ----
        const many = await crawl(`${origin("many.test")}/`, 5, { buttonDiscovery: true });
        const manyText = many.pages.map(textOf).join("\n");
        const manyClicked = many.buttonClicks.filter(click => !/^not clicked/.test(click.outcome)).length;
        record("limit: at most 30 clicks per crawl, the rest reported", manyClicked === 30 && many.buttonClicks.filter(click => /at most 30 clicks/.test(click.outcome)).length === 10 && manyText.includes("MANY-MARKER-29") && !manyText.includes("MANY-MARKER-30"), `${manyClicked} clicked`);
        record("limit: the request budget is respected", many.requestsUsed <= many.requestLimit, `${many.requestsUsed}/${many.requestLimit}`);

        // ---- 4. When it does not run ----
        const links = await crawl(`${origin("links.test")}/`, 5, { buttonDiscovery: true });
        record("ordinary site with links: no clicks even when on", links.buttonClicks.length === 0 && !hitsOf("links.test").some(hit => /clicked/.test(hit)) && links.pages.length >= 4, `${links.buttonClicks.length} clicks, ${links.pages.length} pages`);
        hits["menu.test"] = [];
        console.log = () => {};
        const chosen = await crawlWebsite(`${origin("menu.test")}/`, 5, () => {}, { onlyUrls: [`${origin("menu.test")}/`], buttonDiscovery: true });
        console.log = log;
        record("chosen pages: no clicks even when on", chosen.buttonClicks.length === 0 && !hitsOf("menu.test").some(hit => /clicked|track/.test(hit)), chosen.buttonClicks.length);

        // ---- 5. Wiring ----
        const ingestSource = fs.readFileSync(ingestPath, "utf8");
        const serverSource = fs.readFileSync(path.join(projectDir, "server.js"), "utf8");
        const schema = fs.readFileSync(path.join(projectDir, "db", "schema.sql"), "utf8");
        record("schema: the setting is additive and off by default", /ADD COLUMN IF NOT EXISTS button_discovery BOOLEAN NOT NULL DEFAULT false/.test(schema));
        record("server: full crawls pass the chatbot's setting; chosen pages do not", /maxPages,\s*buttonDiscovery: await getButtonDiscovery\(chatbotId\)/.test(serverSource) && !/onlyUrls: urls,\s*buttonDiscovery/.test(serverSource));
        record("server: only the platform admin can change it", /app\.put\("\/api\/admin\/chatbots\/:id\/button-discovery", requireActor, requirePlatform,/.test(serverSource));
        record("report: the clicks are saved in crawl_report", /buttonClicks: crawl\.buttonClicks/.test(ingestSource));
    } finally {
        console.log = log;
        for (const res of hungResponses) res.destroy();
        server.closeAllConnections();
        server.close();
    }

    for (const r of results) console.log(`${r.result}  ${r.test}${r.result === "FAIL" && r.note ? `  [${r.note}]` : ""}`);
    const failed = results.filter(r => r.result === "FAIL").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})().catch(error => {
    console.error("test error:", error.message);
    process.exit(2);
});
