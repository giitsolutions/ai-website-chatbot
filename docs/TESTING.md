# Testing Guide

All tests are plain Node scripts (no test framework). They print a table and exit with code 0 only when every check
passes. Run heavy suites **one at a time**: the laptop has one 4 GB GPU, and parallel model or browser tests slow each
other down until they time out.

## Commands

| Command | Needs | Time* | What it proves |
|---|---|---|---|
| `npm run check` | – | seconds | Syntax of every source file, test file and the pages' inline scripts |
| `npm test` | – (Ollama not needed) | ~4 min | URL/IP validation (36), crawl scope for help centres (18), help-article extraction and chunking (16), document validation, PDF/DOCX extraction and parsing limits — .docx zip bomb (honest and false size headers), too many parts, parse timeout, memory limit, reader stopped 24 times without crashing the server, stopped readers really gone, reader killed from outside (not mistaken for a memory problem), supervisor lost or not answering (its reader stopped, the next document works), server stopped mid-parse (no reader outlives it), no reader processes left, server responsive during a 300-page PDF (42), diagnostics-tool key safety — localhost / remote HTTP / HTTPS with `--allow-remote` / redirects (22), deterministic policy decisions (34: time windows, other products, exceptions, amount caps, ambiguous and undeterminable purchases), answer guards + narration guard (first-person business answers kept, task narration rejected) + admin keys + model routing + source cards + ranking + context budget + citations only from the model's context + answer-type evidence in ranking + clause-level citations + number-only citations + model-failure retry (153), DNS-rebinding pinning (10), crawler SSRF redirect attacks + robots.txt (10) |
| `npm run test:ingest` | Qdrant, Ollama | ~5–7 min | Index a local fake site: relative links, 404 pages, transient failures retried (503 once, dropped connection, a page that stays busy) and permanent ones not, title/duration/attempts per URL, size/HTML limits, robots.txt, sitemap-only page, page limit, re-index without duplicates, failed re-index keeps data. Uses a temporary chatbot ID; data removed |
| `npm run test:http` | running server | ~30 s | Uses its own temporary chatbots (registered by the test, removed at the end; existing chatbots are not touched). Checks: validation, safe errors, static-file allowlist, CORS, headers, admin auth, dashboard API, settings, widget config, allowed websites, async indexing, crawl quota not used by rejected requests, data unchanged |
| `npm run test:dashboard` | running server | ~30 s | Real browser: admin key handling, chatbot list and statuses, install snippet, settings, preview, mobile width. Temporary chatbot row removed |
| `npm run test:widget` | running server | ~2–4 min | Real browser on another origin: answers and sources, plain-text rendering, hostile attributes, invalid ID, offline/429/503/504/500, mobile |
| `npm run test:embed` | running server, Ollama, indexed docs.python.org FAQ chatbot | ~2–4 min | The real customer installation: settings saved in the dashboard, snippet copied from **Install**, pasted into a separate website (other origin), launcher + name/welcome/colour, supported answer with the source link (a temporary chatbot indexed from a synthetic bakery site; no existing chatbot is changed), exact fallback, mobile width, not-allowed origin → 403, demo host. Restores the chatbot's settings |
| `npm run test:python-faq` | running server, Ollama, indexed docs.python.org FAQ chatbot | ~3–5 min | 11 source-backed questions on a real public website (supported, procedural, condition, unsupported, paraphrase, follow-up): required facts + exact source section; unsupported topics confirmed absent from the indexed text |
| `npm run test:retrieval` | running server, Ollama | ~5–10 min | "On the website but not found" regression on two synthetic websites (yoga studio, bakery): a page linked only from the menu and missing from the sitemap is crawled; repeated scripts reused; price cards stored together; slider copies stored once; direct and reworded price questions answered from the right page; opening hours; similar terms on several pages; only supporting sources; exact fallback; isolation in both directions; diagnostics (admin only); honest partial crawls (page limit and request limit); re-index without duplicates; failed re-index keeps knowledge. Temporary chatbots removed |
| `npm run test:website-rag` | running server, Ollama | ~6–12 min | URL-level crawl report on a synthetic site (FitHome): menu page missing from the sitemap indexed, redirect / 404 / other website / PDF link / login page / robots.txt each with its status and reason, counts reconcile (result, database, admin API, filters, search), page-limit and request-limit stops, diagnostics for failed / skipped / not processed / never found pages; grounded answers with generic page titles: online-training prices (not the dietitian prices), monthly price, rentable equipment, ambiguous "this treadmill", 110 kg treadmill suitability (from published weights), no invented capacity for a bike, purchase vs rent price, two claims with two sources, exact fallback |
| `npm run test:live-answers` | running server, Ollama, the existing InHouseGym chatbot | ~1–2 min | READ-ONLY: checks the stored online-training prices first, then asks the packages and monthly-price questions through the chat API: all four prices, no dietitian prices, cited from the online-training page. Writes nothing |
| `npm run test:documents` | running server, Ollama | ~5–10 min | Uploaded PDF and DOCX through the admin API: validation (false extension, legacy .doc, duplicate, no key), image-only PDF fails visibly, generated storage names not served, PDF-only and DOCX-only facts cited with file name and page, website + document answer citing both, exact fallback, isolation between two chatbots, re-index without duplicates, website re-index keeps documents, removing one document removes only its sections |
| `npm run test:runtime` | running server, Ollama | ~1.5–4 min (waits for one reasoning-model answer) | Answer cache, one question per visitor (429), cancellation when a visitor disconnects |
| `npm run test:answers` | running server, Ollama | ~5–20 min | 25 answer-quality cases on the local data: known answers, missing information, cross-tenant, multi-part, paraphrase, injection |
| `npm run test:helpcenter` | running server, Ollama | ~4–8 min | A local help centre end to end: numbered procedures in order, refund conditions and exceptions, the policy matrix (hosting 10/45 days vs 30, SSL 12 days vs 7, email 20 days vs 14, domain exception, ambiguous purchase, product without a rule) with the quoted rule checked, two related articles, sitemap-only article, follow-up question, injected instruction in a page, unsupported question, both cross-tenant directions, source links to sections, cache. Temporary chatbot row and vectors removed |
| `npm run test:crawl-urls` (also in `npm test`) | nothing (local only) | ~30 s | A real crawl of a local site served as `site.test` and `www.site.test` (SSRF check allow-listed for these two origins, pinned to 127.0.0.1): redirects to the home page / another page already read are skipped with the final address, a normal redirect stores the new page, redirects to the same page under another form (trailing slash, `www.`) are read (not replaced by an empty page), a page linked as both `www.` and bare address is one indexed entry, e-mail addresses written as links are never requested and are reported as skipped while `mailto:` links, `/@team/news`, `badge@2x.html` and `?from=a@b` work; report accounting with the exact InHouseGym addresses (pages stored under `www.` counted as indexed, other hosts, case and query not merged) |
| `npm run test:button-discovery` | nothing (local only) | ~4 min | Clicking menu buttons, real crawls of local fixture sites under `.test` names on a random port: off by default (nothing clicked); on: text a button shows added to the start page, a view of cards listed under its button's name, a new address queued and read; action labels, form buttons, page-content and disabled buttons never clicked; POST requests and moves to another website blocked, new windows closed; a hung view stops at 10 s; at most 30 clicks; no clicks on sites with links or on chosen pages |
| `npm run test:spa-crawl` (also in `npm test`) | nothing (local only) | ~1 min | Script-rendered sites, real crawls of local fixture sites under `.test` names on a random port: `<br>` spacing, button text, the 40% fallback, the app-shell wait (delayed content captured, a hung request stops at the 10 s limit, the next page is not held up), an API on another domain, sitemaps and canonical on another domain (only the sitemap file is requested, never a page), crawl report warnings, ordinary sites unchanged |
| `npm run test:extraction-app-page` (also in `npm test`) | nothing | seconds | Extraction of a rendered script-built page (`tests/fixtures/rendered-app-page.html`: a real page's structure, all text placeholder words): words kept, sections, chunks, prices, footer; menus, breadcrumbs, hidden text and cookie banners removed. |
| `npm run test:widget-sites` (isolated, own server) | PostgreSQL, Qdrant, Ollama | ~2 min, run alone | The real `widget.js` on two customer pages with different origins and hostile styles: right chatbot per site, styles in and out, allowed websites, unanswered -> form -> enquiry, 375 px phone, keyboard, screen-reader names. |
| `npm run test:answer-eval` (isolated, own server) | PostgreSQL, Qdrant, Ollama | ~40 min, run alone | Answer quality on 23 invented websites (shop, service business, help centre, a one-page site whose items are only button labels and metadata, a site that names no items, and those in `tests/fixtures/site-types.js` and `tests/fixtures/app-site-types.js`, one of them a site whose menu is buttons, crawled with clicking on), 395 questions through the real chat API and models: exact facts, paraphrases, Hinglish and typos, not on the site, unrelated, another site's facts. Prints correct, citation and time per question and a summary table. |
| `npm run test:support-email` (isolated) | PostgreSQL, Qdrant | ~1-2 min | Support email suggestions, two customers, real crawls of local fixture sites through the real server (embeddings stubbed, no model, no email): mailto, footer text, JSON-LD, contact and about pages, a script-rendered footer, bracketed `[at]`; ranking and the limit of 5; no candidate; other websites (linked page, redirect, iframe), authors, scripts, comments and samples ignored; a crawl never sets or replaces the address; full addresses never logged; customer A never sees B's suggestions or support email (404). Real browser at 375 px: "Use this" only fills the field, Save stores it, same for customer and admin (64 checks) |
| `npm run test:accounts` (isolated) | PostgreSQL, Qdrant (counts) | ~1 min | Customer accounts, two or more customers, real server in-process on a free port, no crawling, no model. Every admin route across accounts → 404 like an unknown ID; logged out → 401; the admin key still works everywhere; scrypt-only passwords; idle and maximum session expiry; logout; login limits; cross-site `Origin`; same website → separate chatbots. Real browser at 375 px: admin-key flow, platform section (create, assign, disable, reset), a customer sees only their own chatbots with platform controls hidden, nothing in browser storage, expired session and logout return to login (102 checks) |
| `npm run test:contact` (isolated) | PostgreSQL, Ollama (one embedding) | ~20 s | Runs the real server in-process on a free port with `EMAIL_TRANSPORT=test` (messages kept in memory, never sent) and startup recovery off: support-email setting (invalid, header-injection, list, display-name, too long → 400; trimmed and saved; admin key needed; never in the public widget config), `emailConfigured` in the dashboard list, `contact: true` only with the exact fallback and a support address, contact validation (12 cases incl. CR/LF in name and email), unknown chatbot 404, no support address 409, other website 403, one email with the right To / Reply-To / fixed subject / body, repeat of one form sends nothing more, two simultaneous submissions send one email, mail-server failure 502 without internals then a successful retry, 429 after 5 per hour, no SMTP settings → no option and 409. Temporary rows removed |
| `npm run test:sop` | PostgreSQL, Qdrant, Ollama | ~5–10 min | Runs the real server in-process (free port, `EMAIL_TRANSPORT=test`, random test admin key and link secret, startup recovery off) with a local fake website and three fictional multi-page SOPs with overlapping subjects (`Refund_Processing_SOP.pdf`, `Customer_Onboarding_SOP.pdf`, `Technical_Support_SOP.pdf`) plus one SOP of a second chatbot: processing stages, numbered PDF headings stored as sections with pages, the right SOP/page/section cited for each question, a question needing two SOPs, website + SOP, follow-up, exact fallback with the email option only when a support address exists, isolation both ways, visitor access (validation, admin key, other chatbot 404, private by default, signed link to the cited page, exact PDF bytes, tampered / re-pointed / garbage / expired tokens 403, private document or wrong chatbot 404, revocation disables issued links), admin Open, re-index without duplicates, removing one SOP removes only its vectors, file and record. All temporary data removed |
| `npm run test:document-answers` (isolated, own server) | PostgreSQL, Qdrant, Ollama | ~3–5 min | A fictional PDF price list with a table and a Word file: rates from a table row, questions needing a calculation (answered with the stated rate, never a computed total), page citations, no double full stops; a private document is never opened by a visitor or by another logged-in customer, and an allowed one opens at the cited page. `npm test` also runs `tests/document-links-unit.test.js` (links after a restart, with and without `DOCUMENT_LINK_SECRET`). |
| `npm run test:crawl-pages` | PostgreSQL, Qdrant, Ollama | ~5–6 min | Runs the real server in-process on a free port (never 3000–3002) against a local fake website (only its origin allow-listed for SSRF): live crawl progress (current address, phase, counts, per-address rows while running), every discovered address gets a final status, the page limit leaves the rest visible as not processed, robots.txt-blocked links reported; crawling one page without a full re-crawl (no other page requested, other sections unchanged, report row and page count updated), "already up to date", a failed page with its real reason and retries, then retried individually, a batch with a redirect (final address) and a robots-blocked page, a page that fails or is emptied keeps its earlier sections, concurrent duplicate requests (one 202, one 409), the 409 lock during a full crawl, validation (other site, other host, other port, ftp, credentials, e-mail address, > 10, empty, unknown chatbot, no key) and tenant isolation; the report compared with stored content (a row recorded as skipped whose content is stored under www. is shown as indexed, document sections never count, the stored row is unchanged, current counts vs last full-crawl totals); continuing pending addresses in batches (invalid batch/section refused, a section filter, repeated small batches, an e-mail address never requested, each page stored once, another chatbot untouched); the chatbot stays ready while it is re-indexed. Uses a random test admin key; the temporary chatbot and its vectors are removed |
| `npm run test:indexing` | running server, Ollama, internet | ~2–4 min | Background indexing of a public docs section through the admin API: 202 at once, duplicate job 409, live progress stages, page limit respected, honest "partially indexed" status, stats saved, old vectors kept during a re-index, failed crawl reported as `failed` with a reason. Temporary chatbots removed (cleanup waits for running jobs). Starts 3 crawls, the whole quota of 3 per 10 minutes per IP: run it first, or 10 minutes after `test:http` (which starts one) — otherwise the last step is refused with 429 |

| `npm run test:startup` (also in `npm test`) | nothing | ~10 s | Startup recovery: with `STARTUP_RECOVERY=off` no database statement at all at startup (documents another server is processing are never marked failed); by default the interrupted-documents update and the chatbot recovery run exactly once. The real server.js with the database replaced by a recorder (14) |
| `npm run test:admin-auth` (also in `npm test`) | nothing | ~10 s | Every route registered by server.js: the six public routes are listed explicitly; every other route runs `requireAdminKey` first and answers 401 without a key and 403 with a wrong key before any database statement, without revealing the key or internals; the dashboard page never contains the key. A new route that forgets the admin check fails (88) |
| `npm run test:enquiries` | PostgreSQL, Qdrant, Ollama — **isolated** | ~2–4 min | The unanswered-question contact form on a synthetic website without prices: supported question answered with its source and no form; unsupported website question and unrelated question → exact fallback, `unanswered: true`, form offered (also from the cache); no support address → no form; the real widget on a separate customer page (phone width) shows the form automatically with the original question, validates (empty fields, invalid email), "Not now" keeps what was typed, a double click submits once, truthful success message; widget.html shows the form too; the enquiry is stored with the exact question, visitor, details and that chatbot's support address; the fake email went to that address only; another chatbot sees none of it (list, update → 404); admin key needed (401/403); dashboard Enquiries tab lists it and "Mark as handled" stores it; deleting the chatbot removes its enquiries (38) |
| `npm run test:deletion` | PostgreSQL, Qdrant, Ollama — **isolated** (see below) | ~3–6 min | Removing one page, one document, a website's content and whole chatbots (two synthetic websites, four synthetic PDFs, three temporary chatbots): only the target disappears, the other pages, PDFs, website content and a second chatbot stay byte-for-byte the same; cached answers citing removed content are not served again; auth (401/403), validation, confirmation, scope (another chatbot's page/document → 404), preview counts, repeated and simultaneous removals, a chatbot deletion that fails half-way (502 with finished steps, status `deleting`, chat/uploads/settings refused) and is then repeated successfully (60) |

\* On the development laptop with the fast + reasoning model configuration.

### Isolated runs (separate test database and collection)

`node tests/run-isolated.js tests/<suite>.test.js` runs one suite against a separate PostgreSQL database
(`chatbot_test` on the same server, created with `db/schema.sql` if missing), a separate Qdrant collection
(`website_content_test`, created if missing), a temporary upload folder, `EMAIL_TRANSPORT=test` and startup recovery off
(through `DATABASE_URL`, `QDRANT_COLLECTION`, `UPLOAD_DIR`; unset, the server uses the normal database, collection and
`data/uploads`). Before and after, the shared database and collection are counted read-only; any difference fails the
run. `test:deletion` refuses to start outside this environment. Suites that run the server in-process work this way:
`deletion`, `contact`, `sop`, `crawl-pages`, `ingest`. Suites that need a running server (`TEST_BASE_URL`) would need a
separate test server started with the same three variables.

Set `TEST_BASE_URL` (e.g. `http://localhost:3001`) to test a second server instead of port 3000. The admin key is read
from `ADMIN_API_KEY` / `.env` and never printed. `test:http`, `test:embed`, `test:documents`, `test:retrieval` and
`test:website-rag` use temporary chatbots and remove them; the answer, runtime and widget suites read chatbots from the
local development database; `test:live-answers` and `test:python-faq` only read existing chatbots. Run suites one at a
time, on mains power with sleep disabled (a laptop going into standby makes browser suites fail), and `test:http` at most
once per 10 minutes (it makes ~7 of the 10 registrations allowed per 10 minutes).

## Latest verified results (2026-10-20, final run on the uncommitted changes after hardened-v19)

Final full regression **20:15–21:06** on the final code: all 16 suites, one at a time (70 s apart), fresh server on
port 3002, mains power the whole time, no sleep/standby/power event and no application crash in the Windows logs
(Ollama did not fail), free RAM 114–1,346 MB after the suites. After every suite a run guard checked for chatbot rows
created by the run and left behind: none.

| Suite | Result | Exit | Time |
|---|---|---|---|
| `npm run check` | pass | 0 | 32 s |
| `npm test` | all pass: validators · crawl rules 28 · extraction 16 · policy 34 · documents 42 · diagnose 22 · guards 111 · pinning 10 · SSRF/robots | 0 | 352 s |
| `test:indexing` | 12/12 | 0 | 93 s |
| `test:ingest` | 21/21 | 0 | 305 s |
| `test:documents` | 28/28 | 0 | 193 s |
| `test:website-rag` | 33/33 | 0 | 149 s |
| `test:retrieval` | 24/24 | 0 | 184 s |
| `test:python-faq` | **10/11 (known failure)** | 1 | 139 s |
| `test:answers` | 25/25 | 0 | 139 s |
| `test:helpcenter` | 21/21 | 0 | 91 s |
| `test:http` | 64/64 | 0 | 6 s |
| `test:dashboard` | 15/15 | 0 | 25 s |
| `test:widget` | 17/17 | 0 | 66 s |
| `test:runtime` | 4/4 | 0 | 31 s |
| `test:embed` | 14/14 | 0 | 62 s |
| `test:live-answers` | 5/5 | 0 | 20 s |

**Audit run on the final code (2026-10-21 16:34–19:02, test server port 3003, one suite at a time):** check pass ·
`npm test` all pass (documents 42 · diagnose 22 · **guards 153**) · indexing 12/12 · **ingest 26/26** (adds transient-retry
checks) · documents 28/28 · website-rag 33/33 · retrieval 24/24 · **python-faq 11/11** · **answers 24/25** · helpcenter 21/21 ·
http 64/64 · **dashboard 17/17** (adds the Explain panel) · widget 17/17 · runtime 5/5 · embed 14/14 · live-answers 5/5.
answers failure: "Why does IANA charge $50 to register example.com?" — the model rejects the false premise correctly and
cites `domains/reserved` but repeats the question's "$50", which the test forbids (same as on 2026-10-21 12:40; not
related to these changes). Environment: the laptop was unplugged 17:08–18:44 and in standby 17:09–18:41, between
python-faq and answers; no suite ran during standby.

Earlier runs the same day (kept for the record): 13:34 full run 15/16; 17:45 run **invalid** (`npm test` crashed with a
segmentation fault — the worker-thread reader, since fixed — Ollama's model process crashed at 18:03, and the session
ended during retrieval, leaving 4 temporary chatbots); 18:22 full run 15/16 (laptop unplugged 18:56–19:22, standby
twice between suites). Latest results: `HANDOFF.md`, section 4.

**After the final fixes** (narration guard narrowed, clause-level citations; 2026-10-20 23:29 – 2026-10-21 07:45, port
3002, one suite at a time): `npm run check` pass · `npm test` all pass (guards 137) · **`test:python-faq` 11/11** ·
answers 25/25 · retrieval 24/24 · website-rag 33/33 · helpcenter 21/21 · live-answers 5/5 · widget 17/17 ·
documents 28/28 and embed 14/14 (both re-run, see below) · runtime **3/4**. Environment: standby 23:59–07:01 and
07:05–07:18 (laptop on battery 07:05–07:19); the first documents run (07:02–07:20) overlapped standby and was **invalid**
(re-run 07:35: 28/28); the first embed run failed once ("page.goto: Timeout 30000ms exceeded" loading the dashboard,
free RAM ~170–200 MB; re-run 07:40: 14/14). runtime "second concurrent question is refused with 429" failed because the
first answer finished in 2.8 s, before the test's fixed 4 s wait (the test assumes generation takes longer); a direct
check sending the second question 0.3 s and 1 s after the first got HTTP 429 both times — the limit works, the test's
timing is fragile. **Fixed afterwards** (`tests/runtime.test.js`): the first question now goes to the reasoning model
(policy topic + number), the second is sent 0.5 s later, and a new check requires the first to be still in progress
when the second is sent and when its 429 arrives; assertions unchanged (429 within 3 s, first completes with 200).
Five consecutive runs 07:51–08:05: **5/5 each** (second refused in 3–8 ms; first completed in 74–194 s).

Before the fix (kept for the record): **Known failure (not hidden, not worked around):** `test:python-faq` → `[paraphrase] Why can't a string be modified after
it is created in Python?` — "source design.html#why-are-python-strings-immutable not linked". The FAQ section *is* in
the model's context; the 4B model words its answer like the data-model reference, so the citation goes to
`reference/datamodel.html#immutable-sequences`. Citation thresholds and model instructions were not changed to pass it.

## Expected results (release hardened-v19)

Historical results of the hardened-v19 release (2026-10-15):

| Suite | Result |
|---|---|
| `npm run check` | exit 0 |
| `npm test` | 36 + 18 + 10 + 34 + 56 + 10 + 10 checks, exit 0 |
| `test:ingest` | 21/21 |
| `test:http` | 63/63 |
| `test:dashboard` | 15/15 |
| `test:widget` | 17/17 |
| `test:embed` | 14/14 |
| `test:python-faq` | 11/11 |
| `test:runtime` | 4/4 |
| `test:answers` | 25/25 |
| `test:helpcenter` | 21/21 |
| `test:indexing` | 12/12 |

See [HANDOFF.md](../HANDOFF.md), section 4, for the latest results and known weaknesses.

## Performance measurements

To measure indexing yourself, index a site from the dashboard: the
indexing response (and `POST /api/website` without `async`) contains
`"timings": { "crawlMs", "embedMs", "storeMs" }` and `embeddingsReused`. Answer timings per question are printed in
the server window (`Timings: {"embedMs":…,"searchMs":…,"contextMs":…,"generationMs":…,"loadMs":…,"promptMs":…,"outputTokens":…,"outputMs":…}`):
`loadMs` is the model being loaded (after Ollama's keep-alive expired), `promptMs` reading the excerpts, `outputMs`
writing the answer.

## Writing new answer tests

Add cases to `tests/answers.test.js` or `tests/helpcenter.test.js`. Check the **content** of answers (the right facts,
the right yes/no conclusion, the right source page), not only that a request succeeded. Never weaken an assertion to
make a run pass; if an answer is wrong, fix the cause (retrieval, extraction, prompt, model choice).
