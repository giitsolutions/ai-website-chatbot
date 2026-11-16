
(function () {
    "use strict";

    const script = document.currentScript;
    if (!script) return;

    const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    // The local model can take a minute or more; the server gives up after
    // about 240 s, so the widget waits a little longer than that.
    const REQUEST_TIMEOUT_MS = 270000;
    const SLOW_HINT_AFTER_MS = 15000;

    function isSafeHttpUrl(value) {
        try {
            const url = new URL(value);
            return url.protocol === "https:" || url.protocol === "http:";
        } catch {
            return false;
        }
    }

    // data-api: where the chatbot API lives. Defaults to the server that
    // served this script, so a normal embed needs no extra attribute.
    const configuredApi = script.dataset.api || new URL(script.src).origin;
    if (!isSafeHttpUrl(configuredApi)) {
        console.error("Website chatbot: data-api must be an http(s) URL.");
        return;
    }
    const apiBase = configuredApi.replace(/\/$/, "");

    const chatbotId = (script.dataset.chatbotId || "").trim();
    const title = script.dataset.title || "Website Assistant";

    // The accent colour is inserted into CSS, so accept only plain colour
    // values (#hex, rgb()/rgba(), or a colour name).
    const requestedAccent = (script.dataset.accent || "").trim();
    const accent = /^(#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]{3,20})$/i.test(requestedAccent)
        ? requestedAccent
        : "#2E6B4E";

    if (!UUID_PATTERN.test(chatbotId)) {
        console.error("Website chatbot: data-chatbot-id is missing or invalid.");
        return;
    }

    // Questions any website can be asked, offered until the visitor asks their own.
    const SUGGESTED_QUESTIONS = ["What does this website provide?", "What services or products are available?", "How can I contact the company?"];

    // Text on the accent colour must stay readable, whatever colour the owner chose.
    function isLightColor(color) {
        const match = /^#([0-9a-f]{3,8})$/i.exec(color);
        if (!match) return false;
        const hex = match[1].length < 6 ? match[1].split("").map(ch => ch + ch).join("") : match[1];
        const [red, green, blue] = [0, 2, 4].map(start => parseInt(hex.substr(start, 2), 16));
        return 0.299 * red + 0.587 * green + 0.114 * blue > 170;
    }

    // The snippet may be placed in <head> with "async": wait for <body>.
    function start() {
    if (document.getElementById("ai-website-chatbot-widget")) return;

    const host = document.createElement("div");
    host.id = "ai-website-chatbot-widget";
    // The page's rules reach this one element, and a transform on it would move the fixed panel:
    // "all" clears them and everything the widget would inherit (it does not touch --accent).
    host.style.setProperty("all", "initial", "important");
    function applyAccent(color) {
        const light = isLightColor(color);
        host.style.setProperty("--accent", color);
        host.style.setProperty("--on-accent", light ? "#2A2420" : "#ffffff");
    }
    applyAccent(accent);
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });

    function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, ch => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        }[ch]));
    }

    const EXTERNAL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>';
    const siteDomain = window.location.hostname.replace(/^www\./, "");
    function firstLetter(text) {
        return Array.from(String(text).trim())[0] || "";
    }
    function domainOf(url) {
        try {
            return new URL(url).hostname.replace(/^www\./, "");
        } catch {
            return "";
        }
    }

    shadow.innerHTML = `
        <style>
            * { box-sizing: border-box; }
            .launcher {
                position: fixed; right: 20px; bottom: 20px;
                width: 56px; height: 56px; border: 0; padding: 0;
                border-radius: 50%; background-color: var(--accent);
                color: var(--on-accent, #fff); cursor: pointer;
                display: grid; place-items: center;
                z-index: 2147483647;
            }
            .launcher svg { grid-area: 1 / 1; width: 26px; height: 26px; }
            .launcher .icon-close { display: none; }
            .launcher[aria-expanded="true"] .icon-chat { display: none; }
            .launcher[aria-expanded="true"] .icon-close { display: block; }
            .panel {
                position: fixed; right: 20px; bottom: 88px;
                width: min(372px, calc(100vw - 24px));
                height: min(620px, calc(100vh - 110px));
                background: #fff; border: 1px solid #E2D8C9; border-radius: 18px; overflow: hidden;
                display: none; flex-direction: column;
                z-index: 2147483647;
                font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif;
                color: #2A2420;
            }
            .panel.open { display: flex; }
            .head {
                background: #fff; border-bottom: 1px solid #E2D8C9; color: #2A2420;
                padding: 12px 10px 12px 14px; display: flex; gap: 10px;
                align-items: center;
            }
            .head-logo {
                width: 38px; height: 38px; border-radius: 50%; flex: 0 0 auto;
                background: var(--accent); color: var(--on-accent, #fff);
                display: grid; place-items: center; font-weight: 700; font-size: 16px; text-transform: uppercase;
            }
            .head-main { min-width: 0; flex: 1; }
            .head-title {
                font-weight: 700; font-size: 15px; line-height: 1.3;
                white-space: nowrap; overflow: hidden;
                text-overflow: ellipsis;
            }
            .head-sub { font-size: 12px; color: #6A5F55; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
            .close {
                width: 44px; height: 44px; border: 0; padding: 0; flex: 0 0 auto;
                background: transparent; color: #2A2420; cursor: pointer; border-radius: 8px;
                display: grid; place-items: center;
            }
            .close svg { width: 20px; height: 20px; }
            .close:hover { background: #F3EEE6; }
            .msgs { flex: 1; overflow: auto; padding: 14px; background: #FDFBF7; }
            .row { display: flex; margin-bottom: 10px; }
            .row.user { justify-content: flex-end; }
            .bubble {
                max-width: 88%; padding: 10px 13px; line-height: 1.5;
                white-space: pre-wrap; overflow-wrap: anywhere;
            }
            .ai { background: #fff; border: 1px solid #E2D8C9; border-radius: 14px 14px 14px 4px; }
            .ai.notfound { background: #FDF1D6; border-color: #F3DFB1; color: #5A3E05; }
            .user-b { background: var(--accent); color: var(--on-accent, #fff); border-radius: 14px 14px 4px 14px; }
            .thinking { display: flex; align-items: center; gap: 9px; color: #6A5F55; font-size: 13px; }
            .typing { display: inline-flex; gap: 4px; align-items: center; flex: 0 0 auto; }
            .typing i { width: 6px; height: 6px; border-radius: 50%; background: #6A5F55; animation: blink 1.1s ease-in-out infinite; }
            .typing i:nth-child(2) { animation-delay: .14s; }
            .typing i:nth-child(3) { animation-delay: .28s; }
            .suggestions { display: grid; justify-items: start; gap: 6px; margin: 0 0 14px; }
            .suggestion {
                border: 1px solid #E2D8C9; background: #fff; color: #2A2420; cursor: pointer; text-align: left;
                font: inherit; font-size: 13px; line-height: 1.35;
                min-height: 44px; padding: 7px 12px; border-radius: 8px;
            }
            .suggestion:hover { background: #F3EEE6; }
            .sources { display: flex; flex-wrap: wrap; gap: 6px; margin: -2px 0 14px; }
            .src {
                display: inline-flex; align-items: center; gap: 6px; max-width: 100%;
                background: #F3EEE6; color: #2A2420; text-decoration: none;
                border-radius: 999px; padding: 4px 11px; font-size: 12px; line-height: 1.35;
                overflow-wrap: anywhere;
            }
            a.src:hover { text-decoration: underline; }
            .src svg { width: 13px; height: 13px; flex: 0 0 auto; }
            .contact { margin: 0 0 14px; }
            .contact-open, .contact-send { background: var(--accent); color: var(--on-accent, #fff); border: 0; border-radius: 8px; min-height: 44px; padding: 8px 16px; font: inherit; font-weight: 600; cursor: pointer; }
            .contact-cancel { background: #fff; color: #2A2420; border: 1px solid #B9AD9D; border-radius: 8px; min-height: 44px; padding: 8px 16px; font: inherit; cursor: pointer; }
            .contact-open:disabled, .contact-send:disabled, .contact-cancel:disabled { opacity: .6; cursor: default; }
            .contact-form { display: grid; gap: 10px; background: #fff; border: 1px solid #E2D8C9; border-radius: 12px; padding: 13px; }
            .contact-title { font-weight: 700; font-size: 15px; color: #2A2420; overflow-wrap: anywhere; }
            .contact-pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 10px; }
            .contact-form label { display: grid; gap: 4px; font-size: 13px; font-weight: 600; color: #2A2420; min-width: 0; align-content: start; }
            .contact-form input, .contact-form textarea { width: 100%; min-height: 44px; max-height: none; font: inherit; font-size: 14px; font-weight: 400; color: #2A2420; padding: 8px 10px; border: 1px solid #B9AD9D; border-radius: 8px; background: #fff; resize: vertical; }
            .contact-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
            .contact-status { font-size: 13px; color: #6A5F55; }
            .contact-status:empty { display: none; }
            .contact-done { color: #1F4C37; font-weight: 600; background: #E6F0EA; border-radius: 8px; padding: 10px 12px; }
            .contact-label { font-size: 13px; font-weight: 600; color: #2A2420; margin-bottom: -6px; }
            .contact-question { font-size: 14px; color: #2A2420; background: #F3EEE6; border-radius: 8px; padding: 9px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
            .contact-error { font-size: 12px; font-weight: 500; color: #A8412A; }
            .contact-error:empty { display: none; }
            .contact-form [aria-invalid="true"] { border-color: #A8412A; }
            .composer {
                background: #fff; border-top: 1px solid #E2D8C9;
                padding: 10px; display: flex; gap: 8px; align-items: flex-end;
            }
            textarea {
                flex: 1; min-width: 0; min-height: 44px; max-height: 100px;
                resize: none; border: 1px solid #B9AD9D; background: #fff; color: #2A2420;
                border-radius: 8px; padding: 10px 12px;
                font: 14px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; outline: 0;
            }
            textarea:focus { outline: 2px solid #2A2420; outline-offset: 1px; }
            button:focus-visible, a:focus-visible, input:focus { outline: 2px solid #2A2420; outline-offset: 2px; }
            .send {
                width: 44px; height: 44px; border: 0; padding: 0; flex: 0 0 auto;
                border-radius: 8px; background: var(--accent);
                color: var(--on-accent, #fff); cursor: pointer;
                display: grid; place-items: center;
            }
            .send svg { width: 20px; height: 20px; }
            .send:disabled { opacity: .45; cursor: not-allowed; }
            .error { color: #8A321F; background: #FBE3DC; font-size: 12px; padding: 8px 14px; }
            .error:empty { display: none; }
            @keyframes blink { 0%, 60%, 100% { opacity: .35; } 30% { opacity: 1; } }
            @media (max-width: 480px) {
                .launcher { right: 12px; bottom: 12px; }
                .panel { right: 12px; bottom: 76px; height: min(620px, calc(100vh - 88px)); height: min(620px, calc(100dvh - 88px)); }
                textarea, .contact-form input, .contact-form textarea { font-size: 16px; }
            }
            @media (prefers-reduced-motion: reduce) {
                * { animation: none !important; }
            }
        </style>

        <button class="launcher" type="button" aria-label="Open chat" aria-expanded="false">
            <svg class="icon-chat" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H4l2.2-3A8 8 0 1 1 21 12Z"/></svg>
            <svg class="icon-close" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
        <section class="panel" aria-label="Website chatbot">
            <header class="head">
                <div class="head-logo" aria-hidden="true">${escapeHtml(firstLetter(title))}</div>
                <div class="head-main">
                    <div class="head-title">${escapeHtml(title)}</div>
                    <div class="head-sub">Answers from ${escapeHtml(siteDomain || "this website")}</div>
                </div>
                <button class="close" type="button" aria-label="Close chat"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
            </header>
            <div class="msgs" role="log" aria-live="polite" aria-label="Conversation"></div>
            <div class="error" role="status"></div>
            <form class="composer">
                <textarea rows="1" placeholder="Ask about this website..." aria-label="Ask about this website"></textarea>
                <button class="send" type="submit" aria-label="Send"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg></button>
            </form>
        </section>
    `;

    const launcher = shadow.querySelector(".launcher");
    const panel = shadow.querySelector(".panel");
    const close = shadow.querySelector(".close");
    const messages = shadow.querySelector(".msgs");
    const form = shadow.querySelector(".composer");
    const input = shadow.querySelector("textarea");
    const send = shadow.querySelector(".send");
    const errorBox = shadow.querySelector(".error");

    function addMessage(text, user, sources, notFound) {
        const row = document.createElement("div");
        row.className = `row ${user ? "user" : ""}`;

        const bubble = document.createElement("div");
        bubble.className = `bubble ${user ? "user-b" : "ai"}${notFound ? " notfound" : ""}`;
        bubble.textContent = text;
        row.appendChild(bubble);
        messages.appendChild(row);

        if (!user && Array.isArray(sources) && sources.length) {
            const sourcesWrap = document.createElement("div");
            sourcesWrap.className = "sources";

            sources.slice(0, 3).forEach(source => {
                // An uploaded document: file name and page. A link only if the owner allows visitors to open it.
                if (source && source.type === "document") {
                    const chip = document.createElement("span");
                    chip.className = "src";
                    chip.textContent = [source.section || source.title || "Uploaded document", source.page ? `Page ${source.page}` : "", source.section ? source.title : ""].filter(Boolean).join(" · ");
                    sourcesWrap.appendChild(chip);
                    // A signed, expiring link from the server.
                    if (typeof source.link === "string" && source.link.startsWith("/api/documents/")) {
                        const documentLink = document.createElement("a");
                        documentLink.className = "src";
                        documentLink.href = apiBase + source.link;
                        documentLink.target = "_blank";
                        documentLink.rel = "noopener noreferrer";
                        documentLink.innerHTML = EXTERNAL_ICON;
                        documentLink.append(source.page ? `Open document at page ${source.page}` : "Open document");
                        sourcesWrap.appendChild(documentLink);
                    }
                    return;
                }
                if (!source || !isSafeHttpUrl(source.url)) return;

                // Link straight to the section when the server provides one.
                const target = isSafeHttpUrl(source.link) ? source.link : source.url;

                const link = document.createElement("a");
                link.className = "src";
                link.href = target;
                link.target = "_blank";
                link.rel = "noopener noreferrer";
                link.title = target;
                link.innerHTML = EXTERNAL_ICON;
                link.append([source.section || source.title || "Website source", domainOf(source.url)].filter(Boolean).join(" · "));
                sourcesWrap.appendChild(link);
            });

            if (sourcesWrap.children.length) {
                messages.appendChild(sourcesWrap);
            }
        }

        messages.scrollTop = messages.scrollHeight;
    }

    let welcomeBubble = null;
    let suggestions = null;

    function addWelcome() {
        addMessage("Hi! Ask me anything about this website.", false, []);
        welcomeBubble = messages.lastElementChild && messages.lastElementChild.querySelector(".bubble");
        suggestions = document.createElement("div");
        suggestions.className = "suggestions";
        suggestions.setAttribute("role", "group");
        suggestions.setAttribute("aria-label", "Suggested questions");
        SUGGESTED_QUESTIONS.forEach(question => {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "suggestion";
            button.textContent = question;
            button.addEventListener("click", () => ask(question));
            suggestions.appendChild(button);
        });
        messages.appendChild(suggestions);
    }

    // Sent with the next question so short follow-ups ("and on mobile?") keep context.
    let previousQuestion = "";

    async function ask(question) {
        const clean = String(question || "").trim();
        if (!clean || send.disabled) return;

        errorBox.textContent = "";
        if (suggestions) {
            suggestions.remove();
            suggestions = null;
        }
        addMessage(clean, true, []);
        send.disabled = true;
        input.value = "";
        input.style.height = "44px";

        addMessage("Thinking…", false, []);
        const thinking = messages.lastElementChild;
        const thinkingBubble = thinking.querySelector(".bubble");
        thinkingBubble.classList.add("thinking");
        thinkingBubble.innerHTML = '<span class="typing" aria-hidden="true"><i></i><i></i><i></i></span><span class="thinking-text">Thinking…</span>';

        const slowHint = setTimeout(() => {
            thinkingBubble.querySelector(".thinking-text").textContent = "Still working… answers can take up to a minute.";
            messages.scrollTop = messages.scrollHeight;
        }, SLOW_HINT_AFTER_MS);

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        let nextFocus = input;

        try {
            let response;
            let data = null;

            try {
                response = await fetch(`${apiBase}/api/chat`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ chatbotId, question: clean, previousQuestion }),
                    signal: controller.signal
                });
                data = await response.json().catch(() => null);
            } catch (networkError) {
                throw { status: networkError && networkError.name === "AbortError" ? -1 : 0 };
            }

            if (!response.ok || !data || !data.success) {
                throw { status: response.status, data };
            }

            thinking.remove();
            const answer = data.answer || "I could not find this information on the website.";
            addMessage(answer, false, data.sources || [], data.unanswered === true || answer === "I could not find this information on the website.");
            if (data.contact === true) nextFocus = addContactOption(clean);
            previousQuestion = clean;
        } catch (failure) {
            thinking.remove();
            errorBox.textContent = friendlyError(failure && failure.status, failure && failure.data);
        } finally {
            clearTimeout(slowHint);
            clearTimeout(timeout);
            send.disabled = false;
            nextFocus.focus();
        }
    }


    function contactContainer() { return messages; }
    function contactScroll() { messages.scrollTop = messages.scrollHeight; }
    // Contact form after an unanswered question: shown automatically when the server says so
    // (contact: true, i.e. the chatbot could not answer and has a support address). The visitor's
    // original question is kept exactly as asked (shown, not editable) and sent with the form;
    // nothing is sent until the visitor submits. Success is shown only when the server confirms the
    // question was saved; its message says whether an email was also sent.
    function newRequestId() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
        var id = "";
        while (id.length < 24) id += Math.random().toString(36).slice(2);
        return id.slice(0, 24);
    }
    function addContactOption(question) {
        var original = String(question || "").slice(0, 1000);
        // One request ID per form: repeated clicks or retries never save or send it twice.
        var requestId = newRequestId();
        var formId = "contact-" + requestId.slice(0, 8);
        var wrap = document.createElement("div");
        wrap.className = "contact";
        var form = document.createElement("form");
        form.className = "contact-form";
        form.noValidate = true;
        form.setAttribute("aria-label", "Send your question to the support team");

        var intro = document.createElement("div");
        intro.className = "contact-intro contact-title";
        // With no chatbot name set, the header shows the general title: not a team's name.
        var teamName = shadow.querySelector(".head-title").textContent;
        intro.textContent = "Ask the " + (teamName === "Website Assistant" ? siteDomain || "support" : teamName) + " team instead";
        form.appendChild(intro);

        var questionLabel = document.createElement("div");
        questionLabel.className = "contact-label";
        questionLabel.id = formId + "-question-label";
        questionLabel.textContent = "Your question";
        var questionText = document.createElement("div");
        questionText.className = "contact-question";
        questionText.setAttribute("aria-labelledby", questionLabel.id);
        questionText.textContent = original;

        function field(labelText, element, name, parent) {
            var label = document.createElement("label");
            label.textContent = labelText;
            element.name = name;
            element.id = formId + "-" + name;
            var error = document.createElement("span");
            error.className = "contact-error";
            error.id = element.id + "-error";
            element.setAttribute("aria-describedby", error.id);
            label.appendChild(element);
            label.appendChild(error);
            (parent || form).appendChild(label);
            return { input: element, error: error };
        }
        function input(type, maxLength, autocomplete) {
            var element = document.createElement("input");
            element.type = type;
            element.maxLength = maxLength;
            element.required = true;
            if (autocomplete) element.autocomplete = autocomplete;
            return element;
        }
        var pair = document.createElement("div");
        pair.className = "contact-pair";
        form.appendChild(pair);
        var name = field("Name", input("text", 100, "name"), "name", pair);
        var email = field("Email", input("email", 254, "email"), "email", pair);
        form.appendChild(questionLabel);
        form.appendChild(questionText);
        var detailsInput = document.createElement("textarea");
        detailsInput.maxLength = 2000;
        detailsInput.rows = 2;
        var details = field("Anything else? (optional)", detailsInput, "additional");

        var buttons = document.createElement("div");
        buttons.className = "contact-buttons";
        var submit = document.createElement("button");
        submit.type = "submit";
        submit.className = "contact-send";
        submit.textContent = "Send question";
        var later = document.createElement("button");
        later.type = "button";
        later.className = "contact-cancel";
        later.textContent = "Not now";
        buttons.appendChild(submit);
        buttons.appendChild(later);
        form.appendChild(buttons);
        var status = document.createElement("div");
        status.className = "contact-status";
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        form.appendChild(status);

        // "Not now" folds the form into one button; the question and anything typed are kept.
        var reopen = document.createElement("button");
        reopen.type = "button";
        reopen.className = "contact-open";
        reopen.textContent = "Send this question to support";
        later.addEventListener("click", function () { wrap.replaceChildren(reopen); });
        reopen.addEventListener("click", function () { wrap.replaceChildren(form); name.input.focus(); });

        function showError(target, text) {
            target.error.textContent = text;
            target.input.setAttribute("aria-invalid", text ? "true" : "false");
        }
        form.addEventListener("submit", async function (event) {
            event.preventDefault();
            if (submit.disabled) return;
            showError(name, name.input.value.trim() ? "" : "Please enter your name.");
            showError(email, /^[^\s@<>()[\]",;:\\]+@[^\s@]+\.[^\s@]+$/.test(email.input.value.trim()) ? "" : "Please enter a valid email address.");
            showError(details, "");
            var firstInvalid = [name, email].filter(function (f) { return f.input.getAttribute("aria-invalid") === "true"; })[0];
            if (firstInvalid) {
                status.textContent = "Please check the highlighted fields.";
                firstInvalid.input.focus();
                return;
            }
            submit.disabled = true;
            later.disabled = true;
            submit.textContent = "Sending…";
            status.textContent = "Sending your question…";
            try {
                var response = await fetch(apiBase + "/api/chat/contact", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ chatbotId: chatbotId, name: name.input.value, email: email.input.value, question: original, details: details.input.value, requestId: requestId })
                });
                var result = await response.json().catch(function () { return null; });
                if (response.ok && result && result.success === true && result.saved === true) {
                    var done = document.createElement("div");
                    done.className = "contact-status contact-done";
                    done.setAttribute("role", "status");
                    done.textContent = typeof result.message === "string" ? result.message : "Thank you. Your question has been received.";
                    wrap.replaceChildren(done);
                    contactScroll();
                    return;
                }
                // A field the server refused (400 with "field"): its message is shown next to that field.
                var fieldTarget = result && { name: name, email: email, details: details }[result.field];
                if (fieldTarget && typeof result.error === "string") {
                    showError(fieldTarget, result.error);
                    fieldTarget.input.focus();
                }
                status.textContent = response.status === 429
                    ? "Too many messages were sent. Please try again later."
                    : (result && typeof result.error === "string" ? result.error : "Your question could not be sent. Please try again later.");
            } catch (networkError) {
                status.textContent = "Your question could not be sent. Please check your connection and try again.";
            }
            submit.disabled = false;
            later.disabled = false;
            submit.textContent = "Send question";
        });

        wrap.appendChild(form);
        contactContainer().appendChild(wrap);
        contactScroll();
        return name.input;
    }

    // Visitor-facing messages only; never show server internals.
    function friendlyError(status, data) {
        if (status === 0) return "Could not reach the assistant. Please check your connection and try again.";
        if (status === -1 || status === 504) return "The assistant took too long to answer. Please try again.";
        if (status === 429 || status === 503) return "The assistant is busy right now. Please try again in a minute.";
        if (status >= 400 && status < 500 && data && typeof data.error === "string") return data.error;
        return "Something went wrong. Please try again.";
    }

    function setOpen(open) {
        panel.classList.toggle("open", open);
        launcher.setAttribute("aria-expanded", String(open));
        launcher.setAttribute("aria-label", open ? "Close chat" : "Open chat");
        (open ? input : launcher).focus();
    }

    launcher.addEventListener("click", () => setOpen(!panel.classList.contains("open")));

    close.addEventListener("click", () => setOpen(false));

    panel.addEventListener("keydown", event => {
        if (event.key === "Escape") setOpen(false);
    });

    form.addEventListener("submit", event => {
        event.preventDefault();
        ask(input.value);
    });

    input.addEventListener("keydown", event => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            ask(input.value);
        }
    });

    input.addEventListener("input", () => {
        input.style.height = "44px";
        input.style.height = Math.min(input.scrollHeight, 100) + "px";
    });

    // Name, welcome message and colour set in the dashboard. Attributes on the
    // script tag (data-title, data-accent) take precedence. Failure is harmless.
    function applyRemoteConfig() {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 5000);
        fetch(`${apiBase}/api/chatbots/${encodeURIComponent(chatbotId)}/config`, { signal: controller.signal })
            .then(response => (response.ok ? response.json() : null))
            .then(config => {
                if (!config) return;
                if (!script.dataset.title && typeof config.displayName === "string" && config.displayName.trim()) {
                    shadow.querySelector(".head-title").textContent = config.displayName.trim().slice(0, 60);
                    shadow.querySelector(".head-logo").textContent = firstLetter(config.displayName);
                }
                if (!script.dataset.accent && /^#[0-9a-f]{6}$/i.test(config.accentColor || "")) {
                    applyAccent(config.accentColor);
                }
                if (welcomeBubble && typeof config.welcomeMessage === "string" && config.welcomeMessage.trim()) {
                    welcomeBubble.textContent = config.welcomeMessage.trim().slice(0, 300);
                }
            })
            .catch(() => {})
            .finally(() => clearTimeout(timer));
    }

    addWelcome();
    applyRemoteConfig();
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener("DOMContentLoaded", start);
    }
})();
