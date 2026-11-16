// Real-browser test of the dashboard (public/index.html). No crawling, no model calls.
// Settings are changed only on a TEMPORARY chatbot row, which is deleted at the end.
// Needs a running server. Run: npm run test:dashboard
//   (TEST_BASE_URL defaults to http://localhost:3000; the admin key comes from ADMIN_API_KEY / .env)
const path = require("path"), crypto = require("crypto");
const projectDir = path.join(__dirname, "..");
require(path.join(projectDir, "node_modules", "dotenv")).config({ path: path.join(projectDir, ".env"), quiet: true });
const { chromium } = require(require.resolve("playwright", { paths: [projectDir] }));
const pool = require(path.join(projectDir, "dbPool"));

const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const KEY = process.env.ADMIN_API_KEY || "";
const TEMP = crypto.randomUUID();
const results = [];
const record = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 100) });

(async () => {
    if (KEY.length < 32) { console.error("ADMIN_API_KEY is not configured."); process.exit(1); }
    await pool.query("INSERT INTO chatbots (id, website_url, allowed_domain, status, pages_indexed, pages_failed, chunks_indexed, crawl_complete, page_limit, last_indexed_at) VALUES ($1, 'https://dashboard-test.example/', 'dashboard-test.example', 'ready', 8, 1, 0, false, 8, NOW())", [TEMP]);
    const browser = await chromium.launch({ headless: true });
    const errors = [];

    try {
        const page = await browser.newPage();
        page.on("pageerror", e => errors.push(e.message));
        await page.goto(BASE + "/");

        // The admin key field appears after the link on the login screen. Wrong key -> friendly message, not connected.
        await page.click("#showAdminKey");
        await page.fill("#adminKey", "wrong-" + "0".repeat(60));
        await page.click("#keyForm button");
        await page.waitForSelector("#globalMessage .message", { timeout: 10000 });
        record("wrong admin key: friendly message", /not accepted/.test(await page.textContent("#globalMessage")), await page.textContent("#globalMessage"));
        record("admin key field cleared after submit (not kept on screen)", (await page.inputValue("#adminKey")) === "");

        // Correct key -> list of chatbots.
        await page.fill("#adminKey", KEY);
        await page.click("#keyForm button");
        await page.waitForFunction(() => document.querySelectorAll("#chatbotList .bot").length > 0, null, { timeout: 15000 });
        const keyInStorage = await page.evaluate(k => [localStorage, sessionStorage].some(s => Object.keys(s).some(name => (s.getItem(name) || "").includes(k))), KEY);
        record("connected: chatbots listed", (await page.textContent("#keyState")) === "Connected", await page.textContent("#keyState"));
        record("admin key not stored in browser storage", !keyInStorage);

        // The temporary chatbot shows as partially indexed with its counts.
        const card = page.locator("#chatbotList .bot", { hasText: "dashboard-test.example" });
        const cardText = await card.textContent();
        record("status badge: partially indexed + counts", /partially indexed/i.test(cardText) && /Pages indexed: 8/.test(cardText) && /Pages that failed: 1/.test(cardText), cardText.replace(/\s+/g, " ").slice(0, 100));

        // Manage -> detail with tabs.
        await card.locator("button", { hasText: "Manage" }).click();
        await page.waitForSelector("#detail:not([hidden])");
        record("detail opens for the chosen chatbot", (await page.textContent("#detailUrl")) === "https://dashboard-test.example/");

        // Install tab: snippet with the real chatbot ID and this server.
        await page.click("#t-install");
        const snippet = await page.textContent("#embedCode");
        record("install: embed snippet has this chatbot ID and server", snippet.includes(`data-chatbot-id="${TEMP}"`) && snippet.includes(`src="${BASE}/widget.js"`) && snippet.includes("async"), snippet);
        record("install: snippet contains no admin key", !snippet.includes(KEY));

        // Customise: validation error, then save.
        await page.click("#t-customize");
        await page.fill("#setColor", "blue");
        await page.click("#saveSettings");
        await page.waitForSelector("#settingsMessage .message");
        record("customise: invalid colour explained", /#2563eb/.test(await page.textContent("#settingsMessage")), await page.textContent("#settingsMessage"));
        await page.fill("#setName", "Dashboard Test Bot");
        await page.fill("#setWelcome", "Welcome to the test bot!");
        await page.fill("#setColor", "#0f766e");
        await page.fill("#setOrigins", "https://www.dashboard-test.example");
        await page.click("#saveSettings");
        await page.waitForFunction(() => /saved/i.test(document.querySelector("#settingsMessage").textContent), null, { timeout: 10000 });
        const config = await (await fetch(`${BASE}/api/chatbots/${TEMP}/config`)).json();
        record("customise: saved and served to the widget", config.displayName === "Dashboard Test Bot" && config.welcomeMessage === "Welcome to the test bot!" && config.accentColor === "#0f766e", JSON.stringify(config));
        const row = (await pool.query("SELECT allowed_origins FROM chatbots WHERE id = $1", [TEMP])).rows[0];
        record("customise: allowed website stored", row.allowed_origins === "https://www.dashboard-test.example", row.allowed_origins);

        // Test tab: preview loads the full-page widget with the saved name.
        await page.click("#t-test");
        const frame = page.frameLocator("#previewFrame");
        await frame.locator("#title").waitFor({ timeout: 10000 });
        await page.waitForTimeout(1500);
        record("test: preview shows the chatbot with its name", (await frame.locator("#title").textContent()) === "Dashboard Test Bot", await frame.locator("#title").textContent());

        // Explain an answer: the real diagnostics pipeline. This temporary chatbot has nothing
        // indexed, so the honest result is a fallback with that reason (no model call needed).
        await page.fill("#explainQuestion", "<b>How much is the monthly plan?</b>");
        await page.uncheck("#explainGenerate");
        await page.click("#explainButton");
        await page.waitForFunction(() => /Result/.test(document.querySelector("#explainResult").textContent), null, { timeout: 15000 });
        const explained = (await page.textContent("#explainResult")).replace(/\s+/g, " ");
        record("explain: shows the decision and its reason from the real pipeline", /fallback/.test(explained) && /nothing retrieved/.test(explained), explained.slice(0, 100));
        record("explain: question text is never rendered as HTML", (await page.locator("#explainResult b").count()) === 0);

        // Crawl report actions. Nothing is crawled: this chatbot's website does not resolve, so
        // the server refuses page crawls with that reason, which the dashboard must show.
        await pool.query("UPDATE chatbots SET crawl_stop_reason = 'page-limit' WHERE id = $1", [TEMP]);
        await pool.query(`INSERT INTO crawl_urls (chatbot_id, url, status, reason, source, http_status, attempts) VALUES
            ($1, 'https://dashboard-test.example/', 'indexed', NULL, 'start', 200, 1),
            ($1, 'https://dashboard-test.example/broken', 'failed', 'HTTP 503 (after 3 attempts)', 'link', 503, 3),
            ($1, 'https://dashboard-test.example/later', 'not-processed', 'page-limit', 'link', NULL, NULL)`, [TEMP]);
        await page.click("#t-overview");
        await page.selectOption("#chatbotSelect", "");
        await card.locator("button", { hasText: "Manage" }).click();
        await page.waitForSelector("#overviewReport .crawl-table");
        const rowButtons = await page.locator("#overviewReport .crawl-table button").allTextContents();
        // Rows are ordered failed, not processed, indexed; only an indexed page can be removed from the knowledge.
        record("crawl report: Retry on the failed address, Crawl on the not-processed one, Remove on the indexed", JSON.stringify(rowButtons) === '["Retry","Crawl","Remove"]', JSON.stringify(rowButtons));
        record("crawl report: every address can be selected for a batch crawl", (await page.locator("#overviewReport .crawl-pick").count()) === 3);
        await page.locator("#overviewReport .crawl-table button", { hasText: "Retry" }).click();
        await page.waitForSelector("#crawlUrlsMessage .message.error", { timeout: 10000 });
        record("retry: the server's refusal is shown (website not resolvable; nothing crawled)", /resolved/i.test(await page.textContent("#crawlUrlsMessage")), await page.textContent("#crawlUrlsMessage"));
        await page.click("#overviewReport button:has-text('Crawl selected pages')");
        record("batch: crawling with nothing selected is explained", /Select one or more/.test(await page.textContent("#crawlUrlsMessage")), await page.textContent("#crawlUrlsMessage"));
        await page.fill("#crawlUrlsInput", "ftp://dashboard-test.example/file");
        await page.click("#crawlUrlsButton");
        record("crawl pages form: non-web address refused in the browser", /must start with https/.test(await page.textContent("#crawlUrlsMessage")), await page.textContent("#crawlUrlsMessage"));
        await page.fill("#crawlUrlsInput", Array.from({ length: 11 }, (_, i) => `https://dashboard-test.example/p${i}`).join("\n"));
        await page.click("#crawlUrlsButton");
        record("crawl pages form: more than 10 addresses refused", /at most 10/.test(await page.textContent("#crawlUrlsMessage")), await page.textContent("#crawlUrlsMessage"));
        record("crawl pages: no job was started for the chatbot", !(await (await fetch(`${BASE}/api/admin/chatbots/${TEMP}`, { headers: { "x-admin-api-key": KEY } })).json()).chatbot.progress);

        // Current counts and continuing pending addresses (refused here too: the website does not resolve).
        const reportText = (await page.textContent("#overviewReport")).replace(/\s+/g, " ");
        record("report: current counts shown next to the last full crawl", /Now \(after any single-page crawls/.test(reportText) && /not processed \(pending\) 1/.test(reportText), reportText.slice(0, 120));
        record("report: live progress after a restart is explained", /After a server restart, this saved report is still available/.test(reportText));
        record("stats: pending addresses shown from the current report", /Pending \(not processed\): 1/.test(await page.textContent("#overviewStats")), await page.textContent("#overviewStats"));
        record("continue: form shows pending and failed counts", /1 address\(es\) were found but not processed; 1 failed/.test(await page.textContent("#continueForm")));
        await page.fill("#continueBatch", "0");
        await page.click("#continueButton");
        record("continue: invalid batch size explained in the browser", /whole number from 1 to 10/.test(await page.textContent("#continueMessage")), await page.textContent("#continueMessage"));
        await page.fill("#continueBatch", "5");
        await page.click("#continueButton");
        // Wait for the server's answer to replace the previous (browser-side) message.
        await page.waitForFunction(() => /resolv/i.test(document.querySelector("#continueMessage").textContent), null, { timeout: 15000 }).catch(() => {});
        record("continue: the server's refusal is shown (website not resolvable; nothing crawled)", /resolved/i.test(await page.textContent("#continueMessage")), await page.textContent("#continueMessage"));
        record("continue: no job was started", !(await (await fetch(`${BASE}/api/admin/chatbots/${TEMP}`, { headers: { "x-admin-api-key": KEY } })).json()).chatbot.progress);

        // Mobile width: no horizontal scrolling.
        await page.setViewportSize({ width: 375, height: 800 });
        await page.waitForTimeout(300);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        record("mobile 375 px: no horizontal scrolling", overflow <= 1, `overflow ${overflow}px`);

        record("no JavaScript errors on the page", errors.length === 0, errors.join(" | "));
    } catch (error) {
        record("unexpected test error", false, error.message);
    } finally {
        await browser.close();
        await pool.query("DELETE FROM chatbots WHERE id = $1", [TEMP]);
        const left = (await pool.query("SELECT count(*)::int n FROM chatbots WHERE id = $1", [TEMP])).rows[0].n;
        record("cleanup: temporary chatbot removed", left === 0);
        await pool.end();
    }

    console.table(results);
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})();
