# Indexing a Website and Verifying the Answers

How a website becomes chatbot knowledge, and how to check that answers are **correct**, not just fluent.

## From website to answer (what happens, and where in the code)

| Step | What happens | Code |
|---|---|---|
| 1. Register | The address is validated (public http/https, ports 80/443, every DNS answer public) and a chatbot row is created in PostgreSQL with status *pending* | `chatbotRegistry.js` `registerChatbot`; route `POST /api/register` |
| 2. Start indexing | `POST /api/website` (dashboard: **Create chatbot** / **Read the website again**) starts a background job (`202`), at most one per chatbot | `server.js` `runIndexing`, `indexingJobs` |
| 3. Discover pages | robots.txt and sitemap are read; a headless Chromium (Playwright) opens the start page, follows same-site links (help/docs pages first) up to the page limit; every request and redirect is SSRF-checked and pinned to the checked IP | `ingest.js` `crawlWebsite`, `loadRobotsRules`, `discoverSitemapUrls`, `pinnedRequest` |
| 4. Extract | Navigation, footers and scripts are removed; headings, paragraphs, numbered steps, notes/warnings and code blocks are kept in order, with each section's anchor | `ingest.js` `extractSections` |
| 5. Chunk | Each section is split into pieces of ≤ 280 words without cutting a step in half; each piece starts with its heading | `ingest.js` `createChunks` |
| 6. Embed | Each piece is turned into a 768-number vector by `nomic-embed-text` (Ollama), 16 at a time; unchanged pieces reuse their old vectors | `ingest.js` `createEmbeddings` |
| 7. Store | Vectors + text + URL + title + section + anchor + `chatbotId` are written to the Qdrant collection `website_content`; old pieces are deleted only after the new ones are stored | `ingest.js` `ingestWebsite` |
| 8. Record | Status *ready*, pages, failed pages, partial/complete, time, last error saved in PostgreSQL | `chatbotRegistry.js` `recordIndexingResult` |
| 9. Retrieve | A visitor question is embedded and searched in Qdrant **filtered by that chatbot's ID**, then re-ranked by keyword and heading overlap | `server.js` `searchWebsite`, `rerankResults`, `getRelevantResults` |
| 10. Answer | Refund/eligibility questions with a date/amount: computed from the matching rule (`policyCheck.js`). Otherwise the local model (`qwen3:4b-instruct`, Ollama) writes an answer from the retrieved pieces only, then guards reject answers with numbers/links not in the text, leaked instructions, or a subject the pages do not mention → exact fallback | `server.js` `askLLM`, `hasUnsupportedDetails`, `questionSubjectIsCovered`; `policyCheck.js` |
| 11. Sources | The pages whose text the answer used (max 3), each linking to `page#section` | `server.js` `createSources`, `selectUsedSources` |

**Registered ≠ indexed.** Registration only stores the address. Until an indexing job succeeds the chatbot is
*Pending* and the chat API answers `409 not ready`. Indexing can also end *Failed* (nothing readable) or *Partially
indexed* (page limit reached).

## Verified example: docs.python.org FAQ

Chatbot `5375ea8a-b021-4288-930c-c28a7a300333`, start page `https://docs.python.org/3/faq/`. robots.txt allows the
FAQ; the site is public documentation. Re-indexed 2026-10-15 with page limit 10: 10 pages, 206 sections, 80 s
(crawl ~25 s, preparing 206 sections ~53 s), status *Partially indexed* (the FAQ links to more pages than 10).

Expected facts were copied from the live pages **before** asking the chatbot. Results through the real API
(`npm run test:python-faq`, port 3000):

| # | Type | Question | Expected (from the page) | Source section | Result | Time |
|---|---|---|---|---|---|---|
| 1 | supported | What is Python? | interpreted, interactive, object-oriented; modules, exceptions, dynamic typing… | general.html#what-is-python | ✅ correct, near-verbatim | 12.2 s |
| 2 | supported | Why are Python strings immutable? | performance (space allocated at creation, fixed storage); strings "elemental" like numbers | design.html#why-are-python-strings-immutable | ✅ correct | 0.3 s (cached) |
| 3 | supported | How stable is Python? | very stable; releases every 6–18 months; feature release every 12 months since 3.9 (PEP 602) | general.html#how-stable-is-python | ✅ correct; one typo: "PEP -602" | 9.5 s |
| 4 | procedural | How do I make a Python script executable on Unix? | `chmod +x` (or 755) and a first line `#!` + interpreter path; `#!/usr/bin/env python`; not for CGI | library.html#how-do-i-make-a-python-script-executable-on-unix | ✅ correct; the `/bin/sh` hack is shown without its `""":"` lines | 16.4 s |
| 5 | procedural | How do I create static class data in Python? | define a class attribute; assign through the class name (`C.count = …`) | programming.html#how-do-i-create-static-class-data-and-static-class-methods | ✅ correct core; "shared among all instances" is the model's paraphrase | 7.0 s |
| 6 | condition | Can I use Python for commercial purposes? | yes, **as long as** copyrights are left in and displayed in documentation | general.html#are-there-copyright-restrictions-on-the-use-of-python | ✅ condition kept | 15.6 s |
| 7 | condition | Do interfaces stay the same within a series of bugfix releases? | guaranteed to remain the same | general.html#how-stable-is-python | ✅ correct | 14.6 s |
| 8 | unsupported | What is the price of a Python certification exam? | not in the indexed pages ("certification" absent) | – | ✅ exact fallback | 0.3 s |
| 9 | unsupported | Who is the current chair of the Python Software Foundation board? | not in the indexed pages ("chair" absent) | – | ✅ exact fallback | 7.2 s |
| 10 | paraphrase | Why can't a string be modified after it is created in Python? | same as #2 | design.html#… | ✅ correct; last sentence ("constant and reliable") is the model's wording | 15.3 s |
| 11 | follow-up | (after #4) What about on Windows? | installer associates `.py`; add `.py` to `PATHEXT` to run without the extension | windows.html#how-do-i-make-python-scripts-executable | ✅ correct, context kept | 7.9 s |

11/11 pass the automatic checks (facts + exact source section). Manual reading found three small wording issues
(#3, #4, #5): the facts are right, but a small model sometimes paraphrases or simplifies. That is why every answer
shows its source link. Eleven questions do not prove the chatbot is always right.

"Not found" means **not in the indexed pages**, which can differ from "not on the whole website": with a page
limit, some pages are never read (status *Partially indexed*).

## How to verify an answer yourself

1. Ask the question in **Manage → Test** (or in the widget on the test host page).
2. Click the source chip under the answer. The original page opens at the section (`#anchor`).
3. Check: the title and URL are the page you expect; every fact in the answer appears in that section; nothing extra
   (numbers, names, links) was added; conditions and exceptions ("as long as…", "only…") are kept.
4. For a "not found" answer, search the page (Ctrl+F) or the site to confirm the information is really absent; if it
   exists on a page that was not indexed, raise the page limit or index the section that contains it.
5. To repeat the whole matrix automatically: `npm run test:python-faq` (server running; ~3–5 min).

To test another website, write the expected facts from its pages first, then ask; never adjust the expectation to
match the chatbot's answer.
