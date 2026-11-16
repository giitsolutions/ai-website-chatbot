// Crawl URL handling and report accounting (local only: no database, no Qdrant, no model).
// A local fake website is served under two host names, site.test and www.site.test (the SSRF check
// is allow-listed for exactly these two origins and pinned to 127.0.0.1, so the browser never
// resolves them itself and no external site is contacted). crawlWebsite() runs for real and
// markIndexedPages() turns its report into final statuses the way ingestWebsite() does.
// Covers: www/bare address forms in the crawl report, redirects to pages already read (home,
// another page, the same page under another form), normal redirects, and e-mail addresses
// written as links. Run: npm run test:crawl-urls
const fs = require("fs"), path = require("path"), http = require("http"), Module = require("module");

const projectDir = path.join(__dirname, "..");
const ingestPath = path.join(projectDir, "ingest.js");

const results = [];
const record = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 140) });

(async () => {
    // ---- fake website, answered by host name ----
    const hits = {};
    const filler = "Ordinary website text that the crawler extracts and keeps as a section for visitors. ".repeat(6);
    const page = (title, body) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body} ${filler}</p></main></body></html>`;
    const site = http.createServer((req, res) => {
        const host = String(req.headers.host || "").split(":")[0];
        const u = new URL(req.url, "http://x");
        const key = `${host}${u.pathname}${u.search}`;
        hits[key] = (hits[key] || 0) + 1;
        if (u.pathname === "/robots.txt") return res.end("User-agent: *\nAllow: /\n");
        if (u.pathname === "/sitemap.xml") {
            const origin = `http://${host}:${site.address().port}`;
            res.setHeader("Content-Type", "application/xml");
            return res.end(`<?xml version="1.0"?><urlset><url><loc>${origin}/sitemap-sales@inhousegym.in</loc></url><url><loc>${origin}/@sitemap/news</loc></url></urlset>`);
        }
        const go = location => { res.writeHead(301, { Location: location }); res.end(); };
        res.setHeader("Content-Type", "text/html");
        if (u.pathname === "/") {
            return res.end(page("Home", `HOME-MARKER welcome.
                <a href="/about">About us</a>
                <a href="/redirect-home">Start again</a>
                <a href="/moved">Moved page</a>
                <a href="/slash">Trailing slash page</a>
                <a href="/to-www">Main host page</a>
                <a href="/plans">x</a> <a href="http://www.${host}:${site.address().port}/plans">Pricing plans</a>
                <a href="inhousegym@gmail.com">Mail us</a>
                <a href="contactus@inhousegym.in">Contact</a>
                <a href="mailto:hello@site.test">Write to us</a>
                <a href="/@team/news">Team news</a>
                <a href="badge@2x.html">Badge page</a>
                <a href="/share?from=user@site.test">Share page</a>
                <a href="/rooted@inhousegym.in">Mail (root-relative)</a>
                <a href="contact/info@inhousegym.in">Mail (path-prefixed)</a>
                <a href="http://${host}:${site.address().port}/team/absolute@inhousegym.in">Mail (absolute)</a>`));
        }
        if (u.pathname === "/about") return res.end(page("About", `ABOUT-MARKER who we are. <a href="/old-about">Old about address</a>`));
        // Redirects to pages that were already read: the home page, and another page.
        if (u.pathname === "/redirect-home") return go("/");
        if (u.pathname === "/old-about") return go("/about");
        // A normal redirect to a page not read yet.
        if (u.pathname === "/moved") return go("/new-page");
        if (u.pathname === "/new-page") return res.end(page("New page", "NEW-PAGE-MARKER the moved content."));
        // Redirects to the same page under another form of its address (same page key).
        if (u.pathname === "/slash") return go("/slash/");
        if (u.pathname === "/slash/") return res.end(page("Slash page", "SLASH-MARKER content behind a trailing-slash redirect."));
        if (u.pathname === "/to-www" && !host.startsWith("www.")) return go(`http://www.${host}:${site.address().port}/to-www`);
        if (u.pathname === "/to-www") return res.end(page("Main host page", "WWW-MARKER content on the www host."));
        if (u.pathname === "/plans") return res.end(page("Plans", "PLANS-MARKER monthly and yearly plans."));
        // Legitimate addresses that contain "@".
        if (u.pathname === "/@team/news") return res.end(page("Team news", "TEAM-NEWS-MARKER news from the team."));
        if (u.pathname === "/badge@2x.html") return res.end(page("Badge", "BADGE-MARKER a page whose file name has an at sign."));
        if (u.pathname === "/share") return res.end(page("Share", "SHARE-MARKER a page with an at sign in its query."));
        if (u.pathname === "/@sitemap/news") return res.end(page("Sitemap news", "SITEMAP-AT-MARKER a sitemap page whose path has an at sign."));
        // Anything else (including e-mail addresses resolved as paths) fails like the real site did.
        res.writeHead(500); res.end("error");
    });
    await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
    const port = site.address().port;
    const SITE = `http://site.test:${port}`;
    const WWW = `http://www.site.test:${port}`;

    // ---- load ingest.js with the two test origins allow-listed and pinned to 127.0.0.1 ----
    let src = fs.readFileSync(ingestPath, "utf8");
    const marker = "async function assertPublicHttpUrl(rawUrl) {";
    if (!src.includes(marker)) throw new Error("allow-list marker not found in ingest.js");
    src = src.replace(marker, marker + `
    try {
        const parsedTestUrl = new URL(rawUrl);
        if (${JSON.stringify([SITE, WWW])}.includes(parsedTestUrl.origin)) return Object.assign(parsedTestUrl, { publicAddresses: [{ address: "127.0.0.1", family: 4 }] });
    } catch {}`);
    src += "\nmodule.exports.__crawlWebsite = crawlWebsite;\n";
    const m = new Module(ingestPath); m.filename = ingestPath; m.paths = Module._nodeModulePaths(projectDir);
    m._compile(src, ingestPath);
    const { __crawlWebsite: crawlWebsite, markIndexedPages, pageUrlForms, reconcileCrawlRows, isEmailAddressPath } = m.exports;

    const log = console.log;
    try {
        // ---- 1. The exact InHouseGym mismatch (addresses from its stored crawl report) ----
        if (typeof markIndexedPages !== "function") {
            record("www/bare: markIndexedPages() exported", false, "not implemented");
        } else {
            const report = [
                { url: "https://inhousegym.in/", status: "read" },
                { url: "https://inhousegym.in/online_fitness_training.php", status: "read" },
                { url: "https://inhousegym.in/our%20policies.html", status: "read" },
                { url: "https://inhousegym.in/empty.html", status: "read" },
                { url: "https://inhousegym.in/Case.html", status: "read" },
                { url: "https://inhousegym.in/item?id=1", status: "read" },
                { url: "https://www.inhousegym.in/index.html", status: "skipped", reason: "same content as https://inhousegym.in/" }
            ];
            const chunk = (url, n) => Array.from({ length: n }, () => ({ url }));
            const chunks = [
                ...chunk("https://inhousegym.in/", 16),
                ...chunk("https://www.inhousegym.in/online_fitness_training.php", 3),
                ...chunk("https://www.inhousegym.in/our%20policies.html", 7),
                // Different pages that must NOT be credited to the entries above.
                ...chunk("https://help.inhousegym.in/empty.html", 2),
                ...chunk("https://inhousegym.in/case.html", 2),
                ...chunk("https://inhousegym.in/item?id=2", 2)
            ];
            markIndexedPages(report, chunks);
            const byUrl = url => report.find(entry => entry.url === url);
            const training = byUrl("https://inhousegym.in/online_fitness_training.php");
            record("www/bare: page stored under www. is indexed with its section count", training.status === "indexed" && training.sections === 3, JSON.stringify(training));
            record("www/bare: the report shows the address it was stored under", training.finalUrl === "https://www.inhousegym.in/online_fitness_training.php", training.finalUrl);
            record("www/bare: encoded paths match (our%20policies.html)", byUrl("https://inhousegym.in/our%20policies.html").status === "indexed" && byUrl("https://inhousegym.in/our%20policies.html").sections === 7);
            record("www/bare: same-address page keeps its count, no final address added", byUrl("https://inhousegym.in/").status === "indexed" && byUrl("https://inhousegym.in/").sections === 16 && !byUrl("https://inhousegym.in/").finalUrl);
            record("www/bare: another host (help.) is not merged", byUrl("https://inhousegym.in/empty.html").status === "skipped" && /no text/.test(byUrl("https://inhousegym.in/empty.html").reason));
            record("www/bare: a path differing in case is a different page", byUrl("https://inhousegym.in/Case.html").status === "skipped");
            record("www/bare: a different query is a different page", byUrl("https://inhousegym.in/item?id=1").status === "skipped");
            record("www/bare: entries that are not 'read' are left unchanged", byUrl("https://www.inhousegym.in/index.html").status === "skipped" && /same content/.test(byUrl("https://www.inhousegym.in/index.html").reason));
            const indexedSections = report.filter(entry => entry.status === "indexed").reduce((sum, entry) => sum + entry.sections, 0);
            record("www/bare: indexed sections equal the stored sections of these pages", indexedSections === 26, `${indexedSections} of 26`);
        }
        if (typeof pageUrlForms !== "function") {
            record("www/bare: pageUrlForms() exported", false, "not implemented");
        } else {
            const forms = pageUrlForms("https://inhousegym.in/our%20policies.html");
            record("www/bare: both address forms of one page, nothing else", JSON.stringify(forms) === JSON.stringify(["https://inhousegym.in/our%20policies.html", "https://www.inhousegym.in/our%20policies.html"]), JSON.stringify(forms));
            record("www/bare: forms of a www address", JSON.stringify(pageUrlForms("https://www.example.com/a?x=1")) === JSON.stringify(["https://www.example.com/a?x=1", "https://example.com/a?x=1"]), JSON.stringify(pageUrlForms("https://www.example.com/a?x=1")));
            record("www/bare: other subdomains keep one form", JSON.stringify(pageUrlForms("https://help.example.com/a")) === JSON.stringify(["https://help.example.com/a", "https://www.help.example.com/a"]) || JSON.stringify(pageUrlForms("https://help.example.com/a")) === JSON.stringify(["https://help.example.com/a"]), JSON.stringify(pageUrlForms("https://help.example.com/a")));
        }

        // ---- 1b. Stored reports written before the fix: the six InHouseGym rows ----
        // (statuses, reasons and per-page section counts exactly as stored on 2026-10-22)
        if (typeof reconcileCrawlRows !== "function") {
            record("reconcile: reconcileCrawlRows() exported", false, "not implemented");
        } else {
            const six = [
                ["AC_Treadmill.html", 2], ["commercial_treadmill.html", 4], ["crosstrainer_Eliptical%20Magnetic%20Bike.html", 2],
                ["dietitian_service.html", 3], ["online_fitness_training.php", 3], ["our%20policies.html", 7]
            ];
            const rows = [
                ...six.map(([path]) => ({ url: `https://inhousegym.in/${path}`, status: "skipped", reason: "no text long enough to store" })),
                { url: "https://inhousegym.in/", status: "indexed", sections: 16 },
                { url: "https://inhousegym.in/lindex.htm", status: "failed", reason: "HTTP 500" },
                { url: "https://www.inhousegym.in/treadmillonrent-TM-2.html", status: "not-processed", reason: "request-limit" },
                { url: "https://inhousegym.in/images/img/gallery-1.avif", status: "skipped", reason: "not a web page (.avif file)" },
                { url: "https://inhousegym.in/Case.html", status: "skipped", reason: "no text long enough to store" },
                { url: "https://inhousegym.in/item?id=1", status: "skipped", reason: "no text long enough to store" },
                { url: "https://inhousegym.in/docs-only.html", status: "skipped", reason: "no text long enough to store" },
                { url: "https://www.inhousegym.in/contactus@inhousegym.in", status: "not-processed", reason: "request-limit" },
                { url: "https://inhousegym.in/inhousegym@gmail.com", status: "failed", reason: "HTTP 500" },
                { url: "https://inhousegym.in/@team/news", status: "not-processed", reason: "request-limit" },
                { url: "https://inhousegym.in/kept.html", status: "failed", reason: "HTTP 503 (after 3 attempts); the 2 section(s) indexed earlier are still used" }
            ];
            const points = [
                ...six.flatMap(([path, n]) => Array.from({ length: n }, () => ({ url: `https://www.inhousegym.in/${path}`, sourceType: "website" }))),
                ...Array.from({ length: 16 }, () => ({ url: "https://inhousegym.in/", sourceType: "website" })),
                // Not the same pages: another subdomain, other capitalisation, another query.
                { url: "https://help.inhousegym.in/lindex.htm", sourceType: "website" },
                { url: "https://inhousegym.in/case.html", sourceType: "website" },
                { url: "https://inhousegym.in/item?id=2", sourceType: "website" },
                // Uploaded documents never count as website content.
                { url: "https://inhousegym.in/docs-only.html", sourceType: "document" },
                { url: "https://inhousegym.in/kept.html", sourceType: "website" },
                { url: "https://inhousegym.in/kept.html", sourceType: "website" }
            ];
            const before = JSON.stringify(rows);
            const { rows: now, counts } = reconcileCrawlRows(rows, points);
            const at = url => now.find(row => row.url === url);
            const sixNow = six.map(([path, n]) => ({ row: at(`https://inhousegym.in/${path}`), n, path }));
            record("reconcile: the six InHouseGym rows are indexed under the www. address form", sixNow.every(({ row }) => row.current_status === "indexed-elsewhere"), sixNow.map(({ path, row }) => `${path}=${row.current_status}`).join(" "));
            record("reconcile: each shows the stored section count and the www. address", sixNow.every(({ row, n, path }) => row.stored_sections === n && row.stored_url === `https://www.inhousegym.in/${path}`), sixNow.map(({ path, row }) => `${path}:${row.stored_sections}`).join(" "));
            record("reconcile: recorded statuses are kept as they were", sixNow.every(({ row }) => row.status === "skipped" && /no text/.test(row.reason)) && JSON.stringify(rows) === before);
            record("reconcile: indexed pages = home (recorded) + the six (stored under www.) = 7; sections 16 + 21 = 37", (counts.indexed || 0) + (counts["indexed-elsewhere"] || 0) === 7 && now.reduce((sum, row) => sum + (["indexed", "indexed-elsewhere"].includes(row.current_status) ? row.stored_sections : 0), 0) === 37, JSON.stringify(counts));
            record("reconcile: a failed page with no stored content stays failed", at("https://inhousegym.in/lindex.htm").current_status === "failed" && at("https://inhousegym.in/lindex.htm").stored_sections === 0);
            record("reconcile: a pending page stays pending", at("https://www.inhousegym.in/treadmillonrent-TM-2.html").current_status === "not-processed");
            record("reconcile: an image link stays skipped", at("https://inhousegym.in/images/img/gallery-1.avif").current_status === "skipped");
            record("reconcile: other capitalisation is not merged", at("https://inhousegym.in/Case.html").current_status === "skipped");
            record("reconcile: another query is not merged", at("https://inhousegym.in/item?id=1").current_status === "skipped");
            record("reconcile: uploaded-document sections are not website content", at("https://inhousegym.in/docs-only.html").current_status === "skipped" && at("https://inhousegym.in/docs-only.html").stored_sections === 0);
            const pendingMail = at("https://www.inhousegym.in/contactus@inhousegym.in"), failedMail = at("https://inhousegym.in/inhousegym@gmail.com");
            record("reconcile: an e-mail address recorded as pending is shown as skipped, with the reason", pendingMail.current_status === "skipped" && /e-mail address/.test(pendingMail.current_reason || "") && pendingMail.status === "not-processed", JSON.stringify(pendingMail));
            record("reconcile: an e-mail address recorded as failed (HTTP 500) is shown as skipped", failedMail.current_status === "skipped" && /e-mail address/.test(failedMail.current_reason || "") && failedMail.status === "failed", JSON.stringify(failedMail));
            record("reconcile: a pending page with @ in its path stays pending", at("https://inhousegym.in/@team/news").current_status === "not-processed" && !at("https://inhousegym.in/@team/news").current_reason);
            record("reconcile: real failures keep their status and reason", at("https://inhousegym.in/lindex.htm").current_status === "failed" && !at("https://inhousegym.in/lindex.htm").current_reason);
            record("reconcile: a failed retry whose earlier version is still stored is 'kept-earlier'", at("https://inhousegym.in/kept.html").current_status === "kept-earlier" && at("https://inhousegym.in/kept.html").stored_sections === 2);
        }
        if (typeof isEmailAddressPath !== "function") {
            record("e-mail path: isEmailAddressPath() exported", false, "not implemented");
        } else {
            const yes = ["https://inhousegym.in/inhousegym@gmail.com", "https://www.inhousegym.in/contactus@inhousegym.in"];
            const no = ["https://example.com/@team/news", "https://example.com/badge@2x.html", "https://example.com/share?from=user@example.com", "https://example.com/contact", "https://example.com/"];
            record("e-mail path: resolved e-mail links are recognised", yes.every(isEmailAddressPath), yes.filter(url => !isEmailAddressPath(url)).join(" "));
            record("e-mail path: pages with @ in the path, file name or query are not", no.every(url => !isEmailAddressPath(url)), no.filter(isEmailAddressPath).join(" "));
        }

        // ---- 2 + 3. A real crawl of the local site ----
        console.log = () => {};
        let crawl;
        try { crawl = await crawlWebsite(`${SITE}/`, 30); } finally { console.log = log; }
        // Decoded, because the crawler stores query strings encoded ("?from=user%40site.test").
        const pathOf = url => { const parsed = new URL(url); return decodeURIComponent(parsed.pathname + parsed.search); };
        const entry = (pathname, host) => crawl.urlReport.find(item => pathOf(item.url) === pathname && (!host || new URL(item.url).hostname === host));
        const storedText = crawl.pages.map(p => JSON.stringify(p.sections)).join(" ");
        const stored = pathname => crawl.pages.find(p => pathOf(p.url) === pathname);

        const home = entry("/redirect-home");
        record("redirect to the home page already read: skipped with that reason", home?.status === "skipped" && home.reason === "redirects to a page already read", JSON.stringify(home));
        record("redirect to the home page already read: final address is the home page", home && pathOf(home.finalUrl) === "/", home?.finalUrl);
        const oldAbout = entry("/old-about");
        record("redirect to another page already read: skipped with that reason", oldAbout?.status === "skipped" && oldAbout.reason === "redirects to a page already read", JSON.stringify(oldAbout));
        record("redirect to another page already read: final address is that page", oldAbout && pathOf(oldAbout.finalUrl) === "/about", oldAbout?.finalUrl);
        record("redirects to pages already read: those pages are stored once", crawl.pages.filter(p => ["/", "/about"].includes(pathOf(p.url))).length === 2 && (storedText.match(/ABOUT-MARKER/g) || []).length === 1);
        const moved = entry("/moved"), newPage = entry("/new-page");
        record("normal redirect: old address skipped with its final address", moved?.status === "skipped" && moved.reason === "redirects to another address" && pathOf(moved.finalUrl) === "/new-page", JSON.stringify(moved));
        record("normal redirect: the new page is read and stored", newPage?.status === "read" && /NEW-PAGE-MARKER/.test(JSON.stringify(stored("/new-page")?.sections || "")), JSON.stringify(newPage));
        const slash = entry("/slash");
        record("redirect to the same page (trailing slash): the page is read, not an empty stub", slash?.status === "read" && /SLASH-MARKER/.test(storedText), JSON.stringify(slash));
        const toWww = entry("/to-www");
        const wwwPage = crawl.pages.find(p => /\/to-www$/.test(p.url));
        record("redirect to the same page on www.: the page is read, not an empty stub", toWww?.status === "read" && /WWW-MARKER/.test(storedText), JSON.stringify(toWww));
        record("redirect to the same page on www.: stored under the www. address", wwwPage && new URL(wwwPage.url).hostname === "www.site.test", wwwPage?.url);

        // Final statuses as ingestWebsite records them (each stored section counted once).
        if (typeof markIndexedPages === "function") {
            const chunks = crawl.pages.flatMap(p => p.sections.map(() => ({ url: p.url })));
            markIndexedPages(crawl.urlReport, chunks);
            record("report: the www.-redirected page ends indexed with the www. address shown", toWww?.status === "indexed" && toWww.sections > 0 && new URL(toWww.finalUrl || toWww.url).hostname === "www.site.test", JSON.stringify(toWww));
            const plans = crawl.urlReport.filter(item => new URL(item.url).pathname === "/plans");
            record("report: a page linked as both www. and bare address is one entry, indexed", plans.length === 1 && plans[0].status === "indexed" && plans[0].sections > 0, JSON.stringify(plans));
            const indexed = crawl.urlReport.filter(item => item.status === "indexed");
            const sectionsInReport = indexed.reduce((sum, item) => sum + item.sections, 0);
            record("report: indexed pages = stored pages, sections = stored sections", indexed.length === crawl.pages.length && sectionsInReport === chunks.length, `${indexed.length}/${crawl.pages.length} pages, ${sectionsInReport}/${chunks.length} sections`);
        }

        // ---- 3. E-mail addresses written as links (statuses are final: markIndexedPages ran above) ----
        const requested = Object.keys(hits);
        record("e-mail written as a link (inhousegym@gmail.com): never requested", !requested.some(key => /inhousegym@gmail\.com/.test(key)), requested.filter(key => key.includes("@")).join(" "));
        record("e-mail written as a link (contactus@inhousegym.in): never requested", !requested.some(key => /contactus@inhousegym\.in/.test(key)));
        const mail = entry("/inhousegym@gmail.com");
        record("e-mail written as a link: reported as skipped with a reason, not failed", mail?.status === "skipped" && /e-mail address/.test(mail.reason || ""), JSON.stringify(mail));
        record("mailto: link: not crawled and not reported as a page", !requested.some(key => /hello@site\.test/.test(key) && !/share/.test(key)) && !crawl.urlReport.some(item => /mailto|hello@site\.test/.test(item.url) && !/share/.test(item.url)));
        record("valid address with @ in the path (/@team/news): read and indexed", entry("/@team/news")?.status === "indexed" && /TEAM-NEWS-MARKER/.test(storedText), JSON.stringify(entry("/@team/news")));
        record("valid file name with @ (badge@2x.html): read and indexed", entry("/badge@2x.html")?.status === "indexed" && /BADGE-MARKER/.test(storedText), JSON.stringify(entry("/badge@2x.html")));
        record("valid address with @ in the query (/share?from=user@site.test): read and indexed", entry("/share?from=user@site.test")?.status === "indexed" && /SHARE-MARKER/.test(storedText), JSON.stringify(entry("/share?from=user@site.test")));
        for (const [label, pathname] of [["root-relative link", "/rooted@inhousegym.in"], ["path-prefixed link", "/contact/info@inhousegym.in"], ["absolute link", "/team/absolute@inhousegym.in"], ["sitemap entry", "/sitemap-sales@inhousegym.in"]]) {
            const row = entry(pathname);
            record(`e-mail address as ${label}: never requested`, !Object.keys(hits).some(key => key.endsWith(pathname)), Object.keys(hits).filter(key => key.includes("@")).join(" "));
            record(`e-mail address as ${label}: reported as skipped with the reason`, row?.status === "skipped" && /e-mail address/.test(row.reason || ""), JSON.stringify(row));
        }
        record("sitemap: e-mail entry recorded as coming from the sitemap", entry("/sitemap-sales@inhousegym.in")?.source === "sitemap");
        record("sitemap: a page whose path contains @ is read and indexed", entry("/@sitemap/news")?.status === "indexed" && /SITEMAP-AT-MARKER/.test(storedText), JSON.stringify(entry("/@sitemap/news")));
        record("no page failed (every address of the fake site is valid or skipped)", !crawl.urlReport.some(item => item.status === "failed"), crawl.urlReport.filter(item => item.status === "failed").map(item => pathOf(item.url) + " " + item.reason).join(", "));
        record("crawl finished normally", crawl.stopReason === "complete", crawl.stopReason);
    } catch (error) {
        console.log = log;
        record("unexpected test error", false, error.stack || error.message);
    } finally {
        site.close();
    }

    console.table(results);
    const failed = results.filter(row => row.result === "FAIL").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})();
