// Real-browser tests for public/widget.js and public/widget.html, embedded on a
// page served from a different origin (like a customer website).
// Needs a running server. Run: npm run test:widget  (TEST_BASE_URL defaults to http://localhost:3000)
// Uses a question that test:answers already asked (cached); otherwise it waits for the model.
// The chatbot ID is from the local development database.
const http = require("http");
const path = require("path");
const { chromium } = require(require.resolve("playwright", { paths: [path.join(__dirname, "..")] }));

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const ORG = process.env.TEST_CHATBOT_ID || "483c0167-cc2b-457d-97ce-cd5fc399d65c";
const QUESTION = "What is this domain for?";
const ANSWER_TIMEOUT = 280000;

const results = [];
const record = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 110) });

// A "customer website" on its own origin. Pages are chosen by query string.
function customerSite() {
    const embed = (attrs) => `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Customer</title></head>
<body><h1>Customer website</h1><script src="${BASE}/widget.js" ${attrs}></script></body></html>`;
    const server = http.createServer((req, res) => {
        const u = new URL(req.url, "http://x");
        res.setHeader("Content-Type", "text/html");
        if (u.searchParams.get("page") === "xss") {
            return res.end(embed(`data-chatbot-id="${ORG}" data-title="&lt;img src=x onerror=window.__xss=1&gt;" data-accent="red;}&lt;/style&gt;&lt;img src=x onerror=window.__xss2=1&gt;"`));
        }
        if (u.searchParams.get("page") === "bad-id") return res.end(embed(`data-chatbot-id="not-a-real-id"`));
        if (u.searchParams.get("page") === "api-down") return res.end(embed(`data-chatbot-id="${ORG}" data-api="http://127.0.0.1:9"`));
        return res.end(embed(`data-chatbot-id="${ORG}" data-title="Example Assistant" data-accent="#2563eb"`));
    });
    return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve(server)));
}

async function openWidget(page) {
    // The host element has no size of its own (the UI is fixed-position inside
    // its shadow root), so wait for it to exist rather than to be "visible".
    await page.waitForSelector("#ai-website-chatbot-widget", { state: "attached", timeout: 15000 });
    await page.evaluate(() => document.querySelector("#ai-website-chatbot-widget").shadowRoot.querySelector(".launcher").click());
}

async function askInWidget(page, question) {
    await page.evaluate(q => {
        const root = document.querySelector("#ai-website-chatbot-widget").shadowRoot;
        root.querySelector("textarea").value = q;
        root.querySelector("form").requestSubmit();
    }, question);
}

const widgetState = page => page.evaluate(() => {
    const root = document.querySelector("#ai-website-chatbot-widget")?.shadowRoot;
    if (!root) return null;
    const bubbles = [...root.querySelectorAll(".bubble")];
    return {
        bubbles: bubbles.map(b => b.textContent),
        bubbleChildElements: bubbles.reduce((n, b) => n + b.children.length, 0),
        sources: [...root.querySelectorAll("a.src")].map(a => ({ href: a.href, text: a.textContent, rel: a.rel, target: a.target })),
        error: root.querySelector(".error")?.textContent || "",
        sendDisabled: root.querySelector(".send")?.disabled,
        title: root.querySelector(".head-title")?.textContent,
        launcherBg: getComputedStyle(root.querySelector(".launcher")).backgroundColor,
        panelWidth: root.querySelector(".panel")?.getBoundingClientRect().width
    };
});

(async () => {
    const site = await customerSite();
    const SITE = `http://127.0.0.1:${site.address().port}`;
    const browser = await chromium.launch({ headless: true });

    try {
        // 1. Normal embed on another origin: answer, sources, safe rendering.
        {
            const page = await browser.newPage();
            await page.goto(`${SITE}/?page=normal`);
            await openWidget(page);
            await askInWidget(page, QUESTION);
            const busy = await widgetState(page);
            record("send button disabled while waiting (no duplicate submits)", busy.sendDisabled === true);
            await page.waitForFunction(() => {
                const root = document.querySelector("#ai-website-chatbot-widget").shadowRoot;
                return root.querySelectorAll(".bubble").length >= 3 && !/Thinking|Still working/.test(root.querySelector(".msgs").lastElementChild.textContent) || root.querySelector(".error").textContent;
            }, null, { timeout: ANSWER_TIMEOUT });
            const s = await widgetState(page);
            const answer = s.bubbles[s.bubbles.length - 1];
            record("cross-origin widget gets a grounded answer", /document/i.test(answer) && !s.error, answer);
            record("answer rendered as plain text (no HTML elements in bubbles)", s.bubbleChildElements === 0);
            record("source links: example.org only, http(s), new tab, noopener",
                s.sources.length > 0 && s.sources.every(x => /^https?:\/\/example\.org\//.test(x.href) && x.target === "_blank" && /noopener/.test(x.rel)),
                JSON.stringify(s.sources.map(x => x.href)));
            record("custom title and accent applied", s.title === "Example Assistant" && s.launcherBg === "rgb(37, 99, 235)", `${s.title} / ${s.launcherBg}`);

            // Mobile layout: panel fits a 375 px wide screen.
            await page.setViewportSize({ width: 375, height: 667 });
            const m = await widgetState(page);
            record("mobile: panel fits a 375 px screen", m.panelWidth > 0 && m.panelWidth <= 375, `panel width ${m.panelWidth}px`);
            await page.close();
        }

        // 2. Hostile data-title / data-accent attributes are neutralised.
        {
            const page = await browser.newPage();
            await page.goto(`${SITE}/?page=xss`);
            await openWidget(page);
            await page.waitForTimeout(1000);
            const s = await widgetState(page);
            const xss = await page.evaluate(() => ({ a: window.__xss, b: window.__xss2 }));
            const imgs = await page.evaluate(() => document.querySelector("#ai-website-chatbot-widget").shadowRoot.querySelectorAll("img").length);
            record("hostile data-title shown as text, not executed", !xss.a && imgs === 0 && /<img/.test(s.title), s.title);
            record("hostile data-accent rejected (default colour used, no injection)", !xss.b && s.launcherBg === "rgb(46, 107, 78)", s.launcherBg);
            await page.close();
        }

        // 3. Invalid chatbot ID: widget does not load, logs a console error.
        {
            const page = await browser.newPage();
            const errors = [];
            page.on("console", msg => { if (msg.type() === "error") errors.push(msg.text()); });
            await page.goto(`${SITE}/?page=bad-id`);
            await page.waitForTimeout(1500);
            const host = await page.$("#ai-website-chatbot-widget");
            record("invalid data-chatbot-id: widget not shown, console error", !host && errors.some(e => /chatbot-id/.test(e)), errors.join(" | "));
            await page.close();
        }

        // 4. API unreachable: friendly network message.
        {
            const page = await browser.newPage();
            await page.goto(`${SITE}/?page=api-down`);
            await openWidget(page);
            await askInWidget(page, "Hello?");
            await page.waitForFunction(() => document.querySelector("#ai-website-chatbot-widget").shadowRoot.querySelector(".error").textContent, null, { timeout: 30000 });
            const s = await widgetState(page);
            record("API unreachable: friendly message, button re-enabled", /Could not reach the assistant/.test(s.error) && s.sendDisabled === false, s.error);
            await page.close();
        }

        // 5. Server error statuses (simulated in the browser): friendly text, never internals.
        for (const [status, body, expected, label] of [
            [503, { success: false, error: "The assistant is busy answering other questions." }, /busy right now/, "503 busy"],
            [429, { success: false, error: "Too many chat requests." }, /busy right now/, "429 rate limited"],
            [504, { success: false, error: "The assistant took too long." }, /took too long/, "504 timeout"],
            [500, { success: false, error: "Internal", details: "C:\\Users\\secret\\server.js:42 invalid input syntax for type uuid" }, /^Something went wrong\. Please try again\.$/, "500 with internal details"]
        ]) {
            const page = await browser.newPage();
            await page.route(`${BASE}/api/chat`, route => route.request().method() === "OPTIONS"
                ? route.continue()
                : route.fulfill({ status, contentType: "application/json", headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(body) }));
            await page.goto(`${SITE}/?page=normal`);
            await openWidget(page);
            await askInWidget(page, "Anything?");
            await page.waitForFunction(() => document.querySelector("#ai-website-chatbot-widget").shadowRoot.querySelector(".error").textContent, null, { timeout: 15000 });
            const s = await widgetState(page);
            record(`server ${label}: friendly message only`, expected.test(s.error) && !/C:\\|uuid|server\.js/.test(s.error), s.error);
            await page.close();
        }

        // 6. Full-page widget.html.
        {
            const page = await browser.newPage();
            await page.goto(`${BASE}/widget.html?chatbotId=not-valid`);
            const disabled = await page.$eval("#input", el => el.disabled);
            const text = await page.$eval("#chat", el => el.textContent);
            record("widget.html with invalid ID: explains and disables input", disabled && /not set up correctly/.test(text), text.trim().slice(0, 80));

            await page.goto(`${BASE}/widget.html?chatbotId=${ORG}&title=${encodeURIComponent("<b>T</b>")}`);
            const title = await page.$eval("#title", el => ({ text: el.textContent, html: el.innerHTML }));
            record("widget.html title is plain text", title.text === "<b>T</b>" && !/<b>/.test(title.html), title.html);
            await page.fill("#input", QUESTION);
            await page.click("#send");
            await page.waitForFunction(() => {
                const rows = document.querySelectorAll("#chat .row.assistant .bubble");
                const last = rows[rows.length - 1];
                return last && !last.querySelector(".typing");
            }, null, { timeout: ANSWER_TIMEOUT });
            const bubbles = await page.$$eval("#chat .row.assistant .bubble", els => els.map(e => e.textContent));
            const links = await page.$$eval("#chat a.source-url", els => els.map(a => a.href));
            record("widget.html answers with example.org sources", /document/i.test(bubbles[bubbles.length - 1]) && links.length > 0 && links.every(h => /^https:\/\/example\.org\//.test(h)), JSON.stringify(links));
            await page.close();
        }
    } catch (error) {
        record("unexpected test error", false, error.message);
    } finally {
        await browser.close();
        site.close();
    }

    console.table(results);
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exitCode = failed ? 1 : 0;
})();
