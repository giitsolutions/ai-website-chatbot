// Admin authorisation of every route registered by server.js (offline: no database, no Qdrant,
// no model). The real server.js is loaded with dbPool.js replaced by a recorder. Every route that
// is not on the short public list must run requireActor FIRST (the admin key, or a customer session
// cookie), and without a key or cookie must answer 401, with a wrong key 403 - before any database
// statement is sent. A new route that forgets the check fails this test.
// Run: node tests/admin-auth.test.js (part of npm test)
"use strict";
const fs = require("fs"), path = require("path"), Module = require("module"), crypto = require("crypto");
const dir = path.resolve(__dirname, "..");
const DB_POOL_FILE = path.join(dir, "dbPool.js");

// The only routes visitors (the widget, document links) may use without the admin key.
const PUBLIC_ROUTES = new Set([
    "GET /",
    "GET /api/health",
    "POST /api/chat",
    "POST /api/chat/contact",
    "GET /api/chatbots/:id/config",
    "GET /api/documents/:token",
    // Customer login: no key or session needed to log in or out (rate-limited; logout only ends a session).
    "POST /api/auth/login",
    "POST /api/auth/logout"
]);

const queries = [];
const recorder = { query: async sql => { queries.push(String(sql)); return { rows: [], rowCount: 0 }; }, on() {}, end: async () => {}, connect: async () => { throw new Error("no database in this test"); } };
const load = Module._load;
Module._load = function (request, parent, isMain) {
    let resolved = null;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch { /* normal loader */ }
    return resolved === DB_POOL_FILE ? recorder : load.apply(this, arguments);
};

const KEY = crypto.randomBytes(32).toString("hex");
process.env.ADMIN_API_KEY = KEY;
process.env.ADMIN_API_KEYS = "";
process.env.STARTUP_RECOVERY = "off";
process.env.PORT = "0";
delete process.env.DATABASE_URL;

// The real server.js, plus one line exposing the Express app to this test.
const serverFile = path.join(dir, "server.js");
const m = new Module(serverFile);
m.filename = serverFile;
m.paths = Module._nodeModulePaths(dir);
const log = console.log, error = console.error;
console.log = () => {}; console.error = () => {};
m._compile(fs.readFileSync(serverFile, "utf8") + "\nmodule.exports.__app = app;", serverFile);
const app = m.exports.__app;

const results = [];
function check(name, ok, detail = "") {
    results.push({ check: name, result: ok ? "PASS" : "FAIL", detail: String(detail).slice(0, 120) });
}

// Every route: method, path and the name of its first handler.
const routes = [];
for (const layer of app.router.stack) {
    if (!layer.route) continue;
    for (const method of Object.keys(layer.route.methods).filter(name => layer.route.methods[name])) {
        routes.push({ method: method.toUpperCase(), path: layer.route.path, first: layer.route.stack[0]?.handle?.name || "(anonymous)" });
    }
}
check("routes found in server.js", routes.length >= 25, `${routes.length} routes`);
for (const name of PUBLIC_ROUTES) check(`public route still exists: ${name}`, routes.some(route => `${route.method} ${route.path}` === name));
const adminRoutes = routes.filter(route => !PUBLIC_ROUTES.has(`${route.method} ${route.path}`));
for (const route of adminRoutes) {
    check(`${route.method} ${route.path}: requireActor runs first`, route.first === "requireActor", `first handler: ${route.first}`);
}

(async () => {
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const sample = "4f0a0d4e-0000-4000-8000-000000000001";
    for (const route of adminRoutes) {
        const url = base + route.path.replace(/:id|:documentId/g, sample).replace(/:token/g, "x");
        const body = ["POST", "PATCH", "PUT", "DELETE"].includes(route.method) ? JSON.stringify({ confirm: sample, url: "https://example.com/" }) : undefined;
        const headers = body ? { "Content-Type": "application/json" } : {};
        const before = queries.length;
        const none = await fetch(url, { method: route.method, headers, body });
        const noneText = await none.text();
        const wrong = await fetch(url, { method: route.method, headers: { ...headers, "x-admin-api-key": "wrong-" + "0".repeat(60) }, body });
        const wrongText = await wrong.text();
        check(`${route.method} ${route.path}: 401 without key, 403 with a wrong key`, none.status === 401 && wrong.status === 403, `${none.status} / ${wrong.status}`);
        check(`${route.method} ${route.path}: no database statement before the key check`, queries.length === before, `${queries.length - before} statement(s)`);
        check(`${route.method} ${route.path}: refusal reveals no key or internals`, !(noneText + wrongText).includes(KEY) && !/node_modules|at .+:\d+:\d+|[A-Za-z]:\\/.test(noneText + wrongText));
    }
    // The browser never receives the admin key: no route answers with it, and the dashboard page
    // does not contain it.
    const page = await (await fetch(base + "/index.html")).text();
    check("dashboard page does not contain the admin key", !page.includes(KEY));
    server.close();
    console.log = log; console.error = error;
    console.table(results);
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})().catch(failure => { console.log = log; console.error("admin-auth test error:", failure.message); process.exit(2); });
