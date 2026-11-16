# Local Setup and Testing — Step by Step (Windows)

For a Windows laptop. `<project folder>` below means the folder you cloned this repository into. Use **Command Prompt (cmd)**. Commands are exactly what the project
supports; lines starting with `REM` are comments.

## Step 1 — Check the services

| Service | Check | Good result |
|---|---|---|
| Node.js / npm | `node -v` and `npm -v` | `v22.x` / `10.x` |
| PostgreSQL 18 (Windows service, starts automatically) | `sc query postgresql-x64-18` | `STATE : 4 RUNNING` |
| Docker Desktop | `docker ps` | a table (not "error during connect") |
| Qdrant (Docker container `qdrant`) | `curl http://localhost:6333` | JSON with `"title":"qdrant…"` |
| Ollama | `curl http://localhost:11434/api/tags` | JSON listing the models |
| Models | `ollama list` | `qwen3:4b-instruct-2507-q4_K_M`, `qwen3:4b`, `nomic-embed-text` |
| Ports | `netstat -ano \| findstr ":3000 :5050"` | empty before starting (nothing else using them) |

If Docker is not running: start **Docker Desktop** from the Start menu (or
`"%LOCALAPPDATA%\Programs\DockerDesktop\Docker Desktop.exe"`), wait ~1 minute, then `docker start qdrant`.
If Ollama is not running: start **Ollama** from the Start menu.

## Step 2 — Start the application

**Terminal 1 (keep it open — this is the server):**

```cmd
cd <project folder>
npm start
```

Success looks like:

```text
AI Chatbot API running at http://localhost:3000
Server version: hardened-v21
```

Leave this window open; questions and indexing are logged there. To stop: **Ctrl+C**. Start it only once — a second
`npm start` fails with "port 3000 in use" (that means it is already running).

Check: open `http://localhost:3000/api/health` → `"success":true` with `qdrant`, `ollama` and `database` all `"ok"`
and `"version":"hardened-v21"`.

**Terminal 2 (only for the widget demo — the pretend customer website):**

```cmd
cd <project folder>
npm run demo:host
```

→ `Open: http://localhost:5050/`. Keep it open too.

## Step 3 — Open the dashboard

`http://localhost:3000/` → **Platform admin? Use the admin key instead** → paste the admin key into **Admin key** → **Connect** → the top bar shows *Platform admin*. The key is in `.env`
(`ADMIN_API_KEY`); open `.env` yourself in VS Code to copy it — never paste it into chat, email or documents.

## Step 4 — Choose the chatbot

Use the existing **`https://docs.python.org/3/faq/`** chatbot (status *Partially indexed*, 10 pages, 206 sections).
Click **Manage**. You do not need to create a new one. To try registration live, add a different small public site
(see Step 5); adding the same address again only opens the existing chatbot.

## Step 5 — Index a website

- New site: **+ Add website** → *Website address* (e.g. a small public docs/help site) → *Page limit* `5` →
  **Create chatbot**. The card shows *Reading pages…* → *Preparing answers…* → *Saving…*, then *Ready* or
  *Partially indexed*. 5 pages take roughly 30–60 s here.
- Existing site: **Manage → Overview → Page limit** `10` → **Read the website again**. The old knowledge keeps answering until
  the new one is stored.
- *Failed* shows the reason (e.g. robots.txt, no readable content); see [TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Step 6 — Test answer quality (Manage → Test)

| Ask | Expected (from the Python FAQ) | Source card |
|---|---|---|
| What is Python? | interpreted, interactive, object-oriented language… | General Python FAQ → `general.html#what-is-python` |
| Why are Python strings immutable? | performance (space allocated at creation, fixed); strings are "elemental" like numbers | Design and History FAQ → `design.html#why-are-python-strings-immutable` |
| How do I make a Python script executable on Unix? | `chmod +x scriptfile` and a first line `#!/usr/bin/env python` (or the interpreter path) | Library and Extension FAQ → `library.html#…executable-on-unix` |
| then: What about on Windows? | add `.py` to the `PATHEXT` environment variable | Python on Windows FAQ |
| Can I use Python for commercial purposes? | yes, as long as you keep and display the copyrights | General Python FAQ → `…copyright-restrictions…` |

First answer after a pause ~30 s (model loading), then ~10–20 s. More in [VERIFYING_ANSWERS.md](VERIFYING_ANSWERS.md).

## Step 7 — Test the fallback

Ask: `What is the price of a Python certification exam?` → exactly
`I could not find this information on the website.` and no source chip.

## Step 8 — Verify sources

Click the source chip under an answer. The docs.python.org page opens at the cited section. Compare: same
facts, no added numbers or names, conditions kept.

## Step 9 — Customise the widget

**Appearance** → *Chatbot name* `Python FAQ Assistant`, *Welcome message* `Hi! Ask me anything from the Python FAQ.`,
*Colour* `#0f766e` → **Save settings** → "Settings saved". Confirm: **Test** tab header shows the new name; on the test
host page (Step 10) the panel shows the name, welcome message and colour after a reload.

## Step 10 — Install and test the widget on a separate website

The test host page `demo/customer-site.html` currently embeds the **GIIT Solutions Assistant** chatbot
(`https://giitsolutions.com/`). Its active line, between the `PASTE THE SNIPPET` comments, is:
```html
<script src="http://localhost:3000/widget.js" data-chatbot-id="f0b8f15f-5aa5-4093-ade5-bfdd18f016c2" async></script>
```
The Python FAQ chatbot's line (`data-chatbot-id="5375ea8a-b021-4288-930c-c28a7a300333"`) is directly below it,
commented out. To show the Python FAQ chatbot (Steps 4–9) on the test host instead, comment out the GIIT line and
remove the comment marks around the Python line, then save.

1. **Install** → **Copy code** shows the same kind of line for the chatbot you are managing. For any other chatbot,
   replace the active line in `demo/customer-site.html` with its copied code and save.
2. Terminal 2 must be running `npm run demo:host`. Open `http://localhost:5050/`.
3. Click the round button (bottom-right) → ask a question the embedded chatbot's website answers (GIIT: "What
   DevOps services do you provide?"; Python FAQ: "Why are Python strings immutable?") → answer + source chip → click it.
4. Ask something that website does not cover → exact fallback `I could not find this information on the website.`
5. F12 → **Console**: no red errors. **Network** → filter `chat`: `POST http://localhost:3000/api/chat` → `200`.
6. Allowed websites (optional): **Appearance** → allowed websites `http://localhost:5050` → **Save settings**. Then
   `http://127.0.0.1:5050/` (a different origin) shows *This chatbot is not enabled for this website.* (Network: `403`).
   Clear the box and save again afterwards if you want it allowed everywhere.

Details: [EMBED.md](EMBED.md).

## Step 9b — Email for unanswered questions (optional)

1. In `.env` (open it yourself; never paste it anywhere) add your mail server: `SMTP_HOST`, `SMTP_PORT` (587, or 465
   with `SMTP_SECURE=true`), `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` (see `.env.example`). Restart the server.
2. **Overview** → *When the bot can't answer* → *Support email* → your support address → **Save**.
3. **Test** → ask something the website does not cover → the exact fallback answer, then the contact form → fill
   it in → **Send question** → "Thank you. Your question has been sent…". Check the support mailbox; reply to
   the email to answer the visitor.

Without SMTP settings the dashboard shows "Email is not set up on this server yet" and visitors never see the button.

## Step 11 — Automated tests (server running; run one at a time)

| Order | Command | Takes | Checks |
|---|---|---|---|
| 1 | `npm run check` | <1 min | syntax of every file |
| 2 | `npm test` | ~4 min | offline unit tests: URL/SSRF validation, crawl rules, extraction, policy decisions, answer guards, DNS pinning, redirects/robots |
| 3 | `npm run test:http` | ~10 s | API validation, auth, CORS, headers, dashboard API, settings |
| 4 | `npm run test:dashboard` | ~30 s | dashboard in a real browser |
| 5 | `npm run test:widget` | ~2 min | widget error states and safety |
| 6 | `npm run test:embed` | ~2–4 min | real install on a separate website (dashboard → snippet → visitor) |
| 7 | `npm run test:runtime` | ~1 min | cache, one question per visitor, cancellation |
| 8 | `npm run test:python-faq` | ~3–5 min | 11 source-backed questions on docs.python.org |
| 9 | `npm run test:answers` | ~5–15 min | 25 answer-quality and isolation cases |
| 10 | `npm run test:helpcenter` | ~3–8 min | local help-centre fixture: steps, policies, exceptions, isolation |
| 11 | `npm run test:indexing` | ~2–4 min | background indexing of a public docs section. Needs all 3 crawls allowed per 10 minutes: run it first, or 10 minutes after `test:http` (which starts one) |
| 12 | `npm run test:ingest` | ~5–8 min | crawler on a local fake site (no server needed) |
| 13 | `npm run test:contact` | ~20 s | Email your question with a fake mail transport (no server needed, nothing sent) |
| 14 | `npm run test:sop` | ~5–10 min | three synthetic SOPs: right SOP/page/section, document links, management (no server needed) |

Each prints a table and `ALL n PASSED` or `n FAILED`. Close other heavy programs first; this laptop has little free
memory and one 4 GB GPU. A test that fails only with "Timeout … launching browser" or "CUDA out of memory" is an
environment problem: re-run it alone. Details: [TESTING.md](TESTING.md).

## Step 12 — Pre-demo checklist

- [ ] Docker Desktop running; `curl http://localhost:6333` OK; Ollama running.
- [ ] Terminal 1: `npm start` → `http://localhost:3000/api/health` all `ok`, version `hardened-v21`.
- [ ] Terminal 2: `npm run demo:host` → `http://localhost:5050/` shows the test host page.
- [ ] Dashboard connected; docs.python.org FAQ chatbot shows *Partially indexed*, 10 pages, 206 sections.
- [ ] Warm-up: ask "What is Python?" once in **Test** (loads the model; later answers are faster, repeats instant).
- [ ] Appearance saved (name/welcome/colour) and visible on `http://localhost:5050/` after a reload.
- [ ] Allowed websites: empty (or `http://localhost:5050`) — not something that blocks the demo page.
- [ ] Close Chrome tabs/apps you do not need (memory).
- [ ] Optional: `npm run test:embed` passes (~3 min).

## Data safety

- Qdrant data lives in the Docker volume of the `qdrant` container. Never run `docker rm -v qdrant` or
  `docker volume rm …`. Snapshot: `curl -X POST http://localhost:6333/collections/website_content/snapshots`
  (one was taken on 2026-10-15 before re-indexing the Python FAQ).
- Release snapshots of the code are in `backups/release-*` (git-ignored), each with `ROLLBACK.md` where applicable.
