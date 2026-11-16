// Startup recovery in server.js: a server started with STARTUP_RECOVERY=off (tests, a second server
// sharing the database) must not mark documents another server is still processing as failed; with
// recovery on (the default) the documents are recovered exactly once at startup.
// Loads the real server.js in child processes with dbPool.js replaced by a recorder: no database
// connection, nothing written anywhere, random free port. Run: node tests/startup-recovery.test.js
"use strict";
const path = require("path"), Module = require("module");
const { spawnSync } = require("child_process");
const dir = path.resolve(__dirname, "..");
const DB_POOL_FILE = path.join(dir, "dbPool.js");

if (process.argv[2] === "--child") {
    // Every require of dbPool.js (server.js, chatbotRegistry.js) gets the recorder instead.
    const queries = [];
    const recorder = { query: async sql => { queries.push(String(sql)); return { rows: [], rowCount: 0 }; }, on() {}, end: async () => {} };
    const load = Module._load;
    Module._load = function (request, parent, isMain) {
        let resolved = null;
        try { resolved = Module._resolveFilename(request, parent, isMain); } catch { /* left to the normal loader */ }
        return resolved === DB_POOL_FILE ? recorder : load.apply(this, arguments);
    };
    process.env.PORT = "0";
    require(path.join(dir, "server.js"));
    // Startup recovery starts right after loading; give its first queries time to be sent.
    setTimeout(() => {
        process.stdout.write(`\nRESULT ${JSON.stringify({ queries, realPoolLoaded: Boolean(require.cache[DB_POOL_FILE]) })}\n`);
        process.exit(0);
    }, 1500);
    return;
}

const DOCUMENT_RECOVERY = /^UPDATE documents SET status = 'failed'.* WHERE status = 'processing'$/;
const CHATBOT_RECOVERY = /FROM chatbots WHERE status = 'indexing'/;

function startServer(recoverySetting) {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.STARTUP_RECOVERY;
    if (recoverySetting !== undefined) env.STARTUP_RECOVERY = recoverySetting;
    const child = spawnSync(process.execPath, [__filename, "--child"], { cwd: dir, env, encoding: "utf8", timeout: 60000 });
    const line = (child.stdout || "").split("\n").find(text => text.startsWith("RESULT "));
    if (!line) return { error: `child exit ${child.status}: ${(child.stderr || "").trim().split("\n").slice(-3).join(" | ")}` };
    return JSON.parse(line.slice(7));
}

const results = [];
function check(name, ok, detail = "") {
    results.push({ check: name, result: ok ? "PASS" : "FAIL", detail: String(detail).slice(0, 140) });
}

const cases = [
    { label: "STARTUP_RECOVERY=off", setting: "off", documents: 0, chatbots: 0 },
    { label: "STARTUP_RECOVERY=OFF (any case)", setting: "OFF", documents: 0, chatbots: 0 },
    { label: "STARTUP_RECOVERY not set (default)", setting: undefined, documents: 1, chatbots: 1 },
    { label: "STARTUP_RECOVERY=on", setting: "on", documents: 1, chatbots: 1 }
];
for (const test of cases) {
    const run = startServer(test.setting);
    if (run.error) {
        check(`${test.label}: server started with the recorder`, false, run.error);
        continue;
    }
    check(`${test.label}: real database pool never loaded`, run.realPoolLoaded === false, `realPoolLoaded=${run.realPoolLoaded}`);
    const documentUpdates = run.queries.filter(sql => DOCUMENT_RECOVERY.test(sql)).length;
    const chatbotSelects = run.queries.filter(sql => CHATBOT_RECOVERY.test(sql)).length;
    check(`${test.label}: document-recovery UPDATE sent ${test.documents} time(s)`, documentUpdates === test.documents, `sent ${documentUpdates}`);
    check(`${test.label}: chatbot recovery run ${test.chatbots} time(s) (unchanged behaviour)`, chatbotSelects === test.chatbots, `ran ${chatbotSelects}`);
    if (test.documents === 0) {
        check(`${test.label}: no database statement at all at startup`, run.queries.length === 0, `${run.queries.length} statement(s)`);
    }
}

console.table(results);
const failed = results.filter(r => r.result !== "PASS").length;
console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
process.exit(failed ? 1 : 0);
