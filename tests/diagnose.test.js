// tools/diagnose.js: where the admin key may be sent (no real server, no real key). Run: npm test
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { checkDestination } = require("../tools/diagnose.js");

const results = [];
const check = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 110) });

// A fake key: the real ADMIN_API_KEY is never used (dotenv does not override a set variable).
const FAKE_KEY = "diagnose-test-key-" + "f".repeat(40);
const SCRIPT = path.join(__dirname, "..", "tools", "diagnose.js");

function runCli(args) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [SCRIPT, ...args], { env: { ...process.env, ADMIN_API_KEY: FAKE_KEY, TEST_BASE_URL: "" } });
        let output = "";
        child.stdout.on("data", chunk => { output += chunk; });
        child.stderr.on("data", chunk => { output += chunk; });
        child.on("close", code => resolve({ code, output }));
    });
}

(async () => {
    // ---- Policy ----
    const cases = [
        ["http://localhost:3000", {}, true],
        ["http://127.0.0.1:3001", {}, true],
        ["http://[::1]:3000", {}, true],
        ["https://localhost:3443", {}, true],
        ["http://example.com", {}, false],
        ["http://example.com", { allowRemote: true }, false],
        ["http://192.168.1.20:3000", { allowRemote: true }, false],
        ["http://localhost.evil.example:3000", {}, false],
        ["http://127.0.0.1.evil.example", {}, false],
        ["https://chat.example.com", {}, false],
        ["https://chat.example.com", { allowRemote: true }, true],
        ["https://user:secret@chat.example.com", { allowRemote: true }, false],
        ["ftp://localhost", {}, false],
        ["http://localhost:3000/api/admin", {}, false],
        ["not a url", {}, false]
    ];
    for (const [base, options, expected] of cases) {
        const got = checkDestination(base, options).ok;
        check(`${base}${options.allowRemote ? " (--allow-remote)" : ""} -> ${expected ? "allowed" : "refused"}`, got === expected, checkDestination(base, options).reason || "");
    }

    // ---- The CLI refuses before any request and never prints the key ----
    const remoteHttp = await runCli(["00000000-0000-4000-8000-000000000000", "hi", "--base", "http://example.com"]);
    check("CLI: remote plain HTTP refused (exit 1, reason shown)", remoteHttp.code === 1 && /unencrypted/.test(remoteHttp.output), remoteHttp.output.trim());
    check("CLI: the key is not printed when refusing", !remoteHttp.output.includes(FAKE_KEY));

    const remoteHttps = await runCli(["00000000-0000-4000-8000-000000000000", "hi", "--base", "https://chat.example.com"]);
    check("CLI: remote HTTPS without --allow-remote refused", remoteHttps.code === 1 && /--allow-remote/.test(remoteHttps.output), remoteHttps.output.trim());

    // A port that was free a moment ago (opened and closed again): nothing listens there.
    const probe = http.createServer();
    await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
    const closedPort = probe.address().port;
    await new Promise(resolve => probe.close(resolve));
    const unreachable = await runCli(["00000000-0000-4000-8000-000000000000", "hi", "--base", `http://127.0.0.1:${closedPort}`]);
    check("CLI: unreachable local server -> clear error, key not printed", unreachable.code === 1 && /Could not reach the server/.test(unreachable.output) && !/redirect/.test(unreachable.output) && !unreachable.output.includes(FAKE_KEY), unreachable.output.trim());

    // ---- A redirect is not followed: the key never reaches the redirect target ----
    const seenByTarget = [];
    const target = http.createServer((req, res) => { seenByTarget.push(req.headers["x-admin-api-key"] || "(no key)"); res.end("{}"); });
    await new Promise(resolve => target.listen(0, "127.0.0.1", resolve));
    const redirector = http.createServer((req, res) => {
        res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/collect` });
        res.end();
    });
    await new Promise(resolve => redirector.listen(0, "127.0.0.1", resolve));
    const redirected = await runCli(["00000000-0000-4000-8000-000000000000", "hi", "--base", `http://127.0.0.1:${redirector.address().port}`]);
    check("CLI: redirect refused (exit 1)", redirected.code === 1 && /answered with a redirect/.test(redirected.output), redirected.output.trim());
    check("CLI: the redirect target received no request (key not forwarded)", seenByTarget.length === 0, JSON.stringify(seenByTarget.map(() => "request")));
    check("CLI: the key is not printed after a redirect", !redirected.output.includes(FAKE_KEY));
    target.close();
    redirector.close();

    console.table(results);
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})();
