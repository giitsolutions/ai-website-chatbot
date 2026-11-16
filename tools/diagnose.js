// Traces one question through a chatbot's pipeline (admin diagnostics; the server must be running).
// Usage:
//   npm run diagnose -- <chatbotId> "<question>" [--url <page address>] [--previous "<question>"] [--generate]
//                       [--base http://localhost:3000] [--allow-remote]
// --url           also checks whether that page is indexed (or why not, from the last crawl report)
// --generate      also asks the model (slow) and shows which guard, if any, produced the fallback
// --base          server address; default http://localhost:3000 (or TEST_BASE_URL)
// --allow-remote  required to send the admin key to a server that is not on this computer;
//                 such a server must use HTTPS (plain HTTP to another computer is always refused)
// The admin key is read from ADMIN_API_KEY / .env and never printed. It is sent only to the
// address checked below, never to a redirect target.
const path = require("path");
const net = require("net");

// May the admin key be sent to this server? Returns { ok, origin } or { ok: false, reason }.
function checkDestination(base, { allowRemote = false } = {}) {
    let url;
    try {
        url = new URL(base);
    } catch {
        return { ok: false, reason: "The server address is not a valid URL." };
    }
    if (!["http:", "https:"].includes(url.protocol)) return { ok: false, reason: "The server address must start with http:// or https://." };
    if (url.username || url.password) return { ok: false, reason: "The server address must not contain a user name or password." };
    if ((url.pathname && url.pathname !== "/") || url.search || url.hash) {
        return { ok: false, reason: "Give only the server address (for example http://localhost:3000), without a path." };
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback = host === "localhost" || host === "::1" || (net.isIPv4(host) && host.startsWith("127."));
    if (loopback) return { ok: true, origin: url.origin };
    if (url.protocol === "http:") {
        return { ok: false, reason: "Refused: the admin key would travel unencrypted (plain HTTP) to another computer. Use an https:// address." };
    }
    if (!allowRemote) {
        return { ok: false, reason: "Refused: this server is not on this computer. Add --allow-remote to send the admin key to it over HTTPS." };
    }
    return { ok: true, origin: url.origin };
}

async function main() {
    const projectDir = path.join(__dirname, "..");
    require(path.join(projectDir, "node_modules", "dotenv")).config({ path: path.join(projectDir, ".env"), quiet: true });

    const args = process.argv.slice(2);
    const option = name => {
        const index = args.indexOf(name);
        return index >= 0 ? args.splice(index, 2)[1] : undefined;
    };
    const flag = name => args.includes(name) && Boolean(args.splice(args.indexOf(name), 1));
    const generate = flag("--generate");
    const allowRemote = flag("--allow-remote");
    const url = option("--url");
    const previousQuestion = option("--previous");
    const base = option("--base") || process.env.TEST_BASE_URL || "http://localhost:3000";
    const [chatbotId, question] = args;
    const key = process.env.ADMIN_API_KEY || "";

    if (!chatbotId || !question) {
        console.error('Usage: npm run diagnose -- <chatbotId> "<question>" [--url <page>] [--previous "<question>"] [--generate] [--base <address>] [--allow-remote]');
        process.exit(1);
    }
    const destination = checkDestination(base, { allowRemote });
    if (!destination.ok) {
        console.error(destination.reason);
        process.exit(1);
    }
    if (key.length < 32) {
        console.error("ADMIN_API_KEY is not configured in .env.");
        process.exit(1);
    }

    let response;
    try {
        response = await fetch(`${destination.origin}/api/admin/chatbots/${encodeURIComponent(chatbotId)}/diagnose`, {
            method: "POST",
            // A redirect would forward the admin key header to another address: refused.
            redirect: "error",
            headers: { "Content-Type": "application/json", "x-admin-api-key": key },
            body: JSON.stringify({ question, url, previousQuestion, generate })
        });
    } catch (error) {
        const cause = String(error.cause?.message || error.message);
        console.error(/redirect/i.test(cause)
            ? "Refused: the server answered with a redirect, which is not followed (the admin key is sent only to the given address)."
            : `Could not reach the server: ${error.cause?.code || cause}`);
        process.exit(1);
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.success) {
        console.error(`HTTP ${response.status}: ${data.error || "request failed"}`);
        process.exit(1);
    }
    for (const step of data.trace.steps) {
        const { step: name, results, ...detail } = step;
        console.log(`\n== ${name}`);
        if (Object.keys(detail).length) console.log(JSON.stringify(detail, null, 2));
        if (results) {
            console.table(results.map(r => ({
                rank: r.rank, page: r.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 45), section: r.section.slice(0, 35),
                vector: r.vectorScore, final: r.finalScore, decision: r.decision.slice(0, 60)
            })));
        }
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error("Diagnosis failed:", error.message);
        process.exit(1);
    });
}

module.exports = { checkDestination };
