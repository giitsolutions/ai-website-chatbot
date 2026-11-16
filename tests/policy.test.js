// Deterministic policy comparisons (no network, no model). Run: npm test
// Chunks are produced by the real extraction + chunking code, so the checker
// is tested on the same text format the chat route gives it.
const fs = require("fs"), path = require("path"), Module = require("module");
const cheerio = require(require.resolve("cheerio", { paths: [path.join(__dirname, "..")] }));
const { evaluatePolicyQuestion, parseElapsed, parseAmount } = require("../policyCheck.js");

const file = path.join(__dirname, "..", "ingest.js");
const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file, "utf8") + "\nmodule.exports.__x = { extractSections, createChunks };", file);
const { extractSections, createChunks } = m.exports.__x;

const chunksOf = html => createChunks(extractSections(cheerio.load(html), "Help")).map(c => c.chunk);

// A help-centre refund article: a general rule, product rules and exceptions.
const REFUND_PAGE = chunksOf(`<main><h1>Refund policy</h1><p>Most Acme products can be refunded within 30 days of purchase.</p>
<h2 id="eligibility">Eligibility</h2><ul><li>Hosting plans: full refund within 30 days of purchase.</li>
<li>Email plans can be refunded within 14 days of purchase.</li>
<li>Annual plans cancelled after 30 days: no refund for the current term.</li></ul>
<h2 id="exceptions">Exceptions</h2><ul><li>Domain registrations and domain renewals are not refundable.</li>
<li>SSL certificates can be refunded within 7 days of purchase only.</li></ul>
<p>Refunds are returned to the original payment method within 5 to 10 business days.</p></main>`);

// A different website: a product window plus an amount cap.
const INSURANCE_PAGE = chunksOf(`<main><h1>Travel cover</h1><h2>Claims</h2><ul>
<li>Lost baggage claims are reimbursed up to $200 per bag.</li>
<li>Flight cancellation claims must be submitted within 2 weeks of the flight.</li></ul></main>`);

// No concrete rules at all.
const VAGUE_PAGE = chunksOf(`<main><h1>Returns</h1><p>Most items can usually be returned. Contact support for details about your order.</p></main>`);

const results = [];
const check = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 110) });
const ask = (question, chunks = REFUND_PAGE) => evaluatePolicyQuestion(question, chunks);

// Verdict, the rule it relied on, and what the answer and explanation say.
function verdict(test, question, chunks, expected) {
    const v = ask(question, chunks);
    const problems = [];
    if (!v) problems.push("no verdict");
    else {
        if (v.kind !== expected.kind) problems.push(`kind=${v.kind}`);
        if (v.eligible !== expected.eligible) problems.push(`eligible=${v.eligible}`);
        if (expected.rule && !expected.rule.test(v.ruleText)) problems.push(`rule="${v.ruleText}"`);
        for (const pattern of expected.answer || []) if (!pattern.test(v.answer)) problems.push(`answer lacks ${pattern}`);
        for (const pattern of expected.notAnswer || []) if (pattern.test(v.answer)) problems.push(`answer has ${pattern}`);
        for (const pattern of expected.explanation || []) if (!pattern.test(v.explanation)) problems.push(`explanation lacks ${pattern}`);
        if (v.kind !== "undetermined" && v.ruleText && !chunks[v.chunkIndex]?.includes(v.ruleText.split("\n")[0])) problems.push("rule not in its chunk");
    }
    check(test, problems.length === 0, problems.join("; ") || (v && v.answer) || v?.explanation);
}

check("chunks keep each rule on its own line", REFUND_PAGE.join("\n").includes("- SSL certificates can be refunded within 7 days of purchase only."), REFUND_PAGE.length + " chunks");

// ---- Parsing ----
check("elapsed: '45 days ago'", parseElapsed("I bought it 45 days ago")?.days === 45);
check("elapsed: 'three weeks ago' = 21", parseElapsed("three weeks ago I ordered")?.days === 21);
check("elapsed: 'it has been 10 days'", parseElapsed("it has been 10 days, refund?")?.days === 10);
check("elapsed: 'had it for 2 weeks'", parseElapsed("I've had the plan for 2 weeks")?.days === 14);
check("elapsed: 'two months ago' = 60, approximate", parseElapsed("two months ago")?.days === 60 && parseElapsed("two months ago").approximate === true);
check("elapsed: none in 'a refund for 2 years of hosting'", parseElapsed("Can I get a refund for 2 years of hosting?") === null);
check("elapsed: none without a time", parseElapsed("Can I get a refund?") === null);
check("amount: '$250'", parseAmount("my bag cost $250") === 250);
check("amount: '1,200 dollars'", parseAmount("it was 1,200 dollars") === 1200);
check("amount: none", parseAmount("I lost a bag") === null);

// ---- The required matrix ----
verdict("hosting 10 days, 30-day window -> eligible", "I bought a hosting plan 10 days ago. Can I get a refund?", REFUND_PAGE, {
    kind: "window", eligible: true, rule: /^Hosting plans: full refund within 30 days/,
    answer: [/still within/, /"Hosting plans: full refund within 30 days of purchase\."/, /10 days ago/],
    notAnswer: [/no longer|not eligible/i],
    explanation: [/10 <= 30/, /eligible/]
});
verdict("hosting 45 days, 30-day window -> not eligible", "I bought a hosting plan 45 days ago. Can I still get my money back?", REFUND_PAGE, {
    kind: "window", eligible: false, rule: /^Hosting plans/,
    answer: [/no longer eligible/, /30 days/, /45 days ago/], notAnswer: [/^yes/i, /still within/],
    explanation: [/45 > 30/, /not eligible/]
});
verdict("SSL 12 days, 7-day window -> not eligible", "Can I get a refund on an SSL certificate I purchased 12 days ago?", REFUND_PAGE, {
    kind: "window", eligible: false, rule: /^SSL certificates can be refunded within 7 days/,
    answer: [/no longer eligible/, /7 days/, /12 days ago/], explanation: [/12 > 7/]
});
verdict("SSL 5 days, 7-day window -> eligible", "I bought an SSL certificate 5 days ago, refund possible?", REFUND_PAGE, {
    kind: "window", eligible: true, rule: /^SSL certificates/, explanation: [/5 <= 7/]
});
verdict("different product rule: email 20 days vs 14 -> not eligible", "My email plan was purchased 20 days ago. Can I get a refund?", REFUND_PAGE, {
    kind: "window", eligible: false, rule: /^Email plans can be refunded within 14 days/, explanation: [/20 > 14/]
});
verdict("different product rule: email 10 days vs 14 -> eligible", "I bought an email plan 10 days ago. Refund?", REFUND_PAGE, {
    kind: "window", eligible: true, rule: /^Email plans/, explanation: [/10 <= 14/]
});
verdict("exception overrides the general 30-day rule: domain 3 days -> not refundable", "I registered a domain 3 days ago. Can I get a refund?", REFUND_PAGE, {
    kind: "exclusion", eligible: false, rule: /^Domain registrations and domain renewals are not refundable/,
    answer: [/not eligible/, /not refundable/], explanation: [/whatever the date/]
});
verdict("exception without a date: domain renewal -> not refundable", "Can I get a refund for a domain renewal?", REFUND_PAGE, {
    kind: "exclusion", eligible: false, rule: /^Domain registrations/
});
verdict("weeks converted: SSL 'one week ago' (7 days) -> eligible on the boundary", "I bought an SSL certificate one week ago. Can I get a refund?", REFUND_PAGE, {
    kind: "window", eligible: true, explanation: [/7 <= 7/]
});
verdict("months: hosting 'two months ago' (60 days) -> not eligible", "I bought hosting two months ago, can I get a refund?", REFUND_PAGE, {
    kind: "window", eligible: false, explanation: [/60 > 30/]
});
verdict("'after N days: no refund' rule: annual plan cancelled after 40 days -> not eligible", "I want to cancel my annual plan after 40 days. Will I get a refund?", REFUND_PAGE, {
    kind: "window", eligible: false, rule: /^Annual plans cancelled after 30 days/
});

// ---- Ambiguous or incomplete purchase information ----
verdict("ambiguous: no product named -> asks for details", "I bought something 10 days ago. Can I get a refund?", REFUND_PAGE, {
    kind: "needs-detail", eligible: null, answer: [/It depends/, /which product/, /"Hosting plans/], notAnswer: [/still within|no longer/]
});
verdict("ambiguous: 'a month ago' is too close to a 30-day limit", "I bought hosting a month ago. Can I get a refund?", REFUND_PAGE, {
    kind: "needs-detail", eligible: null, answer: [/30 days/, /how many days/], explanation: [/too close/]
});
verdict("ambiguous: two products with different limits", "I bought hosting and an SSL certificate 10 days ago. Can I get refunds?", REFUND_PAGE, {
    kind: "needs-detail", eligible: null, answer: [/Hosting plans/, /SSL certificates/]
});
check("incomplete: no date -> left to the model (explains the condition)", ask("Can I get a refund for my hosting plan?") === null);

// ---- Undeterminable questions ----
verdict("undeterminable: product with no rule -> standard fallback", "I bought a gift card 3 days ago. Can I get a refund?", REFUND_PAGE, {
    kind: "undetermined", eligible: null
});
check("undeterminable: only vague rules -> no verdict", ask("I bought a lamp 3 days ago. Can I return it?", VAGUE_PAGE) === null);
check("not a policy question -> no verdict", ask("How do I add a TXT record 3 days ago?") === null);
check("vague general rule is never used ('Most Acme products')", !/Most Acme/.test(ask("I bought a hosting plan 10 days ago, refund?")?.ruleText || ""));

// ---- Another website: amounts and a week-based window ----
verdict("amount cap: $250 vs up to $200 -> not in full", "My lost baggage was worth $250. Can I claim it all?", INSURANCE_PAGE, {
    kind: "cap", eligible: false, rule: /up to \$200/, answer: [/Not in full/, /at most \$200/, /not \$250/], explanation: [/250 > 200/]
});
verdict("amount cap: $150 vs up to $200 -> covered", "Will a $150 lost baggage claim be covered?", INSURANCE_PAGE, {
    kind: "cap", eligible: true, explanation: [/150 <= 200/]
});
verdict("week window: flight cancellation claim 10 days after -> eligible", "My flight was cancelled 10 days ago. Can I still claim?", INSURANCE_PAGE, {
    kind: "window", eligible: true, rule: /within 2 weeks/, explanation: [/10 <= 14/]
});
verdict("week window: flight cancellation claim 3 weeks after -> not eligible", "My flight cancellation was 3 weeks ago. Can I still submit a claim?", INSURANCE_PAGE, {
    kind: "window", eligible: false, explanation: [/21 > 14/]
});

console.table(results);
const failed = results.filter(r => r.result !== "PASS").length;
console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
process.exit(failed ? 1 : 0);
