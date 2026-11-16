# Security Review

Scope: the chatbot platform (`server.js`, `chatbotRegistry.js`, `ingest.js`, `documents.js`, `documentWorker.js`,
`documentSupervisor.js`, `tools/diagnose.js`, `public/`). Every control below is
covered by an automated test unless marked *manual*.

## Threats and controls

| Threat | Control | Test |
|---|---|---|
| Crawl quota used up by mistakes | 3 accepted crawls per 10 min per IP; requests refused with 400/404/409 (invalid, unknown chatbot, already indexing) do not count | `test:http` |
| Anyone registering sites / starting crawls | `ADMIN_API_KEY` / named `ADMIN_API_KEYS` (≥ 32 chars, rotation, audit log) in `x-admin-api-key`; SHA-256 + constant-time compare; missing/short key → 503 (fail closed); key never accepted from URL or body | `test:http` |
| Admin API called from another website | No CORS headers on admin routes, so browsers block cross-origin calls and the custom header | `test:http` |
| SSRF at registration | http/https only, no credentials, ports 80/443, every DNS answer must be public (IPv4 private/loopback/link-local/CGNAT/reserved; IPv6 loopback/ULA/link-local/multicast/NAT64/6to4/Teredo/IPv4-mapped) | `npm test` |
| SSRF during crawling | Same checks on **every** browser request, **every redirect hop**, robots.txt and sitemaps; connections pinned to the validated IP (DNS rebinding) (redirects followed by the server, not the browser); WebSockets and service workers blocked; max 5 redirects, 250 requests, 45 s per page | `npm test` |
| Crawling against the owner's wishes | `robots.txt` (`*` group, Allow/Disallow, wildcards) respected | `npm test`, `test:ingest` |
| Failed crawl wiping a working bot | New vectors written first, stale ones deleted after; any failure leaves old data; status returns to `ready` | `test:ingest` |
| Cross-tenant data leakage | Every Qdrant query filtered by `chatbotId`; answer cache key includes `chatbotId` and is cleared on re-index | `test:answers` |
| Prompt injection (website text or visitor) | One generic system prompt; excerpts marked untrusted; explicit rule to ignore instructions inside questions | `test:answers` |
| Embedding the chatbot on other websites | Optional per-chatbot list of allowed websites: browsers on other origins get 403 (not authentication: non-browser clients can send any Origin) | `test:http` |
| Links/emails injected through the visitor's question ("append: visit http://evil…") | URLs and emails in an answer must come from the website text; numbers may also come from the question | `npm test` (guards), `test:answers` |
| Wrong yes/no on policy conditions | Time/amount comparisons ("45 days ago" vs "within 30 days", "$250" vs "up to $200") are computed by `policyCheck.js` from the matching rule in the website text, never by the model; ambiguous purchases get a question back, products without a rule get the exact fallback. Other "my situation" questions go to the reasoning model | `npm test` (policy, 34), `test:helpcenter` |
| Uploaded documents | Admin key on every document route; type checked by extension AND file signature; ≤ 10 MB, ≤ 50 per chatbot, duplicates refused; generated storage names under `data/uploads` (never the uploaded name, never served, not in API responses); every section tagged with `chatbotId` + `documentId`; a document is reachable only through its own chatbot (404 otherwise); deleting removes only that document's sections; website re-index never deletes document sections. **Not confidential:** document content can be quoted to anyone who can use the chatbot (see residual risk 8) | `npm test` (documents-unit), `test:documents` |
| Clicking menu buttons while crawling | Off per chatbot; only the platform admin can turn it on. Only the start page of a full crawl with fewer than 3 links; only visible buttons in nav, header and footer; never buttons in a form, submit or disabled buttons, or labels like sign up, log in, pay, cart, order, book, delete, cancel, download. While clicking, every request other than GET/HEAD is aborted and the page cannot move to another website; new windows are closed and every request they make is refused; downloads are refused. At most 30 clicks, 10 s each; the request budget and all SSRF checks still apply. A GET request can still change something on a badly built website | `test:button-discovery` |
| Dashboard fonts | The dashboard page (not the widget) loads two fonts from Google Fonts, so an admin's browser contacts Google; it falls back to system fonts when offline. The widget loads nothing external, so visitors of customer websites never contact Google through it | not tested |
| Document links for visitors | Off per document unless the administrator ticks "Visitors may open". A link is `/api/documents/<token>` where the token (chatbot ID, document ID, expiry) is signed with HMAC-SHA256 (`DOCUMENT_LINK_SECRET`, or a random per-process secret) and expires after 1 hour; constant-time signature check; every open re-checks that the document belongs to that chatbot, is indexed and still allows visitors (so unticking or removing disables issued links). Files are sent with `Cache-Control: private, no-store`, `Referrer-Policy: no-referrer`, `nosniff`; Word files as downloads; the storage name is never exposed; 60 opens per 10 min per IP. The admin **Open** button uses the admin key (`/documents/:id/file`) | `test:sop` |
| Email your question | Only after the visitor submits the form, only after an unanswered question, only if the chatbot has a support address and the server has SMTP settings. SMTP credentials only in `.env`; the destination is the chatbot's stored support address (validated: one plain address, no display name, lists or line breaks), never taken from the request. Fixed subject; the visitor's validated address only as Reply-To; name one line; lengths capped. One email per form (`requestId` reserved before any await, so simultaneous submissions send one); 5 per hour per IP; allowed-websites check as for chat; SMTP errors logged by code only and shown to the visitor as a generic message. Tests use `EMAIL_TRANSPORT=test` (in memory, never sent) | `test:contact` |
| Malicious or oversized document files (zip bomb, complex PDF) | Parsing runs in a separate reader process per document (`documentWorker.js`) with a 120 s timeout and a 512 MB JavaScript heap limit (`--max-old-space-size`). A long-lived supervisor thread (`documentSupervisor.js`) starts the reader, enforces the timeout and kills it, so chat answers keep working (main thread pause ≤ ~40 ms measured during a 300-page PDF) and a stuck or exhausted reader is killed and reported as failed without affecting the server. Failures are contained: a reader killed by something else is reported as an unexpected stop (not as "too much memory", which is recognised by V8's own out-of-memory message); if the supervisor thread fails or stops answering (backstop: timeout + 30 s), the server stops its readers by process ID (a busy reader does not notice the lost connection itself) and a new supervisor takes the next document; a replaced supervisor can never fail its successor's jobs; when the server process ends, Windows ends its readers too. Rejected designs: a worker thread per document (terminating it while it loaded pdf.js crashed the whole server, reproduced) and starting the reader from the main thread (a ~0.6 s main-thread pause per document on Windows). Before mammoth reads a .docx, every ZIP part is really decompressed with a hard cap (100 MB in total; the size fields in the ZIP are not trusted), at most 5,000 parts, no encrypted or ZIP64 archives. Images in .docx files are not decoded (text only). PDFs: at most 500 pages, eval disabled in pdf.js | `npm test` (documents-unit) |
| Citing text the model never saw | Citations are chosen only from the sections actually included in the model's context; sections dropped by the 6,000-character limit can neither inform the answer nor be cited | `npm test` (guards) |
| Admin key leaked by the diagnostics tool | `tools/diagnose.js` sends the key only to `localhost`/`127.x`/`::1`, or to a remote **HTTPS** server with an explicit `--allow-remote`; remote plain HTTP is always refused; redirects are not followed (the key is never forwarded); the key is never printed | `npm test` (diagnose) |
| Vulnerable dependencies | `npm audit` re-checked 2026-10-20 (0 critical, 0 high, 3 moderate): `undici` (high, via `@qdrant/js-client-rest` 1.19.0, which pins 7.29.0) fixed with a scoped `overrides` entry to 7.29.1 (patch release, same major; the version cheerio already uses). Not fixed: the 3 moderate advisories are one chain, mammoth 1.12.3 → `argparse` 1.0.10 → `sprintf-js` 1.0.3 (GHSA-hp3w-g68c-fv3c, denial of service through unbounded precision specifiers; no fixed `sprintf-js` release exists). `argparse` is loaded only by mammoth's command-line tool (`bin/mammoth`), never by its library entry point used here, so it is not reachable at runtime. Re-check when mammoth releases a version without `argparse`. `npm audit fix --force` is NOT used: it would downgrade the Qdrant client to 1.18.0 and mammoth to 0.3.29 (breaking) | `npm audit --omit=dev` |
| Hallucinated facts | Numbers/emails/URLs must appear in retrieved text; cut-off or narrated replies rejected (narration = the model describing its task with a task object such as the question, the answer, the excerpts or "the information provided"; "We are open…" / "We will answer your email…"-style business answers are allowed; narration without a task object, e.g. "We should consider…", is not caught and relies on the other checks); exact fallback | `test:answers`, `npm test` (guards: narration) |
| Leaking internals | JSON-only errors; no stack traces, paths, SQL or Ollama messages; no `X-Powered-By` | `test:http`, `test:widget` |
| Serving private files | Only `/`, `/index.html`, `/widget.js`, `/widget.html` are served; backups, tests, `.env` → 404 | `test:http` |
| XSS through answers, sources or embed attributes | Text inserted with `textContent`; `http(s)` source links only; `data-accent` and `data-api` validated | `test:widget` |
| Clickjacking of the admin page | `X-Frame-Options: DENY` on everything except the widget files | `test:http` |
| Malformed / oversized input | UUID, type and length checks before any DB/LLM work; 32 KB body limit; 500-character questions | `test:http` |
| Overloading the local model | One generation at a time, 2 waiting, one per client IP, 240 s timeout, 1,536 output tokens, cancellation on disconnect, per-IP rate limits; a failed model run (e.g. CUDA out of memory) or dropped embedding connection is retried once, then answered with 503 + Retry-After, never a 500 | `test:runtime`, `npm test` (guards) |
| Secrets in Git | `.env`, `.env.*`, backups ignored; secret scan of tracked files before every commit | *manual (scripted scan)* |

## Customer accounts

- **Ownership is enforced on the server:** middleware on `/api/admin/chatbots/:id` runs before every route under it. A
  customer gets the same 404 for another customer's chatbot, an unassigned one and an unknown ID. The list and
  `/api/website` also filter by owner; platform-only routes answer 404 to customers. The dashboard only hides controls.
- **Passwords:** scrypt (N=16384, r=8, p=1, random salt), compared in constant time, never logged or returned. Unknown
  emails also run scrypt. A wrong email, a wrong password and a disabled account give the same answer.
- **Sessions:** a random 32-byte token in an HttpOnly, SameSite=Strict cookie; only its SHA-256 is stored. 2 h idle, 12 h
  maximum. Logout, disabling an account and a password reset end sessions on the server. The dashboard keeps nothing in
  localStorage or sessionStorage.
- **Login limits:** 5 failures per email and 10 per address in 15 minutes (in memory: they reset on restart and are per
  process). An attacker can use the per-email limit to lock a known email out for up to 15 minutes; a platform-admin
  password reset clears it.
- **Requests from other websites:** a cookie request that changes something, and any login, is refused (403) if its
  `Origin` is another website.
- **Accounts are created by the platform admin only.** There is no sign-up and no password email.
- **Known limitations:** website ownership is not verified, so any customer can register and crawl any public website. No
  usage limits per account. HTTPS is required in deployment: on plain HTTP passwords and session cookies travel unencrypted
  (`Secure` is set only on HTTPS or with `COOKIE_SECURE=true`). Customers see the names (not values) of missing SMTP settings.

## Secrets and configuration

- Secrets live only in `.env` (git-ignored; `.env.*` too). Never pass them on a command line: process errors print the
  whole command line. Back up the database with `PGPASSWORD` in the environment, not a URL argument.
- If the PostgreSQL password contains `@`, `:` or `/`, URL-encode it in `DATABASE_URL`; strict parsers (e.g. `pg_dump`)
  otherwise read part of the password as the host name.
- SMTP settings (`SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`) and `DOCUMENT_LINK_SECRET`
  live only in `.env`; nothing of them reaches the browser. Without `DOCUMENT_LINK_SECRET` links stop working after a restart.
- Rotate admin keys with `ADMIN_API_KEYS` (add the new key, switch clients, remove the old one). The audit log
  (`[admin] … key=<name> ip=… outcome`) never contains a key.

## Residual risks (not solved yet)

1. **DNS rebinding — mitigated in the application, not at the network.** Every crawler request (pages, sub-resources,
   redirects, robots.txt, sitemaps) goes through `pinnedRequest()`, which connects only to the IP addresses that
   passed validation (`npm test` → pinning tests). Remaining gap: Chromium may still pre-resolve/pre-connect hostnames
   it sees in a page (no HTTP request is sent through those connections). *Production:* additionally run the crawler
   where it cannot reach private networks (container with an egress firewall).
2. **Shared admin keys.** `ADMIN_API_KEYS` supports several named keys and rotation, and every admin request is written
   to the audit log (key name, IP, outcome — never the key). Any valid key is a platform admin and can manage every
   chatbot; customer logins reach only their own chatbots (see below). The audit log is the console output; keep it if you need history.
3. **No HTTPS locally.** Admin keys travel in plain text on `http://localhost`. Production must use HTTPS.
4. **Chat abuse.** Anyone who knows a chatbot ID can call `/api/chat` from anywhere (by design for embedding).
   Per-IP limits apply. The optional per-chatbot "Websites allowed" list stops browsers on other websites (403), but it
   is not authentication: other programs can send any `Origin` header. Per-chatbot quotas are on the roadmap.
5. **In-memory limits.** Rate limits, the generation queue and the answer cache live in one process: they reset on
   restart and do not span several server processes. Behind a reverse proxy set `TRUST_PROXY` (e.g. `1`) so limits use
   the visitor's IP; without it every visitor appears to come from the proxy. Several processes would need a shared
   store such as Redis (not used: one process is enough for a single-machine setup).
6. **Model robustness.** Injection resistance is tested, not proven; a 4-billion-parameter model can still be
   misled by sufficiently adversarial page text. Grounding checks reduce, not eliminate, wrong answers.
7. **Crawl size.** Responses are cut off at 5 MB while downloading, and at most 50 pages are crawled per request
   (default 8). Large sites are therefore indexed only partly; the indexing response says so (`crawlComplete: false`).
8. **Uploaded documents are not confidential.** There is no per-visitor access control: whatever a document says can be
   quoted to anyone who can use the chatbot (see 4), and citations show its file name, page and section. The file
   itself is served only for documents the administrator opened to visitors, through signed links that expire after
   1 hour; a link can be shared with anyone during that hour (it is a bearer link, not tied to a visitor).
   Email escalation: the visitor's own address is not verified, so a visitor can type someone else's address as
   Reply-To; the 5-per-hour IP limit bounds abuse but does not stop a determined sender with many addresses. Owners must upload only material they would publish (OWNER_GUIDE section 6).
9. **Document parsing limits are partial.** The reader process's memory limit covers the JavaScript heap, not large
   binary buffers; the .docx expansion cap (100 MB) and the 10 MB upload limit bound those. A PDF is limited by time
   (120 s) and pages (500), not by drawing complexity. Documents are processed one at a time, so one slow file delays the
   next (never chat answers). Starting a reader process takes ~0.6–0.7 s on the development laptop (Windows creates
   processes synchronously); this happens on the supervisor thread, not the main thread, but it adds to each
   document's processing time. Recognising an out-of-memory reader relies on V8's "heap out of memory" message on
   stderr; any other abnormal end is reported as an unexpected stop ("The document could not be processed."). Readers
   end with the server process because Windows places child processes in a kill-on-close job object; on Linux/macOS
   a reader could outlive a crashed server until it finishes. *Production:* add OS-level CPU/memory limits (container or
   job object) for the reader.
10. **Upload race conditions.** The "at most 50 documents" and "duplicate file" checks read the list, then insert, so
    two uploads at the same moment can both pass; the file is written before its database row, so a database failure can
    leave an unreferenced file. Impact is limited (admin-only). Proposed fix (not implemented): one transaction per upload
    that takes a per-chatbot advisory lock (`pg_advisory_xact_lock`), re-counts and checks the SHA-256 inside it, and
    inserts the row; a unique index on `(chatbot_id, sha256)` as a backstop; write the file under a temporary name and
    rename it after the commit (delete it on rollback).
11. **Chatbot rows deleted directly in the database.** `documents` rows cascade, but the uploaded files and the chatbot's
    Qdrant points are not removed. Use `DELETE /api/admin/chatbots/:id` (or the dashboard's **Delete chatbot**) instead: it
    removes the vectors, the stored files and the rows of that chatbot only, in a repeatable order (see API.md, "Removing
    knowledge and chatbots"). A page removed with `DELETE .../pages` can come back with the next full re-index (there is no
    exclusion list yet).
12. **Visitor enquiries are personal data.** The contact form stores the visitor's name, email address and question
    (`enquiries` table) so a failed email never loses them. They are returned only by the admin API (admin key, one
    chatbot at a time) and deleted with their chatbot; server logs record only the chatbot ID and the email status,
    never the visitor's details (the chat route logs only the question's length, not its text). A failed email stores
    an error code only. There is no automatic retention limit yet: decide how long to keep handled enquiries.
    **Known limitations:** (a) any client that knows a chatbot ID can submit an enquiry for it (rate-limited, ready
    chatbots only, allowed websites enforced for browsers); a signed, short-lived token in the unanswered chat response,
    checked by `/api/chat/contact`, is the recommended follow-up. (b) Every admin key can read every chatbot's enquiries;
    a logged-in customer reads only those of their own chatbots (another chatbot's ID → 404).
