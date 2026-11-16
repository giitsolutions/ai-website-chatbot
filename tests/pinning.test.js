// DNS-rebinding protection: pinnedRequest() must connect to the address that passed
// validation, not to whatever DNS answers later. No network beyond 127.0.0.1. Run: npm test
//
// Test-only change: assertPublicHttpUrl() is wrapped so that "rebind.invalid" (a
// reserved name that never resolves in real DNS) is "validated" to 127.0.0.1.
// A successful request to it therefore proves the pinned address was used.
const fs = require("fs"), path = require("path"), http = require("http"), zlib = require("zlib"), Module = require("module");

const ingestPath = path.join(__dirname, "..", "ingest.js");
let src = fs.readFileSync(ingestPath, "utf8");
const marker = "async function assertPublicHttpUrl(rawUrl) {";
src = src.replace(marker, `${marker}
    try {
        const u = new URL(rawUrl);
        if (u.hostname === "rebind.invalid") { u.publicAddresses = [{ address: "127.0.0.1", family: 4 }]; return u; }
        if (u.hostname === "nopin.invalid") { return u; }
    } catch {}`);
src += "\nmodule.exports.__pinned = pinnedRequest;";
const m = new Module(ingestPath); m.filename = ingestPath; m.paths = Module._nodeModulePaths(path.dirname(ingestPath));
m._compile(src, ingestPath);
const pinnedRequest = m.exports.__pinned;

const results = [];
const record = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 100) });

(async () => {
    const server = http.createServer((req, res) => {
        if (req.url === "/hello") { res.setHeader("Set-Cookie", "session=abc"); return res.end("pinned-ok"); }
        if (req.url === "/gzip") { res.setHeader("Content-Encoding", "gzip"); return res.end(zlib.gzipSync("compressed-ok")); }
        if (req.url === "/headers") { res.setHeader("Content-Type", "application/json"); return res.end(JSON.stringify(req.headers)); }
        if (req.url === "/big") { res.write("x".repeat(1024 * 1024)); let n = 0; const t = setInterval(() => { if (res.destroyed || ++n > 10) { clearInterval(t); return res.end(); } res.write("x".repeat(1024 * 1024)); }, 20); return; }
        res.statusCode = 404; res.end();
    });
    await new Promise(r => server.listen(0, "127.0.0.1", r));
    const port = server.address().port;

    try {
        let r = await pinnedRequest(`http://rebind.invalid:${port}/hello`);
        record("connects to the validated address, not DNS", r.status === 200 && r.body.toString() === "pinned-ok", `HTTP ${r.status}`);
        record("Set-Cookie from the site is not passed on", !("set-cookie" in r.headers));

        let error = null;
        try { await pinnedRequest(`http://nopin.invalid:${port}/hello`); } catch (e) { error = e; }
        record("control: same name without pinning fails (DNS cannot resolve it)", !!error, error && (error.code || error.message));

        r = await pinnedRequest(`http://rebind.invalid:${port}/gzip`);
        record("gzip body decoded, content-encoding removed", r.body.toString() === "compressed-ok" && !r.headers["content-encoding"]);

        r = await pinnedRequest(`http://rebind.invalid:${port}/headers`, { headers: { Cookie: "secret=1", "User-Agent": "test-agent", Host: "evil.example" } });
        const seen = JSON.parse(r.body.toString());
        record("cookies and Host header not forwarded; other headers kept", !seen.cookie && seen.host === `rebind.invalid:${port}` && seen["user-agent"] === "test-agent", JSON.stringify({ cookie: seen.cookie, host: seen.host }));

        const started = Date.now();
        error = null;
        try { await pinnedRequest(`http://rebind.invalid:${port}/big`); } catch (e) { error = e; }
        record("response over 5 MB stopped while downloading", !!error && /too large/i.test(error.message), `${error && error.message} after ${Date.now() - started} ms`);

        for (const blocked of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://localhost/"]) {
            error = null;
            try { await pinnedRequest(blocked); } catch (e) { error = e; }
            record(`real validation still rejects ${blocked}`, !!error && !/ECONNREFUSED|ETIMEDOUT|ENOTFOUND/.test(error.code || ""), error && error.message);
        }
    } catch (e) {
        record("unexpected test error", false, e.message);
    } finally {
        server.close();
    }

    console.table(results);
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})();
