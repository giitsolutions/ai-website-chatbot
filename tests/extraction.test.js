// Help-article extraction and chunking (no network, no model). Run: npm test
const fs = require("fs"), path = require("path"), Module = require("module");
const cheerio = require(require.resolve("cheerio", { paths: [path.join(__dirname, "..")] }));

const file = path.join(__dirname, "..", "ingest.js");
const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file, "utf8") + "\nmodule.exports.__x = { extractSections, createChunks, CHUNK_SIZE };", file);
const { extractSections, createChunks, CHUNK_SIZE } = m.exports.__x;

const HELP_PAGE = `<html><body><nav>Products Pricing Sign in</nav><main>
<h1 id="reset">Reset your password</h1><p>You can reset your password from the sign-in page.</p>
<div class="note"><p>You need access to the email address on your account.</p></div>
<ol><li>Go to the <b>Sign in</b> page.</li><li>Select <b>Forgot password</b>.<ul><li>On mobile, tap the menu first.</li></ul></li>
<li>Enter your email address and select <b>Send link</b>.</li></ol>
<div class="callout warning"><p>The reset link expires after 24 hours.</p></div>
<h2 id="dns">Add a DNS record</h2><ol start="4"><li>Open DNS settings.</li><li>Add this record:<pre>Type: TXT
Name: @
Value: verify=abc123</pre></li><li>Click Save.</li></ol>
<h2>Short FAQ</h2><p>Can I change my username? No, usernames cannot be changed.</p>
<h2>Other procedure</h2><ol><li>Open the editor.</li><li>Click Save.</li></ol>
</main><footer>Copyright</footer></body></html>`;

const sections = extractSections(cheerio.load(HELP_PAGE), "Help");
const chunks = createChunks(sections);
const byHeading = heading => chunks.find(c => c.heading === heading)?.chunk || "";

const results = [];
const check = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 90) });

const reset = byHeading("Reset your password");
check("numbered steps kept in order, one per line", /1\. Go to the Sign in page\.\n2\. Select Forgot password\.\n {2}- On mobile, tap the menu first\.\n3\. Enter your email address and select Send link\./.test(reset), reset.replace(/\n/g, " | "));
check("note and warning boxes labelled", /Note: You need access/.test(reset) && /Warning: The reset link expires after 24 hours/.test(reset));
check("navigation and footer not indexed", !chunks.some(c => /Products Pricing|Copyright/.test(c.chunk)));
const dns = byHeading("Add a DNS record");
check("ol start= respected", /^4\. Open DNS settings\./m.test(dns) && /^6\. Click Save\./m.test(dns), dns.replace(/\n/g, " | "));
check("code block keeps its lines", /Type: TXT\nName: @\nValue: verify=abc123/.test(dns));
check("section anchors captured", chunks.find(c => c.heading === "Reset your password")?.anchor === "reset" && chunks.find(c => c.heading === "Add a DNS record")?.anchor === "dns");
check("short FAQ section kept", /usernames cannot be changed/.test(byHeading("Short FAQ")));
check("identical steps in different procedures both kept", /Click Save/.test(dns) && /Click Save/.test(byHeading("Other procedure")));
check("lines ending in 's' are not altered", (() => {
    const c = createChunks([{ heading: "Plans", anchor: "", blocks: ["We offer monthly and yearly plans", "Upgrades take effect within 24 hours"] }]);
    return c.length === 1 && /monthly and yearly plans\nUpgrades take effect within 24 hours$/.test(c[0].chunk);
})());

// A long procedure is split only between steps, never inside one.
const longSteps = Array.from({ length: 60 }, (_, i) => `<li>Step text number ${i + 1} explains one action in a few more words here.</li>`).join("");
const longChunks = createChunks(extractSections(cheerio.load(`<main><h1>Long guide</h1><ol>${longSteps}</ol></main>`), "Guide"));
const everyLineWhole = longChunks.every(c => c.chunk.split("\n").slice(1).every(line => /^\d+\. Step text number \d+ explains one action in a few more words here\.$/.test(line)));
const allStepsPresent = Array.from({ length: 60 }, (_, i) => i + 1).every(n => longChunks.some(c => c.chunk.includes(`${n}. Step text number ${n} `)));
check("long procedure split between steps only, all steps present", longChunks.length > 1 && everyLineWhole && allStepsPresent, `${longChunks.length} chunks (CHUNK_SIZE ${CHUNK_SIZE})`);

// Marketing-style page: a repeated slider, then price cards (short heading + one sentence each).
const PLANS_PAGE = `<main>
<div class="slide"><h2>Welcome to Lotus Studio</h2><p>Classes for every level, in the studio and online, seven days a week.</p></div>
<div class="slide"><h2>Lotus Studio Yoga</h2><p>Classes for every level, in the studio and online, seven days a week.</p></div>
<div class="slide"><h2>Welcome to Lotus Studio</h2><p>Classes for every level, in the studio and online, seven days a week.</p></div>
<h2>Why practise with us</h2><p>Our teachers have many years of experience and keep every class small, so that everyone gets personal attention, gentle corrections and a calm space to learn at their own pace, without pressure or competition, whether they are complete beginners or have practised for a long time.</p>
<h2 id="plans">Membership plans</h2><p>Choose the plan that suits you.</p>
<h3>€15</h3><p>Single drop-in class.</p>
<h3>€59</h3><p>Monthly unlimited membership.</p>
<h3>€149</h3><p>Three-month membership with one free private session.</p>
<h2>How to book</h2><ol><li>Open the Schedule page.</li><li>Choose a class.</li><li>Select Book.</li></ol>
</main>`;
const planChunks = createChunks(extractSections(cheerio.load(PLANS_PAGE), "Plans"));
const planChunk = planChunks.find(c => /Membership plans/.test(c.chunk)) || { chunk: "" };
check("repeated slider text stored once", planChunks.filter(c => /Classes for every level/.test(c.chunk)).length === 1 &&
    (planChunks.map(c => c.chunk).join("\n").match(/Classes for every level/g) || []).length === 1, planChunks.length + " chunks");
check("price cards merged into one section with every price and description", ["€15: Single drop-in class.", "€59: Monthly unlimited membership.", "€149: Three-month membership"].every(text => planChunk.chunk.includes(text)), planChunk.chunk.replace(/\n/g, " | "));
check("merged section keeps the first heading and its anchor", planChunk.heading === "Membership plans" && planChunk.anchor === "plans");
check("a normal-length section is not merged into the price cards", !/teachers have years/.test(planChunk.chunk) && planChunks.some(c => c.heading === "Why practise with us"));
check("a numbered procedure is never merged", planChunks.some(c => c.heading === "How to book" && /^1\. Open the Schedule page\.\n2\. Choose a class\.\n3\. Select Book\.$/m.test(c.chunk.split("\n").slice(1).join("\n"))) && !/€/.test(planChunks.find(c => c.heading === "How to book")?.chunk || "€"));
check("very short identical texts under different headings are kept", (() => {
    const c = createChunks([{ heading: "Hatha", anchor: "", blocks: ["Book a trial class"] }, { heading: "Vinyasa", anchor: "", blocks: ["Book a trial class"] }]);
    return /Hatha/.test(c.map(x => x.chunk).join()) && /Vinyasa/.test(c.map(x => x.chunk).join());
})());

console.table(results);
const failed = results.filter(r => r.result !== "PASS").length;
console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
process.exit(failed ? 1 : 0);
