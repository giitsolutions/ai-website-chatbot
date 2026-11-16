// SSRF redirect test harness for ingest.js crawlWebsite().
// Run: npm test   (starts two local servers; no data is stored)
// Test-only change: the fake "public" site origin (127.0.0.1:PUBLIC_PORT) is
// allow-listed inside assertPublicHttpUrl. Every other URL (including the
// "internal" secret server on a different port) goes through the real checks.
const fs = require("fs"), path = require("path"), http = require("http"), Module = require("module");

const ingestPath = path.resolve(process.argv[2] || path.join(__dirname, "..", "ingest.js"));
const projectDir = path.dirname(ingestPath);

function listen(server, host) {
    return new Promise(r => server.listen(0, host, () => r(server.address().port)));
}

(async () => {
    // ---- internal "secret" service: counts every hit ----
    const secretHits = [];
    const secret = http.createServer((req, res) => {
        secretHits.push(req.method + " " + req.url);
        res.end("<html><head><title>INTERNAL SECRET</title></head><body><p>internal admin secret token value abc123 sensitive data here for testing only.</p></body></html>");
    });
    secret.on("upgrade", (req, socket) => { secretHits.push("WS " + req.url); socket.destroy(); });
    const S = await listen(secret, "::"); // dual-stack: 127.0.0.1 and ::1

    // ---- fake public site ----
    const html = (title, body) => `<html><head><title>${title}</title></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
    const filler = "<p>" + "This is a normal public page with plenty of readable text for the crawler to extract. ".repeat(6) + "</p>";
    const site = http.createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        const to = u.searchParams.get("to");
        if (u.pathname.startsWith("/r3")) { res.writeHead(Number(u.pathname.slice(2, 5)), { Location: to }); return res.end(); }
        if (u.pathname === "/chain") { res.writeHead(302, { Location: "/r302?to=" + encodeURIComponent(to) }); return res.end(); }
        res.setHeader("Content-Type", "text/html");
        if (u.pathname === "/meta") return res.end(`<html><head><meta http-equiv="refresh" content="0;url=${to}"><title>meta</title></head><body>${filler}</body></html>`);
        if (u.pathname === "/js") return res.end(html("js redirect", filler + `<script>location.href=${JSON.stringify(to)}</script>`));
        if (u.pathname === "/sub") return res.end(html("subresources", filler +
            `<script src="${to}"></script><iframe src="${to}"></iframe>` +
            `<script>fetch(${JSON.stringify(to)}).catch(()=>{});try{new WebSocket(${JSON.stringify(to.replace(/^http/, "ws"))})}catch(e){}</script>`));
        if (u.pathname === "/subredirect") return res.end(html("subresource redirect", filler + `<script src="/r302?to=${encodeURIComponent(to)}"></script>`));
        if (u.pathname === "/robots.txt") return res.end("User-agent: *\nDisallow: /blocked\n");
        if (u.pathname === "/blocked") return res.end(html("Blocked Page", filler));
        if (u.pathname === "/ok") return res.end(html("Public Home", filler + `<a href="/r302?to=/about">About us</a> <a href="/blocked">Blocked section</a>`));
        if (u.pathname === "/about") return res.end(html("About Public Site", filler));
        res.writeHead(404); res.end("nf");
    });
    const P = await listen(site, "127.0.0.1");
    const PUBLIC = `http://127.0.0.1:${P}`;

    // ---- load ingest.js with the test allow-list + exported crawlWebsite ----
    let src = fs.readFileSync(ingestPath, "utf8");
    const marker = "async function assertPublicHttpUrl(rawUrl) {";
    if (!src.includes(marker)) throw new Error("assertPublicHttpUrl not found");
    src = src.replace(marker, marker + `\n    try { if (new URL(rawUrl).origin === ${JSON.stringify(PUBLIC)}) return new URL(rawUrl); } catch {}`);
    src += "\nmodule.exports.__crawl = crawlWebsite;";

    // Record what the browser actually did with requests to internal targets.
    const { chromium } = require(require.resolve("playwright", { paths: [projectDir] }));
    const events = [];
    const origLaunch = chromium.launch.bind(chromium);
    chromium.launch = async (...a) => {
        const b = await origLaunch(...a);
        const origNewPage = b.newPage.bind(b);
        b.newPage = async (...pa) => {
            const p = await origNewPage(...pa);
            const internal = url => !url.startsWith(PUBLIC) && !url.startsWith("data:");
            p.on("requestfinished", r => internal(r.url()) && events.push(`SENT+ANSWERED ${r.url()}`));
            p.on("requestfailed", r => internal(r.url()) && events.push(`${(r.failure()?.errorText || "").startsWith("net::ERR_BLOCKED_BY_CLIENT") ? "BLOCKED" : "FAILED(" + r.failure()?.errorText + ")"} ${r.url()}`));
            return p;
        };
        return b;
    };

    const m = new Module(ingestPath); m.filename = ingestPath; m.paths = Module._nodeModulePaths(projectDir);
    m._compile(src, ingestPath);
    const crawl = m.exports.__crawl;

    const origLog = console.log; const quiet = () => {};
    const secretUrl = `http://127.0.0.1:${S}/secret`;
    const cases = [
        ["302 -> 127.0.0.1", `${PUBLIC}/r302?to=${encodeURIComponent(secretUrl)}`],
        ["301 -> localhost", `${PUBLIC}/r301?to=${encodeURIComponent(`http://localhost:${S}/secret-localhost`)}`],
        ["307 -> [::1]", `${PUBLIC}/r307?to=${encodeURIComponent(`http://[::1]:${S}/secret-ipv6`)}`],
        ["2-hop chain -> 127.0.0.1", `${PUBLIC}/chain?to=${encodeURIComponent(`http://127.0.0.1:${S}/secret-chain`)}`],
        ["302 -> 169.254.169.254 (cloud metadata)", `${PUBLIC}/r302?to=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`],
        ["meta refresh -> 127.0.0.1", `${PUBLIC}/meta?to=${encodeURIComponent(`http://127.0.0.1:${S}/secret-meta`)}`],
        ["JS location -> 127.0.0.1", `${PUBLIC}/js?to=${encodeURIComponent(`http://127.0.0.1:${S}/secret-js`)}`],
        ["script/iframe/fetch/WebSocket -> 127.0.0.1", `${PUBLIC}/sub?to=${encodeURIComponent(`http://127.0.0.1:${S}/secret-sub`)}`],
        ["script src 302 -> 127.0.0.1", `${PUBLIC}/subredirect?to=${encodeURIComponent(`http://127.0.0.1:${S}/secret-subredirect`)}`],
    ];

    let failures = 0;
    for (const [name, url] of cases) {
        secretHits.length = 0; events.length = 0;
        let pages = [], err = null;
        console.log = quiet;
        try { const r = await crawl(url, 1); pages = Array.isArray(r) ? r : r.pages; } catch (e) { err = e.message; }
        console.log = origLog;
        const leaked = pages.some(p => JSON.stringify(p).includes("INTERNAL SECRET") || JSON.stringify(p).includes("abc123"));
        const sentOut = events.some(e => e.startsWith("SENT+ANSWERED") || e.includes("ADDRESS_UNREACHABLE") || e.includes("TIMED_OUT"));
        const bad = secretHits.length > 0 || leaked || sentOut;
        if (bad) failures++;
        origLog(`${bad ? "FAIL" : "PASS"}  ${name}`);
        origLog(`      internal server hits: ${JSON.stringify(secretHits)}  content leaked into pages: ${leaked}${err ? "  crawl error: " + err : ""}`);
        for (const e of [...new Set(events)]) origLog("      browser: " + e);
    }

    // Legitimate crawling must still work, including a same-site redirect.
    console.log = quiet;
    let okPages = [];
    try { const r = await crawl(`${PUBLIC}/ok`, 3); okPages = Array.isArray(r) ? r : r.pages; } catch (e) { origLog("crawl error " + e.message); }
    console.log = origLog;
    const titles = okPages.map(p => p.title);
    const okPass = titles.includes("Public Home") && titles.includes("About Public Site") && !titles.includes("Blocked Page");
    if (!okPass) failures++;
    origLog(`${okPass ? "PASS" : "FAIL"}  legit crawl incl. same-site redirect, robots.txt-disallowed page skipped -> pages: ${JSON.stringify(titles)}`);

    origLog(`\n${failures === 0 ? "ALL PASSED" : failures + " FAILED"}`);
    secret.close(); site.close();
    process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
