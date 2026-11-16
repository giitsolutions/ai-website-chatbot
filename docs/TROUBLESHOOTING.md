# Troubleshooting

## Server and services

| Symptom | Cause | Fix |
|---|---|---|
| `http://localhost:3000` does not open | Server not running (window closed) | Terminal: `cd <project folder>` then `npm start` |
| `npm start`: `EADDRINUSE … 3000` | It is already running in another window | Use that window; or `netstat -ano \| findstr :3000` and close that process |
| Health: `"qdrant":"error"` | Docker Desktop or the `qdrant` container is stopped | Start Docker Desktop, wait, `docker start qdrant` |
| Health: `"ollama":"error"` or a model missing | Ollama not running / model not pulled | Start Ollama; `ollama list`; `ollama pull qwen3:4b-instruct-2507-q4_K_M` |
| Health: `"database":"error"` | PostgreSQL service stopped | `sc query postgresql-x64-18`; start it from Services (`services.msc`) |
| `docker ps`: "error during connect" | Docker Desktop not started (common after a reboot) | Start Docker Desktop and wait ~1 minute |

## Dashboard

| Symptom | Fix |
|---|---|
| "Admin key not accepted" | Copy `ADMIN_API_KEY` from `.env` again (no spaces). After changing `.env`, restart the server. |
| Admin features "not available (503)" | `.env` has no valid admin key (≥ 32 characters); the server refuses admin requests until one is set |
| Pages "–", Last indexed "not recorded" | Indexed before statistics were recorded; **Read the website again** fills them in |
| Several *Pending* cards for the same site | Old development registrations; harmless. They are kept, not deleted |
| "Too many crawl requests" | 3 crawls per 10 minutes; wait |
| Indexing *Failed* | Read the reason on the card: robots.txt block, no readable text, site unreachable, private address |

## Answers

| Symptom | Fix |
|---|---|
| First answer takes ~30 s | The model is loading (≈ 10 s) plus the embedding model (≈ 2 s); later answers ~10–20 s |
| "The assistant is busy right now" | One answer is generated at a time; wait a minute |
| "temporarily unavailable" | Ollama ran out of GPU memory and the automatic retry also failed; close other programs, try again |
| "took too long to answer" (after 4 minutes) | The laptop is overloaded; close Chrome tabs and other apps |
| Fallback although the site has the answer | The page may be outside the page limit (*Partially indexed*); raise the limit and re-index |

## Widget on a website

| Symptom | Fix |
|---|---|
| No chat button | F12 → Console: "data-chatbot-id is missing or invalid" = wrong ID. Network: `widget.js` must be `200` (server running? address in `src` right?) |
| "Could not reach the assistant" | Server down or wrong address in the snippet |
| "This chatbot is not enabled for this website." | The page's origin is not in **Appearance → Websites allowed**. Add it (e.g. `http://localhost:5050`) or clear the list |
| "This chatbot is not ready yet" | Chatbot still *Pending*/indexing |
| Name/colour not updated | Reload the page (settings load when the widget starts); `data-title`/`data-accent` on the script tag override them |
| `npm run demo:host`: "Port 5050 is in use" | `node demo/serve.js 5051` and open `http://localhost:5051/` |
| Works locally, not on a real HTTPS website | The chatbot server must also be HTTPS and publicly reachable (not set up yet) |

## Tests

| Symptom | Fix |
|---|---|
| `browserType.launch: Timeout` | Not enough free memory for Chromium; close apps, run the suite alone |
| `CUDA error: out of memory` in the server window | Two models competing for the 4 GB GPU; wait and re-run |
| `test:indexing` gets 429 | The 3-crawls-per-10-minutes quota was used by earlier crawls; wait 10 minutes |

## "The information is on the website, but the chatbot says it cannot find it"

Trace the question (server running; the admin key is read from `.env` and never printed):

```cmd
npm run diagnose -- <chatbotId> "What are your membership prices?" --url https://www.example.com/plans.php
npm run diagnose -- <chatbotId> "What are your membership prices?" --generate
```

| What the trace says | Meaning | What to do |
|---|---|---|
| `page`: "found but not read: the crawl stopped at a limit" | The page was discovered but the crawl ran out of pages or network requests first | Dashboard → Overview → "Last read": stop reason. `page-limit`: raise the page limit and re-index. `request-limit`: the site loads many scripts per page; see Roadmap (request allowance) |
| `page`: "not indexed and not found by the last crawl" | No read page links to it and it is not in the sitemap (or it is on another domain) | Link it from the site's menu or add it to the sitemap, then re-index |
| `page`: "found but could not be read: HTTP 500" (or another reason) | The website returned an error for that page | Fix the page on the website |
| `page`: "not indexed (no crawl report …)" | Indexed before crawl reports existed | Re-index to get a report |
| `retrieval`: the page's sections are listed but "rejected: …" | Retrieved, then not sent to the model; the reason is shown per section (score below the relevance rules, too far below the best match, 2 sections from this page already chosen, near-copy of a chosen section, 5 already chosen) | Usually a wording or content-structure issue; check the `preview` text |
| `subject-check: passed false` | The question's subject words do not appear in the sections sent to the model | The site does not mention it in those sections |
| `decision`: "the model found no answer in the sections it was given" | The model saw the sections and found no answer | Check the sections' `preview`: is the fact really there? |
| `decision`: "guard: … numbers, links or emails not found in the website text" | The model's reply was rejected because it contained details that are not in the website text | Correct behaviour (no invented facts) |

The same trace is available at `POST /api/admin/chatbots/:id/diagnose` (see API.md).
