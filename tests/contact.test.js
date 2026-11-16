// The contact form after an unanswered question (POST /api/chat/contact) and the support-email
// setting, end to end: the enquiry is saved first (table enquiries), then emailed when email is
// configured; a failed or unconfigured email never loses it, and the visitor is told exactly which.
// Runs the real server.js IN THIS PROCESS on a free port (never 3000-3005 or 5050) with
// EMAIL_TRANSPORT=test: messages are kept in memory and NEVER sent. Startup recovery is off.
// Three TEMPORARY chatbot rows are created and removed at the end (also on failure).
// The admin key is a random test key made here (the .env keys are never read or printed).
// Writes enquiries: run it ISOLATED (separate test database). Needs PostgreSQL and Ollama (one
// question embedding). ~20 s. Run: npm run test:contact  (= node tests/run-isolated.js tests/contact.test.js)
const fs = require("fs"), path = require("path"), net = require("net"), crypto = require("crypto"), Module = require("module");

const projectDir = path.join(__dirname, "..");
// QDRANT_COLLECTION: set by tests/run-isolated.js (isolated test collection); default as before.
const QDRANT = `http://localhost:6333/collections/${process.env.QDRANT_COLLECTION || "website_content"}/points`;
const RESERVED_PORTS = new Set([3000, 3001, 3002, 3003, 3004, 3005, 5050]);
const NOT_FOUND = "I could not find this information on the website.";
const SENT = "Thank you. Your question has been sent to the support team. They will reply to your email address.";
const SAVED = "Thank you. Your question has been received and saved for the support team. They can reply to your email address.";

const results = [];
function check(name, ok, note = "") {
    results.push({ test: name, result: ok ? "PASS" : "FAIL" });
    if (!ok || process.env.VERBOSE) process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${note ? `\n     ${String(note).replace(/\s+/g, " ").slice(0, 300)}` : ""}
`);
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

// Compiles a project module with a source change and registers it as the cached module.
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
    const ADMIN_KEY = crypto.randomBytes(32).toString("hex");
    process.env.ADMIN_API_KEY = ADMIN_KEY;
    const port = await freePort();
    process.env.PORT = String(port);
    process.env.STARTUP_RECOVERY = "off";
    process.env.EMAIL_TRANSPORT = "test";
    const mail = require(path.join(projectDir, "supportMail"));
    const pool = require(path.join(projectDir, "dbPool"));
    const log = console.log, warn = console.warn, error = console.error;
    console.log = () => {};
    console.warn = () => {};
    console.error = () => {};
    // The startup check that marks interrupted documents as failed belongs to the real server.
    loadPatched("server.js", src => src.replace("WHERE status = 'processing'\"", "WHERE status = 'processing' AND false\""));
    const BASE = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(BASE + "/api/health")).ok) break; } catch {}
        await sleep(100);
    }

    // BOT: support address set through the admin API; NO_EMAIL: none; LOCKED: allowed origins only.
    const BOT = crypto.randomUUID(), NO_EMAIL = crypto.randomUUID(), LOCKED = crypto.randomUUID();
    const TEMP_IDS = [BOT, NO_EMAIL, LOCKED];
    const SUPPORT = "support@shop.example";

    async function call(method, route, body, { key = ADMIN_KEY, base = BASE, origin } = {}) {
        const r = await fetch(base + route, {
            method,
            headers: { ...(key ? { "x-admin-api-key": key } : {}), ...(body ? { "Content-Type": "application/json" } : {}), ...(origin ? { Origin: origin } : {}) },
            body: body ? JSON.stringify(body) : undefined
        });
        let json = null;
        try { json = await r.json(); } catch {}
        return { status: r.status, json };
    }
    const form = (chatbotId, extra = {}) => ({ chatbotId, name: "Asha Rao", email: "asha@example.org", question: "Can I change my delivery address after ordering?", details: "Order 1234", requestId: crypto.randomUUID(), ...extra });
    const contact = (body, options = {}) => call("POST", "/api/chat/contact", body, { key: "", ...options });
    const storedEnquiry = async (chatbotId, requestId) => (await pool.query("SELECT * FROM enquiries WHERE chatbot_id = $1 AND request_id = $2", [chatbotId, requestId])).rows[0];
    const enquiryCount = async () => Number((await pool.query("SELECT count(*) AS n FROM enquiries WHERE chatbot_id = ANY($1::uuid[])", [TEMP_IDS])).rows[0].n);

    try {
        await pool.query(
            `INSERT INTO chatbots (id, website_url, allowed_domain, status, allowed_origins) VALUES
             ($1, 'http://127.0.0.1:1/contact-test', '127.0.0.1', 'ready', NULL),
             ($2, 'http://127.0.0.1:1/contact-test', '127.0.0.1', 'ready', NULL),
             ($3, 'http://127.0.0.1:1/contact-test', '127.0.0.1', 'ready', 'https://shop.example')`,
            [BOT, NO_EMAIL, LOCKED]);
        await pool.query("UPDATE chatbots SET support_email = $1 WHERE id = $2", [SUPPORT, LOCKED]);

        // ================= Support email setting =================
        for (const bad of ["not-an-email", "a@b.com\r\nBcc: x@evil.example", "a@b.com, c@d.com", "Name <a@b.com>", `${"a".repeat(250)}@b.com`]) {
            const r = await call("PATCH", `/api/admin/chatbots/${BOT}`, { supportEmail: bad });
            check(`setting: invalid support address refused (400): ${JSON.stringify(bad.slice(0, 30))}`, r.status === 400, JSON.stringify(r.json));
        }
        let r = await call("PATCH", `/api/admin/chatbots/${BOT}`, { supportEmail: `  ${SUPPORT}  ` });
        check("setting: support address saved (trimmed) and shown in settings", r.status === 200 && r.json.chatbot.settings.supportEmail === SUPPORT, JSON.stringify(r.json?.chatbot?.settings));
        r = await call("PATCH", `/api/admin/chatbots/${BOT}`, { supportEmail: SUPPORT }, { key: "" });
        check("setting: changing it needs the admin key (401)", r.status === 401, `HTTP ${r.status}`);
        r = await call("GET", "/api/admin/chatbots");
        check("dashboard list says email is configured", r.status === 200 && r.json.emailConfigured === true, `emailConfigured=${r.json?.emailConfigured}`);
        r = await call("GET", `/api/chatbots/${BOT}/config`, null, { key: "" });
        check("public widget config never reveals the support address", r.status === 200 && !JSON.stringify(r.json).includes(SUPPORT), JSON.stringify(r.json));

        // ================= Chat: the email option after an unanswered question =================
        r = await call("POST", "/api/chat", { chatbotId: BOT, question: "Do you sell spare parts for submarines?" }, { key: "" });
        check("unanswered question: exact fallback text, plus contact: true", r.status === 200 && r.json.answer === NOT_FOUND && r.json.contact === true, JSON.stringify(r.json));
        r = await call("POST", "/api/chat", { chatbotId: NO_EMAIL, question: "Do you sell spare parts for submarines?" }, { key: "" });
        check("no support address: the form is still offered (saved for the dashboard only)", r.status === 200 && r.json.answer === NOT_FOUND && r.json.unanswered === true && r.json.contact === true, JSON.stringify(r.json));

        // ================= Contact: validation (nothing sent) =================
        const invalid = [
            ["missing chatbotId", form(BOT, { chatbotId: "nope" }), "chatbotId"],
            ["missing requestId", form(BOT, { requestId: undefined }), "requestId"],
            ["bad requestId", form(BOT, { requestId: "x" }), "requestId"],
            ["empty name", form(BOT, { name: "  " }), "name"],
            ["name with a line break (header injection)", form(BOT, { name: "Asha\r\nBcc: x@evil.example" }), "name"],
            ["name too long", form(BOT, { name: "a".repeat(101) }), "name"],
            ["invalid email", form(BOT, { email: "asha" }), "email"],
            ["email with a line break (header injection)", form(BOT, { email: "asha@example.org\r\nBcc: x@evil.example" }), "email"],
            ["email list", form(BOT, { email: "asha@example.org, x@evil.example" }), "email"],
            ["empty question", form(BOT, { question: " " }), "question"],
            ["question too long", form(BOT, { question: "q".repeat(1001) }), "question"],
            ["details too long", form(BOT, { details: "d".repeat(2001) }), "details"]
        ];
        for (const [name, body, field] of invalid) {
            const res = await contact(body);
            check(`contact refused (400, field "${field}"): ${name}`, res.status === 400 && res.json?.success === false && res.json.field === field, JSON.stringify(res.json));
        }
        r = await contact(form(crypto.randomUUID()));
        check("contact for an unknown chatbot: 404", r.status === 404, JSON.stringify(r.json));
        check("nothing was sent by refused requests", mail._testOutbox.length === 0, `outbox ${mail._testOutbox.length}`);
        check("nothing was saved by refused requests", (await enquiryCount()) === 0);

        // ================= Contact: sending =================
        r = await contact(form(LOCKED), { origin: "https://evil.example" });
        check("contact from a website not allowed for this chatbot: 403, nothing sent", r.status === 403 && mail._testOutbox.length === 0, JSON.stringify(r.json));
        const first = form(BOT, { name: "Asha <Rao>", question: "Can I change my delivery address after ordering?\nIt is urgent." });
        r = await contact(first);
        const message = mail._testOutbox[0];
        check("contact: 'sent' message, saved + emailed, exactly one email", r.status === 200 && r.json.message === SENT && r.json.saved === true && r.json.emailed === true && mail._testOutbox.length === 1, JSON.stringify(r.json));
        const row = await storedEnquiry(BOT, first.requestId);
        check("stored: the exact question, details, visitor and recipient, email_status accepted",
            row && row.question === "Can I change my delivery address after ordering?\nIt is urgent." && row.details === "Order 1234" && row.name === "Asha <Rao>" &&
            row.email === "asha@example.org" && row.recipient === SUPPORT && row.email_status === "accepted" && Boolean(row.emailed_at) && row.status === "open", JSON.stringify(row));
        check("email: To is the chatbot's support address, Reply-To is the visitor", message?.to === SUPPORT && message.replyTo?.address === "asha@example.org" && message.replyTo?.name === "Asha <Rao>", JSON.stringify({ to: message?.to, replyTo: message?.replyTo }));
        // BOT has no display name: its website's domain names it (never its ID); no visitor text in headers.
        check("email: subject and From name from the chatbot's own domain (no visitor text in headers)",
            message?.subject === "New question from 127.0.0.1 chatbot" && message.from?.name === "127.0.0.1 Chatbot" && !message.subject.includes(BOT), JSON.stringify({ subject: message?.subject, from: message?.from }));
        check("email: body has the question, details and website", /delivery address after ordering\?\nIt is urgent\./.test(message?.text || "") && /Order 1234/.test(message.text) && /Website: http:\/\/127\.0\.0\.1:1\/contact-test/.test(message.text), message?.text);
        r = await contact(first);
        check("same request again (double click/retry): same answer, no second email, no second row", r.status === 200 && r.json.message === SENT && r.json.duplicate === true && mail._testOutbox.length === 1 && (await enquiryCount()) === 1, `outbox ${mail._testOutbox.length}`);

        // Two simultaneous submissions of one form: one email.
        mail._setTransportForTests({ sendMail: async m => { await sleep(300); mail._testOutbox.push(m); return {}; } });
        const twin = form(BOT);
        const pair = await Promise.all([contact(twin), contact(twin)]);
        check("two simultaneous submissions of one form: one email, the other told it is being sent (409)",
            pair.map(p => p.status).sort().join(",") === "200,409" && mail._testOutbox.length === 2, pair.map(p => p.status).join(","));
        mail._setTransportForTests(null);

        // Rate limit and failures, from a second address (::1) so the limit starts fresh.
        const BASE6 = `http://[::1]:${port}`;
        let v6 = true;
        try { await fetch(BASE6 + "/api/health"); } catch { v6 = false; }
        check("server reachable over ::1 for the second visitor", v6);
        if (v6) {
            mail._setTransportForTests({ sendMail: async () => { const e = new Error("connect ECONNREFUSED smtp.example:587"); e.code = "ECONNREFUSED"; throw e; } });
            const retry = form(BOT);
            r = await contact(retry, { base: BASE6 });
            check("mail server failure: the enquiry is saved and the visitor told so (not 'sent'), no internals",
                r.status === 200 && r.json.saved === true && r.json.emailed === false && r.json.message === SAVED && !/ECONNREFUSED|smtp/i.test(JSON.stringify(r.json)), JSON.stringify(r.json));
            const failedRow = await storedEnquiry(BOT, retry.requestId);
            check("mail server failure: stored with email_status failed and the error code only", failedRow?.email_status === "failed" && failedRow.email_error === "ECONNREFUSED" && failedRow.question === retry.question, JSON.stringify(failedRow));
            mail._setTransportForTests(null);
            const before = mail._testOutbox.length;
            r = await contact(retry, { base: BASE6 });
            check("after a failure the same form again: the stored result, no duplicate row or email", r.status === 200 && r.json.duplicate === true && r.json.emailed === false && mail._testOutbox.length === before, JSON.stringify(r.json));
            r = await call("POST", `/api/admin/chatbots/${BOT}/enquiries/${failedRow.id}/resend`);
            check("admin: resending the failed notification sends it (email_status accepted)", r.status === 200 && r.json.enquiry.emailStatus === "accepted" && mail._testOutbox.length === before + 1 && mail._testOutbox.at(-1).to === SUPPORT, JSON.stringify(r.json));
            r = await call("POST", `/api/admin/chatbots/${BOT}/enquiries/${failedRow.id}/resend`);
            check("admin: resending an accepted notification is refused (409), nothing sent", r.status === 409 && mail._testOutbox.length === before + 1, JSON.stringify(r.json));

            // No support address: saved with no recipient (none invented), no email.
            const plain = form(NO_EMAIL);
            r = await contact(plain, { base: BASE6 });
            const plainRow = await storedEnquiry(NO_EMAIL, plain.requestId);
            check("no support address: saved, visitor told 'saved', recipient NULL, email_status no-recipient, nothing sent",
                r.status === 200 && r.json.saved === true && r.json.emailed === false && r.json.message === SAVED && plainRow?.recipient === null &&
                plainRow.email_status === "no-recipient" && mail._testOutbox.length === before + 1, JSON.stringify({ response: r.json, row: plainRow }));
            r = await call("POST", `/api/admin/chatbots/${NO_EMAIL}/enquiries/${plainRow.id}/resend`);
            check("admin: resend without a recipient is refused (409), nothing sent", r.status === 409 && mail._testOutbox.length === before + 1, JSON.stringify(r.json));

            // Two chatbots with an enquiry each: no access across them by changing an ID.
            r = await call("GET", `/api/admin/chatbots/${NO_EMAIL}/enquiries?status=`);
            check("isolation: NO_EMAIL's list holds only its own enquiry", r.status === 200 && r.json.enquiries.length === 1 && r.json.enquiries[0].id === plainRow.id, JSON.stringify(r.json?.enquiries?.map(e => e.id)));
            r = await call("GET", `/api/admin/chatbots/${BOT}/enquiries?status=`);
            check("isolation: BOT's list holds its enquiries and never NO_EMAIL's", r.status === 200 && r.json.enquiries.some(e => e.id === failedRow.id) && !r.json.enquiries.some(e => e.id === plainRow.id), JSON.stringify(r.json?.enquiries?.map(e => e.id)));
            r = await call("PATCH", `/api/admin/chatbots/${NO_EMAIL}/enquiries/${failedRow.id}`, { status: "handled" });
            check("ID tampering: PATCH BOT's enquiry through NO_EMAIL -> 404, unchanged", r.status === 404 && (await storedEnquiry(BOT, retry.requestId)).status === "open", JSON.stringify(r.json));
            r = await call("POST", `/api/admin/chatbots/${NO_EMAIL}/enquiries/${failedRow.id}/resend`);
            check("ID tampering: resend BOT's enquiry through NO_EMAIL -> 404", r.status === 404, JSON.stringify(r.json));
            r = await call("PATCH", `/api/admin/chatbots/${BOT}/enquiries/${plainRow.id}`, { status: "handled" });
            check("ID tampering: PATCH NO_EMAIL's enquiry through BOT -> 404, unchanged", r.status === 404 && (await storedEnquiry(NO_EMAIL, plain.requestId)).status === "open", JSON.stringify(r.json));
            r = await call("GET", `/api/admin/chatbots/${BOT}/enquiries/${failedRow.id}`);
            check("no single-enquiry GET route exists (404): enquiries are read only through the chatbot's list", r.status === 404, `HTTP ${r.status}`);

            // Admin authentication.
            r = await call("GET", `/api/admin/chatbots/${BOT}/enquiries`, null, { key: "" });
            check("unauthenticated list -> 401, no visitor data", r.status === 401 && !JSON.stringify(r.json).includes("asha@"), `HTTP ${r.status}`);
            r = await call("PATCH", `/api/admin/chatbots/${BOT}/enquiries/${failedRow.id}`, { status: "handled" }, { key: "" });
            check("unauthenticated PATCH -> 401, unchanged", r.status === 401 && (await storedEnquiry(BOT, retry.requestId)).status === "open", `HTTP ${r.status}`);
            r = await call("POST", `/api/admin/chatbots/${BOT}/enquiries/${failedRow.id}/resend`, null, { key: "" });
            check("unauthenticated resend -> 401", r.status === 401, `HTTP ${r.status}`);

            // Mark handled (and back).
            r = await call("PATCH", `/api/admin/chatbots/${BOT}/enquiries/${failedRow.id}`, { status: "handled" });
            const handled = await storedEnquiry(BOT, retry.requestId);
            check("mark handled: 200, stored as handled with a time", r.status === 200 && r.json.enquiry.status === "handled" && handled.status === "handled" && Boolean(handled.handled_at), JSON.stringify(r.json));
            r = await call("GET", `/api/admin/chatbots/${BOT}/enquiries?status=open`);
            const openIds = r.json?.enquiries?.map(e => e.id) || [];
            r = await call("GET", `/api/admin/chatbots/${BOT}/enquiries?status=handled`);
            check("mark handled: listed under handled, not under open", !openIds.includes(failedRow.id) && r.json.enquiries.some(e => e.id === failedRow.id), JSON.stringify(r.json?.counts));
            for (let i = 0; i < 3; i++) await contact(form(BOT), { base: BASE6 });
            const sentBefore = mail._testOutbox.length;
            r = await contact(form(BOT), { base: BASE6 });
            check("more than 5 messages per hour from one visitor: 429, nothing sent", r.status === 429 && mail._testOutbox.length === sentBefore, `HTTP ${r.status}`);
        }

        // Without SMTP settings the form is still offered: the enquiry is saved (dashboard), no email.
        const saved = { t: process.env.EMAIL_TRANSPORT, h: process.env.SMTP_HOST, f: process.env.SMTP_FROM };
        delete process.env.EMAIL_TRANSPORT; delete process.env.SMTP_HOST; delete process.env.SMTP_FROM;
        r = await call("GET", "/api/admin/chatbots");
        check("no SMTP settings: dashboard told email is not configured", r.json?.emailConfigured === false, `emailConfigured=${r.json?.emailConfigured}`);
        r = await call("GET", `/api/admin/chatbots/${BOT}/enquiries`);
        check("no SMTP settings: the enquiries view names the missing settings (names only)", JSON.stringify(r.json?.missingSmtpSettings) === '["SMTP_HOST","SMTP_FROM"]', JSON.stringify(r.json?.missingSmtpSettings));
        r = await call("POST", "/api/chat", { chatbotId: BOT, question: "Do you sell spare parts for submarines?" }, { key: "" });
        check("no SMTP settings: the fallback still offers the contact form", r.json?.answer === NOT_FOUND && r.json.unanswered === true && r.json.contact === true, JSON.stringify(r.json));
        const outboxBefore = mail._testOutbox.length;
        const offline = form(BOT);
        // From 127.0.0.1 (3 of its 5 per hour used so far); ::1 has reached its limit above.
        r = await contact(offline);
        const offlineRow = await storedEnquiry(BOT, offline.requestId);
        check("no SMTP settings: saved, visitor told 'saved' (never 'sent'), nothing sent",
            r.status === 200 && r.json.saved === true && r.json.emailed === false && r.json.message === SAVED && mail._testOutbox.length === outboxBefore && offlineRow?.email_status === "disabled" && offlineRow.recipient === SUPPORT, JSON.stringify(r.json));
        Object.assign(process.env, { EMAIL_TRANSPORT: saved.t });
        if (saved.h !== undefined) process.env.SMTP_HOST = saved.h;
        if (saved.f !== undefined) process.env.SMTP_FROM = saved.f;
    } catch (e) {
        check("unexpected test error", false, e.stack || e.message);
    } finally {
        for (const id of TEMP_IDS) {
            await pool.query("DELETE FROM chatbots WHERE id = $1 AND website_url = 'http://127.0.0.1:1/contact-test'", [id]);
            await fetch(`${QDRANT}/delete?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "chatbotId", match: { value: id } }] } }) }).catch(() => {});
        }
        const left = Number((await pool.query("SELECT count(*) AS n FROM chatbots WHERE id = ANY($1::uuid[])", [TEMP_IDS])).rows[0].n);
        check("cleanup: temporary chatbot rows removed", left === 0, `left ${left}`);
        console.log = log; console.warn = warn; console.error = error;
        console.table(results);
        const failed = results.filter(x => x.result !== "PASS").length;
        console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
        process.exit(failed ? 1 : 0);
    }
})();
