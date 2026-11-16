# API Guide

Base URL in local development: `http://localhost:3000`. In production use your HTTPS domain.

All requests and responses are JSON. Errors always look like `{"success": false, "error": "<customer-safe message>"}`;
they never contain stack traces, file paths or database messages.

## Authentication

| Route group | Who | How |
|---|---|---|
| `/api/register`, `/api/website`, `/api/admin/*` | Platform admin, or a logged-in customer (own chatbots only) | Header `x-admin-api-key: <key>` (a key from `ADMIN_API_KEY` or `ADMIN_API_KEYS` in `.env`), or the session cookie from `POST /api/auth/login` |
| `/api/auth/login`, `/api/auth/logout` | Anyone (rate-limited) | None |
| `/api/chat`, `/api/chatbots/:id/config`, `/api/health` | Public (website visitors, the widget) | None |

Admin errors: `401` no key and no valid session, `403` wrong key (or a cookie request from another website), `503` no
admin key configured on the server (fails closed). A customer gets the same `404` for another customer's chatbot, an
unassigned chatbot and an unknown ID, on every route under `/api/admin/chatbots/:id` and on `POST /api/website`.

### Customer login

| Route | What it does |
|---|---|
| `POST /api/auth/login` `{ email, password }` | Starts a session: cookie `cb_session` (HttpOnly, SameSite=Strict, `Secure` on HTTPS or with `COOKIE_SECURE=true`). A wrong email, a wrong password and a disabled account all get the same `401`. `429` after 5 failures per email or 10 per address in 15 minutes. `403` from another website |
| `POST /api/auth/logout` | Ends the session and clears the cookie |
| `GET /api/auth/me` | `{ kind: "customer", email }` or `{ kind: "platform" }`; `401` otherwise |

A session ends after 2 hours without a request or 12 hours after login.

### Customer accounts (platform admin key only; a customer gets `404`)

| Route | What it does |
|---|---|
| `POST /api/admin/accounts` `{ email, password }` | Creates an account (password 12-200 characters, stored only as a scrypt hash). `409` for a duplicate email |
| `GET /api/admin/accounts` | `id`, `email`, `status`, `createdAt`, `lastLoginAt` (never a hash) |
| `PATCH /api/admin/accounts/:accountId` `{ status }` | `active` or `disabled`; ends the account's sessions |
| `POST /api/admin/accounts/:accountId/password` `{ password }` | Resets the password; ends the account's sessions |
| `PUT /api/admin/chatbots/:id/owner` `{ accountId }` | Assigns the chatbot's owner; `null` = no owner (visible to the admin key only) |
| `PUT /api/admin/chatbots/:id/button-discovery` `{ enabled }` | Admin key only (a customer gets 404). `true` = the next full crawl clicks the start page's menu buttons (see `docs/ARCHITECTURE.md`); default `false`. 400 until `npm run setup:db` has added the column |

`POST /api/register` as a customer creates a chatbot owned by that customer and returns an existing one only if it is
theirs, so two customers registering one website get two separate chatbots. With the admin key it works on chatbots
without an owner. Chatbot responses in the admin API include `ownerAccountId`.
Admin routes send no CORS headers, so browsers on other websites cannot call them.
A chatbot ID is **not** a secret and does not prove ownership.

## Public endpoints

### `POST /api/chat`

```json
{ "chatbotId": "3e9bc302-3382-4a4a-8557-0cdc6efcf20f", "question": "How do I reset my password?", "previousQuestion": "optional" }
```

| Field | Rules |
|---|---|
| `chatbotId` | UUID of a chatbot with status `ready` |
| `question` | Text, 1–500 characters (`MAX_QUESTION_LENGTH`) |
| `previousQuestion` | Optional. The visitor's previous question; short follow-ups (≤ 8 words) are searched together with it |

Response:

```json
{
  "success": true,
  "answer": "To reset your password:\n1. Go to the Sign In page.\n2. Select Forgot password.\n...",
  "sources": [
    {
      "url": "https://help.example.com/reset-password",
      "title": "Reset your password",
      "section": "Steps",
      "link": "https://help.example.com/reset-password#steps",
      "headings": ["Steps"]
    }
  ],
  "version": "hardened-v21"
}
```

- When the chatbot cannot answer reliably from its own content: `"answer": "I could not find this information on the website."`,
  `"sources": []` and `"unanswered": true`. The flag is set by the server wherever it declines to answer (no relevant
  sections, the question's subject not in them, an undeterminable policy question, or the model found no answer in the
  excerpts) - also for cached answers - not derived from the text. If the enquiries table exists, the response also has
  `"contact": true`: the widget then shows the contact form right away (see `POST /api/chat/contact`). Neither a
  support email address nor SMTP is required for the form. The answer text never changes. Server problems (database,
  Qdrant or model unavailable) are errors (`500`/`503`/`504`) and never offer the form.
- Refund / cancellation / claim questions with a stated time or amount ("I bought hosting 45 days ago…") are answered
  by a deterministic comparison with the matching rule, which the answer quotes, e.g.
  `"You are past the time limit, so you are no longer eligible. The policy says: \"Hosting plans: full refund within 30 days of purchase.\" You bought it 45 days ago, which is more than 30 days."`
  If the product is not named, the answer quotes the rules and asks which product it was.
- `link` points to the section the answer used (falls back to `url`). Only pages whose text the answer used are listed (max 3).

Errors: `400` invalid input · `403` the chatbot has an allowed-website list and the browser's site is not on it ·
`404` unknown chatbot · `409` chatbot not ready · `413` body over 32 KB · `429` rate limit or one question at a time per visitor ·
`503` model busy (queue full), or the model runner failed twice in a row (for example out of GPU memory; one automatic retry first) · `504` the model took too long.

### `POST /api/chat/contact`

The contact form after an unanswered question. The widget shows it automatically when a chat response had
`"contact": true`, with the visitor's original question (shown, not editable) and fields for name, email and optional
details. Nothing is saved or sent until the visitor submits.

```json
{ "chatbotId": "…", "requestId": "<random id made by the widget, 8-64 letters/digits/->", "name": "Asha Rao",
  "email": "asha@example.org", "question": "Can I change my delivery address?", "details": "optional" }
```

Rules: name one line ≤ 100 characters; one plain email address (no display name, list or line breaks; trimmed, and
the domain part lower-cased); question 1–1000 characters; details ≤ 2000; request body ≤ 32 KB (`413`). Every `400`
names the field: `{ "success": false, "error": "…", "field": "name" | "email" | "question" | "details" | "requestId" | "chatbotId" }`.
Nothing is stored for an invalid request.

What happens: (1) the chatbot is looked up on the server; it must exist (`404`), be `ready` (`409`) and allow the
visitor's website (`403`). (2) The enquiry is **saved** in the `enquiries` table under that chatbot, with its support
address as `recipient` - or `NULL` when it has none (no address is ever invented). (3) An email notification is
attempted only if there is a recipient AND the server has email settings (`SMTP_HOST`, `SMTP_FROM`). One shared SMTP
account sends for every chatbot; everything else comes from that chatbot's own settings: subject "New question from
<display name or domain> chatbot", sender = the `SMTP_FROM` address with the name "<display name or domain> Chatbot"
(no line breaks, quotes or angle brackets; at most 60 characters), body naming the website. The visitor's name and
address are the Reply-To (nothing else the visitor typed goes into an email header). (4) The outcome is recorded as
`email_status`:

| `email_status` | Meaning |
|---|---|
| `pending` | saved, outcome not recorded yet |
| `no-recipient` | the chatbot had no support email: not attempted, `recipient` is `NULL` |
| `disabled` | the server has no email settings: not attempted |
| `accepted` | the mail transport accepted the email (this is **not** proof of delivery) |
| `failed` | the transport refused or could not be reached; `email_error` holds a short code only (e.g. `ECONNREFUSED`, `EAUTH`, or `SEND_FAILED`) |

Rows saved before this naming may show `sent`, which means `accepted`. A failed, disabled or recipient-less email never
loses the enquiry; administrators see it in the dashboard (Enquiries). Once the enquiry is saved the request never
fails with `500` (even if recording the email outcome fails). The same `requestId` is saved and emailed at most once:
a repeat returns the first result with `"duplicate": true`, the same response every time (`409` only while the first is
still being processed). The contact flow never logs the visitor's name, email address or question.

`200` `{ "success": true, "saved": true, "emailed": true|false, "message": "…" }` - `emailed` is `true` only when the
transport accepted the email; the message then says "sent to the support team", otherwise "received and saved for the
support team".
Errors: `400` invalid input (with `field`) · `403` website not on the chatbot's allowed list · `404` unknown chatbot ·
`409` chatbot not ready · `413` body too large · `429` more than 5 per hour per IP · `503` the enquiry could not be saved
(for example the `enquiries` table is missing: run `npm run setup:db`) - nothing is claimed as received.

### `GET /api/documents/:token`

Opens a cited document for visitors. The link comes only from a chat answer citing a document whose
"Visitors may open" setting is on: `/api/documents/<signed token>#page=N` (PDFs open at the cited page; Word files are
downloaded). The token is signed (HMAC-SHA256 with `DOCUMENT_LINK_SECRET`) and expires after 1 hour. Every open checks
again that the document still exists, is indexed and still allows visitors, so turning the setting off or removing
the document disables links already given out. `403` invalid/expired link · `404` not available · `429` more than 60 per
10 minutes per IP. Responses are `Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`.

### `GET /api/chatbots/:id/config`

Display settings for the widget (nothing secret):

```json
{ "success": true, "chatbotId": "…", "displayName": "Help Assistant", "welcomeMessage": "Hi!", "accentColor": "#2563eb" }
```

### `GET /api/health`

`200` when everything works, `503` otherwise. Reports only `ok` / `unavailable` per dependency:

```json
{ "success": true, "server": "running", "qdrant": "ok", "ollama": "ok", "database": "ok", "version": "hardened-v21" }
```

`ollama` is `unavailable` if Ollama is not running **or** a configured model (`LLM_MODEL`, `LLM_REASONING_MODEL`,
`nomic-embed-text`) is not installed.

## Admin endpoints (header `x-admin-api-key`, or a customer's session cookie for their own chatbots)

### `POST /api/register`

```json
{ "websiteUrl": "https://help.example.com/" }
```

Creates a chatbot (`201`) or returns the existing one for the same URL (`200`, `"existing": true`). The URL must be
`http(s)`, on port 80/443, without credentials, and every DNS answer must be a public IP address (`400` otherwise).

### `POST /api/website`

```json
{ "chatbotId": "…", "maxPages": 20, "reindex": true, "async": true }
```

| Field | Meaning |
|---|---|
| `chatbotId` | Chatbot to index (or `websiteUrl` to register and index in one call) |
| `maxPages` | Optional, 1–50. Default `CRAWL_MAX_PAGES` (8) |
| `reindex` | `true` to crawl again. Without it, an already-indexed chatbot is reused |
| `async` | `true` returns `202` immediately; follow progress with `GET /api/admin/chatbots/:id` |

Synchronous response (`200`):

```json
{
  "success": true, "alreadyIndexed": false,
  "message": "Website partially indexed: the crawl stopped at the 20-page limit, so some pages were not indexed.",
  "pagesCrawled": 20, "pagesFailed": 1, "pagesBlockedByRobots": 0, "pagesFromSitemap": 140,
  "pageLimit": 20, "crawlComplete": false, "chunksStored": 212, "embeddingsReused": 180,
  "timings": { "crawlMs": 52000, "embedMs": 7400, "storeMs": 300 }
}
```

Failure: `502` with `details` (first line of the reason) and `previousDataKept: true` when an earlier index still answers.
`409` if this chatbot is already being indexed. Rate limit: 3 accepted crawl requests per 10 minutes per IP
(requests refused with `400`, `404` or `409` start no work and do not count).

### `GET /api/admin/chatbots` and `GET /api/admin/chatbots/:id`

```json
{
  "id": "…", "websiteUrl": "https://help.example.com/", "domain": "help.example.com",
  "status": "ready", "displayStatus": "partially indexed",
  "settings": { "displayName": "", "welcomeMessage": "", "accentColor": "", "allowedOrigins": [] },
  "stats": { "pagesIndexed": 20, "pagesFailed": 1, "chunks": 212, "crawlComplete": false, "pageLimit": 20,
             "lastIndexedAt": "2026-10-15T…", "lastError": null },
  "progress": { "type": "crawl", "state": "running", "stage": "crawling",
                "currentUrl": "https://help.example.com/billing", "phase": "fetching",
                "counts": { "discovered": 31, "queued": 22, "inProgress": 1, "read": 2, "indexed": 0, "failed": 1,
                            "skipped": 5, "notProcessed": 0, "remaining": 23 },
                "pagesCrawled": 7, "pageLimit": 20, "pagesFailed": 0,
                "embedded": 0, "toEmbed": 0, "startedAt": "…", "finishedAt": null, "message": null }
}
```

`displayStatus`: `pending`, `indexing`, `ready`, `partially indexed` (page limit reached), `failed`.
`progress` is `null` when no indexing ran since the server started (progress is kept in memory).
`progress.type` is `crawl` (whole website) or `urls` (chosen pages, see below; then `requestedUrls` and, when
finished, `results` are included). `currentUrl`/`phase` (`fetching`, `extracting`) are set while pages are read.
`counts` are per address of the running crawl: `read` = fetched and waiting to be stored (they become `indexed` or
`skipped` when the crawl's pages are stored), `remaining` = queued + in progress.

### `PATCH /api/admin/chatbots/:id`

```json
{ "displayName": "Help Assistant", "welcomeMessage": "Hi! How can I help?", "accentColor": "#2563eb",
  "allowedOrigins": ["https://www.example.com", "https://help.example.com"], "supportEmail": "support@example.com" }
```

All fields optional. Limits: name ≤ 60 characters, welcome ≤ 300, colour `#rrggbb`, at most 10 `http(s)` origins
(paths are removed). An empty `allowedOrigins` list means any website may embed the chatbot. `supportEmail`: one plain
address (≤ 254 characters) for "Email your question"; empty turns it off. It is never sent to the widget.
`GET /api/admin/chatbots` also returns `emailConfigured` (whether the server has SMTP settings).

## Limits

| Limit | Value |
|---|---|
| Request body | 32 KB |
| Question | 500 characters |
| Chat | 30 requests/min per IP; one question at a time per IP; 1 generation at a time + 2 waiting server-wide |
| Register / index | 10 / 3 requests per 10 min per IP |
| Answer time-out | 240 s (model), widget waits 270 s |

### `POST /api/admin/chatbots/:id/diagnose` (admin)

Traces one question through the chat pipeline for one chatbot and returns every decision. Admin key required; 10
requests per minute. Shows retrieved website text and scores; never secrets or stack traces. Not available to the widget.

Body: `{ "question": "…", "url": "https://… (optional)", "previousQuestion": "… (optional)", "generate": false }`
(`generate: true` also asks the model, which is slow).

Response `trace.steps` (in order):

| step | Contents |
|---|---|
| `index` | Pages and sections stored; last crawl counts and stop reason |
| `page` (with `url`) | `indexed`, or why not: found but not read (limit), failed (reason), not found by the last crawl |
| `retrieval` | Each retrieved section: page, section, vector/keyword/heading/final scores, `decision` ("sent to the model" or the rejection reason), text preview |
| `subject-check` | Whether the question's subject appears in the sections sent to the model |
| `model` | Model that would answer |
| `decision` | `answer` (+ sources) or `fallback` with the reason (relevance, subject check, model found nothing, or which guard rejected the reply) |

`GET /api/admin/chatbots/:id` now also returns `crawlReport` (`indexedUrls`, `failedPages` with reasons,
`notProcessedUrls`, `warnings`: a list of `{ code, message }` from the last full crawl, `supportEmailCandidates`: at most 5
`{ address, source, url, ownDomain }` the last full crawl found on the website, best first, only suggestions, with `source` one of
`structured-data`, `mailto`, `contact-page`, `contact-section`, `about-page`, `about-section`, `footer`), and `stats` include `pagesDiscovered`, `pagesNotProcessed` and `stopReason`.

### `GET /api/admin/chatbots/:id/crawl-urls` (admin)

Every address found by the latest successful crawl and what happened to it. Query: `status` (`indexed`, `failed`,
`skipped`, `not-processed`), `search` (part of the address or reason), `limit` (≤ 200), `offset`.

```json
{ "success": true, "stopReason": "page-limit", "crawlComplete": false, "total": 1,
  "counts": { "indexed": 14, "failed": 1, "skipped": 5, "not-processed": 0 },
  "urls": [ { "url": "https://example.com/missing.html", "status": "failed", "reason": "HTTP 404", "http_status": 404,
              "source": "link", "sections": null, "final_url": null, "discovered_at": "…", "processed_at": "…",
              "title": null, "duration_ms": 412, "attempts": 1 } ] }
```

Counts reconcile: pages found = indexed + failed + skipped + not processed; pages read = indexed + pages skipped after
being read (no readable content, same content as another page). Skip reasons: outside the crawl scope, blocked by
robots.txt, not a web page (file type), account/login/checkout page, redirects to another address / to a page already
read, same content as another page, no readable content. Not-processed reasons: `page-limit`, `request-limit`.
`title` (page title), `duration_ms` (time spent on the address) and `attempts` (page loads; transient failures are
retried) are `null` for crawls recorded before these fields existed.

Each row also has its **current** state, compared with the website sections stored now (uploaded documents never
count; rows and sections are matched by page key, so `www.` and the bare address are one page, while other paths,
subdomains and queries stay separate). Nothing stored is changed:
`current_status` (the recorded `status`, or `indexed-elsewhere`: recorded as not indexed but its content is stored under
an equivalent address form, or `kept-earlier`: the latest attempt failed or was skipped and the earlier version is still
stored), `stored_sections`, `stored_url`. `status` also accepts `indexed-elsewhere` and `kept-earlier`. The response adds
`currentCounts` (per current status), `lastFullCrawl` (the totals of the last full crawl; single-page crawls do not
change them), `storedPages` and `storedSections`. `GET /api/admin/chatbots[/:id]` adds `stats.current` (report rows per
recorded status now).

### `GET /api/admin/chatbots/:id/crawl-live` (admin)

The addresses of the running (or most recent, since the server started) crawl, with their status as the crawl goes:
`queued`, `in-progress`, `read` (waiting to be stored), `indexed`, `failed`, `skipped`, `not-processed`. Query:
`status`, `limit` (≤ 200), `offset`. Returns `{ job, total, urls: [{ url, status, reason, source, httpStatus, finalUrl,
title, sections, attempts, durationMs, processedAt }] }`. The saved report (`crawl-urls`) is written when a crawl ends.

### `POST /api/admin/chatbots/:id/crawl-urls/index` (admin)

Crawls and indexes only the given pages of the chatbot's website — for a new page, a failed page (retry) or pages the
last crawl did not reach — without a full re-crawl. Body: `{ "urls": ["https://www.example.com/new-page"] }` (1–10
addresses; duplicates and `#fragments` are removed). `202` starts a background job (`progress.type: "urls"`).

- Validation: `http(s)` only, no credentials, the chatbot's own website (same rule as the crawler, including its
  documentation subdomains) and port, and not an e-mail address written as a link (`https://site/name@example.com`);
  `400` with the reason otherwise. The website must still resolve to public addresses.
- The crawl uses the normal pipeline and rules: robots.txt, skip rules, SSRF and DNS-rebinding checks, bounded retries,
  extraction, chunking, embeddings (unchanged sections reuse their vectors) and storage in this chatbot only. No
  sitemap is read and no links are followed.
- Only the pages that produced new sections are replaced. A page that fails, or now has no usable text, keeps the
  sections indexed earlier (its report row says so). The rest of the website, its report rows and uploaded documents
  are not touched. `pages_indexed` and the section count are recalculated.
- One indexing job per chatbot: `409` while a full crawl or another page crawl of the same chatbot runs.
- Limit: 20 requests per 10 minutes per IP (refused requests are not counted).

Per-address result (`progress.results`): `indexed`, `up-to-date` (stored sections were already identical),
`skipped` (with the reason, e.g. blocked by robots.txt) or `failed` (with the reason, HTTP status and attempts);
`finalUrl` after a redirect.

### `POST /api/admin/chatbots/:id/crawl-urls/continue` (admin)

Crawls the **next batch** of addresses that a crawl found but did not process (`not-processed`, and `failed` with
`includeFailed`), still without stored content. Body: `{ "batchSize": 5, "pathPrefix": "/docs/", "includeFailed": false }`
— `batchSize` 1–10 (default 5), `pathPrefix` optional (only addresses whose path starts with it). Each address is checked
like `crawl-urls/index`; addresses that cannot be crawled (e-mail addresses, other websites or ports) are left out and
counted as `notCrawlable`. `202` starts the same job as `crawl-urls/index` (`urls`, `pending` before the batch);
`200` with `started: false` when nothing is left. One batch per request; same lock (`409`), limits and rate limit.

### Documents (admin)

| Request | Purpose |
|---|---|
| `GET /api/admin/chatbots/:id/documents` | List: `filename`, `fileType`, `sizeBytes`, `status` (`processing`, `indexed`, `failed`), `stage` while processing (`{ stage: "queued" | "reading text" | "creating embeddings" (with `done`, `total`) | "saving" }`, otherwise `null`), `visitorAccess`, `error`, `pages`, `sections`, `uploadedAt`, `indexedAt`; supported types and limits |
| `GET /api/admin/chatbots/:id/documents/:documentId/file` | The stored file (the dashboard's Open button) |
| `PATCH /api/admin/chatbots/:id/documents/:documentId` | `{ "visitorAccess": true }`: visitors may open it from answers that cite it (off by default; `false` makes it private again) |
| `POST /api/admin/chatbots/:id/documents` | Upload ONE file per request: the raw file bytes as the body, its name URL-encoded in the `X-File-Name` header. `202` while it is processed in the background |
| `POST /api/admin/chatbots/:id/documents/:documentId/reindex` | Extract and index that document again (`202`) |
| `DELETE /api/admin/chatbots/:id/documents/:documentId` | Remove that document: its sections, stored file and record only (`{ removed: { filename, sections } }`). Sections first, then file, then record, so a failed removal can be repeated. `409` while the document is processing or already being removed |

Supported: PDF (`.pdf`, text-based; page numbers kept; numbered headings such as `4. Processing Time` become sections) and
Word (`.docx`, headings kept). Up to 10 MB per file (`DOCUMENT_MAX_MB`, 1–50) and 50 documents per chatbot
(`DOCUMENTS_PER_CHATBOT`, 1–500); 60 document requests per 10 minutes per IP. Errors: `415` unsupported type or a file whose
content is not really PDF/DOCX (legacy `.doc` must be saved as `.docx`), `413` too large, `409` duplicate file /
too many documents / still processing, `404` document of another chatbot. A scanned (image-only) PDF is accepted and then
reported as `failed` with "No readable text found … OCR is not supported"; nothing empty is stored.

### Enquiries (admin)

Questions visitors sent with the contact form, per chatbot. Visitor names, email addresses and questions are only
returned here (admin key), and only for the chatbot in the address (another chatbot's enquiry answers `404`).

| Request | Purpose |
|---|---|
| `GET /api/admin/chatbots/:id/enquiries?status=open\|handled&limit=50&offset=0` | Newest first: `name`, `email`, `question`, `details`, `status`, `emailStatus` (`pending`, `no-recipient`, `disabled`, `accepted`, `failed`; older rows may show `sent` = `accepted`), `emailError`, `recipient`, `createdAt`, `emailedAt`, `handledAt`; plus `counts` per status, `supportEmail`, `storageReady`, `emailConfigured` and `missingSmtpSettings` (setting names only, never values) |
| `PATCH /api/admin/chatbots/:id/enquiries/:enquiryId` `{ "status": "open" \| "handled" }` | Mark handled / reopen |
| `POST /api/admin/chatbots/:id/enquiries/:enquiryId/resend` | Send the email notification again to the chatbot's **current** support email, which becomes the enquiry's `recipient` (so correcting a wrong address works) (`409` if email is not configured, the chatbot has no support email now, or it was already accepted; `502` if it fails again - the enquiry is kept). There is no single-enquiry `GET`: enquiries are read through the chatbot's list |

`GET /api/admin/chatbots` also returns `enquiriesOpen` per chatbot and `enquiryStorageReady`. Enquiries are deleted with
their chatbot (`DELETE /api/admin/chatbots/:id` reports `removed.enquiries`; the deletion preview shows `enquiries`).

### Removing knowledge and chatbots (admin)

Three separate operations, each limited to one chatbot (checked on the server; another chatbot's page or document
answers `404`). 30 removal requests per 10 minutes per IP.

| Request | Removes | Keeps |
|---|---|---|
| `GET /api/admin/chatbots/:id/deletion-preview` | nothing: counts of website sections, crawl report rows, documents (sections, stored files, bytes), whether indexing or a deletion is running, and `confirmWith` (the ID to confirm with) | – |
| `DELETE /api/admin/chatbots/:id/pages` `{ "url": "https://site/page" }` | that page's website sections (all stored forms of the address: `www.`/bare, final slash, no `#fragment`); its report row becomes `skipped` with reason `removed by an administrator` | every other page, all documents, settings. A later full re-index can add the page again |
| `DELETE /api/admin/chatbots/:id/website-content` `{ "confirm": "<chatbot ID>" }` | all website sections, the crawl report and the crawl summary; status becomes `ready` if an indexed document remains, otherwise `pending` | the chatbot, its settings, its documents |
| `DELETE /api/admin/chatbots/:id` `{ "confirm": "<chatbot ID>" }` | the whole chatbot: every vector, its stored files, documents, crawl report, settings | other chatbots |

- Refused with `409` while this chatbot is being indexed, while one of its documents is queued or being read by this
  server, or while a deletion of it is running; `400` without the right `confirm` (another chatbot's ID does not count).
- Qdrant, the stored files and PostgreSQL cannot share one transaction. The steps run in a fixed order (chatbot marked
  `deleting`, then vectors, files, database rows), each step is checked, and every step can be repeated. If a step fails,
  the answer is `502` with `completedSteps` and a message saying which steps finished; sending the same request again
  finishes the removal. A chatbot whose deletion did not finish keeps the status `deleting`: it does not answer, and
  indexing, uploads, re-indexing and settings changes are refused (`409`) until the deletion is repeated.
- Answers cached for the chatbot are cleared after every removal, also after a partial failure.
- Responses: `{ removed: { url, sections, reportRows } }`, `{ removed: { websiteSections, reportRows }, kept: { settings, documents }, status }`,
  `{ removed: { chatbot, vectors, documents, storedFiles, reportRows } }`. No file paths are returned.

In `POST /api/chat`, sources are now typed: `{ "type": "webpage", "url", "link", "title", "section" }` or
`{ "type": "document", "title": "<file name>", "page": 3, "section": "…" }`. A document source has a `link`
(`/api/documents/<token>#page=3`, relative to the API) only when the administrator lets visitors open that document;
otherwise documents stay private and are cited by name, page and section only.
