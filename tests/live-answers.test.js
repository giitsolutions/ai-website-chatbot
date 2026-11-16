// READ-ONLY checks against existing, already-indexed chatbots: questions through the real chat
// API, answers and citations compared with the stored source text. Nothing is written (no
// re-index, no settings). Expected facts come from the chatbot's indexed sections, checked first;
// if a website changes and is re-indexed, update them from the stored text, never from an answer.
// Needs a running server and Ollama. ~2-4 min. Run: npm run test:live-answers
//   (TEST_BASE_URL defaults to http://localhost:3000; TEST_INHOUSEGYM_CHATBOT_ID overrides the chatbot)
const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const GYM = process.env.TEST_INHOUSEGYM_CHATBOT_ID || "27569fca-705a-4ad3-befd-8747407a6c94";
const QDRANT = "http://localhost:6333/collections/website_content/points";
const PAGE = /online_fitness_training\.php/;

const results = [];
function check(name, ok, note = "") {
    results.push({ test: name, result: ok ? "PASS" : "FAIL" });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}${note ? `\n     ${String(note).replace(/\s+/g, " ").slice(0, 360)}` : ""}`);
}
async function ask(question) {
    const started = Date.now();
    const r = await fetch(`${BASE}/api/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chatbotId: GYM, question }) });
    const j = await r.json();
    return { status: r.status, answer: String(j.answer || j.error || ""), sources: j.sources || [], seconds: ((Date.now() - started) / 1000).toFixed(1) };
}
const amount = (text, value) => new RegExp(`(₹|rs\\.?|inr)\\s?${value.replace(/(\d)(?=(\d{3})+$)/g, "$1,?")}\\b`, "i").test(text);
const note = r => `${r.seconds}s ${r.answer} | ${r.sources.map(s => s.link || s.url).join(" ")}`;

(async () => {
    // Precondition: the stored online-training page holds these four prices (read-only).
    const all = await (async () => {
        let points = [], offset = null;
        do {
            const page = await (await fetch(`${QDRANT}/scroll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ limit: 500, with_payload: ["url", "heading", "chunk"], with_vector: false, filter: { must: [{ key: "chatbotId", match: { value: GYM } }] }, ...(offset ? { offset } : {}) }) })).json();
            points = points.concat(page.result.points);
            offset = page.result.next_page_offset;
        } while (offset);
        return points;
    })();
    const packages = all.find(p => PAGE.test(p.payload.url) && /PACKAGES/.test(p.payload.heading));
    const prices = ["1200", "3000", "7500", "12000"];
    const ready = Boolean(packages) && prices.every(p => packages.payload.chunk.includes(`₹${p}`));
    check("precondition: the indexed online-training page stores the four package prices", ready, packages ? packages.payload.chunk : `no PACKAGES section among ${all.length} stored sections`);
    if (!ready) {
        console.log("Skipping the answer checks: the chatbot's indexed content does not hold the expected page.");
    } else {
        let r = await ask("What are the online fitness training packages and their prices?");
        check("packages question: all four prices", r.status === 200 && prices.every(p => amount(r.answer, p)), note(r));
        check("packages question: dietitian prices not mixed in", !amount(r.answer, "2000") && !amount(r.answer, "5000") && !amount(r.answer, "9000"), note(r));
        check("packages question: cited from the online-training page", r.sources.some(s => PAGE.test(s.url)) && !r.sources.some(s => /dietitian/.test(s.url)), note(r));
        await new Promise(resolve => setTimeout(resolve, 1500));
        r = await ask("How much does the monthly online training plan cost?");
        check("monthly plan: ₹3000 from the online-training page", amount(r.answer, "3000") && r.sources.some(s => PAGE.test(s.url)), note(r));
    }

    console.table(results);
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})().catch(error => { console.error("failed:", error.message); process.exit(1); });
