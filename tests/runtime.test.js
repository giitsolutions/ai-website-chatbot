// Runtime behaviour of POST /api/chat: answer cache, one question at a time per
// client, and freeing the slot when the visitor disconnects. Calls the LLM (~2-4 min).
// Run alone, after `npm run test:answers` (which warms the cache):
//   npm run test:runtime        (TEST_BASE_URL defaults to http://localhost:3000)
// The chatbot ID is from the local development database.
const BASE = process.env.TEST_BASE_URL || "http://localhost:3000";
const IANA = process.env.TEST_IANA_CHATBOT_ID || "3e9bc302-3382-4a4a-8557-0cdc6efcf20f";

async function ask(question, signal) {
    const started = Date.now();
    const response = await fetch(`${BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chatbotId: IANA, question }),
        signal
    });
    return { status: response.status, body: await response.json(), ms: Date.now() - started };
}

const results = [];
const record = (test, pass, note) => results.push({ test, result: pass ? "PASS" : "FAIL", note });

(async () => {
    // 1. Cache: the same question twice; the second answer must be identical and fast.
    const q1 = "How far in advance are KSK ceremony dates announced?";
    const first = await ask(q1);
    const second = await ask(q1);
    record("cache: repeated question is identical and fast",
        first.status === 200 && second.status === 200 && second.body.answer === first.body.answer &&
        JSON.stringify(second.body.sources) === JSON.stringify(first.body.sources) && second.ms < 3000,
        `first ${first.ms} ms, second ${second.ms} ms`);

    // 2. Per-client limit: a second new question while the first is still being answered gets 429.
    // The server takes the visitor's slot right after the cache check, before any embedding or
    // model work, and keeps it until the answer is finished. The first question names a policy
    // topic ("covered") and a situation (a number), so the server routes it to the reasoning
    // model, which takes tens of seconds even when warm (the fast model can answer in ~2 s, which
    // made a fixed 4 s wait unreliable). The second question is sent once the first has had time
    // to reach the server and take its slot, and the test checks that the first was still being
    // answered both when the second was sent and when its reply came back.
    const unique = Date.now();
    let firstDone = false;
    const slow = ask(`What travel costs are covered for TCRs? (${unique})`).finally(() => { firstDone = true; });
    await new Promise(resolve => setTimeout(resolve, 500));
    const firstActiveAtSend = !firstDone;
    const blocked = await ask(`What does a KSK ceremony typically last? (${unique})`);
    const firstActiveAtReply = !firstDone;
    const slowResult = await slow;
    record("per-client: the first question was still being answered while the second was asked",
        firstActiveAtSend && firstActiveAtReply,
        `first still active when the second was sent: ${firstActiveAtSend}, when its reply arrived: ${firstActiveAtReply}`);
    record("per-client: second concurrent question is refused with 429",
        blocked.status === 429 && blocked.ms < 3000, `second: HTTP ${blocked.status} in ${blocked.ms} ms`);
    record("per-client: the first question still completes",
        slowResult.status === 200 && typeof slowResult.body.answer === "string",
        `first: HTTP ${slowResult.status} in ${slowResult.ms} ms`);

    // 3. Disconnect: abort after 8 s; the slot must be free again straight away.
    const controller = new AbortController();
    const abandoned = ask(`Who can apply for TCR travel support? (${unique})`, controller.signal).catch(error => error.name);
    await new Promise(resolve => setTimeout(resolve, 8000));
    controller.abort();
    await abandoned;
    await new Promise(resolve => setTimeout(resolve, 1000));
    const after = await ask(q1); // cached, so only the per-client slot is being tested
    record("disconnect: client slot is released after abort",
        after.status === 200, `next request: HTTP ${after.status} in ${after.ms} ms (check server log for "generation cancelled")`);

    console.table(results);
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED` : `ALL ${results.length} PASSED`);
    process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error.message); process.exit(2); });
