// End-to-end background indexing through the real admin API (crawls public pages, uses the
// embedding model; ~2-4 min, run alone). Two TEMPORARY chatbots are registered, indexed in the
// background, followed through GET /api/admin/chatbots/:id, and removed (rows + vectors) at the end.
// Run: npm run test:indexing   (TEST_BASE_URL defaults to http://localhost:3000;
// the admin key is read from ADMIN_API_KEY / .env and never printed).
const path = require("path");
const projectDir = path.join(__dirname, "..");
require(path.join(projectDir, "node_modules", "dotenv")).config({ path: path.join(projectDir, ".env"), quiet: true });
const pool = require(path.join(projectDir, "dbPool"));

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const KEY = process.env.ADMIN_API_KEY || "";
if (KEY.length < 32) { console.error("ADMIN_API_KEY is not configured."); process.exit(1); }
// A multi-page public documentation section (crawled with a 4-page limit) and a URL that fails.
const DOCS_URL = process.env.TEST_INDEX_URL || "https://docs.python.org/3/howto/";
const FAILING_URL = process.env.TEST_FAILING_URL || "https://httpbin.org/status/404";
const QDRANT = "http://localhost:6333/collections/website_content/points";

const results = [];
const record = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 110) });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function call(method, route, body) {
    const r = await fetch(BASE + route, {
        method,
        headers: { "x-admin-api-key": KEY, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await r.text();
    if (text.includes(KEY)) throw new Error("admin key echoed in a response");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json };
}

async function vectorCount(chatbotId) {
    const r = await fetch(`${QDRANT}/count`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exact: true, filter: { must: [{ key: "chatbotId", match: { value: chatbotId } }] } }) });
    return (await r.json()).result.count;
}

// Polls the dashboard API until the job finishes; returns every snapshot seen.
async function follow(chatbotId, { timeoutMs = 300000, onSnapshot } = {}) {
    const seen = [];
    const started = Date.now();
    let networkErrors = 0;
    while (Date.now() - started < timeoutMs) {
        let r;
        try {
            r = await call("GET", `/api/admin/chatbots/${chatbotId}`);
            networkErrors = 0;
        } catch (error) {
            // A busy laptop (crawler + model) can drop a poll; give up after 5 in a row.
            if (++networkErrors >= 5) throw new Error(`polling failed: ${error.cause?.code || error.message}`);
            await sleep(2000);
            continue;
        }
        const chatbot = r.json?.chatbot;
        if (chatbot) {
            seen.push(chatbot);
            if (onSnapshot) await onSnapshot(chatbot);
            // No job at all (never started) or a finished one: stop following.
            if (!chatbot.progress || chatbot.progress.state !== "running") return seen;
        }
        await sleep(700);
    }
    throw new Error("indexing did not finish in time");
}

(async () => {
    const created = [];
    try {
        // ---- 1. Background indexing with live progress and a page limit ----
        let r = await call("POST", "/api/register", { websiteUrl: DOCS_URL });
        const docsId = r.json?.chatbotId;
        if (!docsId) throw new Error(`register failed: HTTP ${r.status}`);
        if (r.json.existing) throw new Error(`${DOCS_URL} is already registered; set TEST_INDEX_URL to an unused URL`);
        created.push(docsId);

        const startedAt = Date.now();
        r = await call("POST", "/api/website", { chatbotId: docsId, async: true, maxPages: 4 });
        record("async indexing: 202 returned at once", r.status === 202 && r.json?.started === true && Date.now() - startedAt < 5000, `HTTP ${r.status} in ${Date.now() - startedAt} ms`);

        r = await call("POST", "/api/website", { chatbotId: docsId, async: true, maxPages: 4 });
        record("duplicate job for the same chatbot refused (409)", r.status === 409, `HTTP ${r.status}`);

        const stages = new Set();
        let sawIndexingStatus = false, maxPagesSeen = 0, sawEmbedProgress = false;
        const snapshots = await follow(docsId, {
            onSnapshot: chatbot => {
                const p = chatbot.progress || {};
                if (p.stage) stages.add(p.stage);
                if (chatbot.displayStatus === "indexing") sawIndexingStatus = true;
                maxPagesSeen = Math.max(maxPagesSeen, p.pagesCrawled || 0);
                if (p.toEmbed > 0 && p.embedded >= 0) sawEmbedProgress = true;
            }
        });
        const final = snapshots[snapshots.length - 1];
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        record("progress: shown as 'indexing' while running", sawIndexingStatus, `${snapshots.length} snapshots`);
        record("progress: crawling and embedding stages reported", stages.has("crawling") && stages.has("embedding") && sawEmbedProgress, [...stages].join(" > "));
        record("progress: page count never exceeds the limit", maxPagesSeen >= 1 && maxPagesSeen <= 4, `max pagesCrawled ${maxPagesSeen}`);
        record("job finished successfully", final.progress.state === "done" && final.status === "ready", `${final.progress.state} in ${seconds}s: ${final.progress.message}`);
        record("limit reached -> honest 'partially indexed' status + message",
            final.displayStatus === "partially indexed" && final.stats.crawlComplete === false && /partially indexed/i.test(final.progress.message || ""),
            `${final.displayStatus}; crawlComplete=${final.stats.crawlComplete}`);
        const chunks = await vectorCount(docsId);
        record("stats saved: pages, chunks, page limit, time", final.stats.pagesIndexed >= 1 && final.stats.pagesIndexed <= 4 && final.stats.chunks === chunks && chunks > 0 && final.stats.pageLimit === 4 && Boolean(final.stats.lastIndexedAt),
            `pages ${final.stats.pagesIndexed}, chunks ${final.stats.chunks} (Qdrant ${chunks})`);

        // ---- 2. Re-index: the old knowledge stays searchable during the crawl ----
        r = await call("POST", "/api/website", { chatbotId: docsId, async: true, reindex: true, maxPages: 4 });
        let minDuring = Infinity;
        await follow(docsId, { onSnapshot: async chatbot => { if (chatbot.progress?.state === "running") minDuring = Math.min(minDuring, await vectorCount(docsId)); } });
        const after = await vectorCount(docsId);
        record("re-index: old vectors kept while crawling, replaced after", r.status === 202 && minDuring >= chunks && after > 0,
            `before ${chunks}, lowest during ${minDuring === Infinity ? "n/a" : minDuring}, after ${after}`);

        // ---- 3. A crawl that fails is reported, never shown as ready ----
        r = await call("POST", "/api/register", { websiteUrl: FAILING_URL });
        const failId = r.json?.chatbotId;
        if (failId && !r.json.existing) {
            created.push(failId);
            r = await call("POST", "/api/website", { chatbotId: failId, async: true, maxPages: 2 });
            if (r.status !== 202) throw new Error(`failing crawl not started: HTTP ${r.status} ${r.json?.error || ""}`);
            const failed = (await follow(failId)).pop();
            record("failed crawl: status 'failed' with a reason", failed.progress.state === "failed" && failed.status === "failed" && Boolean(failed.stats.lastError),
                `${failed.status}: ${failed.stats.lastError}`);
            record("failed crawl: no vectors stored", await vectorCount(failId) === 0);
        } else {
            record("failed crawl: temporary chatbot registered", false, `HTTP ${r.status}`);
        }
    } catch (error) {
        record("unexpected test error", false, `${error.message} ${error.cause?.code || ""}`);
    } finally {
        // Never delete a chatbot while its background crawl is still running:
        // the crawl would store vectors for a chatbot that no longer exists.
        for (const id of created) {
            try { await follow(id, { timeoutMs: 600000 }); } catch {}
        }
        for (const id of created) {
            await pool.query("DELETE FROM chatbots WHERE id = $1", [id]);
            await fetch(`${QDRANT}/delete?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "chatbotId", match: { value: id } }] } }) });
        }
        let left = 0;
        for (const id of created) left += await vectorCount(id) + (await pool.query("SELECT count(*)::int AS n FROM chatbots WHERE id = $1", [id])).rows[0].n;
        record("cleanup: temporary chatbots and vectors removed", left === 0, `${created.length} temporary chatbots`);
        await pool.end();
    }

    console.table(results);
    const failedCount = results.filter(r => r.result !== "PASS").length;
    console.log(failedCount ? `${failedCount} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failedCount ? 1 : 0);
})();
