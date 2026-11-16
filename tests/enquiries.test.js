// The unanswered-question contact form, end to end, on a synthetic website ("BrightPath Learning",
// which publishes no prices): a supported question is answered with its source and no form; an
// unsupported website question and an unrelated question get the exact fallback, the structured
// unanswered flag and the form (also from the answer cache); a chatbot without a support address
// gets no form; the real widget on a separate "customer" page shows the form automatically with the
// original question, validates, submits once, and shows the server's truthful result; the full-page
// chat (widget.html) shows it too; the enquiry is stored for that chatbot only and listed in the
// dashboard's Enquiries tab (admin key), where it can be marked handled; a fake email went to that
// chatbot's own support address; deleting the chatbot removes its enquiries. Per chatbot: each email
// carries only its own chatbot's address and name (display name, else domain); a changed support email
// applies to the next enquiry; Resend uses the CURRENT address and records it (409 when there is none).
// ISOLATED: runs only through tests/run-isolated.js (separate test database and collection, temporary
// upload folder, EMAIL_TRANSPORT=test - nothing is ever sent). The real server.js runs IN THIS PROCESS
// on a free port (never 3000-3005 or 5050). Needs PostgreSQL, Qdrant, Ollama. ~2-4 min.
// Run: npm run test:enquiries
"use strict";
const fs = require("fs"), path = require("path"), http = require("http"), net = require("net"), crypto = require("crypto"), Module = require("module");
const { assertIsolated } = require("./support/isolated-env");

const projectDir = path.join(__dirname, "..");
const RESERVED_PORTS = new Set([3000, 3001, 3002, 3003, 3004, 3005, 5050]);
const NOT_FOUND = "I could not find this information on the website.";
const QDRANT = `http://localhost:6333/collections/${process.env.QDRANT_COLLECTION}/points`;
const KNOWN_QUESTION = "How many weekly lessons does each course have?";
const PRICING_QUESTION = "What are BrightPath's exact pricing plans and subscription fees?";
const UNRELATED_QUESTION = "What is the capital of France?";

const results = [];
function check(name, ok, note = "") {
    results.push({ test: name, result: ok ? "PASS" : "FAIL" });
    process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${note && !ok ? `\n     ${String(note).replace(/\s+/g, " ").slice(0, 400)}` : ""}\n`);
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// SKIP_BROWSER=1: no real browser; those parts are listed as SKIPPED (not counted as passed).
const SKIP_BROWSER = process.env.SKIP_BROWSER === "1";
const skipped = [];
function skip(name) {
    skipped.push(name);
    process.stdout.write(`SKIP ${name}\n`);
}

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

const PAGES = {
    "/": { title: "BrightPath Learning", body: "<p>BrightPath Learning runs online maths courses for secondary school students.</p>" },
    "/courses": { title: "BrightPath courses", body: "<h2>Our courses</h2><p>We offer three courses: Algebra Basics, Geometry Explorer and Exam Preparation. Each course has 12 weekly lessons.</p>" },
    "/contact": { title: "Contact BrightPath", body: "<h2>Office hours</h2><p>Our office is open Monday to Friday from 9:00 to 17:00.</p>" }
};
function startSite() {
    const server = http.createServer((req, res) => {
        if (req.url === "/robots.txt") { res.setHeader("Content-Type", "text/plain"); return res.end("User-agent: *\nAllow: /\n"); }
        const page = PAGES[req.url.replace(/\/$/, "") || "/"];
        if (!page) { res.writeHead(404); return res.end(); }
        const links = Object.keys(PAGES).map(href => `<a href="${href}">${PAGES[href].title}</a>`).join(" ");
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html><html><head><title>${page.title}</title></head><body><nav>${links}</nav><main><h1>${page.title}</h1>${page.body}</main></body></html>`);
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}
// A separate "customer website" origin that embeds the widget from the chatbot server.
function startCustomerPage(base, chatbotId) {
    const server = http.createServer((req, res) => {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Customer page</title></head>
<body><h1>BrightPath</h1><script src="${base}/widget.js" data-chatbot-id="${chatbotId}" data-api="${base}"></script></body></html>`);
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

(async () => {
    const site = await startSite();
    const SITE = `http://127.0.0.1:${site.address().port}`;
    const KEY = crypto.randomBytes(32).toString("hex");
    process.env.ADMIN_API_KEY = KEY;
    process.env.ADMIN_API_KEYS = "";
    const port = await freePort();
    process.env.PORT = String(port);

    const pool = require(path.join(projectDir, "dbPool"));
    const isolation = await assertIsolated(pool); // throws (nothing written) unless isolated
    console.log(`isolated environment: database ${isolation.database}, collection ${isolation.collection}`);
    const { ingestWebsite } = loadPatched("ingest.js", src => src.replace("async function assertPublicHttpUrl(rawUrl) {",
        match => `${match}\n    try { if (new URL(String(rawUrl)).origin === ${JSON.stringify(SITE)}) return new URL(String(rawUrl)); } catch {}`));
    const { recordIndexingResult } = require(path.join(projectDir, "chatbotRegistry"));
    const mail = require(path.join(projectDir, "supportMail"));
    const log = console.log, warn = console.warn, error = console.error;
    console.log = () => {}; console.warn = () => {}; console.error = () => {};
    // The API-only contact calls of the per-chatbot email checks send their own X-Forwarded-For (their own
    // rate-limit budget); the browser sends none, so its requests are counted by their real address.
    process.env.TRUST_PROXY = "1";
    require(path.join(projectDir, "server.js"));
    const BASE = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
        try { if ((await fetch(BASE + "/api/health")).ok) break; } catch {}
        await sleep(100);
    }
    console.log = log;

    // A: support address set; B: same website content, other support address; C: no support address.
    const A = crypto.randomUUID(), B = crypto.randomUUID(), C = crypto.randomUUID();
    const TEMP_IDS = [A, B, C];
    const SUPPORT_A = "help@brightpath.example", SUPPORT_B = "office@other.example";
    const call = async (method, route, body, { key = KEY } = {}) => {
        const headers = {};
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (key) headers["x-admin-api-key"] = key;
        const r = await fetch(BASE + route, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch {}
        return { status: r.status, json, text };
    };
    const chat = async (bot, question) => (await call("POST", "/api/chat", { chatbotId: bot, question }, { key: "" })).json || {};
    const enquiriesOf = async bot => (await pool.query("SELECT * FROM enquiries WHERE chatbot_id = $1 ORDER BY created_at", [bot])).rows;
    let browser = null, customer = null, customerC = null;
    let doneTextA = null, doneTextC = null;

    try {
        // ================= Setup: one synthetic website indexed for A, B and C =================
        await pool.query(
            "INSERT INTO chatbots (id, website_url, allowed_domain, status) VALUES ($1, $4, '127.0.0.1', 'indexing'), ($2, $4, '127.0.0.1', 'indexing'), ($3, $4, '127.0.0.1', 'indexing')",
            [A, B, C, `${SITE}/`]);
        console.log = () => {};
        for (const id of TEMP_IDS) {
            await recordIndexingResult(id, await ingestWebsite(`${SITE}/`, id, { maxPages: 5 }));
            await pool.query("UPDATE chatbots SET status = 'ready' WHERE id = $1", [id]);
        }
        console.log = log;
        let r = await call("PATCH", `/api/admin/chatbots/${A}`, { supportEmail: SUPPORT_A, displayName: "BrightPath A" });
        check("setup: A's support address saved through the Customise setting", r.status === 200 && r.json.chatbot.settings.supportEmail === SUPPORT_A, r.text);
        await call("PATCH", `/api/admin/chatbots/${B}`, { supportEmail: SUPPORT_B, displayName: "BrightPath B" });
        await call("PATCH", `/api/admin/chatbots/${C}`, { displayName: "BrightPath C" });

        // ================= Unknown-answer detection =================
        const known = await chat(A, KNOWN_QUESTION);
        check("known answer: answered with the course page as source", known.answer !== NOT_FOUND && /12/.test(known.answer || "") && (known.sources || []).some(s => /\/courses/.test(s.url || "")), JSON.stringify(known).slice(0, 300));
        check("known answer: no contact form and no unanswered flag", known.contact === undefined && known.unanswered === undefined, JSON.stringify(known).slice(0, 200));
        const pricing = await chat(A, PRICING_QUESTION);
        check("unsupported website question: exact fallback, no sources", pricing.answer === NOT_FOUND && (pricing.sources || []).length === 0, JSON.stringify(pricing));
        check("unsupported website question: unanswered flag + contact form offered", pricing.unanswered === true && pricing.contact === true, JSON.stringify(pricing));
        const unrelated = await chat(A, UNRELATED_QUESTION);
        check("unrelated question: no invented answer (fallback), form offered", unrelated.answer === NOT_FOUND && unrelated.unanswered === true && unrelated.contact === true, JSON.stringify(unrelated));
        const cached = await chat(A, PRICING_QUESTION);
        check("cached unanswered answer still carries the flag and the form", cached.answer === NOT_FOUND && cached.unanswered === true && cached.contact === true, JSON.stringify(cached));
        const noEmail = await chat(C, PRICING_QUESTION);
        check("no support address: fallback flagged unanswered, and the form is still offered", noEmail.answer === NOT_FOUND && noEmail.unanswered === true && noEmail.contact === true, JSON.stringify(noEmail));
        r = await call("GET", `/api/admin/chatbots/${C}/enquiries`);
        check("no support address: the admin view says so (empty supportEmail)", r.status === 200 && r.json.supportEmail === "" && r.json.storageReady === true, r.text);

        // ================= Widget on a customer website (real browser) =================
        if (!SKIP_BROWSER) {
        customer = await startCustomerPage(BASE, A);
        const { chromium } = require("playwright");
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 375, height: 760 } }); // phone size (375 px)
        await page.goto(`http://127.0.0.1:${customer.address().port}/`);
        await page.click(".launcher");
        const ask = async question => {
            const before = await page.locator(".msgs .row").count();
            await page.fill(".composer textarea", question);
            await page.click(".composer .send");
            await page.waitForFunction(n => {
                const root = document.querySelector("body > div")?.shadowRoot || [...document.querySelectorAll("*")].find(e => e.shadowRoot)?.shadowRoot;
                return root && root.querySelectorAll(".msgs .row").length >= n + 2 && !root.querySelector(".typing") && !root.querySelector(".composer .send").disabled;
            }, before, { timeout: 240000 });
        };
        await ask(KNOWN_QUESTION);
        check("widget: a known answer shows no form", (await page.locator(".contact-form").count()) === 0);
        await ask(PRICING_QUESTION);
        check("widget: the form appears automatically after the unanswered question", (await page.locator(".contact-form").count()) === 1);
        check("widget: the form says who the question goes to", /^Ask the .+ team instead$/.test(await page.locator(".contact-intro").textContent()), await page.locator(".contact-intro").textContent());
        check("widget: the original question is shown exactly", (await page.locator(".contact-question").textContent()) === PRICING_QUESTION);
        check("widget: name, email, optional details and the Send question button",
            (await page.locator(".contact-form input[name=name]").count()) === 1 && (await page.locator(".contact-form input[name=email][type=email]").count()) === 1 &&
            (await page.locator(".contact-form textarea[name=additional]").count()) === 1 && (await page.locator(".contact-send").textContent()) === "Send question");
        // (e) At 375 px: the form and every control lie inside the screen, nothing scrolls sideways.
        const layout = await page.locator(".contact-form").evaluate(form => {
            const rect = el => el.getBoundingClientRect();
            const controls = [...form.querySelectorAll("input, textarea, button, .contact-question")].map(rect);
            return { width: rect(form).width, left: rect(form).left, right: rect(form).right,
                controlsInside: controls.every(r => r.left >= 0 && r.right <= window.innerWidth), viewport: window.innerWidth,
                pageScrollWidth: document.documentElement.scrollWidth };
        });
        check("widget (e): at 375 px the form and all its fields/buttons fit the screen, no sideways scrolling",
            layout.viewport === 375 && layout.width > 200 && layout.left >= 0 && layout.right <= 375 && layout.controlsInside && layout.pageScrollWidth <= 375, JSON.stringify(layout));

        await page.click(".contact-send");
        check("widget: empty submission shows field errors, nothing sent",
            (await page.locator(".contact-form input[name=name][aria-invalid=true]").count()) === 1 && (await page.locator(".contact-form input[name=email][aria-invalid=true]").count()) === 1 &&
            (await enquiriesOf(A)).length === 0 && mail._testOutbox.length === 0);
        await page.fill(".contact-form input[name=name]", "Riya Sen");
        await page.fill(".contact-form input[name=email]", "riya@example");
        await page.click(".contact-send");
        check("widget: an invalid email address is refused before sending", /valid email address/.test(await page.locator(".contact-form [id$=email-error]").textContent()) && (await enquiriesOf(A)).length === 0);
        // "Not now" folds the form; reopening keeps what was typed and the question.
        await page.click(".contact-cancel");
        await page.click(".contact-open");
        check("widget: 'Not now' then reopen keeps the typed name and the question",
            (await page.locator(".contact-form input[name=name]").inputValue()) === "Riya Sen" && (await page.locator(".contact-question").textContent()) === PRICING_QUESTION);
        // (b) An address the browser check accepts but the server refuses (underscore in the domain):
        // the server's 400 names the field, the message appears next to it, and nothing typed is lost.
        await page.fill(".contact-form input[name=email]", "riya@exa_mple.org");
        await page.fill(".contact-form textarea[name=additional]", "For a class of 30 students.");
        const [serverReply] = await Promise.all([
            page.waitForResponse(response => response.url().endsWith("/api/chat/contact")),
            page.click(".contact-send")
        ]);
        const serverJson = await serverReply.json().catch(() => ({}));
        await page.waitForSelector(".contact-send:not([disabled])");
        const emailError = (await page.locator(".contact-form [id$=email-error]").textContent()).trim();
        check("widget (b): the server's field error is shown next to the email field",
            serverReply.status() === 400 && serverJson.field === "email" && emailError === serverJson.error &&
            (await page.locator(".contact-form input[name=email][aria-invalid=true]").count()) === 1, JSON.stringify({ status: serverReply.status(), serverJson, emailError }));
        check("widget (b): after the server error the typed values are kept and nothing is stored",
            (await page.locator(".contact-form input[name=name]").inputValue()) === "Riya Sen" &&
            (await page.locator(".contact-form input[name=email]").inputValue()) === "riya@exa_mple.org" &&
            (await page.locator(".contact-form textarea[name=additional]").inputValue()) === "For a class of 30 students." &&
            (await page.locator(".contact-question").textContent()) === PRICING_QUESTION && (await enquiriesOf(A)).length === 0);
        await page.fill(".contact-form input[name=email]", "riya@example.org");
        // A double click must not submit twice.
        await page.locator(".contact-send").dblclick();
        await page.waitForSelector(".contact-done", { timeout: 30000 });
        doneTextA = await page.locator(".contact-done").textContent();
        check("widget: success message is the server's truthful result (sent to the support team)", /sent to the support team/.test(doneTextA), doneTextA);

        } else {
            skip("widget journey on a customer page (real browser)");
            // The same submission the widget makes, through the public API.
            r = await call("POST", "/api/chat/contact", { chatbotId: A, name: "Riya Sen", email: "riya@example.org", question: PRICING_QUESTION,
                details: "For a class of 30 students.", requestId: crypto.randomUUID() }, { key: "" });
            check("API submission: saved and sent to the support team (fake transport)", r.status === 200 && r.json.saved === true && r.json.emailed === true, r.text);
        }
        // ================= Stored enquiry and email notification =================
        const stored = await enquiriesOf(A);
        check("stored: exactly one enquiry for A (double click did not duplicate it)", stored.length === 1, `${stored.length} rows`);
        const e = stored[0] || {};
        check("stored: original question, name, email, details, recipient = A's support address",
            e.question === PRICING_QUESTION && e.name === "Riya Sen" && e.email === "riya@example.org" && e.details === "For a class of 30 students." && e.recipient === SUPPORT_A, JSON.stringify(e));
        check("stored: email_status accepted, status open, timestamps", e.email_status === "accepted" && e.status === "open" && Boolean(e.created_at) && Boolean(e.emailed_at), JSON.stringify(e));
        if (!SKIP_BROWSER) {
            check("widget (c): the 'sent to the support team' message matches the stored email_status accepted", /sent to the support team/.test(doneTextA) && e.email_status === "accepted", JSON.stringify({ doneTextA, status: e.email_status }));
        }
        const email = mail._testOutbox.at(-1) || {};
        check("fake email: one message, To = A's support address (not B's), Reply-To = visitor", mail._testOutbox.length === 1 && email.to === SUPPORT_A && email.replyTo?.address === "riya@example.org", JSON.stringify({ to: email.to, replyTo: email.replyTo, n: mail._testOutbox.length }));
        check("fake email: contains the original question and the website", (email.text || "").includes(PRICING_QUESTION) && (email.text || "").includes(SITE), email.text);
        check("fake email: A's own name in the subject, From name and intro; nothing of B",
            email.subject === "New question from BrightPath A chatbot" && email.from?.name === "BrightPath A Chatbot" && (email.text || "").startsWith(`A visitor on BrightPath A (${SITE}/)`) &&
            !JSON.stringify(email).includes("BrightPath B") && !JSON.stringify(email).includes(SUPPORT_B), JSON.stringify({ subject: email.subject, from: email.from }));
        check("isolation: no enquiry stored for B or C", (await enquiriesOf(B)).length === 0 && (await enquiriesOf(C)).length === 0);
        // C has no support address: its enquiry is saved with no recipient and no email.
        const outboxBeforeC = mail._testOutbox.length;
        let messageC;
        if (SKIP_BROWSER) {
            r = await call("POST", "/api/chat/contact", { chatbotId: C, name: "Tom Diaz", email: "tom@example.net", question: PRICING_QUESTION, requestId: crypto.randomUUID() }, { key: "" });
            check("no support address: API response is 'saved' (not emailed)", r.status === 200 && r.json.saved === true && r.json.emailed === false, r.text);
            messageC = r.json?.message || "";
        } else {
            // The same journey on chatbot C's widget (375 px): the form appears, the result says "saved".
            customerC = await startCustomerPage(BASE, C);
            const pageC = await browser.newPage({ viewport: { width: 375, height: 760 } });
            await pageC.goto(`http://127.0.0.1:${customerC.address().port}/`);
            await pageC.click(".launcher");
            await pageC.fill(".composer textarea", PRICING_QUESTION);
            await pageC.click(".composer .send");
            await pageC.waitForSelector(".contact-form", { timeout: 240000 });
            check("widget (a) on chatbot C: the form appears after the unanswered question, question pre-filled", (await pageC.locator(".contact-question").textContent()) === PRICING_QUESTION);
            await pageC.fill(".contact-form input[name=name]", "Tom Diaz");
            await pageC.fill(".contact-form input[name=email]", "tom@example.net");
            await pageC.click(".contact-send");
            await pageC.waitForSelector(".contact-done", { timeout: 30000 });
            doneTextC = await pageC.locator(".contact-done").textContent();
            messageC = doneTextC;
            await pageC.close();
        }
        const c = (await enquiriesOf(C))[0] || {};
        check("no support address: saved for C, visitor told 'saved' (not 'sent')", /saved for the support team/.test(messageC) && !/sent to the support team/.test(messageC), messageC);
        if (!SKIP_BROWSER) {
            check("widget (c): the 'saved' message matches the stored email_status no-recipient", /saved for the support team/.test(doneTextC) && c.email_status === "no-recipient", JSON.stringify({ doneTextC, status: c.email_status }));
        }
        check("no support address: recipient NULL, email_status no-recipient, no email", c.recipient === null && c.email_status === "no-recipient" && mail._testOutbox.length === outboxBeforeC, JSON.stringify(c));

        // ================= Full-page chat (widget.html, the dashboard preview) =================
        if (!SKIP_BROWSER) {
        const preview = await browser.newPage();
        await preview.goto(`${BASE}/widget.html?chatbotId=${B}`);
        await preview.fill("#input", PRICING_QUESTION);
        await preview.click("#send");
        await preview.waitForSelector(".contact-form", { timeout: 240000 });
        check("widget.html: the form appears automatically with the original question", (await preview.locator(".contact-question").textContent()) === PRICING_QUESTION);
        await preview.close();

        } else skip("widget.html shows the form (real browser)");
        // ================= Admin: Enquiries (API) =================
        r = await call("GET", `/api/admin/chatbots/${A}/enquiries`, undefined, { key: "" });
        const wrong = await call("GET", `/api/admin/chatbots/${A}/enquiries`, undefined, { key: "wrong-" + "0".repeat(60) });
        check("admin: enquiries need the admin key (401 / 403) and reveal nothing", r.status === 401 && wrong.status === 403 && !r.text.includes("riya@") && !wrong.text.includes("riya@"));
        r = await call("GET", `/api/admin/chatbots/${A}/enquiries`);
        check("admin: A's open enquiry listed with question, visitor, email status", r.status === 200 && r.json.total === 1 && r.json.enquiries[0].question === PRICING_QUESTION &&
            r.json.enquiries[0].email === "riya@example.org" && r.json.enquiries[0].emailStatus === "accepted" && r.json.emailConfigured === true, r.text);
        r = await call("GET", `/api/admin/chatbots/${B}/enquiries`);
        check("isolation: B's enquiry list does not contain A's enquiry", r.status === 200 && r.json.total === 0 && !r.text.includes("riya@"), r.text);
        r = await call("GET", `/api/admin/chatbots/${C}/enquiries`);
        check("isolation: C's list holds only C's enquiry (no-recipient), not A's", r.status === 200 && r.json.total === 1 && r.json.enquiries[0].emailStatus === "no-recipient" && !r.text.includes("riya@"), r.text);
        r = await call("POST", `/api/admin/chatbots/${C}/enquiries/${e.id}/resend`);
        check("isolation: A's enquiry cannot be resent through chatbot C (404)", r.status === 404, r.text);
        r = await call("PATCH", `/api/admin/chatbots/${B}/enquiries/${e.id}`, { status: "handled" });
        check("isolation: A's enquiry cannot be changed through chatbot B (404)", r.status === 404 && (await enquiriesOf(A))[0].status === "open", r.text);
        r = await call("PATCH", `/api/admin/chatbots/${A}/enquiries/${e.id}`, { status: "closed" });
        check("admin: invalid status refused (400)", r.status === 400, r.text);
        r = await call("GET", "/api/admin/chatbots");
        check("admin: chatbot list shows A's open enquiry count", r.json?.chatbots?.find(bot => bot.id === A)?.enquiriesOpen === 1, JSON.stringify(r.json?.chatbots?.find(bot => bot.id === A)?.enquiriesOpen));

        // ================= Admin: Enquiries tab (real browser) =================
        if (!SKIP_BROWSER) {
        const dash = await browser.newPage();
        await dash.goto(`${BASE}/index.html`);
        await dash.click("#showAdminKey");
        await dash.fill("#adminKey", KEY);
        await dash.click("#keyForm button");
        await dash.waitForSelector("#chatbotList .bot");
        await dash.locator("#chatbotList .bot", { hasText: "BrightPath A" }).locator("button", { hasText: "Manage" }).click();
        await dash.click("#t-enquiries");
        await dash.waitForSelector("#enquiryList .enquiry");
        const listText = await dash.textContent("#enquiryList");
        check("dashboard (d): A's Enquiries tab lists the question, the visitor and the label 'Accepted by mail server'", listText.includes(PRICING_QUESTION) && listText.includes("riya@example.org") && /Accepted by mail server/.test(listText), listText.slice(0, 200));
        check("dashboard (d): no 'no support email' notice for A (it has one)", !/No support email is set/.test(await dash.textContent("#enquiryNotice")));
        check("dashboard: reply link is a mailto: to the visitor", (await dash.locator("#enquiryList a[href^='mailto:riya@example.org']").count()) === 1);
        await dash.locator("#enquiryList button", { hasText: "Mark as handled" }).click();
        await dash.waitForFunction(() => /No open enquiries/.test(document.querySelector("#enquiryList").textContent));
        check("dashboard: 'Mark as handled' updates the stored enquiry", (await enquiriesOf(A))[0].status === "handled" && Boolean((await enquiriesOf(A))[0].handled_at));
        // C: the "no support email" notice and the matching label (the open tab reloads for C).
        await dash.selectOption("#chatbotSelect", "");
        await dash.locator("#chatbotList .bot", { hasText: "BrightPath C" }).locator("button", { hasText: "Manage" }).click();
        await dash.waitForFunction(() => /Tom Diaz/.test(document.querySelector("#enquiryList").textContent));
        const noticeC = await dash.textContent("#enquiryNotice");
        const listC = await dash.textContent("#enquiryList");
        check("dashboard (d): C shows the 'no support email' notice", /No support email is set for this chatbot: visitors still see the contact form/.test(noticeC), noticeC);
        check("dashboard (d): C's enquiry has the label 'No email sent (no support email was set)'", /No email sent \(no support email was set\)/.test(listC) && !listC.includes("riya@"), listC.slice(0, 200));
        await dash.close();

        } else {
            skip("dashboard Enquiries tab (real browser)");
            r = await call("PATCH", `/api/admin/chatbots/${A}/enquiries/${e.id}`, { status: "handled" });
            check("admin API: mark as handled stores status and time", r.status === 200 && (await enquiriesOf(A))[0].status === "handled" && Boolean((await enquiriesOf(A))[0].handled_at), r.text);
        }
        // ================= Per-chatbot email: own address and name, address changes, Resend =================
        let visitorIp = 0;
        const contactAs = async bot => {
            const before = mail._testOutbox.length;
            const res = await fetch(BASE + "/api/chat/contact", {
                method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": `198.51.100.${++visitorIp}` },
                body: JSON.stringify({ chatbotId: bot, name: "Ana Lima", email: "ana@example.net", question: PRICING_QUESTION, requestId: crypto.randomUUID() })
            });
            const json = await res.json().catch(() => ({}));
            return { status: res.status, json, row: (await enquiriesOf(bot)).at(-1) || {}, message: mail._testOutbox.length === before + 1 ? mail._testOutbox.at(-1) : null };
        };
        const brief = sent => JSON.stringify({ status: sent.status, to: sent.message?.to, from: sent.message?.from, subject: sent.message?.subject, recipient: sent.row.recipient, emailStatus: sent.row.email_status });
        const NEW_B = "frontdesk@other.example", SUPPORT_C = "team@brightpath-c.example";
        let sent = await contactAs(B);
        check("per chatbot: B's enquiry is emailed only to B's address, 'BrightPath B' in subject, From name and intro, nothing of A",
            sent.status === 200 && sent.message?.to === SUPPORT_B && sent.row.recipient === SUPPORT_B && sent.message.subject === "New question from BrightPath B chatbot" &&
            sent.message.from?.name === "BrightPath B Chatbot" && sent.message.text.startsWith("A visitor on BrightPath B (") &&
            !JSON.stringify(sent.message).includes("BrightPath A") && !JSON.stringify(sent.message).includes(SUPPORT_A), brief(sent));
        r = await call("PATCH", `/api/admin/chatbots/${B}`, { supportEmail: NEW_B });
        sent = await contactAs(B);
        check("support email changed: B's next enquiry goes to the new address (stored as recipient)",
            r.status === 200 && sent.message?.to === NEW_B && sent.row.recipient === NEW_B && sent.row.email_status === "accepted", brief(sent));
        // A typo address (the send fails), then corrected: Resend goes to the corrected address.
        await call("PATCH", `/api/admin/chatbots/${B}`, { supportEmail: "frontdsk@other.exmaple" });
        mail._setTransportForTests({ sendMail: async () => { throw Object.assign(new Error("550 no such user"), { code: "EENVELOPE" }); } });
        const typo = await contactAs(B);
        mail._setTransportForTests(null);
        await call("PATCH", `/api/admin/chatbots/${B}`, { supportEmail: NEW_B });
        let outboxBefore = mail._testOutbox.length;
        r = await call("POST", `/api/admin/chatbots/${B}/enquiries/${typo.row.id}/resend`);
        let current = (await pool.query("SELECT recipient, email_status FROM enquiries WHERE id = $1", [typo.row.id])).rows[0] || {};
        check("resend after the address was fixed: one email to the NEW address, recipient updated, accepted",
            typo.row.email_status === "failed" && typo.row.recipient === "frontdsk@other.exmaple" && r.status === 200 && mail._testOutbox.length === outboxBefore + 1 &&
            mail._testOutbox.at(-1).to === NEW_B && current.recipient === NEW_B && current.email_status === "accepted" && r.json.enquiry.recipient === NEW_B, JSON.stringify({ r: r.json, current }));
        // C still has no support email: Resend is refused, nothing sent; once one is set, it goes there.
        outboxBefore = mail._testOutbox.length;
        r = await call("POST", `/api/admin/chatbots/${C}/enquiries/${c.id}/resend`);
        check("resend with no support email now: 409 with a clear message, nothing sent, recipient still empty",
            r.status === 409 && /No support email is set/.test(r.json?.error || "") && mail._testOutbox.length === outboxBefore && (await enquiriesOf(C))[0].recipient === null, r.text);
        await call("PATCH", `/api/admin/chatbots/${C}`, { supportEmail: SUPPORT_C });
        r = await call("POST", `/api/admin/chatbots/${C}/enquiries/${c.id}/resend`);
        current = (await enquiriesOf(C))[0] || {};
        check("resend after a support email was set for C: sent to it with C's name, recipient recorded",
            r.status === 200 && mail._testOutbox.length === outboxBefore + 1 && mail._testOutbox.at(-1).to === SUPPORT_C && mail._testOutbox.at(-1).subject === "New question from BrightPath C chatbot" &&
            current.recipient === SUPPORT_C && current.email_status === "accepted", JSON.stringify({ r: r.json, recipient: current.recipient }));
        // No display name: the website's domain names the chatbot, never its ID.
        await call("PATCH", `/api/admin/chatbots/${B}`, { displayName: "" });
        sent = await contactAs(B);
        check("no display name: the domain is used in subject, From name and intro, not the chatbot ID",
            sent.message?.subject === "New question from 127.0.0.1 chatbot" && sent.message.from?.name === "127.0.0.1 Chatbot" && sent.message.text.startsWith(`A visitor on 127.0.0.1 (${SITE}/)`) &&
            ![sent.message.subject, sent.message.from.name, sent.message.text.split("\n")[0]].some(text => text.includes(B)), brief(sent));

        // ================= Deleting the chatbot removes its enquiries =================
        r = await call("GET", `/api/admin/chatbots/${A}/deletion-preview`);
        check("deletion preview counts A's enquiries", r.status === 200 && r.json.enquiries === 1, r.text);
        r = await call("DELETE", `/api/admin/chatbots/${A}`, { confirm: A });
        check("deleting A removes its enquiries (reported) and nothing of B", r.status === 200 && r.json.removed.enquiries === 1 && (await enquiriesOf(A)).length === 0 &&
            (await pool.query("SELECT 1 FROM chatbots WHERE id = $1", [B])).rowCount === 1, r.text);
    } catch (failure) {
        check("test run finished without an unexpected error", false, failure.stack || failure.message);
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (customer) customer.close();
        if (customerC) customerC.close();
        // Fallback cleanup, by the exact IDs of this run only, in the isolated database/collection.
        for (const id of TEMP_IDS) {
            await pool.query("DELETE FROM chatbots WHERE id = $1", [id]).catch(() => {});
            await fetch(`${QDRANT}/delete?wait=true`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ filter: { must: [{ key: "chatbotId", match: { value: id } }] } }) }).catch(() => {});
        }
        let left = 0;
        for (const id of TEMP_IDS) {
            left += Number((await pool.query("SELECT (SELECT count(*) FROM chatbots WHERE id = $1) + (SELECT count(*) FROM enquiries WHERE chatbot_id = $1) + (SELECT count(*) FROM crawl_urls WHERE chatbot_id = $1) AS n", [id])).rows[0].n);
            left += (await (await fetch(`${QDRANT}/count`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ exact: true, filter: { must: [{ key: "chatbotId", match: { value: id } }] } }) })).json()).result.count;
        }
        check("cleanup: nothing of this run left in the test database or collection", left === 0, `left ${left}`);
        site.close();
        console.log = log; console.warn = warn; console.error = error;
        console.table(results);
        const failed = results.filter(x => x.result !== "PASS").length;
        console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
        if (skipped.length) console.log(`SKIPPED (not run): ${skipped.join("; ")}`);
        process.exit(failed ? 1 : 0);
    }
})().catch(failure => { console.error("enquiries test error:", failure.message); process.exit(2); });
