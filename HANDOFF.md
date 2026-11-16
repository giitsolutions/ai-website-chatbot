# Handover: AI Website Chatbot

For the next team working on this project. Written on 2026-11-10 at the end of the first internship batch.
Read this first, then [`docs/SETUP.md`](docs/SETUP.md) to get it running.

No secrets are in this repository. Every password and key lives only in a local `.env` file, which is never committed.

---

## 1. What this project is

A chatbot platform that works for **any website**. An administrator (or a customer with an account) adds a website in
the dashboard. The system then:

1. **crawls** the site's public pages safely, including JavaScript (React and similar) sites;
2. **extracts** the text into sections and stores them as vectors (one chatbot per website, kept separate);
3. optionally adds **documents** (PDF or DOCX) as extra knowledge;
4. gives a one-line `<script>` **widget** to put on the website.

A visitor asks a question. The server finds the most relevant sections **of that chatbot only**, asks a local language
model to answer **only from those sections**, and shows the answer with its sources. If the website doesn't contain the
answer, the bot replies exactly `I could not find this information on the website.` and offers a contact form. The
enquiry is saved, shown in the dashboard and emailed to the website's support address.

Everything runs locally. There are no paid APIs.

**The most important rule:** every change must be **generic**. Nothing in the code may depend on one website's text,
layout, class names or domain. Real sites are evidence for a problem, never the target of a fix. See section 7.

---

## 2. Technology

| Part | Technology |
|---|---|
| Server | Node.js 22, Express 5 (`server.js`) |
| Database | PostgreSQL (database `chatbot`, schema in `db/schema.sql`) |
| Vectors | Qdrant in Docker (container `qdrant`, collection `website_content`, 768 dimensions, cosine) |
| Models (Ollama) | `nomic-embed-text` for embeddings; `qwen3:4b-instruct-2507-q4_K_M` for answers; `qwen3:4b` for "if/eligible" questions |
| Crawler | Playwright Chromium and cheerio, through an SSRF-safe, DNS-pinned HTTP client |
| Documents | `pdfjs-dist` and `mammoth`, parsed in a separate child process with size limits |
| Email | `nodemailer` (`supportMail.js`); tests use a fake transport (`EMAIL_TRANSPORT=test`) |
| Tests | Plain Node scripts, no framework |

Developed on a Windows laptop with a 4 GB GPU. Heavier hardware makes answers faster but isn't required.

### Main files

| File | What it does |
|---|---|
| `server.js` | All routes, retrieval, answer rules and guards, accounts, enquiries, deletion |
| `ingest.js` | Crawler, menu-button clicking, extraction, sections, chunking, embedding |
| `chatbotRegistry.js` | All SQL (chatbots, crawl rows, accounts, enquiries). Uses CRLF line endings |
| `documents.js`, `documentWorker.js`, `documentSupervisor.js` | Document upload and safe parsing |
| `policyCheck.js` | Fixed-rule answers for refund and eligibility questions |
| `supportMail.js` | Sends enquiry emails |
| `public/index.html` | The dashboard (login, chatbots, crawl report, documents, test chat, enquiries, accounts) |
| `public/widget.js`, `public/widget.html` | Two copies of the chat UI: **change both together** |
| `tools/diagnose.js` | Shows why a question got its answer (`npm run diagnose`) |
| `demo/` | A pretend customer website on port 5050 for testing the widget |

More detail: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`docs/API.md`](docs/API.md).

---

## 3. What is finished

All of this is built and tested.

| Area | What works |
|---|---|
| Safe crawling | Blocks private addresses and DNS rebinding, follows sitemaps, page and request limits, help centres, script-rendered sites |
| Menu buttons | Opt-in per chatbot (platform admin only). On sites whose menu is buttons rather than links, the crawler clicks menu buttons on the start page, reads the new views and lists the cards in each view. It never clicks forms, log-in, cart, pay and similar action buttons |
| Extraction | Reads the whole page, including footers, contact details, forms, tools, labelled cards and site metadata |
| Answers | Only from the site's content, with at most 2 sources, exact contact details, no outside knowledge, no invented list items. Follow-up questions work. Hindi and Hinglish broad and location questions are understood |
| Documents | PDF and DOCX, private by default, optional signed visitor links to the exact page |
| Contact form | Shown when the bot can't answer. Enquiries are saved, listed in the dashboard and emailed when SMTP is set. Resend is possible |
| Support email | Set per chatbot. The first crawl suggests the address found on the site |
| Accounts | Platform admin (admin key) sees everything. Customers log in and see only their own chatbots (scrypt passwords, hashed sessions) |
| Deletion | Remove one page, all website content, or a whole chatbot, checked step by step |
| Widget | Works on other websites, protected from the host page's styles, keyboard and screen-reader friendly |
| Dashboard | Cream and green design, chatbot picker, crawl report, Test tab, Enquiries tab, Accounts |

Each feature's commit is in `git log`.

---

## 4. Test results (latest)

Commands and rules are in [`docs/TESTING.md`](docs/TESTING.md).

| Check | Result | Date |
|---|---|---|
| Full answer evaluation (`npm run test:answer-eval`, 23 invented site types) | **395/395 correct, citations 123/123**, no site type lower than before | 2026-11-07 |
| Read-only questions on all 7 real chatbots | Same outcome as before the last change | 2026-11-07 |
| `test:accounts` | 106/106 | 2026-11-10 |
| `test:contact` | 59/59 | 2026-11-10 |
| `test:support-email` | 66/66 | 2026-11-10 |
| `test:deletion` | 63/63 | 2026-11-10 |
| `test:widget-sites` / `test:enquiries` / `test:dashboard` | 35 / 57 / 31, all passed | 2026-11-06 |
| `npm run check`, `npm test` | Pass | 2026-11-07 |

**Known test problems (old tests, not product bugs):**
- `test:sop` gives 48/49. One check expects no contact form without a support email. Since the form became always
  available, that expectation is out of date and needs updating.
- `test:helpcenter` gives 20/21, and `test:answers`, `test:runtime` and `test:widget` can't run. They hard-code chatbot
  IDs that were deleted, so they need new IDs or fixtures.
- **Don't run `tests/embed.test.js`**: it writes into the real collection. `tests/widget-sites.test.js` replaces it.

The evaluation uses invented websites that were also used while fixing, so a high score alone doesn't prove real sites
work. That's why every change is also checked read-only on real chatbots.

---

## 5. What is left (future work)

None of these is half-built. Each is a separate piece of work.

### Answers and crawling
1. **Product detail pages behind cards.** On button-menu sites, full product specs often appear only after clicking a
   product card. The crawler clicks menu buttons only. Clicking cards generically needs a careful design, since it's
   riskier than clicking menus.
2. **Missing products in a category view.** On one real React shop, the site said 4 treadmills, but 2 were stored. The
   cause isn't proven. One theory: `prepareSections` in `ingest.js` drops a section whose body matches an earlier one
   without comparing headings, so two identical cards would collapse into one. Prove it with a saved page first, then fix
   it generically and run the full evaluation.
3. **Thin content.** Sites that load almost everything from an API answer poorly. A "thin content" warning in the crawl
   report would help owners.
4. **Removed pages can come back** on the next full re-index. This needs an exclusion list, an additive database change.
5. **Crawl scope** is the whole host, not the registered path. An optional path limit would help.
6. Only one crawl at a time across chatbots, to protect a small machine.

### Product and security (need a decision from the mentor)
7. **Support email verification:** send a confirmation link before emailing enquiries to a new address. The full design
   is in [`docs/PLAN-support-email-verification.md`](docs/PLAN-support-email-verification.md). Not built.
8. Signed "unanswered" token for the contact form. Today, anyone who knows a chatbot ID can submit enquiries
   (rate-limited, allowed websites only).
9. Password rules for customer accounts. Today only a 12-200 character length check exists.
10. Should customers be allowed to turn on menu-button clicking? Today only the platform admin can.
11. Should crawler requests be GET-only? Today all methods are forwarded, because some sites load content with POST.
12. Website ownership isn't verified: any customer can add any public website. There are no usage limits yet.
13. No automatic retention limit for enquiries, which hold visitor names, emails and questions.

### Before real customers (hosting)
[`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md) lists everything, with its status. The main items:
- HTTPS and a real server instead of a laptop.
- Real SMTP with a company domain (SPF, DKIM, DMARC).
- Backups of the database, Qdrant and `data/uploads`.
- A log file and monitoring.
- A database user with fewer rights than a superuser.
- A fixed `DOCUMENT_LINK_SECRET`; without it, document links break after every restart.

### Code tidy-up
- Merge the two widget copies (`widget.js`, `widget.html`) into one.
- Update the old tests listed in section 4.
- The branch is named `hardened-v20`, although the code is newer.

---

## 6. Accounts, passwords and email: set up your own

The first batch used **personal** accounts on their own laptop. None of them are in this repository, and none can be
reused:
- the PostgreSQL password, the admin key (`ADMIN_API_KEY`) and the SMTP login were in a local `.env` file, which is
  git-ignored and was never committed;
- the dashboard accounts, chatbots, crawled pages and enquiries live in that laptop's database and Qdrant. They aren't in
  git.

**What you do:**
1. Copy `.env.example` to `.env` and fill in your **own** values. Use a long random admin key.
2. Use a **company** email account for SMTP and for support addresses, not a personal one.
3. Create your own dashboard accounts and add your own websites.
4. Never commit `.env`, `data/uploads/`, database dumps or backups. `.gitignore` already excludes them.

---

## 7. Rules for working on this project

1. **Generic changes only.** Every crawler, extraction or answer change must pass:
   - the **full** answer evaluation (`npm run test:answer-eval`) with no site type lower than before, **and**
   - a **read-only** question run against all ready chatbots.

   A fix that helps one site type but lowers another isn't accepted. To reproduce a real site's problem, add an
   **invented** site type to `tests/fixtures/site-types.js` or `tests/fixtures/app-site-types.js`. Never copy the real
   site's text.
2. **The fallback text never changes:** `I could not find this information on the website.`
3. **A decline is better than an invented answer.**
4. **Tests that write data run isolated:** `node tests/run-isolated.js [--with-server] tests/<suite>.test.js`. This uses a
   separate database (`chatbot_test`) and collection (`website_content_test`) and fails if real data changed.
5. Run heavy tests one at a time, on mains power with sleep turned off. The full evaluation takes about 40 minutes.
6. `npm run test:http` at most once per 10 minutes, because of the registration rate limit.
7. The "CUDA error: out of memory" lines printed by `npm test` are expected: `tests/guards.test.js` prints them on
   purpose.
8. When Docker Desktop isn't running, Qdrant is down and the bot can't answer. Check `/api/health` first.
9. After changing answer rules, restart the server. After changing the crawler or extraction, restart **and re-index**
   each website.
10. Keep changes small, match the existing style, add no new dependencies without agreement, and back up files before
    big edits.
11. Never put passwords on a command line. Error messages can print them.

---

## 8. Getting started (first day)

1. Install Node.js 22, PostgreSQL, Docker Desktop and Ollama. Pull the three models:
   ```
   ollama pull nomic-embed-text
   ollama pull qwen3:4b-instruct-2507-q4_K_M
   ollama pull qwen3:4b
   ```
2. Clone the repository, then run `npm install` and `npx playwright install chromium`.
3. Create `.env` from `.env.example` (section 6).
4. Start Docker Desktop, then create the vector store: `docker run -d --name qdrant --restart unless-stopped -p 6333:6333 -v qdrant_storage:/qdrant/storage qdrant/qdrant`
5. Run `npm run setup:db` and `npm run setup:qdrant`. Both are safe to run again.
6. Run `npm start` and open http://localhost:3000.
7. Run `npm run check` and `npm test`. Both should pass.
8. Add a small public website, index it, and ask questions in the Test tab.

The full step-by-step guide is [`docs/SETUP.md`](docs/SETUP.md). If something goes wrong, see
[`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md).

### All documentation

| Document | Contents |
|---|---|
| [`README.md`](README.md) | Overview, features, quick start |
| [`docs/SETUP.md`](docs/SETUP.md) | Step-by-step setup and checks |
| [`docs/OWNER_GUIDE.md`](docs/OWNER_GUIDE.md) | Every dashboard section and button |
| [`docs/EMBED.md`](docs/EMBED.md) | Putting the widget on a website |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Crawler, extraction, retrieval, models |
| [`docs/API.md`](docs/API.md) | Every endpoint |
| [`docs/SECURITY.md`](docs/SECURITY.md) | Threats, controls, remaining risks |
| [`docs/TESTING.md`](docs/TESTING.md) | Every test and how to run it |
| [`docs/ANSWER_QUALITY.md`](docs/ANSWER_QUALITY.md) | Rules every answer follows |
| [`docs/VERIFYING_ANSWERS.md`](docs/VERIFYING_ANSWERS.md) | How to check answers are correct |
| [`docs/LAUNCH_CHECKLIST.md`](docs/LAUNCH_CHECKLIST.md) | What's needed before real customers |
| [`docs/RELEASE_CHECKLIST.md`](docs/RELEASE_CHECKLIST.md) | Testing and rolling out a change safely |
| [`docs/PLAN-support-email-verification.md`](docs/PLAN-support-email-verification.md) | Design for the next feature (not built) |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | Common problems |
