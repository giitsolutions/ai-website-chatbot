# AI Website Chatbot

A reusable chatbot platform for many websites, run by one operator on one machine. For each website the operator
creates a chatbot; the system safely crawls the site's public pages (help centres, FAQs, policies), optionally adds
uploaded SOP documents (PDF, Word), and the website owner installs a one-line script. Visitors get answers grounded
**only** in that chatbot's own website pages and documents, with links to the page (or document and page number) that
supports each answer. When the sources do not contain the answer, the chatbot says exactly
`I could not find this information on the website.` and can offer to email the question to the site's support team.

Everything runs locally and free: Node.js, PostgreSQL, Qdrant and Ollama. No paid APIs.

- [1. Overview](#1-overview)
- [2. Setup](#2-setup)
- [3. Usage](#3-usage)
- [4. Project structure](#4-project-structure)
- [5. Architecture](#5-architecture)
- [Tests](#tests) · [Troubleshooting](#troubleshooting) · [Known limitations](#known-limitations) · [More documentation](#more-documentation)

---

## 1. Overview

### What it does

| Area | What is implemented |
|---|---|
| **Admin dashboard** | One page for all chatbots: add a website, live crawl progress, statuses (pending / indexing / ready / partially indexed / failed / deleting), crawl report per address with reasons, re-index, crawl chosen pages, preview chat, answer diagnostics, branding, allowed websites, support email, embed code |
| **Website crawling** | Playwright (JavaScript pages) with SSRF protection on every request and redirect, DNS-rebinding pinning, robots.txt, sitemaps, help-centre aware URL scoring, page limit 1–50 per full crawl, batches of chosen pages, retries for temporary errors, duplicate detection |
| **SOP documents** | Several PDF/DOCX files per chatbot, parsed in a separate time- and memory-limited process; sections keep their page numbers; per-document status, re-index, remove; optional visitor access through signed, expiring links to the cited page |
| **Answers** | Retrieval filtered by chatbot, reranking, a fast model for most questions and a reasoning model for "my situation vs a rule", deterministic refund/eligibility decisions, grounding checks (no invented numbers, emails or URLs), follow-up questions, answer cache per chatbot |
| **Citations** | Only the sources the answer used: page URL with section anchor, or document name, page and section |
| **Unanswered questions** | When the chatbot cannot answer reliably, it says so and shows a contact form in the chat with the visitor's original question; the enquiry is saved for that chatbot (dashboard **Enquiries** tab: reply, mark handled, resend) and emailed to the chatbot's support address when SMTP is configured (fake in-memory transport for tests) |
| **Removing knowledge** | Remove one page, one document, all website content (keeping settings and documents) or a whole chatbot; each scoped to one chatbot, previewed, confirmed, and safe to repeat after a failure |
| **Security** | Admin API key(s) on every admin route (verified by a test that reads every route), scoped CORS, rate limits, safe errors, static-file allowlist, tenant isolation in every vector operation |

### Why

Website visitors ask the same questions the site already answers. This platform answers them from the site's own
content and internal SOPs without inventing facts, keeps every website's knowledge separate, and runs on a laptop
without sending data to paid AI services.

### Current status

Complete and verified by automated tests (see [Tests](#tests)). A platform administrator uses the admin key; website
owners log in with customer accounts and see only their own chatbots. There is no billing, no quotas and no production
HTTPS deployment yet. Current state and future work: [HANDOFF.md](HANDOFF.md).

---

## 2. Setup

Windows Command Prompt. A beginner-friendly, step-by-step version with checks after every step is in
[docs/SETUP.md](docs/SETUP.md).

### Prerequisites

| Component | Version used | Purpose |
|---|---|---|
| Node.js | 22.x | API server, crawler, tests |
| PostgreSQL | 18 | chatbots, crawl reports, documents |
| Docker Desktop | 29.x | runs Qdrant |
| Qdrant | 1.19.1 (Docker) | vector database |
| Ollama | 0.40+ | local embedding and language models |

### 1. Install packages and the crawler browser

```cmd
cd <project folder>
npm install
npx playwright install chromium
```

### 2. Environment variables

```cmd
copy .env.example .env
```

Edit `.env` (it is git-ignored; never commit it or paste keys or passwords into chats, screenshots or browser code):

| Variable | Required | Meaning |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. If the password contains `@`, `:` or `/`, URL-encode it (`@` → `%40`). |
| `ADMIN_API_KEY` | yes | Admin key, **at least 32 characters**. If missing or short, admin routes refuse all requests (fail closed). |
| `ADMIN_API_KEYS` | no | Several named keys for rotation: `alice:<key>,ci:<key>` (each ≥ 32 chars). Used together with `ADMIN_API_KEY`. |
| `LLM_MODEL` / `LLM_THINK` | no | Answer model (default `qwen3:4b`) and whether it reasons first (default `true`). Recommended: `qwen3:4b-instruct-2507-q4_K_M` / `false`. |
| `LLM_REASONING_MODEL` / `LLM_REASONING_THINK` | no | Model for "my situation vs a rule" questions (default: same as `LLM_MODEL`). Recommended: `qwen3:4b` / `true`. |
| `CRAWL_MAX_PAGES` | no | Default page limit, `8` (max `50`; the dashboard sets it per crawl) |
| `LLM_NUM_GPU` / `EMBED_NUM_GPU` | no | GPU layers: answer model `all` (default) / `auto` / a number; embedding model `0` (default, CPU) / `auto` |
| `OLLAMA_KEEP_ALIVE` | no | How long Ollama keeps models loaded, e.g. `30m` (default 5 min; longer = faster first answer, more memory held) |
| `DOCUMENT_LINK_SECRET` | recommended | ≥ 32 characters; signs visitor links to documents. Without it, links stop working after a restart |
| `DOCUMENT_MAX_MB` / `DOCUMENTS_PER_CHATBOT` | no | Upload limits (defaults 10 MB, 50 documents) |
| `SMTP_HOST`, `SMTP_FROM` (+ `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`) | no | Enables "Email your question". Without `SMTP_HOST` and `SMTP_FROM` the option is not offered |
| `TRUST_PROXY` | no | `1` behind one reverse proxy, so per-IP limits see visitors' addresses |
| `PORT` | no | Default `3000` |
| `MAX_QUESTION_LENGTH` / `MAX_WAITING_GENERATIONS` | no | Defaults `500` characters / `2` queued questions |
| `STARTUP_RECOVERY` | no | `off` for test servers or a second server sharing the database (no status repairs at startup) |

Test-only variables (`QDRANT_COLLECTION`, `UPLOAD_DIR`, `EMAIL_TRANSPORT=test`) are set automatically by
`tests/run-isolated.js`; leave them unset for the real server.

Generate an admin key without displaying it:

```cmd
node -e "require('fs').appendFileSync('.env', '\nADMIN_API_KEY=' + require('crypto').randomBytes(32).toString('hex') + '\n')"
```

### 3. PostgreSQL

Create the database `chatbot` (pgAdmin or `createdb chatbot`), set `DATABASE_URL`, then:

```cmd
npm run setup:db
```

This runs [db/schema.sql](db/schema.sql): `CREATE TABLE IF NOT EXISTS` plus `ADD COLUMN IF NOT EXISTS`. Safe to re-run;
existing rows are never changed. Run it again after updating the code (new columns are added, nothing is removed).

### 4. Qdrant (persistent)

```cmd
docker volume create qdrant_storage
docker run -d --name qdrant --restart unless-stopped -p 6333:6333 -p 6334:6334 -v qdrant_storage:/qdrant/storage qdrant/qdrant
npm run setup:qdrant
```

`setup:qdrant` creates `website_content` (768-dimensional, cosine) if missing; otherwise it only checks its settings.
Docker Desktop must be running (enable *Settings → Start Docker Desktop when you sign in*, or start it after each reboot).

### 5. Ollama models

```cmd
ollama pull nomic-embed-text
ollama pull qwen3:4b
ollama pull qwen3:4b-instruct-2507-q4_K_M
```

The last model is optional but recommended (fast answers; set `LLM_MODEL` / `LLM_THINK` as above).

### 6. Start and stop the server

```cmd
npm start
```

Open **http://localhost:3000** (dashboard). Stop the server with **Ctrl+C** in its window, or (PowerShell) stop only
the process on port 3000:

```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000 -State Listen).OwningProcess
```

`http://localhost:3000/api/health` reports `ok` / `unavailable` for Qdrant, Ollama (incl. configured models) and
PostgreSQL.

---

## 3. Usage

Full dashboard guide: [docs/OWNER_GUIDE.md](docs/OWNER_GUIDE.md). Every action is also available through the API
([docs/API.md](docs/API.md), header `x-admin-api-key`).

1. **Connect:** open the dashboard, select *Platform admin? Use the admin key instead*, paste the admin key (from `.env`;
   it is kept only in the page's memory) and select **Connect**. Customers log in with their email and password instead.
2. **+ Add website:** its address (e.g. a help centre) and a page limit. Watch the progress bar and the live list of
   addresses being crawled.
3. **Manage a chatbot** (choose it in the top bar) — six tabs:
   - **Overview:** statistics, crawl report (every address with status, HTTP code, reason; filters, search; *Retry*,
     *Crawl*, *Remove* per address), read chosen pages, continue pending addresses in batches, read the website again, support email,
     page limit, and
     *Remove website content…* / *Delete chatbot…* (preview + typed confirmation).
   - **Test:** a preview chat, and *Explain an answer* (which sections were retrieved, sent to the model, and why).
   - **Documents:** upload PDF/DOCX files (several at once), watch their processing, *Open*, *Re-index*, *Remove*, and
     *Visitors may open this document*.
   - **Enquiries:** questions visitors sent with the contact form after an unanswered question: reply by email, *Mark as
     handled*, *Resend*.
   - **Appearance:** name, welcome message, colour, allowed websites.
   - **Install:** the embed snippet.
4. **Install the widget** on the website, before `</body>`:

   ```html
   <script src="https://YOUR-CHATBOT-SERVER/widget.js" data-chatbot-id="YOUR-CHATBOT-ID" async></script>
   ```

   Locally `YOUR-CHATBOT-SERVER` is `localhost:3000` over `http://`; for real websites it must be your HTTPS domain.
   To try it on a pretend customer website (separate origin): `npm run demo:host` in a second terminal, then open
   `http://localhost:5050/` ([docs/EMBED.md](docs/EMBED.md)).

---

## 4. Project structure

```text
ai-chatbot/
├── server.js               Express app: routes, admin auth, retrieval, prompts, answer checks, citations,
│                           indexing jobs, document queue, email contact, deletion, startup recovery
├── ingest.js               Crawler (SSRF checks, DNS-pinned requests, robots.txt, sitemaps, Playwright),
│                           extraction, chunking, embeddings, storing vectors in Qdrant
├── chatbotRegistry.js      All PostgreSQL access: chatbots, settings, crawl reports, documents, statuses
├── documents.js            Document uploads: validation, storage, extraction, chunking, indexing, removal
├── documentSupervisor.js   Worker thread that starts one reader process per document (time limit, kill)
├── documentWorker.js       Reader process: PDF (pdf.js) and DOCX (mammoth) parsing with size/zip-bomb limits
├── policyCheck.js          Deterministic refund/eligibility decisions from the website's rule
├── supportMail.js          "Email your question": SMTP via nodemailer, or a fake transport for tests
├── dbPool.js               PostgreSQL connection pool (DATABASE_URL)
├── create-collection.js    Creates/checks the Qdrant collection   (npm run setup:qdrant)
├── db/
│   ├── schema.sql          Tables chatbots, crawl_urls, documents (additive, re-runnable)
│   └── setup.js            Applies schema.sql                      (npm run setup:db)
├── public/
│   ├── index.html          Admin dashboard (plain JavaScript)
│   ├── widget.js           Embeddable widget (Shadow DOM)
│   └── widget.html         Full-page chat (dashboard preview)
├── demo/                   Pretend customer website on port 5050   (npm run demo:host)
├── tools/diagnose.js       Command-line answer diagnostics
├── tests/                  Plain Node test scripts (see Tests); run-isolated.js + support/ for isolated runs;
│                           fixtures/ for synthetic PDFs, DOCX and recorded answers
├── docs/                   Detailed guides (see More documentation)
├── data/uploads/           Uploaded documents, one folder per chatbot (git-ignored)
├── .env.example            Template for .env
└── HANDOFF.md              Current state, decisions and next steps for whoever continues the work
```

Files named `*.before-*`, `*.backup.js`, `server_v14_backup.js` and the `backups/` folder are older copies kept as
safety backups (git-ignored); they are not used by the application.

---

## 5. Architecture

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (crawler, extraction, retrieval, models) and
[docs/SECURITY.md](docs/SECURITY.md) (threats, controls, residual risks).

### Components

```text
 Website visitor                 Administrator
       │ widget.js / widget.html         │ dashboard (index.html), header x-admin-api-key
       ▼                                 ▼
 ┌──────────────────────────── server.js (Express, one process) ────────────────────────────┐
 │ public: /api/chat, /api/chat/contact,          admin: /api/register, /api/website,       │
 │ /api/chatbots/:id/config, /api/documents/:t,   /api/admin/chatbots/... (requireAdminKey)  │
 │ /api/health                                                                               │
 │ in memory: indexing jobs, document queue, answer cache, rate limits, deletion locks       │
 └──────┬───────────────┬────────────────────┬────────────────────┬────────────────────────┘
        │               │                    │                    │
   PostgreSQL        Qdrant              Ollama              data/uploads/     SMTP server
   chatbots,         website_content     nomic-embed-text    <chatbot>/        (optional,
   crawl_urls,       (vectors, filtered  qwen3:4b-instruct   <document>.pdf     supportMail.js)
   documents         by chatbotId)       qwen3:4b
```

### Data model

- **PostgreSQL** ([db/schema.sql](db/schema.sql)):
  - `chatbots` — one row per website: URL, allowed domain, status, settings (name, welcome text, colour, allowed
    origins, support email), last crawl summary.
  - `crawl_urls` — the latest crawl report: one row per discovered address with status, reason, HTTP code, sections.
  - `documents` — uploaded files: name, type, size, SHA-256, generated storage name, status, pages, sections,
    visitor access.
  - `enquiries` — contact-form questions: visitor name and email, original question, details, recipient, status
    (open / handled), email status (pending / no-recipient / disabled / accepted / failed).
  - `crawl_urls`, `documents` and `enquiries` are deleted with their chatbot (`ON DELETE CASCADE`).
- **Qdrant** collection `website_content`: one point per text section, with payload `chatbotId`, `sourceType`
  (`website` or `document`), `url` or `documentId` + `page`, `heading`, `chunk`, `contentHash`. Every search, count and
  delete is filtered by `chatbotId`.
- **Files:** `data/uploads/<chatbot id>/<document id>.<ext>` (generated names; never served directly).

### Indexing a website

```text
POST /api/website (async) ─► robots.txt + sitemaps ─► Playwright crawl (every request, redirect and DNS answer checked)
  ─► extraction (headings, numbered steps, notes, code, anchors) ─► chunks ─► embeddings (unchanged chunks reused)
  ─► upsert new vectors ─► delete stale vectors of this chatbot's website (documents untouched)
  ─► crawl report saved (crawl_urls) ─► status ready / partially indexed
```

A failed crawl keeps the previous knowledge. One indexing job per chatbot at a time.

### Answering a question

```text
POST /api/chat ─► validate (chatbot ID, ready, allowed origin) ─► answer cache? ─► embed question
  ─► Qdrant search filtered by chatbotId (website + documents) ─► rerank ─► relevance checks
  ─► refund/eligibility with a date or amount: computed by policyCheck.js
  ─► otherwise fast or reasoning model with the selected sections only (excerpts treated as untrusted data)
  ─► grounding checks ─► answer + sources (+ signed document links, + contact option on the fallback)
```

### Removing knowledge

`DELETE /api/admin/chatbots/:id/pages`, `/website-content` and `DELETE /api/admin/chatbots/:id` run in a fixed order
(chatbot marked `deleting` → vectors → stored files → database rows). Qdrant, files and PostgreSQL cannot share one
transaction, so each step is checked and can be repeated; a failure reports the finished steps (`502`). Cached answers
are cleared every time. See [docs/API.md](docs/API.md#removing-knowledge-and-chatbots-admin).

### Security in brief

Admin routes need an admin key (constant-time comparison, audit log, fail closed). The public chat API only answers
for `ready` chatbots and can be restricted to allowed websites. The crawler refuses private, loopback and reserved
addresses on every request, redirect, robots.txt and sitemap, and pins connections to validated IPs. Uploads are checked
by file signature and parsed in a limited child process. Note: anything indexed — including uploaded documents — can be
quoted to anyone who can use that chatbot.

---

## Tests

Plain Node scripts; each prints a table and exits with 0 only when every check passes. Run heavy suites one at a time
(one 4 GB GPU), on mains power with sleep disabled. Full list and what each proves: [docs/TESTING.md](docs/TESTING.md).

| Kind | Commands | Needs |
|---|---|---|
| Offline | `npm run check`, `npm test` (12 suites incl. admin authorisation and startup recovery) | nothing |
| **Isolated** (separate test database `chatbot_test`, collection `website_content_test`, temp uploads, fake email) | `npm run test:deletion`, or `node tests/run-isolated.js tests/<suite>.test.js` for `contact`, `sop`, `crawl-pages`, `ingest` | PostgreSQL, Qdrant, Ollama |
| Local only | `node tests/crawl-sites.test.js` | nothing external |
| Running server (`TEST_BASE_URL`, default port 3000) | `test:http`, `test:dashboard`, `test:widget`, `test:embed`, `test:answers`, `test:runtime`, `test:documents`, `test:retrieval`, `test:website-rag`, `test:followup`, `test:helpcenter` | a server; they write temporary data to the database that server uses |
| Live websites / real chatbots | `test:indexing`, `test:python-faq`, `test:live-answers` | internet or existing chatbots — run only deliberately |

Latest verified results (2026-10-28, current code): `npm run check` pass; `npm test` 510 checks passed, 0 failed;
isolated `deletion` 63/63, `contact` 41/41, `sop` 49/49, `crawl-pages` 71/71, `ingest` 29/29; `crawl-sites` 49/49; the
shared database and collection were unchanged by every isolated run. The running-server suites were last run on earlier
code ([HANDOFF.md](HANDOFF.md), section 4).

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Health shows `qdrant: unavailable` | Docker Desktop is not running (e.g. after a reboot). Start it (here: `%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe`); the `qdrant` container restarts automatically. Otherwise `docker start qdrant`. |
| Health shows `ollama: unavailable` | Start Ollama. If it runs, a configured model is missing: `ollama list`, then `ollama pull <model>`. |
| Health shows `database: unavailable` | Start PostgreSQL; check `DATABASE_URL` (URL-encode special characters in the password). |
| Admin routes / dashboard say the key is not configured | `ADMIN_API_KEY` missing or shorter than 32 characters in `.env`; restart the server. |
| Indexing fails or finds few pages | See the reason in the dashboard's crawl report; [docs/OWNER_GUIDE.md](docs/OWNER_GUIDE.md#troubleshooting). Crawling is limited to public pages, ports 80/443, robots.txt and the page limit. |
| Chat returns 503 "busy" / 504 "took too long" | One question is answered at a time; retry shortly. Avoid running heavy tests while demonstrating. |
| A chatbot shows **deleting** | A deletion was interrupted. Select *Delete chatbot…* again to finish it. |
| Visitor document links stop working after a restart | Set `DOCUMENT_LINK_SECRET` in `.env`. |
| Port 3000 in use | `netstat -ano \| findstr :3000`, then stop that process. |
| Playwright errors when indexing | `npx playwright install chromium` |
| Widget shows nothing | Browser console: `data-chatbot-id` must be a valid ID; allowed websites must include the page's origin. |

More: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md).

---

## Known limitations

- **Speed** (4 GB GPU, little free RAM): most of the answer time is the model. A warm fast-model answer takes a few
  seconds; the first answer after idle adds 12–17 s of model loading; reasoning-model questions take 30–90 s.
  Refund/eligibility questions with a date or amount are computed in under a second. Repeated questions are cached.
- **Accuracy:** a 4-billion-parameter model; grounding checks reduce but cannot eliminate wrong answers.
- **Not confidential:** website and document content can be quoted to anyone with the chatbot's ID (it is in the
  embed snippet). Upload only material you would publish.
- **Crawling:** at most 50 pages per full crawl (more in batches of up to 10); a full crawl covers the whole host, not
  only the registered section; a page removed by the administrator can come back with the next full re-index;
  several chatbots can crawl at the same time (heavy on a laptop). Pages behind logins, linked PDFs and images are not
  read (upload PDFs as documents instead).
- **Documents:** at most two sections of one document are used per answer, and one page is cited per document; a
  server restart marks documents that were being processed as failed (re-index them). Scanned PDFs need OCR, which is
  not supported.
- **Contact form:** offered after the fallback answer, not after a timeout or busy error; enquiries have no automatic
  retention limit yet. Emails need SMTP settings (`SMTP_HOST`, `SMTP_FROM`); without them enquiries are only saved.
- **One process, one operator:** jobs, cache, rate limits and progress live in memory (reset on restart); one shared
  admin key (rotation supported); no billing or quotas; no HTTPS in local development.

Planned work and priorities: [HANDOFF.md](HANDOFF.md), sections 5 and 6.

---

## More documentation

| Document | For | Contents |
|---|---|---|
| [HANDOFF.md](HANDOFF.md) | Whoever continues the work | Current state, decisions, constraints, next steps |
| [docs/SETUP.md](docs/SETUP.md) | **Start here** (beginners) | Step-by-step setup and checks, automated tests, pre-demo checklist |
| [docs/OWNER_GUIDE.md](docs/OWNER_GUIDE.md) | Website owners | Every dashboard section, button, status and tab |
| [docs/EMBED.md](docs/EMBED.md) | Owners / developers | Widget, snippet, platforms, allowed websites, testing on a separate website |
| [docs/VERIFYING_ANSWERS.md](docs/VERIFYING_ANSWERS.md) | Everyone | How a website becomes knowledge, how to verify answers |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Everyone | Services, dashboard, answers, widget, tests |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Developers | Crawler, extraction, chunking, retrieval, models, sources, isolation |
| [docs/API.md](docs/API.md) | Developers | Every endpoint with examples, errors and limits |
| [docs/SECURITY.md](docs/SECURITY.md) | Developers / operators | Threats, controls, residual risks, production requirements |
| [docs/TESTING.md](docs/TESTING.md) | Developers | Test commands, what each proves, isolated runs |
| [docs/RELEASE_CHECKLIST.md](docs/RELEASE_CHECKLIST.md) | Operators | Test, deploy and roll back safely |
| [docs/LAUNCH_CHECKLIST.md](docs/LAUNCH_CHECKLIST.md) | Operators / mentor | What is needed before real customers |
| [docs/ANSWER_QUALITY.md](docs/ANSWER_QUALITY.md) | Developers | Rules every answer follows |
| [docs/PLAN-support-email-verification.md](docs/PLAN-support-email-verification.md) | Developers | Design of the next feature (not built) |
