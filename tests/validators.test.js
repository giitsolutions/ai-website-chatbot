// Direct validator checks for chatbotRegistry.js and ingest.js.
// No database writes, no crawling. Run: npm test
const fs = require("fs"), path = require("path"), Module = require("module");
const dir = path.resolve(__dirname, "..");

function load(file, exportsExpr, stubs = {}) {
    const full = path.join(dir, file);
    const m = new Module(full); m.filename = full; m.paths = Module._nodeModulePaths(dir);
    const req = m.require.bind(m); m.require = id => (id in stubs ? stubs[id] : req(id));
    m._compile(fs.readFileSync(full, "utf8") + `\nmodule.exports.__t = ${exportsExpr};`, full);
    return m.exports.__t;
}

const reg = load("chatbotRegistry.js", "{ normalizeWebsiteUrl, assertPublicWebsiteUrl, isValidChatbotId }", { "./dbPool": {} });
const ingestFns = load("ingest.js", "{ assertPublicHttpUrl, parseRobotsTxt, isAllowedByRobots }");
const ingestCheck = ingestFns.assertPublicHttpUrl;

const ROBOTS = [
    "User-agent: Googlebot", "Disallow: /", "",
    "User-agent: *", "User-agent: OtherBot",
    "Disallow: /private/", "Allow: /private/public-page",
    "Disallow: /*.pdf$", "Disallow: /search?", "Disallow:", "",
    "Sitemap: https://example.com/sitemap.xml"
].join("\n");
const robotsCases = [
    ["https://x.com/", true], ["https://x.com/private/data", false],
    ["https://x.com/private/public-page", true], ["https://x.com/a/report.pdf", false],
    ["https://x.com/a/report.pdf?x=1", true], ["https://x.com/search?q=a", false], ["https://x.com/search", true]
];

const urlCases = [
    // [url, expected: "accept" | "reject"]
    ["https://example.com/", "accept"],
    ["https://example.org/", "accept"],
    ["https://www.iana.org/domains/reserved", "accept"],
    ["https://example.com:443/", "accept"],
    ["http://example.com:80/", "accept"],
    ["http://8.8.8.8/", "accept"],
    ["http://[2606:4700:4700::1111]/", "accept"],
    ["https://example.com:8443/", "reject"],
    ["http://example.com:22/", "reject"],
    ["http://127.0.0.1/", "reject"],
    ["http://localhost/", "reject"],
    ["http://service.internal/", "reject"],
    ["http://10.1.2.3/", "reject"],
    ["http://169.254.169.254/latest/meta-data/", "reject"],
    ["http://[::1]/", "reject"],
    ["http://[::ffff:127.0.0.1]/", "reject"],
    ["http://[64:ff9b::7f00:1]/", "reject"],
    ["http://[2002:7f00:1::1]/", "reject"],
    ["http://[2001:0:4136:e378:8000:63bf:3fff:fdd2]/", "reject"],
    ["http://[fd00::1]/", "reject"],
    ["http://localtest.me/", "reject"],
    ["ftp://example.com/", "reject"],
    ["https://user:pass@example.com/", "reject"],
];

(async () => {
    let failures = 0;
    const rows = [];
    for (const [url, expected] of urlCases) {
        let regResult, ingResult;
        try { const { normalizedUrl } = reg.normalizeWebsiteUrl(url); await reg.assertPublicWebsiteUrl(new URL(normalizedUrl)); regResult = "accept"; } catch (e) { regResult = "reject"; }
        try { await ingestCheck(url); ingResult = "accept"; } catch (e) { ingResult = "reject"; }
        const ok = regResult === expected && ingResult === expected;
        if (!ok) failures++;
        rows.push({ url, expected, registry: regResult, crawler: ingResult, result: ok ? "PASS" : "FAIL" });
    }
    const idCases = [["483c0167-cc2b-457d-97ce-cd5fc399d65c", true], ["abc", false], [{ x: 1 }, false], ["", false], ["483c0167-cc2b-457d-97ce-cd5fc399d65c' OR 1=1", false]];
    for (const [id, expected] of idCases) {
        const got = reg.isValidChatbotId(id);
        if (got !== expected) failures++;
        rows.push({ url: "chatbotId " + JSON.stringify(id), expected: String(expected), registry: String(got), crawler: "-", result: got === expected ? "PASS" : "FAIL" });
    }
    const robotsRules = ingestFns.parseRobotsTxt(ROBOTS);
    for (const [url, expected] of robotsCases) {
        const got = ingestFns.isAllowedByRobots(robotsRules, url);
        if (got !== expected) failures++;
        rows.push({ url: "robots.txt " + url, expected: expected ? "allowed" : "blocked", registry: "-", crawler: got ? "allowed" : "blocked", result: got === expected ? "PASS" : "FAIL" });
    }
    const emptyAllows = ingestFns.isAllowedByRobots(ingestFns.parseRobotsTxt(""), "https://x.com/anything");
    if (!emptyAllows) failures++;
    rows.push({ url: "robots.txt missing/empty", expected: "allowed", registry: "-", crawler: emptyAllows ? "allowed" : "blocked", result: emptyAllows ? "PASS" : "FAIL" });

    console.table(rows);
    console.log(failures ? `${failures} FAILED` : "ALL PASSED");
    process.exitCode = failures ? 1 : 0;
})();
