// POST /api/chat/contact, offline: the real server.js with dbPool.js replaced by an in-memory recorder
// (no PostgreSQL, Qdrant or Ollama) and EMAIL_TRANSPORT=test (nothing is ever sent). Covers field-level
// validation with nothing stored, the email outcomes kept apart (accepted, disabled, no-recipient,
// failed), a failing status update after the save (never 500), a failing save (never a false success),
// duplicates (one row, the same response), the ready check, email normalisation, a truthful visitor
// response in every case, and that no visitor data reaches the logs. Per chatbot: each email goes only to
// that chatbot's current support address with its own name (display name, else domain - never the ID) in
// the subject, sender name and body; Resend uses the chatbot's CURRENT address (409 when it has none);
// unsafe display names are sanitised (checked on the raw message rendered offline by nodemailer).
// Run: npm run test:contact-unit (part of npm test)
"use strict";
const fs = require("fs"), path = require("path"), Module = require("module"), crypto = require("crypto");
const dir = path.resolve(__dirname, "..");
const DB_POOL_FILE = path.join(dir, "dbPool.js");
const SENT = "Thank you. Your question has been sent to the support team. They will reply to your email address.";
const SAVED = "Thank you. Your question has been received and saved for the support team. They can reply to your email address.";

// ---------- in-memory stand-in for the three tables this route uses ----------
const READY = crypto.randomUUID(), NO_SUPPORT = crypto.randomUUID(), PENDING = crypto.randomUUID();
const SUPPORT = "help@shop.example";
const chatbots = new Map([
    [READY, { id: READY, website_url: "https://shop.example/", allowed_domain: "shop.example", status: "ready", support_email: SUPPORT, allowed_origins: null, display_name: "Shop" }],
    [NO_SUPPORT, { id: NO_SUPPORT, website_url: "https://plain.example/", allowed_domain: "plain.example", status: "ready", support_email: null, allowed_origins: null }],
    [PENDING, { id: PENDING, website_url: "https://new.example/", allowed_domain: "new.example", status: "pending", support_email: SUPPORT, allowed_origins: null }]
]);
// Per-chatbot email: a second named chatbot, one without a display name, unsafe and long display names.
const GARDEN = crypto.randomUUID(), NAMELESS = crypto.randomUUID(), UNSAFE = crypto.randomUUID(), LONG = crypto.randomUUID();
const GARDEN_SUPPORT = "garden@other.example";
const LONG_NAME = "Northern Lights Adventure Travel and Outdoor Gear Shop"; // 54 characters
chatbots.set(GARDEN, { id: GARDEN, website_url: "https://garden.example/", allowed_domain: "garden.example", status: "ready", support_email: GARDEN_SUPPORT, allowed_origins: null, display_name: "Garden Centre" });
chatbots.set(NAMELESS, { id: NAMELESS, website_url: "https://www.nameless.example/shop", allowed_domain: "nameless.example", status: "ready", support_email: "desk@nameless.example", allowed_origins: null, display_name: null });
chatbots.set(UNSAFE, { id: UNSAFE, website_url: "https://unsafe.example/", allowed_domain: "unsafe.example", status: "ready", support_email: "help@unsafe.example", allowed_origins: null, display_name: "Ev\"il\r\nBcc: x@evil.example <b>" });
chatbots.set(LONG, { id: LONG, website_url: "https://long.example/", allowed_domain: "long.example", status: "ready", support_email: "help@long.example", allowed_origins: null, display_name: LONG_NAME });
const enquiries = [];
const faults = { insert: false, update: false };
let inserts = 0;
const recorder = {
    async query(sql, params = []) {
        const text = String(sql);
        if (/FROM chatbots\s+WHERE id = \$1/.test(text)) return { rows: chatbots.has(params[0]) ? [chatbots.get(params[0])] : [] };
        if (/to_regclass\('public\.enquiries'\)/.test(text)) return { rows: [{ ready: true }] };
        if (/^\s*INSERT INTO enquiries/.test(text)) {
            inserts++;
            if (faults.insert) throw Object.assign(new Error("simulated database failure"), { code: "57P01" });
            const [id, chatbotId, requestId, name, email, question, details, recipient] = params;
            if (enquiries.some(e => e.chatbot_id === chatbotId && e.request_id === requestId)) return { rows: [] };
            const row = { id, chatbot_id: chatbotId, request_id: requestId, name, email, question, details, recipient, status: "open",
                email_status: "pending", email_error: null, created_at: new Date(), emailed_at: null, handled_at: null };
            enquiries.push(row);
            return { rows: [row] };
        }
        if (/FROM enquiries WHERE chatbot_id = \$1 AND request_id = \$2/.test(text)) {
            return { rows: enquiries.filter(e => e.chatbot_id === params[0] && e.request_id === params[1]) };
        }
        if (/FROM enquiries WHERE id = \$1 AND chatbot_id = \$2/.test(text)) {
            return { rows: enquiries.filter(e => e.id === params[0] && e.chatbot_id === params[1]) };
        }
        if (/^\s*UPDATE enquiries SET recipient = \$3 WHERE id = \$1 AND chatbot_id = \$2/.test(text)) {
            const row = enquiries.find(e => e.id === params[0] && e.chatbot_id === params[1]);
            if (row) row.recipient = params[2];
            return { rows: row ? [row] : [] };
        }
        if (/^\s*UPDATE enquiries SET email_status/.test(text)) {
            if (faults.update) throw Object.assign(new Error("simulated database failure"), { code: "57P01" });
            const row = enquiries.find(e => e.id === params[0]);
            if (row) Object.assign(row, { email_status: params[1], email_error: params[2], ...(params[1] === "accepted" ? { emailed_at: new Date() } : {}) });
            return { rows: row ? [row] : [] };
        }
        return { rows: [], rowCount: 0 };
    },
    on() {},
    end: async () => {},
    connect: async () => { throw new Error("no transactions in this test"); }
};
const load = Module._load;
Module._load = function (request, parent, isMain) {
    let resolved = null;
    try { resolved = Module._resolveFilename(request, parent, isMain); } catch { /* normal loader */ }
    return resolved === DB_POOL_FILE ? recorder : load.apply(this, arguments);
};

process.env.ADMIN_API_KEY = crypto.randomBytes(32).toString("hex");
process.env.ADMIN_API_KEYS = "";
process.env.STARTUP_RECOVERY = "off";
process.env.EMAIL_TRANSPORT = "test";
process.env.TRUST_PROXY = "1"; // each scenario uses its own X-Forwarded-For address (own rate-limit budget)
process.env.PORT = "0";
for (const name of ["DATABASE_URL", "SMTP_HOST", "SMTP_FROM", "SMTP_USER", "SMTP_PASS"]) delete process.env[name];

// Everything logged while requests run (checked for visitor data at the end).
const logged = [];
const capture = (...args) => logged.push(args.map(String).join(" "));
const original = { log: console.log, error: console.error, warn: console.warn };
console.log = capture; console.error = capture; console.warn = capture;
const serverFile = path.join(dir, "server.js");
const m = new Module(serverFile);
m.filename = serverFile;
m.paths = Module._nodeModulePaths(dir);
m._compile(fs.readFileSync(serverFile, "utf8") + "\nmodule.exports.__app = app;", serverFile);
const app = m.exports.__app;
const mail = require(path.join(dir, "supportMail"));

const results = [];
function check(name, ok, detail = "") {
    results.push({ check: name, result: ok ? "PASS" : "FAIL", detail: ok ? "" : String(detail).slice(0, 140) });
}

(async () => {
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    let ip = 0;
    const contact = async (body, { visitor, raw } = {}) => {
        const r = await fetch(`${base}/api/chat/contact`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-Forwarded-For": visitor || `203.0.113.${++ip}` },
            body: raw !== undefined ? raw : JSON.stringify(body)
        });
        let json = null;
        try { json = await r.json(); } catch {}
        return { status: r.status, json };
    };
    const form = (chatbotId, extra = {}) => ({ chatbotId, name: "Riya Sen", email: "riya.sen@example.org", question: "What are your exact subscription fees?\nFor 30 users.",
        details: "Class of 30", requestId: crypto.randomUUID(), ...extra });
    const rowOf = requestId => enquiries.find(e => e.request_id === requestId);
    const truthful = (r, emailed) => r.status === 200 && r.json.success === true && r.json.saved === true && r.json.emailed === emailed && r.json.message === (emailed ? SENT : SAVED);

    try {
        // ================= Validation: 400 + field, nothing stored =================
        const invalid = [
            ["chatbotId missing", form("nope"), "chatbotId"],
            ["requestId missing", form(READY, { requestId: undefined }), "requestId"],
            ["requestId malformed", form(READY, { requestId: "x" }), "requestId"],
            ["name missing", form(READY, { name: "   " }), "name"],
            ["name with a line break", form(READY, { name: "Riya\r\nBcc: x@evil.example" }), "name"],
            ["name too long (101)", form(READY, { name: "a".repeat(101) }), "name"],
            ["email missing", form(READY, { email: "" }), "email"],
            ["email invalid", form(READY, { email: "riya" }), "email"],
            ["email with a line break", form(READY, { email: "riya@example.org\r\nBcc: x@evil.example" }), "email"],
            ["email list", form(READY, { email: "a@example.org, b@example.org" }), "email"],
            ["email too long (255)", form(READY, { email: `${"a".repeat(243)}@example.org` }), "email"],
            ["question empty", form(READY, { question: "  " }), "question"],
            ["question too long (1001)", form(READY, { question: "q".repeat(1001) }), "question"],
            ["details too long (2001)", form(READY, { details: "d".repeat(2001) }), "details"]
        ];
        for (const [label, body, field] of invalid) {
            const r = await contact(body, { visitor: "198.51.100.1" });
            check(`validation: ${label} -> 400, field "${field}"`, r.status === 400 && r.json?.success === false && r.json.field === field && typeof r.json.error === "string", JSON.stringify(r.json));
        }
        let r = await contact(null, { visitor: "198.51.100.1", raw: JSON.stringify(form(READY, { details: "d".repeat(40000) })) });
        check("oversized request body (over 32 KB) -> 413", r.status === 413, `HTTP ${r.status}`);
        check("validation: nothing stored and no email for any invalid request", inserts === 0 && enquiries.length === 0 && mail._testOutbox.length === 0, `inserts ${inserts}`);

        // ================= Chatbot identified and checked on the server =================
        r = await contact(form(crypto.randomUUID()));
        check("unknown chatbot -> 404, nothing stored", r.status === 404 && inserts === 0, JSON.stringify(r.json));
        r = await contact(form(PENDING));
        check("chatbot not ready -> 409, nothing stored", r.status === 409 && inserts === 0, JSON.stringify(r.json));

        // ================= accepted =================
        const accepted = form(READY, { email: "  Riya.Sen@Example.ORG " });
        r = await contact(accepted, { visitor: "192.0.2.10" });
        const acceptedRow = rowOf(accepted.requestId);
        check("accepted: visitor told 'sent to the support team' (saved + emailed)", truthful(r, true), JSON.stringify(r.json));
        check("accepted: stored under that chatbot, email_status accepted, recipient = its support address",
            acceptedRow?.chatbot_id === READY && acceptedRow.email_status === "accepted" && acceptedRow.recipient === SUPPORT && Boolean(acceptedRow.emailed_at), JSON.stringify(acceptedRow));
        check("accepted: original question stored exactly", acceptedRow?.question === "What are your exact subscription fees?\nFor 30 users.", JSON.stringify(acceptedRow?.question));
        check("email normalised: trimmed, only the domain lower-cased", acceptedRow?.email === "Riya.Sen@example.org", acceptedRow?.email);
        check("accepted: exactly one fake email, to the support address, Reply-To the visitor",
            mail._testOutbox.length === 1 && mail._testOutbox[0].to === SUPPORT && mail._testOutbox[0].replyTo?.address === "Riya.Sen@example.org", JSON.stringify(mail._testOutbox.map(x => x.to)));

        // ================= duplicate requestId =================
        const again1 = await contact(accepted, { visitor: "192.0.2.10" });
        const again2 = await contact(accepted, { visitor: "192.0.2.10" });
        check("duplicate: one row, no second email", enquiries.filter(e => e.request_id === accepted.requestId).length === 1 && mail._testOutbox.length === 1);
        check("duplicate: the same response every time (marked duplicate)", truthful(again1, true) && again1.json.duplicate === true &&
            JSON.stringify(again1.json) === JSON.stringify(again2.json), JSON.stringify([again1.json, again2.json]));

        // ================= no-recipient (no support email on the chatbot) =================
        const noRecipient = form(NO_SUPPORT);
        r = await contact(noRecipient);
        const noRecipientRow = rowOf(noRecipient.requestId);
        check("no-recipient: saved, visitor told 'saved' (not emailed)", truthful(r, false), JSON.stringify(r.json));
        check("no-recipient: recipient NULL (none invented), email_status no-recipient", noRecipientRow?.recipient === null && noRecipientRow.email_status === "no-recipient", JSON.stringify(noRecipientRow));
        check("no-recipient: no email attempted", mail._testOutbox.length === 1);

        // ================= disabled (no email settings on the server) =================
        delete process.env.EMAIL_TRANSPORT;
        const disabled = form(READY);
        r = await contact(disabled);
        process.env.EMAIL_TRANSPORT = "test";
        check("disabled: saved, visitor told 'saved' (not emailed)", truthful(r, false), JSON.stringify(r.json));
        check("disabled: email_status disabled, recipient kept, nothing sent", rowOf(disabled.requestId)?.email_status === "disabled" && rowOf(disabled.requestId).recipient === SUPPORT && mail._testOutbox.length === 1, JSON.stringify(rowOf(disabled.requestId)));

        // ================= failed (fake transport refuses) =================
        mail._setTransportForTests({ sendMail: async () => { throw Object.assign(new Error("connect ECONNREFUSED smtp.example:587 user=admin password=hunter2"), { code: "ECONNREFUSED" }); } });
        const failed = form(READY);
        r = await contact(failed);
        check("failed: saved, visitor told 'saved' (never 'sent'), no internals", truthful(r, false) && !/ECONNREFUSED|smtp|hunter2/i.test(JSON.stringify(r.json)), JSON.stringify(r.json));
        check("failed: email_status failed with the error code only", rowOf(failed.requestId)?.email_status === "failed" && rowOf(failed.requestId).email_error === "ECONNREFUSED", JSON.stringify(rowOf(failed.requestId)));
        mail._setTransportForTests({ sendMail: async () => { throw new Error("535 auth failed for password=hunter2"); } });
        const failedNoCode = form(READY);
        await contact(failedNoCode);
        check("failed without an error code: stored as SEND_FAILED (no server text, no secrets)", rowOf(failedNoCode.requestId)?.email_error === "SEND_FAILED", JSON.stringify(rowOf(failedNoCode.requestId)));
        mail._setTransportForTests(null);

        // ================= recording the outcome fails AFTER the save: never 500 =================
        faults.update = true;
        const unrecordedAccepted = form(READY);
        r = await contact(unrecordedAccepted);
        check("status update fails after an accepted email: 200, truthful 'sent' (it was accepted)", truthful(r, true), JSON.stringify(r.json));
        delete process.env.EMAIL_TRANSPORT;
        const unrecordedDisabled = form(READY);
        r = await contact(unrecordedDisabled);
        process.env.EMAIL_TRANSPORT = "test";
        check("status update fails with email disabled: 200, truthful 'saved' (not 500)", truthful(r, false), JSON.stringify(r.json));
        faults.update = false;
        check("the enquiries stay saved when their status could not be recorded", Boolean(rowOf(unrecordedAccepted.requestId)) && Boolean(rowOf(unrecordedDisabled.requestId)));

        // ================= the save itself fails: an error, never a false success =================
        faults.insert = true;
        const notSaved = form(READY);
        const outboxBefore = mail._testOutbox.length;
        r = await contact(notSaved);
        faults.insert = false;
        check("save fails -> 503 error, no success, no email", r.status === 503 && r.json?.success === false && !r.json.saved && mail._testOutbox.length === outboxBefore && !rowOf(notSaved.requestId), JSON.stringify(r.json));

        // ================= per chatbot: own address, own name, never another chatbot's =================
        const sentFor = async chatbotId => {
            const before = mail._testOutbox.length;
            const body = form(chatbotId);
            const res = await contact(body);
            return { res, row: rowOf(body.requestId), message: mail._testOutbox.length === before + 1 ? mail._testOutbox.at(-1) : null };
        };
        const resend = async (chatbotId, enquiryId) => {
            const res = await fetch(`${base}/api/admin/chatbots/${chatbotId}/enquiries/${enquiryId}/resend`, {
                method: "POST", headers: { "x-admin-api-key": process.env.ADMIN_API_KEY, "X-Forwarded-For": `203.0.113.${++ip}` }
            });
            let json = null;
            try { json = await res.json(); } catch {}
            return { status: res.status, json };
        };
        const summary = sent => JSON.stringify(sent.message ? { to: sent.message.to, from: sent.message.from, subject: sent.message.subject, intro: sent.message.text.split("\n")[0] } : { status: sent.res?.status, row: sent.row });
        const ownEmail = (sent, address, label, others) => Boolean(sent.message) && sent.message.to === address && sent.row?.recipient === address &&
            sent.message.subject === `New question from ${label} chatbot` && sent.message.from?.name === `${label} Chatbot` &&
            sent.message.text.split("\n")[0].startsWith(`A visitor on ${label} (`) && others.every(other => !JSON.stringify(sent.message).includes(other));
        const shop = await sentFor(READY), garden = await sentFor(GARDEN);
        check("two chatbots: Shop's email only to Shop's address, 'Shop' in subject, From name and body, nothing of Garden",
            ownEmail(shop, SUPPORT, "Shop", ["Garden", GARDEN_SUPPORT]), summary(shop));
        check("two chatbots: Garden's email only to Garden's address, 'Garden Centre' in subject, From name and body, nothing of Shop",
            ownEmail(garden, GARDEN_SUPPORT, "Garden Centre", ["Shop", SUPPORT]), summary(garden));
        check("shared sender: both emails come from the same SMTP account address", shop.message?.from?.address === "chatbot@localhost" && garden.message?.from?.address === "chatbot@localhost", summary(garden));

        const nameless = await sentFor(NAMELESS);
        check("no display name: the domain (without www) names the chatbot in subject, From name and body",
            ownEmail(nameless, "desk@nameless.example", "nameless.example", []) && nameless.message.text.includes("(https://www.nameless.example/shop)"), summary(nameless));
        check("no display name: the chatbot ID is not in the subject, From name or intro (only a reference line)",
            !nameless.message?.subject.includes(NAMELESS) && !nameless.message?.from?.name.includes(NAMELESS) && !nameless.message?.text.split("\n")[0].includes(NAMELESS) &&
            nameless.message?.text.includes(`Chatbot ID (reference): ${NAMELESS}`), summary(nameless));

        // Support email changed: the next enquiry goes to the new address (earlier ones keep theirs).
        chatbots.get(GARDEN).support_email = "desk@garden.example";
        const gardenAfterChange = await sentFor(GARDEN);
        check("support email changed: the next enquiry goes to the new address", ownEmail(gardenAfterChange, "desk@garden.example", "Garden Centre", [GARDEN_SUPPORT]), summary(gardenAfterChange));
        check("support email changed: the earlier enquiry still records the address it was sent to", garden.row?.recipient === GARDEN_SUPPORT, JSON.stringify(garden.row?.recipient));

        // A wrong address (the send fails), then corrected: Resend goes to the corrected address.
        chatbots.get(GARDEN).support_email = "typo@garden.exmaple";
        mail._setTransportForTests({ sendMail: async () => { throw Object.assign(new Error("550 no such user"), { code: "EENVELOPE" }); } });
        const typo = await sentFor(GARDEN);
        mail._setTransportForTests(null);
        chatbots.get(GARDEN).support_email = "desk@garden.example";
        let outboxBeforeResend = mail._testOutbox.length;
        r = await resend(GARDEN, typo.row?.id);
        const resent = mail._testOutbox.at(-1);
        check("resend after the address was fixed: sent once, to the NEW address, with Garden's name",
            typo.row?.email_status === "accepted" && r.status === 200 && mail._testOutbox.length === outboxBeforeResend + 1 && resent?.to === "desk@garden.example" &&
            resent.subject === "New question from Garden Centre chatbot" && resent.from?.name === "Garden Centre Chatbot", JSON.stringify({ status: r.status, json: r.json, to: resent?.to }));
        check("resend after the address was fixed: the enquiry's recipient is updated (API and stored)",
            typo.row?.recipient === "desk@garden.example" && r.json?.enquiry?.recipient === "desk@garden.example", JSON.stringify(typo.row));

        // No support email NOW: 409 and nothing sent - never silently to the old address.
        mail._setTransportForTests({ sendMail: async () => { throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }); } });
        const failedBeforeRemoval = await sentFor(GARDEN);
        mail._setTransportForTests(null);
        chatbots.get(GARDEN).support_email = null;
        outboxBeforeResend = mail._testOutbox.length;
        r = await resend(GARDEN, failedBeforeRemoval.row?.id);
        check("resend when the chatbot has no support email now: 409 with a clear message, nothing sent",
            r.status === 409 && /No support email is set/.test(r.json?.error || "") && mail._testOutbox.length === outboxBeforeResend, JSON.stringify(r.json));
        check("resend refused: the old address is not used and the enquiry is unchanged",
            failedBeforeRemoval.row?.recipient === "desk@garden.example" && failedBeforeRemoval.row.email_status === "failed", JSON.stringify(failedBeforeRemoval.row));
        r = await resend(NO_SUPPORT, noRecipientRow?.id);
        check("resend of a no-recipient enquiry while still no support email: 409, nothing sent", r.status === 409 && mail._testOutbox.length === outboxBeforeResend, JSON.stringify(r.json));
        chatbots.get(NO_SUPPORT).support_email = "new@plain.example";
        r = await resend(NO_SUPPORT, noRecipientRow?.id);
        check("resend of a no-recipient enquiry after a support email is set: sent to it, recipient recorded",
            r.status === 200 && mail._testOutbox.at(-1)?.to === "new@plain.example" && noRecipientRow.recipient === "new@plain.example" && noRecipientRow.email_status === "accepted", JSON.stringify(r.json));
        chatbots.get(NO_SUPPORT).support_email = null;

        // Unsafe display name + SMTP_FROM written with its own display name: header-safe, address part only.
        const render = message => require("nodemailer").createTransport({ streamTransport: true, buffer: true, newline: "unix" }).sendMail(message)
            .then(info => info.message.toString("utf8").split("\n\n")[0].replace(/\n[ \t]+/g, " ").split("\n"));
        process.env.SMTP_FROM = "\"Old Sender Name\" <bot@mailer.example>";
        const unsafe = await sentFor(UNSAFE);
        delete process.env.SMTP_FROM;
        const unsafeLabel = "Ev il Bcc: x@evil.example b";
        check("unsafe display name: no line breaks, quotes or <> in the subject or From name",
            unsafe.message?.subject === `New question from ${unsafeLabel} chatbot` && unsafe.message.from?.name === `${unsafeLabel} Chatbot` &&
            !/[\r\n"<>]/.test(unsafe.message.subject + unsafe.message.from.name), summary(unsafe));
        check("SMTP_FROM with its own display name: only its address is used, with the chatbot's name",
            unsafe.message?.from?.address === "bot@mailer.example" && !JSON.stringify(unsafe.message.from).includes("Old Sender Name"), JSON.stringify(unsafe.message?.from));
        const headers = unsafe.message ? await render(unsafe.message) : [];
        const named = name => headers.filter(line => line.toLowerCase().startsWith(name.toLowerCase() + ":"));
        check("raw message: exactly one From, To, Subject and Reply-To header, no Bcc or Cc header (no injection)",
            named("From").length === 1 && named("To").length === 1 && named("Subject").length === 1 && named("Reply-To").length === 1 && !named("Bcc").length && !named("Cc").length &&
            named("To")[0] === "To: help@unsafe.example" && named("From")[0].endsWith("<bot@mailer.example>"), JSON.stringify(headers));
        process.env.SMTP_FROM = "noreply@mailer.example";
        const long = await sentFor(LONG);
        delete process.env.SMTP_FROM;
        check("long display name: From name at most 60 characters and ends with ' Chatbot'; plain SMTP_FROM used as is",
            long.message?.from?.name.length <= 60 && long.message.from.name.endsWith(" Chatbot") && long.message.from.address === "noreply@mailer.example" &&
            long.message.subject.startsWith("New question from Northern Lights"), summary(long));

        // ================= logs never contain visitor data =================
        const allLogs = logged.join("\n");
        check("logs contain no visitor name, email, question or details", !/Riya|riya|subscription fees|Class of 30|hunter2/.test(allLogs), allLogs.slice(0, 200));
    } catch (failure) {
        check("test run finished without an unexpected error", false, failure.stack || failure.message);
    } finally {
        server.close();
        console.log = original.log; console.error = original.error; console.warn = original.warn;
        console.table(results);
        const failedCount = results.filter(x => x.result !== "PASS").length;
        console.log(failedCount ? `${failedCount} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
        process.exit(failedCount ? 1 : 0);
    }
})();
