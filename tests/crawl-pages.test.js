// Live crawl progress and crawling chosen pages, end to end through the real admin API.
// Runs the real server.js IN THIS PROCESS on a free port (never 3000-3002) against a local
// fake website. Only that website's origin (127.0.0.1:<random port>) is allow-listed in the
// SSRF checks; every other address still goes through them. One TEMPORARY chatbot is
// registered (plus one row of a second temporary chatbot, for isolation); their rows, crawl
// reports and vectors are removed at the end (also on failure).
// The admin key is a random test key made here (the .env keys are never read or printed).
// Needs PostgreSQL, Qdrant and Ollama (embeddings only). ~1-2 min. Run: npm run test:crawl-pages
const fs = require("fs"), path = require("path"), http = require("http"), net = require("net"), crypto = require("crypto"), Module = require("module");

const projectDir = path.join(__dirname, "..");
// QDRANT_COLLECTION: set by tests/run-isolated.js (isolated test collection); default as before.
const QDRANT = `http://localhost:6333/collections/${process.env.QDRANT_COLLECTION || "website_content"}`;
const RESERVED_PORTS = new Set([3000, 3001, 3002, 3003, 3004, 3005, 5050]);

const results = [];
const record = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 140) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function qdrant(route, body) {
    const r = await fetch(QDRANT + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return (await r.json()).result;
}
const countAll = async () => (await qdrant("/points/count", { exact: true })).count;
const pointsOf = async chatbotId => (await qdrant("/points/scroll", { limit: 1000, with_payload: true, filter: { must: [{ key: "chatbotId", match: { value: chatbotId } }] } })).points;
const pointsForPath = (points, pathname) => points.filter(point => { try { return new URL(point.payload.url).pathname === pathname; } catch { return false; } });

// A free port chosen by the OS, checked against the ports this project must never use.
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

// Compiles a project module with a source change and registers it as the cached module, so
// server.js (and documents.js) load this version.
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

(async () => {
    // ---- fake website ----
    let mode = "normal";
    let brokenFixed = false;
    let keepPath = null; // an indexed page that later fails (section 6)
    const hits = {};
    const filler = "This is ordinary public website text that the crawler should extract and index for visitors. ".repeat(5);
    const page = (title, body, links = "") => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1><p>${body} ${filler}</p>${links}</main></body></html>`;
    const TOPICS = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
    const site = http.createServer(async (req, res) => {
        const u = new URL(req.url, "http://x");
        hits[u.pathname] = (hits[u.pathname] || 0) + 1;
        if (u.pathname === "/robots.txt") return res.end("User-agent: *\nDisallow: /private\n");
        if (u.pathname === "/sitemap.xml") { res.writeHead(404); return res.end(); }
        res.setHeader("Content-Type", "text/html");
        // Every page is a little slow, so the running crawl can be observed.
        await sleep(350);
        if (u.pathname === "/") {
            const links = TOPICS.map(topic => `<a href="/${topic}">${topic}</a>`).join(" ") + ` <a href="/broken">Broken</a> <a href="/private/area">Private</a>`;
            return res.end(page("Test Site Home", "HOME-MARKER welcome.", links));
        }
        const topic = u.pathname.replace(/\/$/, "").slice(1);
        if (TOPICS.includes(topic)) {
            if (mode === "keep-down" && u.pathname === keepPath) { res.writeHead(500); return res.end("error"); }
            if (mode === "keep-empty" && u.pathname === keepPath) return res.end("<html><head><title>Alpha</title></head><body><p>Moved.</p></body></html>");
            return res.end(page(`Topic ${topic}`, `${topic.toUpperCase()}-MARKER details about ${topic}.`));
        }
        if (u.pathname === "/broken") {
            if (!brokenFixed) { res.writeHead(503); return res.end("busy"); }
            return res.end(page("Broken Page", "BROKEN-FIXED-MARKER this page works now."));
        }
        if (u.pathname === "/old-address") { res.writeHead(301, { Location: "/new-address" }); return res.end(); }
        if (u.pathname === "/new-address") return res.end(page("New Address", "NEW-ADDRESS-MARKER the page moved here."));
        if (/^\/(extra-[123]|section\/(one|two))$/.test(u.pathname)) return res.end(page(`Pending ${u.pathname}`, `PENDING-MARKER ${u.pathname} content.`));
        if (u.pathname === "/private/area") return res.end(page("Private", "PRIVATE-MARKER must never be indexed."));
        res.writeHead(404);
        res.end(page("Not found", "nothing"));
    });
    await new Promise(resolve => site.listen(0, "127.0.0.1", resolve));
    const SITE = `http://127.0.0.1:${site.address().port}`;

    // ---- the real server, with only the fake site allow-listed ----
    const ADMIN_KEY = crypto.randomBytes(32).toString("hex");
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const port = await freePort();
    process.env.PORT = String(port);
    // The in-process server must not recover the real chatbots of the shared database.
    process.env.STARTUP_RECOVERY = "off";
    const allow = `\n    try { if (new URL(String(rawUrl)).origin === ${JSON.stringify(SITE)}) return new URL(String(rawUrl)); } catch {}`;
    loadPatched("ingest.js", src => src.replace("async function assertPublicHttpUrl(rawUrl) {", match => match + allow));
    loadPatched("chatbotRegistry.js", src => src
        .replace("async function assertPublicWebsiteUrl(parsedUrl) {", match => match + `\n    if (parsedUrl.origin === ${JSON.stringify(SITE)}) return;`)
        .replace('const ALLOWED_PORTS = new Set(["", "80", "443"]);', `const ALLOWED_PORTS = new Set(["", "80", "443", ${JSON.stringify(new URL(SITE).port)}]);`));
    const pool = require(path.join(projectDir, "dbPool"));
    const log = console.log, error = console.error, warn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    // The startup check that marks interrupted documents as failed belongs to the real server
    // process; this in-process copy must not touch other chatbots' documents.
    loadPatched("server.js", src => src.replace("WHERE status = 'processing'\"", "WHERE status = 'processing' AND false\""));
    const BASE = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(BASE + "/api/health")).ok) break; } catch {}
        await sleep(100);
    }

    async function call(method, route, body, key = ADMIN_KEY) {
        const r = await fetch(BASE + route, {
            method,
            headers: { ...(key ? { "x-admin-api-key": key } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined
        });
        let json = null;
        try { json = await r.json(); } catch {}
        return { status: r.status, json };
    }
    const detail = async id => (await call("GET", `/api/admin/chatbots/${id}`)).json?.chatbot;
    async function waitForJob(id, onRunning) {
        const started = Date.now();
        while (Date.now() - started < 240000) {
            const bot = await detail(id);
            const job = bot?.progress;
            if (job && job.state !== "running") return job;
            if (job && onRunning) await onRunning(job);
            await sleep(250);
        }
        throw new Error("job did not finish in time");
    }
    const crawlUrls = (id, urls, key) => call("POST", `/api/admin/chatbots/${id}/crawl-urls/index`, { urls }, key);
    const report = async id => (await call("GET", `/api/admin/chatbots/${id}/crawl-urls?limit=200`)).json;
    const rowFor = (rep, pathname) => rep.urls.find(row => { try { return new URL(row.url).pathname === pathname; } catch { return false; } });

    const totalBefore = await countAll();
    const rowsBefore = (await pool.query("SELECT count(*)::int AS n FROM chatbots")).rows[0].n;
    let chatbotId = null;
    let otherId = null;

    try {
        const registered = await call("POST", "/api/register", { websiteUrl: `${SITE}/` });
        chatbotId = registered.json?.chatbotId;
        record("setup: temporary chatbot registered for the local test site", registered.status === 201 && chatbotId, `status ${registered.status}`);
        if (!chatbotId) throw new Error("registration failed");
        record("setup: the temporary chatbot has no vectors yet", (await pointsOf(chatbotId)).length === 0);

        // 1. Full crawl with a page limit below the number of pages: live progress while it runs.
        const started = await call("POST", "/api/website", { chatbotId, maxPages: 5, reindex: true, async: true });
        record("full crawl: started in the background", started.status === 202, `status ${started.status}`);
        const seen = { currentUrls: new Set(), phases: new Set(), countsWhileRunning: 0, liveRows: 0, liveStatuses: new Set(), conflict: null };
        const fullJob = await waitForJob(chatbotId, async job => {
            if (job.currentUrl) seen.currentUrls.add(job.currentUrl);
            if (job.phase) seen.phases.add(job.phase);
            if (job.counts && job.counts.discovered > 0) seen.countsWhileRunning++;
            const live = await call("GET", `/api/admin/chatbots/${chatbotId}/crawl-live?limit=200`);
            if (live.json?.urls?.length) {
                seen.liveRows = Math.max(seen.liveRows, live.json.urls.length);
                for (const row of live.json.urls) seen.liveStatuses.add(row.status);
            }
            if (!seen.conflict) seen.conflict = (await crawlUrls(chatbotId, [`${SITE}/alpha`])).status;
        });
        record("live: current address reported while the crawl runs", seen.currentUrls.size >= 2, [...seen.currentUrls].map(url => new URL(url).pathname).join(" "));
        record("live: phase reported (fetching / extracting)", seen.phases.has("fetching") && seen.phases.has("extracting"), [...seen.phases].join(","));
        record("live: counts exposed while running", seen.countsWhileRunning >= 2, `${seen.countsWhileRunning} snapshots`);
        record("live: per-address rows with changing statuses while running", seen.liveRows >= 5 && seen.liveStatuses.has("queued") && (seen.liveStatuses.has("in-progress") || seen.liveStatuses.has("read")), `${seen.liveRows} rows; ${[...seen.liveStatuses].join(",")}`);
        record("lock: crawling a page while the full crawl runs is refused (409)", seen.conflict === 409, `status ${seen.conflict}`);
        record("full crawl: finished", fullJob.state === "done", fullJob.message);

        const rep1 = await report(chatbotId);
        const statuses = new Set(["indexed", "failed", "skipped", "not-processed"]);
        record("report: every discovered address has a final status (none left queued)", rep1.urls.length >= 9 && rep1.urls.every(row => statuses.has(row.status)), rep1.urls.map(row => `${new URL(row.url).pathname}=${row.status}`).join(" "));
        const notProcessed = rep1.urls.filter(row => row.status === "not-processed");
        record("limits: pages beyond the page limit remain visible as not processed, with the reason", notProcessed.length >= 1 && notProcessed.every(row => row.reason === "page-limit"), `${notProcessed.length} not processed`);
        const privateRow = rowFor(rep1, "/private/area");
        record("report: robots.txt-blocked address recorded as skipped with its reason", privateRow?.status === "skipped" && /robots/.test(privateRow.reason || ""), JSON.stringify(privateRow && { s: privateRow.status, r: privateRow.reason }));
        const finishedLive = await call("GET", `/api/admin/chatbots/${chatbotId}/crawl-live?limit=200`);
        record("live: after the crawl, the live view shows final statuses", finishedLive.json?.urls?.every(row => statuses.has(row.status)), `${finishedLive.json?.urls?.length} rows`);

        // 2. One page that was not processed: indexed alone, without a full re-crawl.
        const topicPaths = TOPICS.map(topic => "/" + topic);
        const target = notProcessed.map(row => new URL(row.url).pathname).find(pathname => topicPaths.includes(pathname) && pathname !== "/bravo");
        record("single page: a not-processed topic page is available to index", Boolean(target), target);
        const pointsBefore = await pointsOf(chatbotId);
        const hitsBefore = { ...hits };
        const pagesIndexedBefore = (await detail(chatbotId)).stats.pagesIndexed;
        const single = await crawlUrls(chatbotId, [`${SITE}${target}`]);
        record("single page: request accepted (202)", single.status === 202, `status ${single.status}`);
        const singleSeen = { type: null, current: null };
        const singleJob = await waitForJob(chatbotId, job => { singleSeen.type = job.type; if (job.currentUrl) singleSeen.current = job.currentUrl; });
        const result = singleJob.results?.[0];
        record("single page: live progress shows the requested page", singleSeen.type === "urls" && singleSeen.current && new URL(singleSeen.current).pathname === target, `${singleSeen.type} ${singleSeen.current}`);
        record("single page: outcome indexed", result?.outcome === "indexed" && result.sections > 0, JSON.stringify(result));
        const pointsAfter = await pointsOf(chatbotId);
        record("single page: its sections are stored under this chatbot", pointsForPath(pointsAfter, target).length === result?.sections, `${pointsForPath(pointsAfter, target).length} points`);
        const otherIdsBefore = pointsBefore.map(point => point.id).sort().join();
        const otherIdsAfter = pointsAfter.filter(point => new URL(point.payload.url).pathname !== target).map(point => point.id).sort().join();
        record("single page: every other page's sections are unchanged", otherIdsBefore === otherIdsAfter, `${pointsBefore.length} -> ${pointsAfter.length}`);
        const otherRequests = Object.keys(hits).filter(key => key !== target && key !== "/robots.txt" && hits[key] !== hitsBefore[key]);
        record("single page: no other page was requested (no full re-crawl, no sitemap)", otherRequests.length === 0 && hits[target] === (hitsBefore[target] || 0) + 1, otherRequests.join(",") || "only the page");
        const rep2 = await report(chatbotId);
        record("single page: report row updated to indexed; the rest of the report kept", rowFor(rep2, target)?.status === "indexed" && rep2.urls.length === rep1.urls.length, `${rep1.urls.length} -> ${rep2.urls.length} rows`);
        record("single page: chatbot page count updated", (await detail(chatbotId)).stats.pagesIndexed === pagesIndexedBefore + 1, `${pagesIndexedBefore} -> ${(await detail(chatbotId)).stats.pagesIndexed}`);

        // 3. The same page again, unchanged: reported as already up to date, nothing duplicated.
        await crawlUrls(chatbotId, [`${SITE}${target}/`]);
        const again = (await waitForJob(chatbotId)).results?.[0];
        const pointsAgain = await pointsOf(chatbotId);
        record("repeat: an unchanged page is reported already up to date", again?.outcome === "up-to-date", JSON.stringify(again));
        record("repeat: no duplicate sections", pointsAgain.length === pointsAfter.length && pointsForPath(pointsAgain, target).length === result?.sections, `${pointsAgain.length} points`);

        // 4. A failing page: failed with the real reason; retried individually once it works.
        const brokenRequestsBefore = hits["/broken"] || 0;
        await crawlUrls(chatbotId, [`${SITE}/broken`]);
        const brokenFirst = (await waitForJob(chatbotId)).results?.[0];
        record("failure: outcome failed with the real reason and retry attempts", brokenFirst?.outcome === "failed" && /HTTP 503/.test(brokenFirst.reason || "") && brokenFirst.attempts === 3 && hits["/broken"] - brokenRequestsBefore === 3, JSON.stringify(brokenFirst));
        const brokenRow = rowFor(await report(chatbotId), "/broken");
        record("failure: report row failed with reason and attempts", brokenRow?.status === "failed" && /HTTP 503/.test(brokenRow.reason || "") && brokenRow.attempts === 3, JSON.stringify(brokenRow && { s: brokenRow.status, r: brokenRow.reason, a: brokenRow.attempts }));
        brokenFixed = true;
        await crawlUrls(chatbotId, [`${SITE}/broken`]);
        const brokenRetry = (await waitForJob(chatbotId)).results?.[0];
        record("retry: the failed page is indexed when retried individually", brokenRetry?.outcome === "indexed" && /BROKEN-FIXED-MARKER/.test(JSON.stringify(pointsForPath(await pointsOf(chatbotId), "/broken").map(point => point.payload))), JSON.stringify(brokenRetry));
        record("retry: report row now indexed", rowFor(await report(chatbotId), "/broken")?.status === "indexed");

        // 5. Batch with a redirect and a robots-blocked page; duplicates in the list collapse.
        const batch = await crawlUrls(chatbotId, [`${SITE}/old-address`, `${SITE}/private/area`, `${SITE}/old-address#top`]);
        const batchJob = await waitForJob(chatbotId);
        const moved = batchJob.results?.find(item => /old-address/.test(item.url));
        const blocked = batchJob.results?.find(item => /private/.test(item.url));
        record("batch: duplicate addresses in one request are processed once", batch.json?.urls?.length === 2 && batchJob.results?.length === 2, JSON.stringify(batch.json?.urls));
        record("batch: redirect reported with its final address", moved?.outcome === "indexed" && /new-address/.test(moved.finalUrl || ""), JSON.stringify(moved));
        record("batch: robots.txt still applies (skipped with the reason)", blocked?.outcome === "skipped" && /robots/.test(blocked.reason || "") && !/PRIVATE-MARKER/.test(JSON.stringify((await pointsOf(chatbotId)).map(point => point.payload))), JSON.stringify(blocked));

        // 6. A page that fails now keeps its earlier sections (failed, and empty).
        keepPath = rep1.urls.map(row => new URL(row.url).pathname).find(pathname => topicPaths.includes(pathname) && pathname !== "/bravo" && pathname !== target && rowFor(rep1, pathname).status === "indexed");
        const alphaBefore = keepPath ? pointsForPath(await pointsOf(chatbotId), keepPath).map(point => point.id).sort().join() : "";
        if (alphaBefore) {
            for (const [failMode, label, expected] of [["keep-down", "server error", "failed"], ["keep-empty", "no usable text", "skipped"]]) {
                mode = failMode;
                await crawlUrls(chatbotId, [`${SITE}${keepPath}`]);
                const outcome = (await waitForJob(chatbotId)).results?.[0];
                const alphaAfter = pointsForPath(await pointsOf(chatbotId), keepPath).map(point => point.id).sort().join();
                record(`keep on failure (${label}): reported ${expected}, earlier sections still used`, outcome?.outcome === expected && /indexed earlier are still used/.test(outcome.reason || ""), JSON.stringify(outcome));
                record(`keep on failure (${label}): existing sections untouched`, alphaAfter === alphaBefore, `${alphaAfter.split(",").length} sections`);
            }
            mode = "normal";
        } else {
            record("keep on failure: a topic page was indexed by the full crawl", false, "none indexed; cannot check");
        }

        // 7. Concurrent duplicate requests: one runs, the other is refused.
        const [first, second] = await Promise.all([crawlUrls(chatbotId, [`${SITE}/bravo`]), crawlUrls(chatbotId, [`${SITE}/bravo`])]);
        const codes = [first.status, second.status].sort().join(",");
        await waitForJob(chatbotId);
        const bravoPoints = pointsForPath(await pointsOf(chatbotId), "/bravo");
        record("concurrency: two simultaneous requests -> one accepted, one refused (409)", codes === "202,409", codes);
        record("concurrency: the page is stored once (no duplicate sections)", bravoPoints.length >= 1 && new Set(bravoPoints.map(point => point.payload.chunk)).size === bravoPoints.length, `${bravoPoints.length} sections`);

        // 9. The report compared with the stored content; current counts vs last full crawl.
        const vector = () => Array.from({ length: 768 }, () => Math.random() - 0.5);
        const upsert = points => fetch(`${QDRANT}/points?wait=true`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ points }) }).then(r => r.json());
        const port = new URL(SITE).port;
        // A row recorded before the address-form fix ("skipped" under the bare address while the
        // content is stored under www.), and a page whose only stored content is a document section.
        // (A host name pair: "www." + an IP address is not a valid URL.)
        const LEGACY_ROW_URL = "http://legacy-site.example/legacy-page";
        const LEGACY_STORED_URL = "http://www.legacy-site.example/legacy-page";
        await pool.query(`INSERT INTO crawl_urls (chatbot_id, url, status, reason, source) VALUES ($1, $2, 'skipped', 'no text long enough to store', 'link'), ($1, $3, 'skipped', 'no text long enough to store', 'link')`,
            [chatbotId, LEGACY_ROW_URL, `${SITE}/doc-only`]);
        await upsert([
            { id: crypto.randomUUID(), vector: vector(), payload: { chatbotId, url: LEGACY_STORED_URL, sourceType: "website", chunk: "LEGACY-MARKER one" } },
            { id: crypto.randomUUID(), vector: vector(), payload: { chatbotId, url: LEGACY_STORED_URL, sourceType: "website", chunk: "LEGACY-MARKER two" } },
            { id: crypto.randomUUID(), vector: vector(), payload: { chatbotId, url: `${SITE}/doc-only`, sourceType: "document", chunk: "DOCUMENT-MARKER" } }
        ]);
        const reconciled = (await call("GET", `/api/admin/chatbots/${chatbotId}/crawl-urls?status=indexed-elsewhere&limit=200`)).json;
        const legacy = reconciled?.urls?.find(row => row.url === LEGACY_ROW_URL);
        record("reconcile: recorded 'skipped' but stored under the www. form -> shown as indexed under another address", legacy?.current_status === "indexed-elsewhere" && legacy.status === "skipped" && legacy.stored_sections === 2 && /\/\/www\./.test(legacy.stored_url || ""), JSON.stringify(legacy));
        const docRow = (await call("GET", `/api/admin/chatbots/${chatbotId}/crawl-urls?limit=200&search=doc-only`)).json?.urls?.find(row => row.url === `${SITE}/doc-only`);
        record("reconcile: uploaded-document sections never count as website content", docRow?.current_status === "skipped" && docRow.stored_sections === 0, JSON.stringify(docRow));
        const legacyDb = (await pool.query("SELECT status, reason FROM crawl_urls WHERE chatbot_id = $1 AND url = $2", [chatbotId, LEGACY_ROW_URL])).rows[0];
        record("reconcile: the stored report row is not changed", legacyDb?.status === "skipped", JSON.stringify(legacyDb));
        record("reconcile: current counts include it; the last full crawl's totals are kept separately",
            reconciled.currentCounts["indexed-elsewhere"] === 1 && reconciled.lastFullCrawl && reconciled.lastFullCrawl.notProcessed === notProcessed.length,
            JSON.stringify({ current: reconciled.currentCounts, full: reconciled.lastFullCrawl }));

        // 10. Continue pending addresses in batches (rows as a crawl stopped by a limit leaves them).
        const pendingPaths = ["/section/one", "/section/two", "/extra-1", "/extra-2", "/extra-3"];
        await pool.query(`INSERT INTO crawl_urls (chatbot_id, url, status, reason, source) SELECT $1, u, 'not-processed', 'page-limit', 'sitemap' FROM UNNEST($2::text[]) AS u
            ON CONFLICT DO NOTHING`, [chatbotId, [...pendingPaths.map(p => SITE + p), `${SITE}/info@example.com`]]);
        // A second chatbot with its own pending row and section: continuing chatbot A must not touch it.
        otherId = crypto.randomUUID();
        await pool.query("INSERT INTO chatbots (id, website_url, allowed_domain, status) VALUES ($1, $2, '127.0.0.1', 'ready')", [otherId, `${SITE}/other-tenant/`]);
        await pool.query("INSERT INTO crawl_urls (chatbot_id, url, status, reason, source) VALUES ($1, $2, 'not-processed', 'page-limit', 'link')", [otherId, `${SITE}/extra-1`]);
        await upsert([{ id: crypto.randomUUID(), vector: vector(), payload: { chatbotId: otherId, url: `${SITE}/extra-1`, sourceType: "website", chunk: "OTHER-TENANT-MARKER" } }]);

        const cont = body => call("POST", `/api/admin/chatbots/${chatbotId}/crawl-urls/continue`, body);
        for (const [body, label] of [[{ batchSize: 0 }, "batch size 0"], [{ batchSize: 11 }, "batch size 11"], [{ pathPrefix: "section" }, "section not starting with /"]]) {
            const r = await cont(body);
            record(`continue: ${label} -> 400`, r.status === 400, `${r.status} ${r.json?.error || ""}`);
        }
        const emptySection = await cont({ batchSize: 3, pathPrefix: "/no-such-section/" });
        record("continue: no pending address in the section -> nothing started", emptySection.status === 200 && emptySection.json?.started === false && /Nothing left/.test(emptySection.json.message), JSON.stringify(emptySection.json));
        const hitsBeforeSection = { ...hits };
        const sectionStep = await cont({ batchSize: 5, pathPrefix: "/section/" });
        const sectionJob = await waitForJob(chatbotId);
        const sectionUrls = (sectionStep.json?.urls || []).map(url => new URL(url).pathname).sort();
        record("continue: a section filter crawls only that section", sectionStep.status === 202 && JSON.stringify(sectionUrls) === JSON.stringify(["/section/one", "/section/two"]) && !Object.keys(hits).some(key => !key.startsWith("/section/") && key !== "/robots.txt" && hits[key] !== hitsBeforeSection[key]), JSON.stringify(sectionStep.json?.urls));
        record("continue: the batch's pages are indexed", sectionJob.results?.length === 2 && sectionJob.results.every(result => result.outcome === "indexed"), JSON.stringify(sectionJob.results));
        const currentAfterSection = (await detail(chatbotId)).stats.current;
        const reportAfterSection = (await call("GET", `/api/admin/chatbots/${chatbotId}/crawl-urls?limit=1`)).json;
        record("summary: current counts refreshed after the batch, last full crawl's totals unchanged",
            reportAfterSection.currentCounts.indexed === currentAfterSection.indexed && reportAfterSection.lastFullCrawl.notProcessed === notProcessed.length && (currentAfterSection["not-processed"] || 0) === (reconciled.currentCounts["not-processed"] || 0) + 6 - 2,
            JSON.stringify({ current: currentAfterSection, full: reportAfterSection.lastFullCrawl }));
        // Small batches until nothing crawlable is left (bounded loop).
        let batches = 0, last = null;
        for (; batches < 10; batches++) {
            last = await cont({ batchSize: 2 });
            if (last.status !== 202) break;
            const job = await waitForJob(chatbotId);
            if (!job.results || job.results.length !== last.json.urls.length) break;
        }
        const finalCurrent = (await detail(chatbotId)).stats.current;
        record("continue: repeated small batches process every crawlable pending address", last?.status === 200 && last.json.started === false && (finalCurrent["not-processed"] || 0) === 1, `${batches} batches; ${JSON.stringify(last?.json)}; current ${JSON.stringify(finalCurrent)}`);
        const finalReport = (await call("GET", `/api/admin/chatbots/${chatbotId}/crawl-urls?limit=200&search=info@example.com`)).json;
        const mailRow = finalReport?.urls?.find(row => row.url === `${SITE}/info@example.com`);
        record("report: an e-mail address recorded as pending is shown as skipped; nothing is pending", mailRow?.current_status === "skipped" && /e-mail address/.test(mailRow.current_reason || "") && !(finalReport.currentCounts["not-processed"]), JSON.stringify({ mailRow, current: finalReport?.currentCounts }));
        record("report: the stored row of that address is not changed", (await pool.query("SELECT status FROM crawl_urls WHERE chatbot_id = $1 AND url = $2", [chatbotId, `${SITE}/info@example.com`])).rows[0]?.status === "not-processed");
        record("continue: with only an e-mail address left, nothing is pending", last?.json?.pending === 0 && /Nothing left/.test(last.json.message || ""), JSON.stringify(last?.json));
        record("continue: an e-mail address left pending is never requested", !Object.keys(hits).some(key => key.includes("@")), Object.keys(hits).filter(key => key.includes("@")).join(" "));
        const storedNow = await pointsOf(chatbotId);
        record("continue: every pending page is now stored once", pendingPaths.every(p => pointsForPath(storedNow, p).length === 1), pendingPaths.map(p => `${p}=${pointsForPath(storedNow, p).length}`).join(" "));
        const otherRows = (await pool.query("SELECT status FROM crawl_urls WHERE chatbot_id = $1", [otherId])).rows;
        const otherPoints = (await qdrant("/points/count", { exact: true, filter: { must: [{ key: "chatbotId", match: { value: otherId } }] } })).count;
        record("isolation: continuing one chatbot leaves another chatbot's rows and sections unchanged", otherRows.length === 1 && otherRows[0].status === "not-processed" && otherPoints === 1, JSON.stringify({ otherRows, otherPoints }));

        // 11. Chat stays available while a chatbot with knowledge is re-indexed.
        const reindex = await call("POST", "/api/website", { chatbotId, maxPages: 3, reindex: true, async: true });
        const statusesWhileRunning = new Set();
        let displayedIndexing = false;
        await waitForJob(chatbotId, async job => {
            if (job.state === "running") {
                statusesWhileRunning.add((await pool.query("SELECT status FROM chatbots WHERE id = $1", [chatbotId])).rows[0].status);
                if ((await detail(chatbotId)).displayStatus === "indexing") displayedIndexing = true;
            }
        });
        record("re-index: the chatbot stays 'ready' (answers from existing knowledge) while the job runs", reindex.status === 202 && statusesWhileRunning.size >= 1 && [...statusesWhileRunning].every(status => status === "ready"), [...statusesWhileRunning].join(","));
        record("re-index: the dashboard still shows the running job as 'indexing'", displayedIndexing);

        // 8. Validation and tenant isolation.
        const invalid = [
            [["https://another-website.example/page"], 400, "another website"],
            [[`http://localhost:${new URL(SITE).port}/alpha`], 400, "same port, different host"],
            [[`http://127.0.0.1:${Number(new URL(SITE).port) + 1}/alpha`], 400, "same host, different port"],
            [["ftp://127.0.0.1/file"], 400, "not http(s)"],
            [["not a url"], 400, "not an address"],
            [[], 400, "empty list"],
            [Array.from({ length: 11 }, (_, i) => `${SITE}/p${i}`), 400, "more than 10"],
            [[`http://user:pass@127.0.0.1:${new URL(SITE).port}/alpha`], 400, "credentials in the address"],
            [[`${SITE}/info@example.com`], 400, "e-mail address written as a link"]
        ];
        for (const [urls, expected, label] of invalid) {
            const r = await crawlUrls(chatbotId, urls);
            record(`validation: ${label} -> ${expected}`, r.status === expected, `status ${r.status}: ${r.json?.error || ""}`);
        }
        record("validation: unknown chatbot -> 404", (await crawlUrls(crypto.randomUUID(), [`${SITE}/alpha`])).status === 404);
        record("validation: invalid chatbot ID -> 400", (await crawlUrls("not-an-id", [`${SITE}/alpha`])).status === 400);
        record("auth: no admin key -> 401", (await crawlUrls(chatbotId, [`${SITE}/alpha`], "")).status === 401);
        const all = await pointsOf(chatbotId);
        const foreign = (await qdrant("/points/scroll", { limit: 1000, with_payload: ["chatbotId", "chunk"], filter: { must: [{ key: "url", match: { any: [...new Set(all.map(point => point.payload.url))] } }] } })).points;
        // Two customers may index the same address: section 10 gave the second temporary chatbot
        // its own section at /extra-1, which this chatbot also keeps (pages a limited re-index did
        // not reach keep their sections). That section must be exactly the second chatbot's own one;
        // any other owner, or this chatbot's text under another owner, is a leak.
        const notOwn = foreign.filter(point => point.payload.chatbotId !== chatbotId);
        const otherTotal = (await qdrant("/points/count", { exact: true, filter: { must: [{ key: "chatbotId", match: { value: otherId } }] } })).count;
        record("isolation: every section of the test site belongs to the temporary chatbot (the other test chatbot has only its own one section)",
            notOwn.every(point => point.payload.chatbotId === otherId && point.payload.chunk === "OTHER-TENANT-MARKER") && notOwn.length <= 1 && otherTotal === 1,
            `${foreign.length} points: ${foreign.length - notOwn.length} own, ${notOwn.length} of the other test chatbot (which has ${otherTotal} in total)`);
    } catch (e) {
        record("run", false, e.message);
    } finally {
        // Remove only what this test created: the temporary chatbot (crawl report cascades) and its vectors.
        if (otherId) {
            await qdrant("/points/delete?wait=true", { filter: { must: [{ key: "chatbotId", match: { value: otherId } }] } }).catch(() => {});
            await pool.query("DELETE FROM chatbots WHERE id = $1 AND website_url LIKE $2", [otherId, `${SITE}%`]).catch(() => {});
        }
        if (chatbotId) {
            await qdrant("/points/delete?wait=true", { filter: { must: [{ key: "chatbotId", match: { value: chatbotId } }] } }).catch(() => {});
            await pool.query("DELETE FROM chatbots WHERE id = $1 AND website_url LIKE $2", [chatbotId, `${SITE}%`]).catch(() => {});
        }
        const totalAfter = await countAll().catch(() => -1);
        const rowsAfter = (await pool.query("SELECT count(*)::int AS n FROM chatbots").catch(() => ({ rows: [{ n: -1 }] }))).rows[0].n;
        record("cleanup: vector total and chatbot rows back to their starting values", totalAfter === totalBefore && rowsAfter === rowsBefore, `points ${totalBefore} -> ${totalAfter}, rows ${rowsBefore} -> ${rowsAfter}`);
        console.log = log;
        console.warn = warn;
        console.error = error;
        console.table(results);
        const failed = results.filter(row => row.result === "FAIL").length;
        console.log(`\n${results.length - failed}/${results.length} passed`);
        site.close();
        process.exit(failed ? 1 : 0);
    }
})();
