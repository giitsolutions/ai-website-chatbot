// Generic URL handling across several different websites (local only: no database, no Qdrant).
// Three fake websites with different structures, each under its own host names, plus a fourth
// "other company" website, all served by one local server and pinned to 127.0.0.1 in a test-only
// copy of ingest.js (the SSRF check is allow-listed for exactly these origins; the browser never
// resolves them itself, and nothing outside this machine is contacted):
//   brochure.test (+ www.)       small business site: address forms, redirects (same page, page
//                                already read, www, another website), duplicates, images, robots.txt,
//                                an e-mail link
//   docs-site.test (/guide/)     documentation registered at a folder: a documentation subdomain
//                                (in scope), another subdomain (not), pagination, capitalisation,
//                                tracking parameters, fragments, a sitemap with mixed entries
//   shop.test                    shop: login/cart pages, 404 vs 500 (retried), a redirect to a page
//                                already read, the page limit leaving pages visibly not processed
// Every discovered address must end with a final status and a reason, and no other website's text
// may ever be stored. Run: npm run test:crawl-sites
const fs = require("fs"), path = require("path"), http = require("http"), Module = require("module");

const projectDir = path.join(__dirname, "..");
const ingestPath = path.join(projectDir, "ingest.js");
const results = [];
const record = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 140) });
const FINAL = new Set(["indexed", "failed", "skipped", "not-processed"]);

(async () => {
    const hits = {};
    const filler = "Ordinary website text that the crawler extracts and keeps as a section for visitors. ".repeat(6);
    const page = (title, body) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body} ${filler}</p></main></body></html>`;
    let port;
    const at = host => `http://${host}:${port}`;
    const server = http.createServer((req, res) => {
        const host = String(req.headers.host || "").split(":")[0];
        const u = new URL(req.url, "http://x");
        hits[`${host}${u.pathname}${u.search}`] = (hits[`${host}${u.pathname}${u.search}`] || 0) + 1;
        const go = location => { res.writeHead(301, { Location: location }); res.end(); };
        const html = text => { res.setHeader("Content-Type", "text/html"); res.end(text); };
        const site = host.replace(/^www\./, "").replace(/^(docs|blog)\.(?=docs-site\.test$)/, "");

        if (host === "other.test") return html(page("Other company", "OTHER-SITE-MARKER a different company's website."));

        if (site === "brochure.test") {
            if (u.pathname === "/robots.txt") return res.end("User-agent: *\nDisallow: /private\n");
            if (u.pathname === "/sitemap.xml") { res.writeHead(404); return res.end(); }
            const home = page("Brochure home", `BROCHURE-HOME-MARKER welcome.
                <a href="/about">About</a> <a href="/about/">About (slash)</a> <a href="${at("www.brochure.test")}/about">About (www)</a>
                <a href="/index.html">Home again</a> <a href="/team">Team</a> <a href="/news">News</a> <a href="/partner">Partner</a>
                <a href="/gallery.jpg">Gallery</a> <a href="/private">Private</a> <a href="http://elsewhere.test/">Elsewhere</a>
                <a href="hello@brochure.test">Mail</a>`);
            if (u.pathname === "/" || u.pathname === "/index.html") return html(home);
            if (u.pathname === "/about") return html(page("About", "BROCHURE-ABOUT-MARKER who we are."));
            if (u.pathname === "/team") return go("/team/");
            if (u.pathname === "/team/") return html(page("Team", "BROCHURE-TEAM-MARKER the people."));
            if (u.pathname === "/news" && !host.startsWith("www.")) return go(`${at("www.brochure.test")}/news`);
            if (u.pathname === "/news") return html(page("News", "BROCHURE-NEWS-MARKER on the www host."));
            if (u.pathname === "/partner") return go(`${at("other.test")}/`);
            if (u.pathname === "/private") return html(page("Private", "BROCHURE-PRIVATE-MARKER must not be read."));
        }

        if (site === "docs-site.test") {
            if (u.pathname === "/robots.txt") return res.end("User-agent: *\nAllow: /\n");
            if (u.pathname === "/sitemap.xml") {
                res.setHeader("Content-Type", "application/xml");
                return res.end(`<?xml version="1.0"?><urlset>
                    <url><loc>${at("docs-site.test")}/guide/sitemap-only</loc></url>
                    <url><loc>${at("other.test")}/listed-elsewhere</loc></url>
                    <url><loc>${at("docs-site.test")}/guide/writers@docs-site.test</loc></url>
                    <url><loc>${at("docs-site.test")}/guide/intro</loc></url></urlset>`);
            }
            if (host === "blog.docs-site.test") return html(page("Blog", "DOCS-BLOG-MARKER another subdomain."));
            if (host === "docs.docs-site.test" && u.pathname === "/faq") return html(page("FAQ", "DOCS-FAQ-MARKER documentation subdomain."));
            if (u.pathname === "/guide/") {
                return html(page("Guide", `DOCS-START-MARKER start here.
                    <a href="intro">Intro</a> <a href="intro?page=2">Intro page 2</a> <a href="Intro">Intro (capital)</a>
                    <a href="intro?utm_source=newsletter">Intro (tracked)</a> <a href="intro#part-2">Intro (fragment)</a>
                    <a href="${at("docs.docs-site.test")}/faq">FAQ</a> <a href="${at("blog.docs-site.test")}/post">Blog</a>`));
            }
            if (u.pathname === "/guide/intro" && u.searchParams.get("page") === "2") return html(page("Intro, page 2", "DOCS-INTRO-PAGE2-MARKER second page."));
            if (u.pathname === "/guide/intro") return html(page("Intro", "DOCS-INTRO-MARKER first page."));
            if (u.pathname === "/guide/Intro") return html(page("Intro (other)", "DOCS-INTRO-CAPITAL-MARKER a different page."));
            if (u.pathname === "/guide/sitemap-only") return html(page("Sitemap only", "DOCS-SITEMAP-MARKER listed only in the sitemap."));
        }

        if (site === "shop.test") {
            if (u.pathname === "/robots.txt") return res.end("User-agent: *\nAllow: /\n");
            if (u.pathname === "/sitemap.xml") { res.writeHead(404); return res.end(); }
            if (u.pathname === "/") {
                return html(page("Shop", `SHOP-HOME-MARKER products.
                    <a href="/login">Log in</a> <a href="/cart">Cart</a> <a href="/missing">Missing</a> <a href="/broken">Broken</a>
                    <a href="/product">Product</a> ${Array.from({ length: 6 }, (_, i) => `<a href="/p${i + 1}">Item ${i + 1}</a>`).join(" ")}
                    <a href="/forbidden">Staff</a> <a href="/busy">Busy</a> <a href="/html-missing">Old</a> <a href="/html-unavailable">Later</a>
                    <a href="/moved-away">Moved</a> <a href="/download">Brochure</a> <a href="/picture">Picture</a> <a href="/drop">Unstable</a>`));
            }
            if (u.pathname === "/product") return html(page("Product", `SHOP-PRODUCT-MARKER details. <a href="/old-product">Old address</a>`));
            if (u.pathname === "/old-product") return go("/product");
            if (u.pathname === "/missing") { res.writeHead(404); return res.end("not found"); }
            if (u.pathname === "/broken") { res.writeHead(500); return res.end("error"); }
            // HTTP status vs content type: error statuses keep their real status whatever the
            // body is; successful non-HTML responses are still refused as pages.
            if (u.pathname === "/forbidden") { res.writeHead(403, { "Content-Type": "text/plain" }); return res.end("forbidden"); }
            if (u.pathname === "/busy") { res.writeHead(429, { "Content-Type": "application/json" }); return res.end("{\"error\":\"slow down\"}"); }
            if (u.pathname === "/html-missing") { res.writeHead(404, { "Content-Type": "text/html" }); return res.end(page("Page not found", "SHOP-404-MARKER")); }
            if (u.pathname === "/html-unavailable") { res.writeHead(503, { "Content-Type": "text/html" }); return res.end(page("Unavailable", "SHOP-503-MARKER")); }
            if (u.pathname === "/moved-away") return go("/gone");
            if (u.pathname === "/gone") { res.writeHead(404, { "Content-Type": "text/plain" }); return res.end("gone"); }
            if (u.pathname === "/download") { res.writeHead(200, { "Content-Type": "application/pdf" }); return res.end("%PDF-1.4 SHOP-PDF-MARKER"); }
            if (u.pathname === "/picture") { res.writeHead(200, { "Content-Type": "image/png" }); return res.end("PNG SHOP-IMAGE-MARKER"); }
            if (u.pathname === "/drop") return req.socket.destroy();
            if (/^\/p\d$/.test(u.pathname)) return html(page(`Item ${u.pathname}`, `SHOP-ITEM-MARKER ${u.pathname}.`));
            if (u.pathname === "/login" || u.pathname === "/cart") return html(page("Account", "SHOP-ACCOUNT-MARKER must not be read."));
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    port = server.address().port;
    const origins = ["brochure.test", "www.brochure.test", "docs-site.test", "docs.docs-site.test", "blog.docs-site.test", "shop.test", "other.test"].map(at);

    let src = fs.readFileSync(ingestPath, "utf8");
    const marker = "async function assertPublicHttpUrl(rawUrl) {";
    if (!src.includes(marker)) throw new Error("allow-list marker not found in ingest.js");
    src = src.replace(marker, marker + `
    try {
        const parsedTestUrl = new URL(rawUrl);
        if (${JSON.stringify(origins)}.includes(parsedTestUrl.origin)) return Object.assign(parsedTestUrl, { publicAddresses: [{ address: "127.0.0.1", family: 4 }] });
    } catch {}`);
    src += "\nmodule.exports.__crawlWebsite = crawlWebsite;\n";
    const m = new Module(ingestPath); m.filename = ingestPath; m.paths = Module._nodeModulePaths(projectDir);
    m._compile(src, ingestPath);
    const { __crawlWebsite: crawlWebsite, markIndexedPages, scopeSkipReason } = m.exports;

    const log = console.log;
    const crawl = async (start, limit) => {
        console.log = () => {};
        try {
            const result = await crawlWebsite(start, limit);
            // Final statuses as ingestWebsite records them (each stored section counted once).
            markIndexedPages(result.urlReport, result.pages.flatMap(p => p.sections.map(() => ({ url: p.url }))));
            return result;
        } finally {
            console.log = log;
        }
    };
    const pathOf = url => { const parsed = new URL(url); return decodeURIComponent(parsed.pathname + parsed.search); };
    const finder = result => (pathname, host) => result.urlReport.filter(e => pathOf(e.url) === pathname && (!host || new URL(e.url).hostname === host));
    const storedText = result => result.pages.map(p => JSON.stringify(p.sections)).join(" ");
    const allFinal = (label, result) => {
        const open = result.urlReport.filter(e => !FINAL.has(e.status) || ((e.status === "skipped" || e.status === "failed" || e.status === "not-processed") && !e.reason));
        record(`${label}: every discovered address has a final status and a reason`, open.length === 0, open.map(e => `${pathOf(e.url)}=${e.status}`).join(" "));
        record(`${label}: no other website's text is stored`, !/OTHER-SITE-MARKER/.test(storedText(result)));
    };

    try {
        // ---- G5: scope reasons (another website first) ----
        record("scope: another website over http on an https site -> another website", scopeSkipReason("http://other.example/x", "site.example", "https:") === "outside the crawl scope (another website)");
        record("scope: own page over http on an https site -> http address", scopeSkipReason("http://site.example/a", "site.example", "https:") === "http address on an https website");
        record("scope: www. form of the own site -> in scope", scopeSkipReason("https://www.site.example/a", "site.example", "https:") === null);
        record("scope: documentation subdomain -> in scope", scopeSkipReason("https://docs.site.example/a", "site.example", "https:") === null);
        record("scope: other subdomain -> another website", scopeSkipReason("https://blog.site.example/a", "site.example", "https:") === "outside the crawl scope (another website)");
        record("scope: http site, http page -> in scope", scopeSkipReason("http://site.example/a", "site.example", "http:") === null);

        // ---- Brochure site ----
        const b = await crawl(`${at("brochure.test")}/`, 20);
        const fb = finder(b);
        allFinal("brochure", b);
        record("brochure: /about, /about/ and www./about are one page, indexed once", fb("/about").length === 1 && fb("/about")[0].status === "indexed" && (storedText(b).match(/BROCHURE-ABOUT-MARKER/g) || []).length === 1, JSON.stringify(fb("/about")));
        record("brochure: /index.html with the home page's text is skipped as the same content", fb("/index.html")[0]?.status === "skipped" && /same content/.test(fb("/index.html")[0].reason), JSON.stringify(fb("/index.html")[0]));
        record("brochure: /team -> /team/ (same page) is read and stored", fb("/team")[0]?.status === "indexed" && /BROCHURE-TEAM-MARKER/.test(storedText(b)), JSON.stringify(fb("/team")[0]));
        record("brochure: /news -> www./news (same site) is stored under the www. address", fb("/news")[0]?.status === "indexed" && b.pages.some(p => /\/\/www\.brochure\.test:\d+\/news$/.test(p.url)), JSON.stringify(fb("/news")[0]));
        const partner = fb("/partner")[0];
        record("brochure: /partner -> another website is skipped with the reason and final address", partner?.status === "skipped" && partner.reason === "redirects to another website" && /other\.test/.test(partner.finalUrl || ""), JSON.stringify(partner));
        record("brochure: the other website's page was loaded only up to the redirect (no assets)", !Object.keys(hits).some(key => key.startsWith("other.test") && key !== "other.test/"));
        record("brochure: image link skipped as not a web page", /not a web page/.test(fb("/gallery.jpg")[0]?.reason || ""));
        record("brochure: robots.txt-disallowed page skipped and never requested", /robots/.test(fb("/private")[0]?.reason || "") && !hits["brochure.test/private"]);
        record("brochure: link to another website skipped with the scope reason", (b.urlReport.find(e => /elsewhere\.test/.test(e.url)) || {}).reason === "outside the crawl scope (another website)");
        record("brochure: e-mail link skipped, never requested", /e-mail address/.test(fb("/hello@brochure.test")[0]?.reason || "") && !Object.keys(hits).some(key => key.includes("@")));

        // ---- Documentation site registered at a folder ----
        const d = await crawl(`${at("docs-site.test")}/guide/`, 20);
        const fd = finder(d);
        allFinal("docs", d);
        record("docs: /guide/intro and /guide/intro?page=2 are separate pages", fd("/guide/intro")[0]?.status === "indexed" && fd("/guide/intro?page=2")[0]?.status === "indexed" && /DOCS-INTRO-PAGE2-MARKER/.test(storedText(d)));
        record("docs: /guide/Intro (capital I) is a separate page", fd("/guide/Intro")[0]?.status === "indexed" && /DOCS-INTRO-CAPITAL-MARKER/.test(storedText(d)));
        record("docs: tracking parameters and #fragments do not create extra pages", !d.urlReport.some(e => /utm_source|#/.test(e.url)) && (storedText(d).match(/DOCS-INTRO-MARKER/g) || []).length === 1);
        record("docs: documentation subdomain (docs.) is in scope and read", fd("/faq", `docs.docs-site.test`)[0]?.status === "indexed" && /DOCS-FAQ-MARKER/.test(storedText(d)));
        record("docs: another subdomain (blog.) is outside the crawl scope", fd("/post", "blog.docs-site.test")[0]?.reason === "outside the crawl scope (another website)" && !/DOCS-BLOG-MARKER/.test(storedText(d)));
        record("docs: a page listed only in the sitemap is read", fd("/guide/sitemap-only")[0]?.status === "indexed" && fd("/guide/sitemap-only")[0].source === "sitemap");
        record("docs: sitemap entry on another website skipped", fd("/listed-elsewhere", "other.test")[0]?.reason === "outside the crawl scope (another website)" && !hits[`other.test/listed-elsewhere`]);
        record("docs: sitemap e-mail entry skipped, never requested", /e-mail address/.test(fd("/guide/writers@docs-site.test")[0]?.reason || "") && !Object.keys(hits).some(key => key.includes("writers@")));
        record("docs: an address both linked and in the sitemap is one entry", fd("/guide/intro").length === 1);

        // ---- Shop: limits and HTTP errors ----
        const s = await crawl(`${at("shop.test")}/`, 20);
        const fs1 = finder(s);
        allFinal("shop", s);
        record("shop: login and cart pages skipped, never requested", /account|login|cart/i.test(fs1("/login")[0]?.reason || "") && /account|login|cart/i.test(fs1("/cart")[0]?.reason || "") && !hits["shop.test/login"] && !hits["shop.test/cart"]);
        // "Not retried" = one attempt. (The server can see this address twice when the browser was
        // still finishing the previous failed page: open() then repeats the same navigation once,
        // within the same attempt. That depends on page order, not on the HTTP status; the 403,
        // HTML 404 and redirect-to-404 checks below count server requests.)
        record("shop: HTTP 404 (plain text, no content type) is 'HTTP 404', one attempt (not retried)", fs1("/missing")[0]?.status === "failed" && fs1("/missing")[0].reason === "HTTP 404" && fs1("/missing")[0].httpStatus === 404 && fs1("/missing")[0].attempts === 1, `requests ${hits["shop.test/missing"]}, attempts ${fs1("/missing")[0]?.attempts}, ${fs1("/missing")[0]?.reason}`);
        record("shop: HTTP 500 failed after 3 attempts (temporary, retried)", fs1("/broken")[0]?.status === "failed" && /HTTP 500 \(after 3 attempts\)/.test(fs1("/broken")[0].reason) && hits["shop.test/broken"] === 3, JSON.stringify(fs1("/broken")[0]));
        // HTTP status classification is independent of the response's content type.
        const one = pathname => fs1(pathname)[0] || {};
        record("http: 403 (text/plain) is 'HTTP 403', permanent, requested once", one("/forbidden").status === "failed" && one("/forbidden").reason === "HTTP 403" && one("/forbidden").httpStatus === 403 && hits["shop.test/forbidden"] === 1, JSON.stringify(one("/forbidden")));
        record("http: 429 (JSON body) is temporary: 'HTTP 429 (after 3 attempts)'", one("/busy").reason === "HTTP 429 (after 3 attempts)" && one("/busy").attempts === 3 && hits["shop.test/busy"] === 3, JSON.stringify(one("/busy")));
        record("http: 404 with an HTML error page is 'HTTP 404', not stored", one("/html-missing").reason === "HTTP 404" && hits["shop.test/html-missing"] === 1 && !/SHOP-404-MARKER/.test(storedText(s)), JSON.stringify(one("/html-missing")));
        record("http: 503 with an HTML error page is retried: 'HTTP 503 (after 3 attempts)'", one("/html-unavailable").reason === "HTTP 503 (after 3 attempts)" && hits["shop.test/html-unavailable"] === 3 && !/SHOP-503-MARKER/.test(storedText(s)), JSON.stringify(one("/html-unavailable")));
        record("http: a redirect ending in a plain-text 404 reports 'HTTP 404'", one("/moved-away").status === "failed" && one("/moved-away").reason === "HTTP 404" && hits["shop.test/gone"] === 1, JSON.stringify(one("/moved-away")));
        record("content type: a successful PDF response (no file extension) is refused as a page, once", one("/download").status === "failed" && one("/download").reason === "Not an HTML page." && hits["shop.test/download"] === 1 && !/SHOP-PDF-MARKER/.test(storedText(s)), JSON.stringify(one("/download")));
        record("content type: a successful image response (no file extension) is refused as a page", one("/picture").status === "failed" && one("/picture").reason === "Not an HTML page." && !/SHOP-IMAGE-MARKER/.test(storedText(s)), JSON.stringify(one("/picture")));
        record("network: a connection dropped every time is retried by the network rule (2 attempts)", one("/drop").status === "failed" && one("/drop").attempts === 2 && /\(after 2 attempts\)$/.test(one("/drop").reason || "") && hits["shop.test/drop"] === 2, JSON.stringify(one("/drop")) + " requests " + hits["shop.test/drop"]);
        record("http: valid HTML pages are still read and indexed", one("/product").status === "indexed" && fs1("/p1")[0]?.status === "indexed" && /SHOP-PRODUCT-MARKER/.test(storedText(s)));
        record("shop: redirect to a page already read is skipped with the final address", fs1("/old-product")[0]?.reason === "redirects to a page already read" && /\/product$/.test(fs1("/old-product")[0].finalUrl || ""), JSON.stringify(fs1("/old-product")[0]));
        record("shop: complete crawl", s.stopReason === "complete", s.stopReason);
        const limited = await crawl(`${at("shop.test")}/`, 3);
        allFinal("shop with a 3-page limit", limited);
        const waiting = limited.urlReport.filter(e => e.status === "not-processed");
        record("limit: the page limit stops the crawl with the reason", limited.stopReason === "page-limit" && limited.pages.length === 3, `${limited.stopReason}, ${limited.pages.length} pages`);
        record("limit: pages beyond the limit stay visible as not processed (page-limit)", waiting.length >= 3 && waiting.every(e => e.reason === "page-limit"), `${waiting.length} not processed`);
    } catch (error) {
        console.log = log;
        record("unexpected test error", false, error.stack || error.message);
    } finally {
        server.close();
    }
    console.table(results);
    const failed = results.filter(row => row.result === "FAIL").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})();
