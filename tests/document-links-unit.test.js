// Unit test: visitors' document links after a server restart (no network, no model, no database writes).
// server.js is loaded twice in this process, as two "starts" of the server: with DOCUMENT_LINK_SECRET set,
// a link signed by the first start opens on the second; without it, each start makes its own random secret,
// so the link no longer opens (the reason .env needs a fixed secret). Run: npm test
const fs = require("fs"), path = require("path"), crypto = require("crypto"), Module = require("module");

process.env.PORT = "0"; // server.js starts listening when loaded; use a random free port
process.env.STARTUP_RECOVERY = "off";
const file = path.join(__dirname, "..", "server.js");
const source = fs.readFileSync(file, "utf8") + "\nmodule.exports.__links = { signDocumentLink, readDocumentLink };";
function startServer() {
    const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
    const warn = console.warn, log = console.log;
    console.warn = () => {}; console.log = () => {};
    try { m._compile(source, file); } finally { console.warn = warn; console.log = log; }
    return m.exports.__links;
}

const results = [];
const check = (test, ok) => results.push({ test, result: ok ? "PASS" : "FAIL" });
const CHATBOT = crypto.randomUUID(), DOCUMENT = crypto.randomUUID();
const inOneHour = Date.now() + 60 * 60 * 1000;

process.env.DOCUMENT_LINK_SECRET = crypto.randomBytes(32).toString("hex");
let first = startServer(), second = startServer();
let token = first.signDocumentLink(CHATBOT, DOCUMENT, inOneHour);
let opened = second.readDocumentLink(token);
check("with DOCUMENT_LINK_SECRET: a link still opens after a restart", opened?.chatbotId === CHATBOT && opened?.documentId === DOCUMENT);
check("with DOCUMENT_LINK_SECRET: an expired link does not", second.readDocumentLink(first.signDocumentLink(CHATBOT, DOCUMENT, Date.now() - 1000)) === null);

delete process.env.DOCUMENT_LINK_SECRET;
first = startServer(); second = startServer();
token = first.signDocumentLink(CHATBOT, DOCUMENT, inOneHour);
check("without it: the link opens until the restart", first.readDocumentLink(token)?.documentId === DOCUMENT);
check("without it: the link stops working after a restart", second.readDocumentLink(token) === null);

process.env.DOCUMENT_LINK_SECRET = "too-short";
first = startServer(); second = startServer();
check("a secret under 32 characters is not used (same as none)", second.readDocumentLink(first.signDocumentLink(CHATBOT, DOCUMENT, inOneHour)) === null);

console.table(results);
const failed = results.filter(row => row.result !== "PASS").length;
console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
process.exit(failed ? 1 : 0);
