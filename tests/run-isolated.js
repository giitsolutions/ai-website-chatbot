// Runs one integration test in the isolated test environment (tests/support/isolated-env.js):
// separate test database and Qdrant collection, temporary upload folder, fake email, startup
// recovery off. Before and after, the SHARED database and collection are counted (read-only);
// any difference is reported as a failure.
//   node tests/run-isolated.js tests/deletion.test.js
//   node tests/run-isolated.js --with-server tests/http.test.js
// --with-server: for suites that need a running server (TEST_BASE_URL). Starts server.js as a child
// process with the same isolated environment on a random free port (never 3000-3005 or 5050), points
// the suite at it, and stops exactly that child process afterwards. Its log goes to a temporary file.
"use strict";
const fs = require("fs"), os = require("os"), net = require("net"), path = require("path");
const { spawn, spawnSync } = require("child_process");
const { isolatedEnv, prepare, sharedSnapshot } = require("./support/isolated-env");

const projectDir = path.join(__dirname, "..");
const RESERVED_PORTS = new Set([3000, 3001, 3002, 3003, 3004, 3005, 5050]);

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

// Starts server.js with the isolated environment; resolves when /api/health answers success.
async function startServer(env) {
    const port = await freePort();
    const logFile = path.join(os.tmpdir(), `chatbot-isolated-server-${port}.log`);
    const log = fs.openSync(logFile, "w");
    const child = spawn(process.execPath, [path.join(projectDir, "server.js")], {
        cwd: projectDir, env: { ...process.env, ...env, PORT: String(port) }, stdio: ["ignore", log, log]
    });
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 120; i++) {
        if (child.exitCode !== null) throw new Error(`test server exited early (code ${child.exitCode}); log: ${logFile}`);
        try {
            const health = await (await fetch(`${base}/api/health`)).json();
            if (health.success) return { child, base, port, logFile };
        } catch { /* not listening yet */ }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    child.kill();
    throw new Error(`test server did not become healthy in 60 s; log: ${logFile}`);
}

async function stopServer(server) {
    if (!server || server.child.exitCode !== null) return;
    const exited = new Promise(resolve => server.child.once("exit", resolve));
    server.child.kill();
    await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 10000))]);
}

(async () => {
    const withServer = process.argv.includes("--with-server");
    const testFile = process.argv.slice(2).find(arg => !arg.startsWith("--"));
    if (!testFile || !fs.existsSync(testFile)) {
        console.error("usage: node tests/run-isolated.js [--with-server] <test file>");
        process.exit(2);
    }
    const env = isolatedEnv();
    await prepare(env);
    const before = await sharedSnapshot();
    console.log(`isolated: database ${env.TEST_DATABASE_NAME}, collection ${env.QDRANT_COLLECTION}, uploads in a temporary folder`);
    let server = null;
    let status = 1;
    try {
        if (withServer) {
            server = await startServer(env);
            console.log(`isolated test server: ${server.base} (process ${server.child.pid}; log ${server.logFile})`);
        }
        const childEnv = { ...process.env, ...env, ...(server ? { TEST_BASE_URL: server.base } : {}) };
        const child = spawnSync(process.execPath, [testFile], { stdio: "inherit", env: childEnv });
        status = child.status === null ? 1 : child.status;
    } finally {
        if (server) {
            await stopServer(server);
            console.log(`isolated test server stopped: ${server.child.exitCode !== null || server.child.signalCode ? "yes" : "NO (process " + server.child.pid + ")"}`);
        }
    }
    const after = await sharedSnapshot();
    const leftovers = fs.existsSync(env.UPLOAD_DIR) ? fs.readdirSync(env.UPLOAD_DIR).length : 0;
    fs.rmSync(env.UPLOAD_DIR, { recursive: true, force: true });
    const sharedUnchanged = JSON.stringify(before) === JSON.stringify(after);
    console.log(`shared database and collection unchanged: ${sharedUnchanged ? "yes" : `NO (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`}`);
    console.log(`temporary upload folder: ${leftovers} entr${leftovers === 1 ? "y" : "ies"} left by the test (folder removed)`);
    process.exit(status !== 0 ? status : sharedUnchanged ? 0 : 1);
})().catch(error => {
    console.error("run-isolated error:", error.message);
    process.exit(2);
});
