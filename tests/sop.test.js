// Several SOP documents with overlapping subjects, end to end: retrieval picks the right SOP and
// page, citations carry file name / section / page, website + document answers, a question
// needing two SOPs, follow-ups, isolation, the "Email your question" offer, document links that
// visitors may open (per-document opt-in, signed and expiring) and document management.
// Runs the real server.js IN THIS PROCESS on a free port (never 3000-3005 or 5050), with
// EMAIL_TRANSPORT=test (nothing is ever sent) and startup recovery off. Synthetic, fictional
// SOPs only. Two TEMPORARY chatbots; their rows, documents, files and vectors are removed at the
// end (also on failure). The admin key and link secret are random test values made here.
// Needs PostgreSQL, Qdrant and Ollama (embeddings + answers). ~5-10 min, run alone.
// Run: npm run test:sop
const fs = require("fs"), path = require("path"), http = require("http"), net = require("net"), crypto = require("crypto"), Module = require("module");
const { makePdf } = require("./fixtures/documents.js");

const projectDir = path.join(__dirname, "..");
// QDRANT_COLLECTION: set by tests/run-isolated.js (isolated test collection); default as before.
const QDRANT = `http://localhost:6333/collections/${process.env.QDRANT_COLLECTION || "website_content"}/points`;
const RESERVED_PORTS = new Set([3000, 3001, 3002, 3003, 3004, 3005, 5050]);
const NOT_FOUND = "I could not find this information on the website.";

const results = [];
function check(name, ok, note = "") {
    results.push({ test: name, result: ok ? "PASS" : "FAIL" });
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${note ? `\n     ${String(note).replace(/\s+/g, " ").slice(0, 400)}` : ""}\n`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

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

// ---------- three fictional SOPs with overlapping subjects (refunds, outages, billing) ----------
const REFUND_SOP = makePdf([
    ["Refund Processing SOP",
        "1. Purpose",
        "This SOP explains how support agents process customer refunds for Northwind Cloud subscriptions.",
        "2. Eligibility",
        "Annual plans can be refunded within 30 days of purchase.",
        "Monthly plans are not refunded after the billing date."],
    ["3. Approval Limits",
        "Agents may approve refunds up to €250 without a manager.",
        "Refunds above €250 need approval from the billing manager.",
        "4. Processing Time",
        "Approved refunds are returned to the original card within 7 business days."],
    ["5. Refunds for Service Outages",
        "When an outage lasts more than 4 hours, customers receive a credit of 10% of the monthly fee.",
        "Outage credits are issued by the technical support lead, not by the billing team."]
]);
const ONBOARDING_SOP = makePdf([
    ["Customer Onboarding SOP",
        "1. Account Setup",
        "Create the customer workspace within 1 business day of the signed order.",
        "2. Welcome Call",
        "The onboarding manager schedules a 45-minute welcome call in the first week."],
    ["3. Data Migration",
        "Customer data imports are limited to 20 GB during onboarding.",
        "Larger imports need a migration ticket with the technical support team.",
        "4. Billing Setup",
        "The first invoice is sent on the day the workspace is activated."],
    ["5. Onboarding Completion",
        "Onboarding is complete after the customer signs the acceptance form."]
]);
const SUPPORT_SOP = makePdf([
    ["Technical Support SOP",
        "1. Priority Levels",
        "Priority 1 incidents are complete service outages.",
        "Priority 1 incidents must receive a first response within 15 minutes.",
        "Priority 2 incidents must receive a first response within 2 hours."],
    ["2. Escalation",
        "Unresolved Priority 1 incidents are escalated to the on-call engineer after 30 minutes.",
        "3. Password Resets",
        "Agents must verify the customer identity with two security questions before a password reset."],
    ["4. Outage Communication",
        "During an outage the status page is updated every 30 minutes.",
        "After an outage of more than 4 hours, tell the customer that a service credit is available."]
]);
const OTHER_BOT_SOP = makePdf([["Returns SOP", "1. Return Window", "Hardware can be returned within 90 days of delivery."]]);

function startSite() {
    const html = `<!doctype html><html><head><title>Northwind Cloud pricing</title></head><body><main><h1>Northwind Cloud pricing</h1>
<p>Northwind Cloud is a project workspace for small teams.</p>
<h2>Plans</h2><p>The Team plan costs €30 per user per month. The Business plan costs €55 per user per month.</p>
<h2>Free trial</h2><p>Every plan starts with a 14-day free trial. No card is needed for the trial.</p></main></body></html>`;
    const server = http.createServer((req, res) => {
        if (req.url === "/robots.txt") { res.setHeader("Content-Type", "text/plain"); return res.end("User-agent: *\nAllow: /\n"); }
        if (req.url !== "/") { res.writeHead(404); return res.end(); }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

(async () => {
    const site = await startSite();
    const SITE = `http://127.0.0.1:${site.address().port}`;
    const ADMIN_KEY = crypto.randomBytes(32).toString("hex");
    const LINK_SECRET = crypto.randomBytes(32).toString("hex");
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    process.env.DOCUMENT_LINK_SECRET = LINK_SECRET;
    process.env.STARTUP_RECOVERY = "off";
    process.env.EMAIL_TRANSPORT = "test";
    const port = await freePort();
    process.env.PORT = String(port);
    const { ingestWebsite } = loadPatched("ingest.js", src => src.replace("async function assertPublicHttpUrl(rawUrl) {",
        match => `${match}\n    try { if (new URL(String(rawUrl)).origin === ${JSON.stringify(SITE)}) return new URL(String(rawUrl)); } catch {}`));
    const pool = require(path.join(projectDir, "dbPool"));
    const mail = require(path.join(projectDir, "supportMail"));
    const log = console.log, warn = console.warn, error = console.error;
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    loadPatched("server.js", src => src.replace("WHERE status = 'processing'\"", "WHERE status = 'processing' AND false\""));
    const BASE = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(BASE + "/api/health")).ok) break; } catch {}
        await sleep(100);
    }

    const BOT = crypto.randomUUID(), OTHER = crypto.randomUUID();
    const TEMP_IDS = [BOT, OTHER];
    process.stdout.write(`temporary chatbot IDs (removed at the end): ${TEMP_IDS.join(", ")}\n`);

    async function call(method, route, body, key = ADMIN_KEY) {
        const r = await fetch(BASE + route, {
            method,
            headers: { ...(key ? { "x-admin-api-key": key } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
            body: body ? JSON.stringify(body) : undefined
        });
        return { status: r.status, json: await r.json().catch(() => null) };
    }
    async function upload(chatbotId, filename, buffer) {
        const r = await fetch(`${BASE}/api/admin/chatbots/${chatbotId}/documents`, {
            method: "POST",
            headers: { "x-admin-api-key": ADMIN_KEY, "X-File-Name": encodeURIComponent(filename), "Content-Type": "application/octet-stream" },
            body: buffer
        });
        return { status: r.status, json: await r.json().catch(() => null) };
    }
    const documentsOf = async id => (await call("GET", `/api/admin/chatbots/${id}/documents`)).json?.documents || [];
    async function ask(chatbotId, question, previousQuestion) {
        const started = Date.now();
        const r = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatbotId, question, ...(previousQuestion ? { previousQuestion } : {}) }) });
        const j = await r.json();
        return { status: r.status, answer: String(j.answer || j.error || ""), sources: j.sources || [], contact: j.contact, seconds: ((Date.now() - started) / 1000).toFixed(1) };
    }
    const docSource = (r, filename, page) => r.sources.find(s => s.type === "document" && s.title === filename && (page === undefined || s.page === page));
    const describe = r => `${r.seconds}s ${r.answer} | ${r.sources.map(s => s.type === "document" ? `${s.title}#p${s.page} [${s.section}]${s.link ? " +link" : ""}` : s.url).join(" ; ")}`;
    async function count(filter) {
        const r = await fetch(`${QDRANT}/count`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exact: true, filter: { must: filter } }) });
        return (await r.json()).result.count;
    }
    const byChatbot = id => ({ key: "chatbotId", match: { value: id } });
    const byDocument = id => ({ key: "documentId", match: { value: id } });
    const sign = (chatbotId, documentId, expiresAt) => {
        const payload = Buffer.from(`${chatbotId}.${documentId}.${expiresAt}`).toString("base64url");
        return `${payload}.${crypto.createHmac("sha256", LINK_SECRET).update(payload).digest("base64url")}`;
    };
    const open = async (link, headers = {}) => {
        const r = await fetch(BASE + String(link).split("#")[0], { headers });
        return { status: r.status, type: r.headers.get("content-type") || "", disposition: r.headers.get("content-disposition") || "", cache: r.headers.get("cache-control") || "", body: Buffer.from(await r.arrayBuffer()) };
    };

    try {
        await pool.query("INSERT INTO chatbots (id, website_url, allowed_domain, status) VALUES ($1, $2, '127.0.0.1', 'indexing'), ($3, $4, '127.0.0.1', 'pending')", [BOT, `${SITE}/`, OTHER, `${SITE}/other/`]);
        await ingestWebsite(`${SITE}/`, BOT, { maxPages: 2 });
        await pool.query("UPDATE chatbots SET status = 'ready' WHERE id = $1", [BOT]);
        check("website indexed for the SOP chatbot", (await count([byChatbot(BOT)])) > 0);

        // ================= Upload three SOPs; watch the processing stages =================
        for (const [name, buffer] of [["Refund_Processing_SOP.pdf", REFUND_SOP], ["Customer_Onboarding_SOP.pdf", ONBOARDING_SOP], ["Technical_Support_SOP.pdf", SUPPORT_SOP]]) {
            const u = await upload(BOT, name, buffer);
            check(`upload ${name}: accepted (202), private by default`, u.status === 202 && u.json?.document?.visitorAccess === false, JSON.stringify(u.json));
        }
        check("upload to the other chatbot", (await upload(OTHER, "Returns_SOP.pdf", OTHER_BOT_SOP)).status === 202);
        const stagesSeen = new Set();
        let docs = [];
        for (let i = 0; i < 2400; i++) {
            docs = await documentsOf(BOT);
            for (const d of docs) if (d.stage) stagesSeen.add(d.stage.stage);
            if (docs.length === 3 && docs.every(d => d.status !== "processing")) break;
            await sleep(100);
        }
        while ((await documentsOf(OTHER)).some(d => d.status === "processing")) await sleep(500);
        check("processing stages are reported while documents are processed", stagesSeen.has("queued") && [...stagesSeen].some(s => s !== "queued"), [...stagesSeen].join(", "));
        check("no stage once processing has finished", docs.every(d => d.stage === null), JSON.stringify(docs.map(d => d.stage)));
        const refund = docs.find(d => d.filename === "Refund_Processing_SOP.pdf");
        const onboarding = docs.find(d => d.filename === "Customer_Onboarding_SOP.pdf");
        const support = docs.find(d => d.filename === "Technical_Support_SOP.pdf");
        check("all three SOPs indexed with 3 pages each", [refund, onboarding, support].every(d => d?.status === "indexed" && d.pages === 3), JSON.stringify(docs.map(d => [d.filename, d.status, d.pages, d.sections, d.error])));
        // Numbered headings inside the PDF pages become sections, each with its page.
        const points = (await (await fetch(`${QDRANT}/scroll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: 200, with_payload: true, filter: { must: [byChatbot(BOT), byDocument(refund.id)] } }) })).json()).result.points;
        const headingPages = points.map(p => `${p.payload.page}:${p.payload.heading}`);
        check("Refund SOP: numbered headings stored as sections with their pages",
            ["1:2. Eligibility", "2:3. Approval Limits", "2:4. Processing Time", "3:5. Refunds for Service Outages"].every(h => headingPages.includes(h)), headingPages.join(" | "));

        // ================= The right SOP, page and section =================
        let a = await ask(BOT, "Within how many days are approved refunds returned to the card?");
        check("refund timing: answered from the Refund SOP, page 2, section 4. Processing Time", /7 business days|seven business days/i.test(a.answer) && docSource(a, "Refund_Processing_SOP.pdf", 2)?.section === "4. Processing Time", describe(a));
        check("private documents: citation has no link", a.sources.every(s => !("link" in s)) && a.sources.every(s => !("documentId" in s)), JSON.stringify(a.sources));
        a = await ask(BOT, "How fast must we respond to a Priority 1 incident?");
        check("P1 response: answered from the Technical Support SOP, page 1", /15 minutes/i.test(a.answer) && docSource(a, "Technical_Support_SOP.pdf", 1), describe(a));
        check("P1 response: the overlapping Refund/Onboarding SOPs are not cited", !docSource(a, "Refund_Processing_SOP.pdf") && !docSource(a, "Customer_Onboarding_SOP.pdf"), describe(a));
        a = await ask(BOT, "How large can a customer data import be during onboarding?");
        check("data import limit: answered from the Onboarding SOP, page 2", /20 ?GB/i.test(a.answer) && docSource(a, "Customer_Onboarding_SOP.pdf", 2), describe(a));
        a = await ask(BOT, "Can an agent approve a €400 refund without a manager?");
        check("approval limit: billing manager needed, Refund SOP page 2", /billing manager/i.test(a.answer) && docSource(a, "Refund_Processing_SOP.pdf", 2), describe(a));

        // ================= Two SOPs; website + SOP =================
        a = await ask(BOT, "What credit does a customer get after a 5-hour outage, and how often is the status page updated during an outage?");
        check("two SOPs: 10% credit (Refund SOP p3) and 30-minute status updates (Support SOP p3)",
            /10 ?%/.test(a.answer) && /30 minutes/i.test(a.answer) && docSource(a, "Refund_Processing_SOP.pdf", 3) && docSource(a, "Technical_Support_SOP.pdf", 3), describe(a));
        a = await ask(BOT, "How much does the Team plan cost, and within how many days can an annual plan be refunded?");
        check("website + SOP: €30 from the website and 30 days from the Refund SOP, both cited",
            /€\s?30\b/.test(a.answer) && /30 days/i.test(a.answer) && a.sources.some(s => s.type === "webpage") && docSource(a, "Refund_Processing_SOP.pdf", 1), describe(a));

        // ================= Follow-up =================
        a = await ask(BOT, "How long is the welcome call?");
        const followUp = await ask(BOT, "Who schedules it?", "How long is the welcome call?");
        check("follow-up: 45 minutes, then 'Who schedules it?' answered from the same SOP", /45/.test(a.answer) && /onboarding manager/i.test(followUp.answer) && docSource(followUp, "Customer_Onboarding_SOP.pdf", 1), `${describe(a)} || ${describe(followUp)}`);

        // ================= Not found; isolation =================
        a = await ask(BOT, "Do you offer on-site training in Antarctica?");
        check("unrelated question: exact fallback, no citation, no email option without a support address", a.answer === NOT_FOUND && a.sources.length === 0 && a.contact === undefined, describe(a));
        check("support address set", (await call("PATCH", `/api/admin/chatbots/${BOT}`, { supportEmail: "help@northwind.example" })).status === 200);
        a = await ask(BOT, "Do you offer on-site training in Antarctica?");
        check("unrelated question with a support address: exact fallback + email option", a.answer === NOT_FOUND && a.contact === true, describe(a));
        a = await ask(BOT, "How fast must we respond to a Priority 1 incident?");
        check("answered question: no email option", a.answer !== NOT_FOUND && a.contact === undefined, describe(a));
        check("no email was sent without a visitor submitting the form", mail._testOutbox.length === 0, `outbox ${mail._testOutbox.length}`);
        a = await ask(OTHER, "How fast must we respond to a Priority 1 incident?");
        check("isolation: the other chatbot cannot answer from these SOPs", a.answer === NOT_FOUND && a.sources.length === 0, describe(a));
        a = await ask(BOT, "Within how many days can hardware be returned?");
        check("isolation: the other chatbot's SOP (90 days) is never used here", !/90/.test(a.answer), describe(a));

        // ================= Document links (per-document opt-in) =================
        let r = await call("PATCH", `/api/admin/chatbots/${BOT}/documents/${refund.id}`, { visitorAccess: "yes" });
        check("visitor access: only true/false accepted (400)", r.status === 400, JSON.stringify(r.json));
        r = await call("PATCH", `/api/admin/chatbots/${BOT}/documents/${refund.id}`, { visitorAccess: true }, "");
        check("visitor access: needs the admin key (401)", r.status === 401, `HTTP ${r.status}`);
        r = await call("PATCH", `/api/admin/chatbots/${OTHER}/documents/${refund.id}`, { visitorAccess: true });
        check("visitor access: another chatbot cannot change it (404)", r.status === 404, `HTTP ${r.status}`);
        r = await call("PATCH", `/api/admin/chatbots/${BOT}/documents/${refund.id}`, { visitorAccess: true });
        check("visitor access enabled for the Refund SOP only", r.status === 200 && r.json?.document?.visitorAccess === true, JSON.stringify(r.json));

        a = await ask(BOT, "What credit does a customer get after a 5-hour outage, and how often is the status page updated during an outage?");
        const refundCite = docSource(a, "Refund_Processing_SOP.pdf");
        const supportCite = docSource(a, "Technical_Support_SOP.pdf");
        check("allowed document: citation has a signed link that opens at the cited page",
            refundCite && /^\/api\/documents\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+#page=\d+$/.test(refundCite.link || "") && refundCite.link.endsWith(`#page=${refundCite.page}`), describe(a));
        check("private document in the same answer: no link", supportCite ? !("link" in supportCite) : false, describe(a));
        const link = refundCite?.link || "/api/documents/missing.missing";
        let f = await open(link);
        check("link opens the PDF (inline, not cached, exact file)", f.status === 200 && f.type.startsWith("application/pdf") && /^inline; filename="Refund_Processing_SOP.pdf"/.test(f.disposition) && /no-store/.test(f.cache) && f.body.equals(REFUND_SOP), `${f.status} ${f.type} ${f.disposition} ${f.cache}`);
        const [payload, signature] = link.split("#")[0].split("/").pop().split(".");
        f = await open(`/api/documents/${payload}.${signature.slice(0, -2)}${signature.slice(-2) === "AA" ? "BB" : "AA"}`);
        check("tampered signature: 403", f.status === 403, `HTTP ${f.status}`);
        f = await open(`/api/documents/${Buffer.from(`${BOT}.${support.id}.${Date.now() + 3600000}`).toString("base64url")}.${signature}`);
        check("link changed to point at another document: 403", f.status === 403, `HTTP ${f.status}`);
        f = await open("/api/documents/not-a-token");
        check("garbage token: 403", f.status === 403, `HTTP ${f.status}`);
        f = await open(`/api/documents/${sign(BOT, refund.id, Date.now() - 1000)}`);
        check("expired link: 403", f.status === 403, `HTTP ${f.status}`);
        f = await open(`/api/documents/${sign(BOT, support.id, Date.now() + 60000)}`);
        check("valid signature for a PRIVATE document: 404", f.status === 404, `HTTP ${f.status}`);
        f = await open(`/api/documents/${sign(OTHER, refund.id, Date.now() + 60000)}`);
        check("valid signature naming the wrong chatbot: 404", f.status === 404, `HTTP ${f.status}`);
        f = await open(`/data/uploads/${BOT}/`);
        check("upload folder is not served", f.status === 404, `HTTP ${f.status}`);

        // Admin file endpoint
        f = await open(`/api/admin/chatbots/${BOT}/documents/${support.id}/file`);
        check("admin Open: needs the admin key (401)", f.status === 401, `HTTP ${f.status}`);
        f = await open(`/api/admin/chatbots/${BOT}/documents/${support.id}/file`, { "x-admin-api-key": ADMIN_KEY });
        check("admin Open: private document opens for the administrator", f.status === 200 && f.body.equals(SUPPORT_SOP), `HTTP ${f.status}`);
        f = await open(`/api/admin/chatbots/${OTHER}/documents/${support.id}/file`, { "x-admin-api-key": ADMIN_KEY });
        check("admin Open: through another chatbot (404)", f.status === 404, `HTTP ${f.status}`);

        // Revoking access disables links already given out.
        r = await call("PATCH", `/api/admin/chatbots/${BOT}/documents/${refund.id}`, { visitorAccess: false });
        f = await open(link);
        check("access removed: the earlier link stops working (404)", r.status === 200 && f.status === 404, `HTTP ${f.status}`);
        a = await ask(BOT, "Within how many days are approved refunds returned to the card?");
        check("access removed: citations no longer have a link", docSource(a, "Refund_Processing_SOP.pdf") && a.sources.every(s => !("link" in s)), describe(a));

        // ================= Management: re-index and remove one SOP =================
        const refundPoints = await count([byChatbot(BOT), byDocument(refund.id)]);
        r = await call("POST", `/api/admin/chatbots/${BOT}/documents/${refund.id}/reindex`);
        while ((await documentsOf(BOT)).some(d => d.status === "processing")) await sleep(300);
        check("re-index a SOP: same sections, no duplicates", r.status === 202 && (await count([byChatbot(BOT), byDocument(refund.id)])) === refundPoints, `${refundPoints} -> ${await count([byChatbot(BOT), byDocument(refund.id)])}`);
        const supportPoints = await count([byChatbot(BOT), byDocument(support.id)]);
        const total = await count([byChatbot(BOT)]);
        const stored = (await pool.query("SELECT storage_name FROM documents WHERE id = $1", [support.id])).rows[0].storage_name;
        r = await call("DELETE", `/api/admin/chatbots/${BOT}/documents/${support.id}`);
        check("remove one SOP: its vectors, file and record only",
            r.status === 200 && (await count([byChatbot(BOT), byDocument(support.id)])) === 0 && (await count([byChatbot(BOT)])) === total - supportPoints &&
            !fs.existsSync(path.join(process.env.UPLOAD_DIR || path.join(projectDir, "data", "uploads"), BOT, stored)) && (await documentsOf(BOT)).length === 2, JSON.stringify(r.json?.removed));
        f = await open(`/api/documents/${sign(BOT, support.id, Date.now() + 60000)}`);
        check("removed document: link 404", f.status === 404, `HTTP ${f.status}`);
        a = await ask(BOT, "How fast must we respond to a Priority 1 incident?");
        check("removed SOP is no longer used for answers", !/15 minutes/i.test(a.answer) && !docSource(a, "Technical_Support_SOP.pdf"), describe(a));
    } catch (e) {
        check("unexpected test error", false, e.stack || e.message);
    } finally {
        for (const id of TEMP_IDS) {
            await pool.query("DELETE FROM chatbots WHERE id = $1 AND website_url LIKE 'http://127.0.0.1:%'", [id]);
            await fetch(`${QDRANT}/delete?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [byChatbot(id)] } }) });
            await fs.promises.rm(path.join(process.env.UPLOAD_DIR || path.join(projectDir, "data", "uploads"), id), { recursive: true, force: true });
        }
        let left = 0;
        for (const id of TEMP_IDS) {
            left += await count([byChatbot(id)]);
            left += Number((await pool.query("SELECT (SELECT count(*) FROM chatbots WHERE id = $1) + (SELECT count(*) FROM documents WHERE chatbot_id = $1) AS n", [id])).rows[0].n);
            left += fs.existsSync(path.join(process.env.UPLOAD_DIR || path.join(projectDir, "data", "uploads"), id)) ? 1 : 0;
        }
        check("cleanup: temporary chatbots, documents, files and vectors removed", left === 0, `left ${left}`);
        site.close();
        console.log = log; console.warn = warn; console.error = error;
        console.table(results);
        const failed = results.filter(x => x.result !== "PASS").length;
        console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
        process.exit(failed ? 1 : 0);
    }
})();
