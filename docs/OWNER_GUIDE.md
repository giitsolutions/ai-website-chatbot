# Dashboard Guide (website owner / admin)

The dashboard is one page: **`http://localhost:3000/`** (file `public/index.html`). No programming is needed to use it.
It talks only to the admin API (`/api/admin/...`, `/api/register`, `/api/website`) with the admin key.

## Screen layout

| Area | What it is |
|---|---|
| Login screen (shown when logged out) | Customers enter their email and password and click **Log in**. A platform admin clicks **Platform admin? Use the admin key instead**, pastes the key and clicks **Connect**. A wrong key shows "not accepted". The key is kept only in the page's memory (not in browser storage); after a reload, enter it again. |
| Top bar (after logging in) | The **Chatbot** dropdown (choose a chatbot, or *All chatbots* for the list), **+ Add website**, **Refresh**, *Platform admin* (admin key) or *Logged in as <email>*, **Log out** |
| **+ Add website** | Opens a window: *Website address* + *Page limit* (1–50, default 20) + **Create chatbot** |
| **Your chatbots** (shown under *All chatbots*) | One card per chatbot: address, status badge, statistics, progress bar while indexing, last error if any, **Manage** button. **Refresh** in the top bar reloads the list (it also refreshes by itself while a job runs). |
| Chatbot detail (after **Manage**, or chosen in the dropdown) | Name, address, last read date, status, and six tabs: **Overview**, **Test**, **Documents**, **Enquiries**, **Appearance**, **Install** |

## Customer login

If the platform admin gave you an account, enter your email and password on the login screen and
click **Log in**. The top bar then shows *Logged in as <email>* and **Log out**. You see only your own chatbots. You stay
logged in for up to 12 hours, or until 2 hours without activity; then the dashboard returns to the login form and asks
you to log in again. After 5 failed attempts, wait 15 minutes or ask the platform admin to reset your password.

## Customer accounts (platform admin)

After connecting with the admin key, the **Customer accounts** section appears:

- **Create account:** an email and a password of 12 to 200 characters. Give the password to the customer privately.
- **Assign a chatbot:** choose a chatbot and its owner, then **Assign**. *No owner* means only the admin key can see it.
- **Reset a password:** ends that account's sessions.
- **Disable / Enable:** a disabled account is logged out and cannot log in.

To use the admin key and a customer login side by side, use a private/incognito window for the customer: while a customer
is logged in, a window does not offer the admin-key link, and while connected with the key it does not offer the login form.

## 1. Connect (platform admin)

1. Open `http://localhost:3000/`.
2. Click **Platform admin? Use the admin key instead**, then paste the admin key into **Admin key** (ask the person who set up the server; it is in their `.env`, never in chat
   or email).
3. Click **Connect** → the top bar shows *Platform admin*, and **Your chatbots** fills in.

## 2. Add a website (registration + indexing)

Click **+ Add website** in the top bar, then:

1. **Website address**: the public site the chatbot should know, ideally its help centre or docs
   (e.g. `https://docs.python.org/3/faq/`). Private, local (`localhost`, `192.168…`) and non-standard-port addresses are refused.
2. **Page limit**: how many pages to read (5–20 is a good demo size; each page takes ~2 s to read plus ~0.3 s per
   section to prepare).
3. Click **Create chatbot**.

Registering creates the chatbot record (status *Pending*); indexing then reads the pages in the background. A
website that already has a chatbot is not duplicated: the dashboard opens the existing one ("This website already has
a chatbot…") and you use **Read the website again** instead.

While indexing, the card shows a progress bar: *Reading pages: N of up to L* → *Preparing answers: N of M sections* →
*Saving…*. You can leave the page; the job continues on the server.

## Statuses and statistics

| Status | Meaning | What to do |
|---|---|---|
| Pending | Registered, never indexed | **Manage → Overview → Read the website again** |
| Indexing | A job is running | Wait; a second click is refused ("already running") |
| Ready | Indexed, and every page found within the limit was read | Test and install |
| Partially indexed | Indexed, but the page limit stopped the crawl before all linked pages were read | Raise the page limit and re-index if answers are missing — it still answers from what it has |
| Failed | Nothing usable could be indexed; the reason is shown ("Last indexing failed: …") | Fix the cause (see Troubleshooting) and re-index |

| Statistic | Meaning |
|---|---|
| Pages indexed | Pages read and stored in the last successful indexing |
| Sections | Pieces of text the chatbot searches (counted live in the vector database) |
| Pages that failed | Pages that returned an error (e.g. 404) during the last indexing |
| Last indexed | When the last successful indexing finished |

**Last read (Overview).** After indexing, the Overview shows every address the crawler found and what happened to it:
*Indexed* (with its number of sections), *Failed* (HTTP or network error), *Skipped* (with the reason: another website,
robots.txt, not a web page, login/checkout page, redirect to a page already read, same content as another page, no
readable text) or *Not processed (limit)* (the page limit or the network-request limit stopped the crawl first). The counts
add up: found = indexed + failed + skipped + not processed; "pages read" are the pages actually fetched. Use the status
filter and the search box (part of the address or reason) to find one page. Chatbots indexed before this report existed
show "Re-index to see every address found".

**"–" and "not recorded (re-index to update)"**: chatbots indexed before these statistics existed (before release v18)
have sections but no recorded page count or date. Nothing is wrong with their knowledge; **Read the website again** records the
details. (The docs.python.org FAQ chatbot was re-indexed on 2026-10-15 and now shows 10 pages, 206 sections.)
The `example.com` and `127.0.0.1` cards marked *Pending* are old development registrations that were never indexed;
they are kept, not deleted.

## 3. Overview tab

Shows the statistics, a live progress bar while indexing, the last error, and **Refresh the chatbot's knowledge**:
choose a *Page limit* and click **Read the website again**. Unchanged sections are reused (faster), and the old knowledge keeps
answering until the new crawl has been stored. A failed re-index leaves the old knowledge in place.

**While a crawl runs** the Overview shows it live (refreshed every 2 seconds): the address being read and what is
happening to it (*fetching*, *extracting text*), the counts (found, queued, in progress, read and waiting to be stored,
indexed, failed, skipped, not processed, remaining) and a table of every address found so far with its status, HTTP
status, reason, final address after a redirect and retry attempts. Pages are read first and stored together at the end,
so *read, waiting to be stored* turns into *Indexed* (or *Skipped*, no usable text) in the last step.

**Read chosen pages (no full re-crawl).** To add a new page, retry a page that failed, or read pages the last crawl did
not reach:
- type up to 10 addresses of this website (one per line) under **Read chosen pages** and click **Crawl these pages**; or
- in the *Last read* table click **Retry** (failed page) or **Crawl** (page not processed because of a limit); or
- tick several rows and click **Crawl selected pages**.

Only those pages are read (no sitemap, no links followed), with the same rules as a full crawl: same website and
port, robots.txt, safe addresses. When it finishes, each address shows **Indexed**, **Already up to date**,
**Skipped** (with the reason) or **Failed** (with the reason, e.g. "HTTP 503 (after 3 attempts)"), and its row in the
*Last read* table is updated. A page that fails keeps the version indexed earlier; nothing else is changed. A page
crawl cannot start while a full crawl or another page crawl of the same chatbot is running. E-mail addresses written
as links ("…/name@example.com") are refused with the reason.

**Last full crawl vs now.** The *Last read* box shows the totals of the last full crawl and, below them, the current
state of every address: after single-page crawls, and checked against the content actually stored. An address that
was recorded as "not indexed" although its content is stored under the same page with or without "www." is shown as
**Indexed (under another address form)**; one whose latest attempt failed but whose earlier version is still used is
shown as **Earlier version still indexed**. The recorded status stays in the details. The statistics at the top use
the current counts ("Pending (not processed)" = addresses still waiting).

**Crawl warnings.** The *Last read* box can show these after a full crawl. They come from a website's own setup, and the
crawl still ran:
- **JS-rendered site:** the text comes from scripts, so the crawl takes a little longer per page.
- **The menu uses buttons, not links:** the crawler follows links only, so what these buttons show was not read (the
  warning names the buttons). The platform admin can tick **Click menu buttons while reading** in Overview and re-index: the crawler
  then clicks the start page's menu buttons (never ones like sign up, pay or delete) and adds what they show. Better
  still, ask the website's developer for real links, or upload the missing text as a document.
- **Menu buttons clicked:** how many were clicked, which ones showed new text, and which led to a new page address. The
  list under it gives each button's result.
- **Thin content:** under 500 words were read, so many questions cannot be answered.
- **Canonical address, sitemap or robots.txt sitemap on another domain:** usually a leftover from a staging or old
  address. The other domain's pages are never crawled, but the website's developer should correct it.

**Continue pending addresses.** Under the table: choose *Pages per batch* (1–10), optionally *Only addresses under*
(a section such as `/docs/`; it is pre-filled with the folder of the registered address) and *Include failed
addresses*, then click **Process next batch**. Only the next addresses are read, with the normal checks and limits;
the result appears above, the counts update, and you start the next batch when you are ready. Live progress exists only
while a crawl runs in the server process; after a server restart the saved report is still shown.

**Re-indexing keeps the chatbot answering.** While a chatbot that already has knowledge is re-indexed, visitors keep
getting answers from the existing knowledge (the dashboard shows the job as "indexing").

**Removing knowledge or the chatbot.** Three separate actions; none can be undone:
- *Remove* next to an indexed address in the crawl report removes only that page's knowledge (other pages and documents
  stay). A later full re-index can add the page again.
- **Remove website content…** removes every indexed page and the crawl report. The chatbot, its settings and its
  documents stay; with an indexed document it keeps answering from the documents.
- **Delete chatbot…** removes everything of this chatbot: settings, indexed pages, documents and their stored files. The
  embed code stops working.

Both buttons first show what will be removed and ask you to type the website's domain. They are refused while the
chatbot is being indexed or a document is being processed. If a deletion is interrupted, the chatbot shows **deleting**
and stops answering; click **Delete chatbot…** again to finish it.

## 4. Test tab

A preview of the chat (the full-page widget, `widget.html`) for this chatbot. Ask the questions your visitors ask.

- Answers come only from the indexed pages, with small source chips showing the section and the website (a chip opens
  the original page at that section).
- If the indexed pages do not contain the answer: exactly *I could not find this information on the website.*
- Refund/eligibility questions with a date or amount ("I bought hosting 45 days ago…") are decided by comparing
  the numbers with the matching rule on the site; the answer quotes the rule. If the product is unclear, it asks.
- Short follow-ups ("What about on Windows?") use the previous question as context.
- The first answer after a pause takes longer (~30 s) because the model has to load; later answers ~10–20 s;
  a repeated question is instant (cached).

**Explain an answer** (below the preview): type a question and press **Explain**. It runs the same pipeline as the chat
and shows the result (answered, or the reason for the fallback — e.g. "no retrieved section passed the relevance
rules", or the check that rejected the model's reply), the answer and its sources, what is indexed, and every retrieved
section with its scores and whether it was sent to the model. Use it to tell *the information is not indexed* (missing
from the crawl report / not retrieved) from *it was retrieved but not used*. Untick **Ask the model too** for a quick
retrieval-only check.

## 5. Appearance tab

| Field | Effect on the widget |
|---|---|
| Chatbot name | Header of the chat panel |
| Welcome message | First message in the panel |
| Colour | Launcher, the round icon in the header, and the visitor's messages (`#rrggbb`, or use the colour picker). The default is green; text on a light colour turns dark. |
| Websites allowed to show this chatbot | One origin per line (e.g. `https://www.example.com`). Empty = any website. Other websites get "This chatbot is not enabled for this website." It stops casual copying of your widget; it is not a password. |

Click **Save settings** → "Settings saved". Installed widgets pick the settings up the next time a visitor loads a
page (no new snippet needed). Invalid values are explained (e.g. a colour that is not `#rrggbb`).

### Support email (Overview tab, card *When the bot can't answer*)

When the chatbot answers "I could not find this information on the website.", visitors see a contact form below the answer (their question, name, email, optional details). Every submitted question is saved in the **Enquiries** tab. If this address is set and the server has email settings (SMTP, see SETUP.md), it is also emailed here; replying to that email answers the visitor. Empty = questions are only saved in the Enquiries tab (no email). The address is never shown to visitors.

Below the support email field, the dashboard lists up to 5 addresses the last full crawl found on your website: **Found on
your website: `<address>` (from `<where>`) [Use this]**. They come from email links, structured data (JSON-LD), and the
footer, contact and about text, also when written as `info [at] site.com`. The website's own domain comes first (support@,
help@, contact@, info@), then other addresses it shows, such as a gmail address. **Use this** only fills the field: nothing
changes until you click **Save**, and a crawl never sets the address. Check that the address is right: it comes from
the page's text, and could belong to someone else, such as the web designer. Chatbots crawled before this feature show
suggestions after their next full crawl.

Click **Save** → "Support email saved".

## 6. Documents tab

Add documents the chatbot should know besides the website — procedures, manuals, policies:

1. **Manage** → **Documents** → *Documents*: choose one or more files (Ctrl/Shift-click) → **Upload**.
2. Each file shows *processing…* with its current step (*queued*, *reading text*, *creating embeddings 3/8*, *saving*),
   then **indexed** (with its pages and sections) or **failed** with the reason.
3. Ask questions in **Test**: answers can use the website, the documents or both; a document source chip shows the file
   name and page (for PDFs) and the section. In PDFs, numbered headings such as `4. Processing Time` become sections, so
   citations name the right part of a long SOP.
4. **Re-index** processes one document again (a failed re-index keeps the previous version); **Remove** deletes that
   document's knowledge only — the website and other documents are not affected. **Open** shows the stored file (for you
   only).
5. **Visitors may open this document** (off by default): when ticked, a citation of this document gets an *Open document
   at page N →* link, so visitors can read the original at the cited page (PDFs open at that page; Word files are
   downloaded). Each link is signed and stops working after 1 hour; unticking the box (or removing the document) stops
   all links at once. Leave it off for documents visitors should not have as a file.

Supported: **PDF** (text-based) and **Word .docx**, up to 10 MB each, 50 per chatbot. Not supported: scanned PDFs (images
only — they fail with "No readable text found"), old **.doc** files (save as .docx first), images, spreadsheets.
A .docx that expands to more than 100 MB when opened, or a file that takes longer than 2 minutes to read, is stopped and
marked **failed** with the reason; the chatbot keeps answering meanwhile.

> **Uploaded documents are not private.** Their content becomes part of the chatbot's knowledge, and the chatbot can quote
> it in answers to **anyone who can use the chatbot**: every visitor of a website where the widget is installed, and
> anyone who knows the chatbot ID (the chat API is public by design; "Websites allowed" only limits browsers, not
> other programs). Visitors cannot download the file unless you tick *Visitors may open this document*, but they can ask
> about what it says, and citations show its file name, page and section. Upload only material you would also publish on your website — never confidential, personal,
> internal-only or customer data.

## 6b. Enquiries tab

When the chatbot cannot answer a visitor's question from this website's information, it says so and shows a short
form right in the chat: the visitor's original question, their name and email address, and optional details. The form
is shown whether or not a support email is set in the Overview tab; without one, questions
are only saved here (no email).

Every submitted question is **saved** and listed in the **Enquiries** tab (newest first; filter Open / Handled / All):
the question, the visitor's name and email address (a link to reply by email), any details, when it arrived, and the
email status: **Accepted by mail server** (this does not prove it reached the inbox), **Email could
not be sent** (with a short error code), **No email sent (server email not configured)**, or **No email sent (no support
email was set)**. If the server's email (SMTP) is configured and a support email is set, a notification is emailed to
it; otherwise the tab says what is missing, and questions are only kept here. A notification that failed can be sent
again with **Resend** (to the chatbot's current support email). After replying, select **Mark as handled** (**Reopen** undoes it). The tab
shows a badge with the number of open enquiries.

The visitor is told exactly what happened: "sent to the support team" only when the mail server accepted the email,
otherwise "received and saved for the support team". If a field is wrong, the message appears next to that field and
what the visitor typed is kept.

## 7. Install tab

Shows the snippet for **this** chatbot, e.g.:

```html
<script src="http://localhost:3000/widget.js" data-chatbot-id="5375ea8a-b021-4288-930c-c28a7a300333" async></script>
```

Click **Copy code** and paste it before `</body>` on every page where the chat button should appear (plain HTML
template; WordPress "header and footer code" plugin; Wix/Squarespace/Shopify "custom code → body end"). It contains no
admin key. The note under the snippet reminds you that a live HTTPS website needs the chatbot server on HTTPS too.

To try it without a real website, use the test host: see [EMBED.md — Testing an installation](EMBED.md#testing-an-installation-on-a-separate-website-the-test-host).

## Troubleshooting

| Problem | Likely cause and fix |
|---|---|
| "Private or local network addresses cannot be registered" | Only public websites can be used (not `localhost`, intranet or IP addresses). |
| "Only websites on the standard ports" | Use the normal `https://` address without `:8080` etc. |
| "Too many crawl requests" | At most 3 crawls are started per 10 minutes; wait and try again. Refused requests do not count. |
| "The Word document expands to more than 100 MB …" | The .docx contains very large embedded parts (often images or a damaged file). Save a copy without large images, or as PDF, and upload that. |
| "The document took longer than 120 seconds to read …" / "needs too much memory" | The file is too complex to read. Split it, or save it again as a standard PDF, and upload that. |
| Failed: "robots.txt does not allow crawling" | The site blocks crawlers for those pages. Index a different section. |
| Failed: "No useful content found" | The pages returned errors or had no readable text (e.g. behind a login). Try the help-centre address. |
| An answer is missing | The page may be beyond the page limit (*Partially indexed*): raise the limit and re-index. |
| Chatbot does not appear on your site | Check the snippet is on that page (browser F12 → Console/Network); if you set allowed websites, the site's origin must be listed. |
| "The assistant is busy" / "temporarily unavailable" | One question is answered at a time on this laptop, or the model ran out of GPU memory; try again in a minute. |
| Pages behind a login, PDFs, images | Not read. Source links send visitors to the original article. |

More: [TROUBLESHOOTING.md](TROUBLESHOOTING.md).
