// Ingestion tests: index, re-index without duplicates, and failed re-index keeps old data.
// Uses a local fake website and writes to the real Qdrant collection ONLY under a new random
// chatbot ID that is not in the database; those points are deleted at the end (also on failure).
// No PostgreSQL rows are created. Needs Qdrant + Ollama (embeddings only). Run: npm run test:ingest
//
// Test-only change: the fake site's origin (127.0.0.1:<random port>) is allow-listed inside
// assertPublicHttpUrl; every other URL still goes through the real SSRF checks.
const fs = require("fs"), path = require("path"), http = require("http"), crypto = require("crypto"), Module = require("module");

const projectDir = path.join(__dirname, "..");
const ingestPath = path.join(projectDir, "ingest.js");
// QDRANT_COLLECTION: set by tests/run-isolated.js (isolated test collection); default as before.
const QDRANT = `http://localhost:6333/collections/${process.env.QDRANT_COLLECTION || "website_content"}`;
const TEMP_ID = crypto.randomUUID();

async function qdrant(route, body) {
    const r = await fetch(QDRANT + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()).result;
}
const countAll = async () => (await qdrant("/points/count", { exact: true })).count;
const tempPoints = async () => (await qdrant("/points/scroll", { limit: 1000, with_payload: true, filter: { must: [{ key: "chatbotId", match: { value: TEMP_ID } }] } })).points;

const results = [];
const record = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 120) });

(async () => {
    // ---- fake website whose behaviour each step can change ----
    let mode = "v1";
    // Requests per path (retry tests: transient failures retried, permanent ones not).
    const hits = {};
    const filler = "This is ordinary public website text that the crawler should extract and index. ".repeat(5);
    const page = (title, body) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body} ${filler}</p></main></body></html>`;
    const site = http.createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        hits[u.pathname] = (hits[u.pathname] || 0) + 1;
        if (u.pathname === "/robots.txt") {
            const sitemapLine = `Sitemap: http://${req.headers.host}/sitemap.xml\n`;
            return res.end(mode === "robots-blocked" ? "User-agent: *\nDisallow: /\n" + sitemapLine : "User-agent: *\nDisallow: /private\n" + sitemapLine);
        }
        // Sitemap: one page linked from nowhere, one on another host, one disallowed by robots.txt.
        if (u.pathname === "/sitemap.xml") {
            res.setHeader("Content-Type", "application/xml");
            return res.end(`<?xml version="1.0"?><urlset><url><loc>http://${req.headers.host}/hidden</loc></url><url><loc>http://other-host.example/elsewhere</loc></url><url><loc>http://${req.headers.host}/private/secret</loc></url></urlset>`);
        }
        if (u.pathname === "/hidden" && !["server-error", "hanging"].includes(mode)) {
            res.setHeader("Content-Type", "text/html");
            return res.end(page("Unlinked Page", "HIDDEN-SITEMAP-MARKER only listed in the sitemap."));
        }
        if (mode === "server-error") { res.writeHead(500); return res.end("error"); }
        if (mode === "hanging") return; // never answers
        res.setHeader("Content-Type", "text/html");
        const marker = mode === "v1" ? "ALPHA-VERSION-ONE" : "BRAVO-VERSION-TWO";
        if (u.pathname === "/") return res.end(page("Fake Shop Home", `Welcome. Marker ${marker}. <a href="/about">About</a> <a href="/flaky">Flaky</a> <a href="/reset-once">Reset</a> <a href="/busy">Busy</a> <a href="/private">Private</a> <a href="/download">Download</a> <a href="/huge">Catalogue</a> <a href="/docs/">Docs</a>`));
        // Directory-relative links: "guide.html" on "/docs/" must open "/docs/guide.html".
        // Transient failures: 503 once, a dropped connection once, and a page that stays busy.
        if (u.pathname === "/flaky") {
            if (hits["/flaky"] === 1) { res.writeHead(503); return res.end("busy"); }
            return res.end(page("Flaky Page", "FLAKY-MARKER available on the second attempt."));
        }
        if (u.pathname === "/reset-once") {
            if (hits["/reset-once"] === 1) return req.socket.destroy();
            return res.end(page("Reset Page", "RESET-MARKER available after a dropped connection."));
        }
        if (u.pathname === "/busy") { res.writeHead(503); return res.end("busy"); }
        if (u.pathname === "/docs") { res.writeHead(301, { Location: "/docs/" }); return res.end(); }
        if (u.pathname === "/docs/") return res.end(page("Docs Index", `Documentation. <a href="guide.html">Guide</a> <a href="missing.html">Old page</a>`));
        if (u.pathname === "/docs/guide.html") return res.end(page("Docs Guide", "DOCS-GUIDE-MARKER How to use the widgets."));
        if (u.pathname === "/guide.html") return res.end(page("Wrong Guide", "WRONG-BASE-MARKER resolved against the wrong directory."));
        if (u.pathname === "/docs/missing.html") { res.writeHead(404); return res.end(page("Page not found", "NOT-FOUND-MARKER This page does not exist.")); }
        if (u.pathname === "/download") { res.setHeader("Content-Type", "application/octet-stream"); return res.end(page("Binary Download", "BINARY-MARKER should never be indexed.")); }
        if (u.pathname === "/huge") return res.end(page("Huge Catalogue", "HUGE-MARKER " + "x".repeat(6 * 1024 * 1024)));
        if (u.pathname === "/about") return res.end(page("About Fake Shop", `We sell test widgets. Marker ${marker}.`));
        if (u.pathname === "/private") return res.end(page("Private Page", "This must never be indexed."));
        res.writeHead(404); res.end();
    });
    await new Promise(r => site.listen(0, "127.0.0.1", r));
    const SITE = `http://127.0.0.1:${site.address().port}`;

    // ---- load ingest.js with the test allow-list ----
    let src = fs.readFileSync(ingestPath, "utf8");
    const marker = "async function assertPublicHttpUrl(rawUrl) {";
    src = src.replace(marker, marker + `\n    try { if (new URL(rawUrl).origin === ${JSON.stringify(SITE)}) return new URL(rawUrl); } catch {}`);
    const m = new Module(ingestPath); m.filename = ingestPath; m.paths = Module._nodeModulePaths(projectDir);
    m._compile(src, ingestPath);
    const { ingestWebsite } = m.exports;

    const log = console.log;
    const quiet = async fn => { console.log = () => {}; try { return await fn(); } finally { console.log = log; } };
    const baseline = await countAll();

    try {
        // Safety: the temporary ID must not belong to any existing chatbot data.
        record("temporary chatbot ID has no existing points", (await tempPoints()).length === 0, TEMP_ID);

        // 1. First index.
        mode = "v1";
        const r1 = await quiet(() => ingestWebsite(`${SITE}/`, TEMP_ID));
        const p1 = await tempPoints();
        const text1 = JSON.stringify(p1.map(p => p.payload));
        record("sitemap: unlinked page found and indexed", /HIDDEN-SITEMAP-MARKER/.test(text1) && r1.pagesFromSitemap >= 1, `pagesFromSitemap=${r1.pagesFromSitemap}`);
        record("sitemap: other host and robots-disallowed entries not indexed", !/elsewhere|never be indexed/.test(text1));
        record("index: chunks stored under the chatbot ID", r1.chunksStored > 0 && p1.length === r1.chunksStored,`${r1.chunksStored} chunks, ${p1.length} points`);
        record("index: robots.txt-disallowed page skipped", r1.pagesBlockedByRobots >= 1 && !/Private Page|never be indexed/.test(text1), `pagesBlockedByRobots=${r1.pagesBlockedByRobots}`);
        record("index: every point tagged with this chatbot ID only", p1.every(p => p.payload.chatbotId === TEMP_ID));
        record("index: directory-relative links resolved against the page's real address",
            /DOCS-GUIDE-MARKER/.test(text1) && !/WRONG-BASE-MARKER/.test(text1));
        record("index: HTTP 404 error page not indexed", !/NOT-FOUND-MARKER/.test(text1));
        record("index: non-HTML response and >5 MB page not indexed", !/BINARY-MARKER|HUGE-MARKER/.test(text1) && /About Fake Shop/.test(text1), `pagesFailed=${r1.pagesFailed}`);
        record("index: rejected pages (binary, >5 MB, 404) counted as failed", r1.pagesFailed >= 3, JSON.stringify({ crawlComplete: r1.crawlComplete, pagesFailed: r1.pagesFailed }));
        // Bounded retries for transient failures; permanent failures are not retried.
        const entry = pathname => (r1.urlReport || []).find(item => { try { return new URL(item.url).pathname === pathname; } catch { return false; } });
        const flaky = entry("/flaky"), reset = entry("/reset-once"), busy = entry("/busy"), missing = entry("/docs/missing.html"), about = entry("/about");
        record("retry: a page answering HTTP 503 once is indexed on the second attempt", /FLAKY-MARKER/.test(text1) && flaky?.status === "indexed" && flaky?.attempts === 2, JSON.stringify(flaky));
        record("retry: a dropped connection is retried and the page indexed", /RESET-MARKER/.test(text1) && reset?.status === "indexed" && reset?.attempts === 2, JSON.stringify(reset));
        record("retry: a page that stays busy is reported failed after 3 attempts (HTTP 503)", busy?.status === "failed" && busy?.attempts === 3 && busy?.httpStatus === 503 && /HTTP 503 \(after 3 attempts\)/.test(busy?.reason || "") && hits["/busy"] === 3, JSON.stringify({ status: busy?.status, attempts: busy?.attempts, http: busy?.httpStatus, reason: busy?.reason }) + " requests " + hits["/busy"]);
        record("retry: a permanent failure (404) is requested only once", missing?.status === "failed" && (missing?.attempts || 1) === 1 && hits["/docs/missing.html"] === 1, JSON.stringify(missing) + " requests " + hits["/docs/missing.html"]);
        record("report: an indexed page has its title and processing time", about?.status === "indexed" && /About Fake Shop/.test(about?.title || "") && Number.isFinite(about?.durationMs), JSON.stringify(about));

        // 2. Re-index changed content: replaced, not duplicated.
        mode = "v2";
        const r2 = await quiet(() => ingestWebsite(`${SITE}/`, TEMP_ID));
        const p2 = await tempPoints();
        const text2 = JSON.stringify(p2.map(p => p.payload));
        const oldIds = new Set(p1.map(p => p.id));
        record("re-index: point count equals new chunk count (no duplicates)", p2.length === r2.chunksStored, `${p2.length} points, ${r2.chunksStored} chunks`);
        record("re-index: old content fully replaced", /BRAVO-VERSION-TWO/.test(text2) && !/ALPHA-VERSION-ONE/.test(text2) && p2.every(p => !oldIds.has(p.id)));

        // 3-5. Failed re-indexes must keep the previous knowledge untouched.
        const snapshot = JSON.stringify(p2.map(p => p.id).sort());
        for (const [failMode, expect, label] of [
            ["robots-blocked", /robots\.txt/, "robots.txt now disallows everything"],
            ["server-error", /No useful content/, "site returns HTTP 500"],
            ["hanging", /No useful content/, "start page never responds (page timeout)"]
        ]) {
            mode = failMode;
            const started = Date.now();
            let error = null;
            try { await quiet(() => ingestWebsite(`${SITE}/`, TEMP_ID)); } catch (e) { error = e.message; }
            const after = await tempPoints();
            record(`failed re-index (${label}): error reported`, !!error && expect.test(error), `${error} (${Math.round((Date.now() - started) / 1000)}s)`);
            record(`failed re-index (${label}): previous data kept`, JSON.stringify(after.map(p => p.id).sort()) === snapshot, `${after.length} points`);
        }
        // Page limit per indexing request.
        mode = "v2";
        const beforeLimited = await tempPoints();
        const limited = await quiet(() => ingestWebsite(`${SITE}/`, TEMP_ID, { maxPages: 2 }));
        const pLimited = await tempPoints();
        const beforeIds = new Set(beforeLimited.map(p => p.id));
        const afterIds = new Set(pLimited.map(p => p.id));
        const newPoints = pLimited.filter(p => !beforeIds.has(p.id));
        const reread = new Set(newPoints.map(p => p.payload.url));
        record("page limit: maxPages 2 crawls at most 2 pages, reported as partial",
            limited.pagesCrawled <= 2 && limited.pageLimit === 2 && limited.crawlComplete === false && newPoints.length === limited.chunksStored,
            JSON.stringify({ pagesCrawled: limited.pagesCrawled, pageLimit: limited.pageLimit, crawlComplete: limited.crawlComplete }));
        // An incomplete re-index (stopped by a limit) replaces only the pages it stored; the pages it
        // did not reach keep their earlier sections (removed only by a complete crawl).
        const unreached = beforeLimited.filter(p => !reread.has(p.payload.url));
        record("incomplete re-index: pages it did not reach keep their sections", unreached.length > 0 && unreached.every(p => afterIds.has(p.id)), `${unreached.length} kept of ${beforeLimited.length}`);
        record("incomplete re-index: pages it read again are replaced, not duplicated", beforeLimited.filter(p => reread.has(p.payload.url)).every(p => !afterIds.has(p.id)) && pLimited.length === limited.sectionsInIndex, `${pLimited.length} points, sectionsInIndex ${limited.sectionsInIndex}`);
        const clamped = await quiet(() => ingestWebsite(`${SITE}/`, TEMP_ID, { maxPages: 500 }));
        record("page limit: values above the maximum are capped at 50", clamped.pageLimit === 50, `pageLimit=${clamped.pageLimit}`);
        const pClamped = await tempPoints();
        record("complete re-index: stale sections removed (index = this crawl's sections)", !clamped.crawlComplete || pClamped.length === clamped.chunksStored, JSON.stringify({ crawlComplete: clamped.crawlComplete, points: pClamped.length, chunksStored: clamped.chunksStored }));
    } catch (error) {
        record("unexpected test error", false, error.message);
    } finally {
        // Cleanup: delete only this test's temporary chatbot ID.
        await fetch(QDRANT + "/points/delete?wait=true", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "chatbotId", match: { value: TEMP_ID } }] } }) });
        const left = (await tempPoints()).length;
        const total = await countAll();
        record("cleanup: temporary points removed, collection back to baseline", left === 0 && total === baseline, `baseline ${baseline}, now ${total}, temp left ${left}`);
        site.closeAllConnections?.();
        site.close();
    }

    console.table(results);
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})();
