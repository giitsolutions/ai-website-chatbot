// Source-backed accuracy matrix on a REAL public website: the docs.python.org FAQ chatbot.
// Expected facts and source sections were taken from the live pages (2026-10-15); if the Python
// documentation changes, update them from the page, never from the chatbot's answer.
// Calls the model (~3-6 min, run alone). Run: npm run test:python-faq
//   (TEST_BASE_URL defaults to http://localhost:3000; TEST_PYTHON_CHATBOT_ID overrides the chatbot)
const fs = require("fs"), path = require("path");
const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const BOT = process.env.TEST_PYTHON_CHATBOT_ID || "5375ea8a-b021-4288-930c-c28a7a300333";
const NOT_FOUND = "I could not find this information on the website.";
const FAQ = "https://docs.python.org/3/faq/";

// [kind, question, required facts (all must match), expected source (page#section) or null for the fallback, previous question]
const CASES = [
    ["supported", "What is Python?", [/interpreted/i, /interactive/i, /object-oriented/i], "general.html#what-is-python"],
    ["supported", "Why are Python strings immutable?", [/performance/i, /creat|fixed/i], "design.html#why-are-python-strings-immutable"],
    ["supported", "How stable is Python?", [/stable/i, /12 months|6 to 18 months/i], "general.html#how-stable-is-python"],
    ["procedural", "How do I make a Python script executable on Unix?", [/chmod \+x|chmod 755/, /#!/], "library.html#how-do-i-make-a-python-script-executable-on-unix"],
    ["procedural", "How do I create static class data in Python?", [/class attribute/i, /class name/i], "programming.html#how-do-i-create-static-class-data-and-static-class-methods"],
    ["condition", "Can I use Python for commercial purposes?", [/commercial/i, /copyright/i], "general.html#are-there-copyright-restrictions-on-the-use-of-python"],
    ["condition", "Do interfaces stay the same within a series of bugfix releases?", [/interface/i, /same|guarantee/i], "general.html#how-stable-is-python"],
    ["unsupported", "What is the price of a Python certification exam?", [], null],
    ["unsupported", "Who is the current chair of the Python Software Foundation board?", [], null],
    ["paraphrase", "Why can't a string be modified after it is created in Python?", [/performance|elemental/i], "design.html#why-are-python-strings-immutable"],
    ["follow-up", "What about on Windows?", [/PATHEXT|\.py/], "windows.html#how-do-i-make-python-scripts-executable", "How do I make a Python script executable on Unix?"]
];

// Words that would have to be in the indexed text for the unsupported questions to be answerable.
// What would have to be in the indexed text for an unsupported question to be answerable: the
// specific information, not a single word (a large documentation index can mention "TLS
// certification" or a "chair" without saying anything about exam prices or the PSF board).
const ABSENT = {
    "What is the price of a Python certification exam?": /certification exam|exam (price|fee|cost)|(price|fee|cost) of (the |a )?(python )?(certification|exam)/i,
    "Who is the current chair of the Python Software Foundation board?": /(chair|chairman|chairperson|president)[^.\n]{0,60}(board|PSF|Python Software Foundation)|(board|PSF|Python Software Foundation)[^.\n]{0,60}(chair|chairman|chairperson)/i
};

(async () => {
    const scroll = await (await fetch("http://localhost:6333/collections/website_content/points/scroll", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ limit: 1000, with_payload: ["chunk"], with_vector: false, filter: { must: [{ key: "chatbotId", match: { value: BOT } }] } })
    })).json();
    const indexedText = scroll.result.points.map(p => p.payload.chunk).join("\n");

    const rows = [];
    for (const [kind, question, facts, source, previous] of CASES) {
        const started = Date.now();
        const r = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatbotId: BOT, question, previousQuestion: previous }) });
        const j = await r.json().catch(() => ({}));
        const seconds = ((Date.now() - started) / 1000).toFixed(1);
        const answer = String(j.answer || "");
        const links = (j.sources || []).map(s => s.link);
        const problems = [];
        if (r.status !== 200) problems.push(`HTTP ${r.status} ${j.error || ""}`);
        if (source === null) {
            if (answer !== NOT_FOUND) problems.push("expected the exact fallback");
            if (links.length) problems.push("sources on a fallback");
            if (ABSENT[question].test(indexedText)) problems.push("the topic IS in the indexed text");
        } else {
            if (answer === NOT_FOUND) problems.push("answered with the fallback");
            for (const fact of facts) if (!fact.test(answer)) problems.push(`missing ${fact}`);
            if (!links.includes(FAQ + source)) problems.push(`source ${source} not linked`);
        }
        rows.push({ kind, question, seconds, result: problems.length ? "FAIL" : "PASS", problems: problems.join("; "), answer, links });
        console.log(`${problems.length ? "FAIL" : "PASS"} [${kind}] ${question} (${seconds}s)\n     ${answer.replace(/\s+/g, " ").slice(0, 300)}\n     sources: ${JSON.stringify(links)}${problems.length ? "\n     PROBLEMS: " + problems.join("; ") : ""}`);
    }

    if (process.env.TEST_RESULTS_FILE) fs.writeFileSync(process.env.TEST_RESULTS_FILE, JSON.stringify(rows, null, 2));
    console.table(rows.map(({ kind, question, seconds, result, problems }) => ({ kind, question: question.slice(0, 60), seconds, result, problems: problems.slice(0, 60) })));
    const failed = rows.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${rows.length}` : `ALL ${rows.length} PASSED`);
    process.exit(failed ? 1 : 0);
})();
