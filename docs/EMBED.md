# Embedding the Chatbot

Each website gets its own **chatbot ID** when it is added in the dashboard. The ID selects that website's knowledge;
it is not a secret. The admin key is never needed, sent or stored by the widget.

## The snippet a customer pastes

Copy it from the dashboard (**Manage → Install**): the server address and the ID are already filled in. It is this one line:

```html
<script src="https://YOUR-CHATBOT-SERVER/widget.js" data-chatbot-id="YOUR-CHATBOT-ID" async></script>
```

Paste it once on every page, just before `</body>` (it also works in `<head>`; the widget waits for the page). Nothing else is needed. If the
customer's website is listed under allowed websites, list its exact address there, including `https://` and any `www.`. Replace:

| Placeholder | Local development | Production |
|---|---|---|
| `YOUR-CHATBOT-SERVER` | `localhost:3000` with `http://` | Your HTTPS domain, e.g. `https://chat.yourcompany.com` |
| `YOUR-CHATBOT-ID` | From the dashboard | Same |

A website served over HTTPS can only load the widget from an HTTPS server (browsers block "mixed content"), so a
production deployment needs HTTPS — see [SECURITY.md](SECURITY.md).

### Optional attributes

| Attribute | Meaning |
|---|---|
| `data-title` | Header text. Overrides the name set in the dashboard. |
| `data-accent` | Colour (`#hex`, `rgb()`, or a colour name). Overrides the dashboard colour. Anything else is ignored. |
| `data-api` | API address if it differs from the server that serves `widget.js` (rarely needed). Must be `http(s)`. |

The name, welcome message and colour set in the dashboard are loaded automatically from
`GET /api/chatbots/:id/config`, so installed widgets update when you change them.

## Where to paste it

- **Plain HTML:** in your page template, before `</body>`.
- **WordPress:** a "header and footer code" plugin (footer section), or your theme's footer template.
- **Wix / Squarespace / Shopify / Webflow:** the site's custom-code setting ("body end" or "footer").
- **Single-page apps (React, Vue…):** add the tag to `index.html`; the widget does not need to be re-created on route changes.

## Allowed websites

In **Appearance → Websites allowed to show this chatbot**, list the origins (scheme + host, e.g.
`https://www.example.com`). Browsers on other websites then get "This chatbot is not enabled for this website".
The dashboard preview (same server) is always allowed. This prevents casual reuse of your chatbot on other sites;
it is **not** authentication — a script outside a browser can send any `Origin` header.

## Full-page chat

Link to or iframe:

```text
https://YOUR-CHATBOT-SERVER/widget.html?chatbotId=YOUR-CHATBOT-ID
```

## What visitors see

- A chat button in the bottom-right corner; the panel fits phone screens. The widget lives in a Shadow DOM and clears everything it would inherit
  from the page, so it does not change your site's styles and your styles do not change it. A page element placed above it (a very high `z-index`) can still cover it.
- When the chatbot cannot answer: the exact fallback text and a form (name, email, optional details). The enquiry is saved for that chatbot.
- Keyboard: Tab reaches the button, Enter opens it, Escape closes it and returns to the button. After an unanswered question the cursor moves to the form.
  Fields, buttons and the conversation are named for screen readers, and new messages are announced.
- "Thinking…", then after 15 s "Still working…". The send button is disabled until the answer arrives.
- Answers as plain text (no HTML from the server is ever rendered), with small source chips: the section and the website,
  linking to that section of the original page.
- Friendly messages for network errors, time-outs (the widget waits up to 4.5 minutes), a busy server or an
  unapproved website. Server internals are never shown.
- Short follow-up questions ("and on mobile?") keep the context of the previous question.

## How the widget works (for developers)

| Piece | File / route | What it does |
|---|---|---|
| Embeddable widget | `public/widget.js`, served at `/widget.js` | The script in the snippet. Reads `data-chatbot-id` from its own `<script>` tag, adds a floating launcher + chat panel inside a Shadow DOM, and talks to the server that served it |
| Settings | `GET /api/chatbots/:id/config` (public) | Name, welcome message and colour saved in **Appearance**; loaded when the widget starts |
| Questions | `POST /api/chat` `{ chatbotId, question, previousQuestion }` (public) | Returns `{ answer, sources[] }`; each source has `title`, `section` and `link` (page + `#section`) |
| Dashboard preview | `public/widget.html` in an iframe (**Test** tab) | A full-page version of the same chat UI calling the same API. It is **not** `widget.js`, so the preview alone does not prove external embedding — use the test host below |
| Snippet | Built by `public/index.html` (**Install** tab) | `<script src="<this server>/widget.js" data-chatbot-id="<ID>" async></script>` — no admin key, nothing secret |

Flow on a customer page: browser loads `widget.js` from the chatbot server → widget fetches `/config` → visitor
types → `POST /api/chat` with the chatbot ID → the server searches only that chatbot's indexed pages
(`chatbotId` filter in Qdrant), checks the allowed-websites list against the browser's `Origin`, generates the
answer and returns it with source links → the widget shows the answer (as plain text) and source chips.

Different customers = different chatbot IDs. Each ID has its own website, indexed content, settings and allowed
websites; the same `widget.js` serves all of them.

## Testing an installation on a separate website (the test host)

The project contains a **test host page** that plays the part of a customer's website: `demo/customer-site.html`,
served by `demo/serve.js` on its own origin (`http://localhost:5050`), different from the chatbot server
(`http://localhost:3000`). It is not part of the product and is only reachable from this computer.

1. Make sure the chatbot server is running (`http://localhost:3000/api/health` shows `"success":true`).
2. In a **second** terminal:
   ```cmd
   cd <project folder>
   npm run demo:host
   ```
   It prints `Open: http://localhost:5050/`. Keep this window open. (Port busy? `node demo/serve.js 5051`.)
3. In the dashboard: **Manage** the chatbot → **Install** → **Copy code**.
4. Open `demo/customer-site.html` in VS Code, replace the line between the two `PASTE THE SNIPPET` comments with the
   copied code, save. (It already contains the snippet for the docs.python.org FAQ chatbot.)
5. Open `http://localhost:5050/` in Chrome. A round chat button appears bottom-right.
6. Click it: the panel shows the chatbot's name and welcome message from **Appearance**.
7. Ask a supported question, e.g. "Why are Python strings immutable?" — answer in ~10–25 s, with a source chip
   for the "Design and History FAQ" section.
8. Click the source chip: `https://docs.python.org/3/faq/design.html#why-are-python-strings-immutable` opens in a new
   tab; compare the answer with the paragraph there.
9. Ask an unsupported question, e.g. "What is the price of a Python certification exam?" — exactly
   *I could not find this information on the website.* and no source chip.
10. Press **F12**. **Console**: no red errors. **Network**: filter `chat` — `POST http://localhost:3000/api/chat`
    with status `200`; its Response shows `answer` and `sources`. A `config` request returns the settings.

### Testing the allowed-websites rule (optional)

1. **Appearance** → *Websites allowed to show this chatbot* → enter `http://localhost:5050` → **Save settings**.
2. `http://localhost:5050/` still works.
3. Open `http://127.0.0.1:5050/` — the same page, but a **different origin** for the browser. The button appears, but a
   question shows *This chatbot is not enabled for this website.* (Network: `POST /api/chat` → `403`).
4. Afterwards, clear the box and **Save settings** again if the chatbot should work everywhere.

Do not switch the rule off to make a demo work; add the demo origin instead.

### Automated versions

- `npm run test:widget-sites` (isolated) puts the widget on two customer pages with different origins and hostile styles: see [TESTING.md](TESTING.md).
- **`tests/embed.test.js` writes temporary vectors to the shared `website_content` collection** (hard-coded). Do not run it until that is changed.
- `npm run test:embed` does all of the above in a real browser: settings saved in the dashboard, snippet copied from
  **Install**, pasted into a separate website, launcher/name/welcome/colour, supported and unsupported questions,
  source link, mobile width, not-allowed origin (403), and the demo host. It restores the chatbot's settings at the end.
- `npm run test:widget` checks error states (invalid ID, server down, busy, time-out), hostile attributes and plain-text
  rendering.

## Common problems

| Problem | Fix |
|---|---|
| No chat button | Open the browser console: "data-chatbot-id is missing or invalid" means the ID in the snippet is wrong. Network tab: `widget.js` must load with status 200 (wrong server address or server not running otherwise). |
| "This chatbot is not ready yet" | The chatbot is still Pending/Indexing; index it in the dashboard first. |
| Button appears, answers fail with "Could not reach the assistant" | The server address in `src` is wrong or the server is down. |
| "This chatbot is not enabled for this website" | Add the site's origin under allowed websites, or clear the list. |
| Works locally, not on the live HTTPS site | The widget must be served from HTTPS too. |
