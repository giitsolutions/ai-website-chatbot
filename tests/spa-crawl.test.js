// Script-rendered websites (local only: no database, no Qdrant, no model, no live site).
// One local server on a random port answers by host name: spa.test (an app shell), other.test (another
// domain with a sitemap), api.test (another domain with an API), hung.test (an app shell with a
// request that never answers) and plain.test (an ordinary website). The SSRF check is allow-listed
// for exactly these origins and pinned to 127.0.0.1, so nothing outside this machine is contacted.
// Covers: <br> spacing, button text, the 40% fallback, the app-shell wait, a hung request, sitemaps and
// canonical addresses on another domain, crawl report warnings. Run: npm run test:spa-crawl
const fs = require("fs"), path = require("path"), http = require("http"), Module = require("module");
const cheerio = require(require.resolve("cheerio", { paths: [path.join(__dirname, "..")] }));

const projectDir = path.join(__dirname, "..");
const ingestPath = path.join(projectDir, "ingest.js");
const RESERVED_PORTS = new Set([3000, 3001, 3002, 3003, 3004, 3005, 5050]);

const results = [];
const record = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 140) });

const SHELL = (script, head = "") => `<!doctype html><html><head><title>Shell App</title>${head}</head><body><div id="root"></div><script type="module" src="${script}"></script></body></html>`;

(async () => {
    const hits = {};
    const hungResponses = [];
    let port = 0;
    const origin = host => `http://${host}:${port}`;
    const server = http.createServer((req, res) => {
        const host = String(req.headers.host || "").split(":")[0];
        const u = new URL(req.url, "http://x");
        (hits[host] = hits[host] || []).push(u.pathname);
        const send = (type, body, delay = 0) => setTimeout(() => {
            res.setHeader("Content-Type", type);
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.end(body);
        }, delay);
        const html = body => send("text/html", body);
        const js = body => send("text/javascript", body);

        if (host === "other.test") {
            if (u.pathname === "/sitemap.xml") {
                return send("application/xml", `<?xml version="1.0"?><urlset><url><loc>${origin("spa.test")}/from-other-sitemap</loc></url><url><loc>${origin("other.test")}/secret-page</loc></url></urlset>`);
            }
            return html("<html><body><main><p>OTHER-DOMAIN-MARKER must never be read.</p></main></body></html>");
        }
        if (host === "api.test") return send("application/json", JSON.stringify({ text: "CROSS-DOMAIN-API-MARKER" }), 1500);

        if (host === "spa.test") {
            if (u.pathname === "/robots.txt") return send("text/plain", `User-agent: *\nAllow: /\nSitemap: ${origin("other.test")}/sitemap.xml\n`);
            if (u.pathname === "/sitemap.xml") return send("application/xml", `<?xml version="1.0"?><urlset><url><loc>${origin("spa.test")}/from-own-sitemap</loc></url></urlset>`);
            if (u.pathname === "/api/slow") return send("application/json", JSON.stringify({ text: "DELAYED-API-MARKER" }), 3000);
            if (u.pathname === "/assets/app.js") {
                return js(`
                    const here = location.pathname;
                    const root = document.getElementById("root");
                    if (here !== "/") { root.innerHTML = "<main><h1>Page " + here + "</h1><p>PAGE-MARKER " + here + " has a few ordinary words for visitors to read today.</p></main>"; }
                    else {
                        root.innerHTML = '<nav><button>Home</button><button>Plans</button><button>About</button><button>Contact</button></nav>' +
                            '<main><h1>RENT FITNESS<br>AT HOME</h1><p>Premium equipment is delivered right to your doorstep every single day.</p>' +
                            '<button><span>01</span><span>Treadmills</span><span>Cardio and endurance training</span></button><button>View all</button>' +
                            '<div id="late"></div><div id="cross"></div></main>';
                        fetch("/api/slow").then(r => r.json()).then(d => { document.getElementById("late").innerHTML = "<p>" + d.text + " arrived late from the API.</p>"; });
                        fetch(${JSON.stringify(origin("api.test"))} + "/items").then(r => r.json()).then(d => { document.getElementById("cross").innerHTML = "<p>" + d.text + " arrived from another domain.</p>"; });
                    }`);
            }
            return html(SHELL("/assets/app.js", `<link rel="canonical" href="${origin("other.test")}/">`));
        }

        if (host === "hung.test") {
            if (u.pathname === "/robots.txt" || u.pathname === "/sitemap.xml") { res.writeHead(404); return res.end(); }
            if (u.pathname === "/api/never") { hungResponses.push(res); return; }
            if (u.pathname === "/assets/hung.js") {
                return js(`
                    document.getElementById("root").innerHTML = "<main><h1>Waiting page</h1><p>HUNG-PAGE-MARKER this text is on the page before the request ends.</p><a href='/next'>Next</a></main>";
                    fetch("/api/never");`);
            }
            if (u.pathname === "/assets/next.js") return js(`document.getElementById("root").innerHTML = "<main><h1>Next page</h1><p>NEXT-PAGE-MARKER the page after the hung request reads quickly.</p></main>";`);
            return html(SHELL(u.pathname === "/next" ? "/assets/next.js" : "/assets/hung.js"));
        }

        if (host === "busy.test") {
            if (u.pathname === "/robots.txt" || u.pathname === "/sitemap.xml") { res.writeHead(404); return res.end(); }
            if (u.pathname === "/assets/busy.js") {
                return js(`
                    document.getElementById("root").innerHTML = "<main><h1>Busy page</h1><p>BUSY-PAGE-MARKER this text keeps growing while the visitor reads it.</p><p id='more'></p></main>";
                    setInterval(() => { document.getElementById("more").textContent += "more "; }, 200);`);
            }
            return html(SHELL("/assets/busy.js"));
        }

        if (host === "foot.test") {
            if (u.pathname === "/robots.txt" || u.pathname === "/sitemap.xml") { res.writeHead(404); return res.end(); }
            const shared = "<footer><p>FOOTER-MARKER Call our support team on 0123 456 789 from Monday to Friday.</p><a href='/a'>Terms</a><a href='/b'>Privacy</a></footer>";
            const text = "Ordinary website text that the crawler reads from the HTML the server sends to every visitor. ".repeat(10);
            if (u.pathname === "/only-footer") return html(`<html><head><title>Only</title></head><body>${shared}</body></html>`);
            return html(`<html><head><title>Foot</title><meta name="description" content="ABOUT-MARKER what this website does."></head><body><main><h1>Page ${u.pathname}</h1><p>${text}</p><a href="/a">Page A link</a> <a href="/b">Page B link</a> <a href="/only-footer">Only footer link</a></main>${shared}</body></html>`);
        }

        if (host === "plain.test") {
            if (u.pathname === "/robots.txt") return send("text/plain", `User-agent: *\nAllow: /\nSitemap: ${origin("plain.test")}/map.xml\n`);
            if (u.pathname === "/map.xml") return send("application/xml", `<?xml version="1.0"?><urlset><url><loc>${origin("plain.test")}/listed</loc></url></urlset>`);
            const words = "Ordinary website text that the crawler reads from the HTML the server sends to every visitor. ".repeat(40);
            return html(`<html><head><title>Plain</title><link rel="canonical" href="${origin("plain.test")}${u.pathname}"></head><body><nav><a href="/a">A</a><a href="/b">B</a><a href="/c">C</a></nav><main><h1>Plain ${u.pathname}</h1><p>${words}</p></main></body></html>`);
        }
        res.writeHead(404);
        res.end();
    });
    for (;;) {
        await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
        port = server.address().port;
        if (!RESERVED_PORTS.has(port)) break;
        await new Promise(resolve => server.close(resolve));
    }

    // ---- load ingest.js with the test origins allow-listed and pinned to 127.0.0.1 ----
    const allowed = ["spa.test", "other.test", "api.test", "hung.test", "busy.test", "foot.test", "plain.test"].map(origin);
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
    const { __crawlWebsite: crawlWebsite, extractSections } = m.exports;

    const log = console.log;
    const crawl = async (url, limit) => {
        console.log = () => {};
        try { return await crawlWebsite(url, limit); } finally { console.log = log; }
    };
    const textOf = page => page.sections.map(section => `${section.heading}\n${section.blocks.join("\n")}`).join("\n\n");
    const extract = html => extractSections(cheerio.load(html), "Title");
    const allOf = sections => sections.map(section => `${section.heading}\n${section.blocks.join("\n")}`).join("\n");

    try {
        // ---- 1. Extraction, without a browser ----
        const brText = allOf(extract("<main><h1>RENT FITNESS<br>AT HOME</h1><p>A better way to<br/>train at home every day of the week, with no long commitment at all.</p></main>"));
        record("br: words on both sides stay separate (heading)", brText.includes("RENT FITNESS AT HOME"), brText);
        record("br: words on both sides stay separate (paragraph)", brText.includes("way to train at home"), brText);
        const preText = allOf(extract("<main><h1>Code</h1><pre>first line<br>second line</pre><p>Words around the code block to keep this a structured page today.</p></main>"));
        record("br: stays a line break inside <pre>", preText.includes("first line\nsecond line"), preText);

        const buttonText = allOf(extract("<main><h1>Equipment</h1><p>Choose the equipment that matches your space and your goals every day.</p><button><span>01</span><span>Treadmills</span><span>Cardio and endurance</span></button><button>View all</button><button>Sign up now</button></main>"));
        record("button: 4+ words are kept, with spaces between their parts", buttonText.includes("01 Treadmills Cardio and endurance"), buttonText);
        record("button: short labels are removed", !/View all|Sign up now/.test(buttonText), buttonText);
        const nestedText = allOf(extract("<main><h1>Cards</h1><p>Choose a card below to see what is included in each of the options.</p><button><h3>Exercise bikes</h3><p>Everyday fitness on a quiet machine at home.</p></button></main>"));
        record("button: headings and paragraphs inside are read once", (nestedText.match(/Everyday fitness/g) || []).length === 1 && nestedText.includes("Exercise bikes"), nestedText);
        const inParagraph = allOf(extract("<main><h1>Inside</h1><p>Some text with <button>a button with several words</button> in the middle of this ordinary sentence.</p></main>"));
        record("button: inside a paragraph it is not read twice", (inParagraph.match(/a button with several words/g) || []).length === 1, inParagraph);
        const inNav = allOf(extract("<nav><button>Our long menu button label here</button></nav><main><h1>Menu</h1><p>Plain words in the main part of the page for all visitors today.</p></main>"));
        record("button: in a menu it is still removed with the menu", !inNav.includes("menu button label"), inNav);

        const cards = Array.from({ length: 12 }, (_, i) => `<div><span>Card ${i}</span><span>This card describes equipment number ${i} in plain words for visitors.</span></div>`).join("");
        const divSections = extract(`<main id="a"><h1 id="top">Our range</h1><p>Short intro about the range here today for you.</p>${cards}<h2 id="more">More cards</h2><div>DIV-MARKER text placed in a plain div without paragraph tags, with enough words to count here.</div></main>`);
        const divText = allOf(divSections);
        record("fallback: under 40% structured text reads the text in divs", divText.includes("number 11") && divText.includes("DIV-MARKER"), divText.slice(0, 120));
        record("fallback: headings still split the sections", divSections.map(s => s.heading).join("|") === "Our range|More cards" && divSections[1].anchor === "more", divSections.map(s => s.heading).join("|"));
        record("fallback: words in neighbouring spans are not glued", divText.includes("Card 3 This card"), divText.slice(0, 120));
        const sparse = extract("<main><h1>Few words</h1><div><span>Open</span><span>daily</span></div></main>");
        record("fallback: a page with only a few words is read too", allOf(sparse).includes("Open daily"), allOf(sparse));
        const structuredPage = `<main><h1>Guide</h1><p>${"Words in a proper paragraph for this guide page. ".repeat(20)}</p><ul><li>First step of it</li><li>Second step of it</li></ul><div>A small note in a div.</div></main>`;
        const structured = extract(structuredPage);
        record("a normally structured page keeps its blocks, and text in a plain div as a block of its own", structured.length === 1 && structured[0].blocks.length === 4 && structured[0].blocks[3] === "A small note in a div.", JSON.stringify(structured[0].blocks.length));

        // ---- 2. An app shell, crawled for real ----
        const spa = await crawl(`${origin("spa.test")}/`, 10);
        const home = spa.pages.find(page => new URL(page.url).pathname === "/");
        const homeText = home ? textOf(home) : "";
        record("app shell: script-rendered text is read", homeText.includes("Premium equipment"), homeText.slice(0, 100));
        record("app shell: <br> heading in a real render", homeText.includes("RENT FITNESS AT HOME"), homeText.slice(0, 100));
        record("app shell: button text kept in a real render", homeText.includes("01 Treadmills Cardio and endurance training"), homeText.slice(0, 200));
        record("app shell: content that arrives after 3 s is captured", homeText.includes("DELAYED-API-MARKER"), homeText.slice(0, 200));
        record("app shell: an API on another domain answers (GET, through the same checks) and is captured", homeText.includes("CROSS-DOMAIN-API-MARKER"), homeText.slice(0, 200));

        // ---- 3. Sitemaps and canonical on another domain ----
        const paths = spa.pages.map(page => new URL(page.url).pathname).sort();
        record("sitemap: the site's own /sitemap.xml is read as well", paths.includes("/from-own-sitemap") && (hits["spa.test"] || []).includes("/sitemap.xml"), paths.join(" "));
        record("sitemap: same-site addresses from the other domain's sitemap are used", paths.includes("/from-other-sitemap"), paths.join(" "));
        const otherHits = hits["other.test"] || [];
        record("other domain: only the sitemap file is requested, never a page", otherHits.length === 1 && otherHits[0] === "/sitemap.xml", otherHits.join(" "));
        record("other domain: nothing from it is stored", !spa.pages.some(page => /other\.test/.test(page.url) || textOf(page).includes("OTHER-DOMAIN-MARKER")));
        const skippedOther = spa.urlReport.find(entry => /other\.test.*secret-page/.test(entry.url));
        record("other domain: its address is reported as skipped", skippedOther?.status === "skipped" && /another website/.test(skippedOther.reason || ""), JSON.stringify(skippedOther));

        // ---- 4. Warnings ----
        const codes = spa.warnings.map(warning => warning.code).sort().join(" ");
        record("warnings: all of them on the app shell", codes === "canonical-other-domain js-rendered menu-uses-buttons robots-sitemap-other-domain sitemap-other-domain thin-content", codes);
        record("warnings: every warning has a message for the dashboard", spa.warnings.every(warning => warning.message && warning.message.length > 20));
        record("warnings: messages name the other domain", spa.warnings.filter(warning => /other-domain/.test(warning.code)).every(warning => warning.message.includes("other.test")));

        // ---- 5. A request that never answers ----
        const hung = await crawl(`${origin("hung.test")}/`, 5);
        const hungEntry = hung.urlReport.find(entry => new URL(entry.url).pathname === "/");
        const nextEntry = hung.urlReport.find(entry => new URL(entry.url).pathname === "/next");
        record("hung request: the wait stops at the time limit (about 10 s)", hungEntry?.durationMs >= 9500 && hungEntry.durationMs < 16000, `${hungEntry?.durationMs} ms`);
        record("hung request: the page's text is still read", hung.pages.some(page => textOf(page).includes("HUNG-PAGE-MARKER")));
        record("hung request: the next page is not held up by it", nextEntry?.status === "read" && nextEntry.durationMs < 6000, `${nextEntry?.durationMs} ms`);
        record("hung request: a warning says a request did not answer in time", hung.warnings.some(warning => warning.code === "request-timeout" && /did not answer in time/.test(warning.message)) && !hung.warnings.some(warning => warning.code === "content-still-changing"), hung.warnings.map(warning => warning.code).join(" "));
        for (const res of hungResponses) res.destroy();

        const busy = await crawl(`${origin("busy.test")}/`, 1);
        record("changing page: the wait stops at the limit, the text is read, and a warning says so", busy.pages.some(page => textOf(page).includes("BUSY-PAGE-MARKER")) && busy.warnings.some(warning => warning.code === "content-still-changing" && /still changing/.test(warning.message)) && !busy.warnings.some(warning => warning.code === "request-timeout"), busy.warnings.map(warning => warning.code).join(" "));

        // ---- Footers repeat on every page ----
        const foot = await crawl(`${origin("foot.test")}/`, 5);
        const withFooter = foot.pages.filter(page => textOf(page).includes("FOOTER-MARKER"));
        record("footer: its text is read and stored once, not once per page", foot.pages.length === 3 && withFooter.length === 1, `${foot.pages.length} pages, ${withFooter.length} with the footer`);
        record("footer: a page with nothing but a footer is not a page with content", foot.urlReport.find(entry => /only-footer/.test(entry.url))?.reason === "no readable content on the page", JSON.stringify(foot.urlReport.find(entry => /only-footer/.test(entry.url))));
        const withAbout = foot.pages.filter(page => textOf(page).includes("ABOUT-MARKER"));
        record("about: stored for the start page only", withAbout.length === 1 && withAbout[0].isStartPage === true, `${withAbout.length} pages`);
        record("footer: its links are still followed", foot.pages.some(page => /\/b$/.test(page.url)));

        // ---- 6. An ordinary website behaves as before ----
        const plain = await crawl(`${origin("plain.test")}/`, 5);
        const plainHome = plain.urlReport.find(entry => new URL(entry.url).pathname === "/");
        record("ordinary site: no warnings (none of the wait warnings either)", plain.warnings.length === 0, plain.warnings.map(warning => warning.code).join(" "));
        record("ordinary site: no app-shell wait", plainHome?.durationMs < 1000, `${plainHome?.durationMs} ms`);
        record("ordinary site: its same-site sitemap is used, /sitemap.xml is not added", hits["plain.test"].includes("/map.xml") && !hits["plain.test"].includes("/sitemap.xml") && plain.pages.some(page => /\/listed$/.test(page.url)), hits["plain.test"].join(" "));

        // ---- 7. Report and dashboard ----
        console.log = () => {};
        const chosen = await crawlWebsite(`${origin("spa.test")}/`, 5, () => {}, { onlyUrls: [`${origin("spa.test")}/from-own-sitemap`] });
        console.log = log;
        record("chosen pages: no site-wide warnings from a partial crawl", chosen.warnings.length === 0 && chosen.pages.length === 1, chosen.warnings.map(warning => warning.code).join(" "));
        record("report: ingestWebsite saves the warnings in crawl_report", /notProcessedUrls: crawl\.notProcessedUrls,\s*warnings: crawl\.warnings/.test(fs.readFileSync(ingestPath, "utf8")));
        const dashboard = fs.readFileSync(path.join(projectDir, "public", "index.html"), "utf8");
        record("dashboard: the Last crawl report lists the warnings as plain text", /report\?\.warnings[\s\S]{0,160}note\.textContent = warning\.message/.test(dashboard));
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
