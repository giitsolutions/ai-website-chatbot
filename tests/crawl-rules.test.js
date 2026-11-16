// Crawl scope rules for help centres (no network). Run: npm test
const fs = require("fs"), path = require("path"), Module = require("module");
const file = path.join(__dirname, "..", "ingest.js");
const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file, "utf8") + "\nmodule.exports.__u = { shouldSkipUrl, getPageType, isSameDomain, scoreUrl, extractSitemapLocations, isMediaSitemap, pageKey };", file);
const { shouldSkipUrl, getPageType, isSameDomain, scoreUrl, extractSitemapLocations, isMediaSitemap, pageKey } = m.exports.__u;

const cases = [
    // [description, actual, expected]
    ["help article about signing in is crawled", shouldSkipUrl("https://acme.example/help/sign-in"), false],
    ["support article about password reset is crawled", shouldSkipUrl("https://acme.example/support/reset-password"), false],
    ["help subdomain article about payment is crawled", shouldSkipUrl("https://help.acme.example/payment"), false],
    ["real login page skipped", shouldSkipUrl("https://acme.example/login"), true],
    ["account orders page skipped", shouldSkipUrl("https://acme.example/account/orders"), true],
    ["checkout page skipped", shouldSkipUrl("https://acme.example/checkout"), true],
    ["help article typed 'help' (usable as a source)", getPageType("https://acme.example/help/sign-in"), "help"],
    ["real login page typed 'account'", getPageType("https://acme.example/login"), "account"],
    ["ordinary page typed 'content'", getPageType("https://acme.example/pricing"), "content"],
    ["help article ranked above an ordinary page", scoreUrl("https://acme.example/help/reset-password", "Reset your password") > scoreUrl("https://acme.example/blog/news", "News"), true],
    ["www and bare domain are the same site", isSameDomain("https://www.acme.example/x", "acme.example"), true],
    ["help. subdomain of the site is included", isSameDomain("https://help.acme.example/a", "acme.example"), true],
    ["support. subdomain included when site is www.", isSameDomain("https://support.acme.example/a", "www.acme.example"), true],
    ["docs. sibling of a help. start site is included", isSameDomain("https://docs.acme.example/", "help.acme.example"), true],
    ["main site not crawled when a help subdomain was registered", isSameDomain("https://acme.example/", "help.acme.example"), false],
    ["other subdomain (shop.) not included", isSameDomain("https://shop.acme.example/", "acme.example"), false],
    ["help. subdomain of another domain not included", isSameDomain("https://help.evil.example/", "acme.example"), false],
    ["look-alike domain not included", isSameDomain("https://help.acme.example.evil.com/", "acme.example"), false],
    // Sitemaps written by WordPress SEO plugins wrap addresses in CDATA.
    ["sitemap <loc> in CDATA is read", extractSitemapLocations("<urlset><url><loc><![CDATA[https://acme.example/devops/]]></loc></url></urlset>").join(), "https://acme.example/devops/"],
    ["plain sitemap <loc> still read, &amp; decoded", extractSitemapLocations("<urlset><url><loc> https://acme.example/a?x=1&amp;y=2 </loc></url></urlset>").join(), "https://acme.example/a?x=1&y=2"],
    ["attachment sitemap skipped (media, not pages)", isMediaSitemap("https://acme.example/attachment-sitemap.xml"), true],
    ["image sitemap skipped", isMediaSitemap("https://acme.example/image_sitemap.xml"), true],
    ["page sitemap kept", isMediaSitemap("https://acme.example/page-sitemap.xml"), false],
    // One key per page: www. and the bare domain, and a trailing slash, are the same page.
    ["www. and bare domain are one page", pageKey("https://www.acme.example/About-Us/") === pageKey("https://acme.example/About-Us"), true],
    ["host name case ignored", pageKey("https://WWW.Acme.Example/") === pageKey("https://acme.example/"), true],
    ["different paths stay different pages", pageKey("https://acme.example/devops") === pageKey("https://acme.example/cloud-solutions"), false],
    ["path case is kept (servers may treat it differently)", pageKey("https://acme.example/About-Us") === pageKey("https://acme.example/about-us"), false],
    ["documentation subdomain is not merged with the main site", pageKey("https://help.acme.example/x") === pageKey("https://acme.example/x"), false],
];

let failures = 0;
const rows = cases.map(([test, got, expected]) => {
    const pass = got === expected;
    if (!pass) failures++;
    return { test, expected, got, result: pass ? "PASS" : "FAIL" };
});
console.table(rows);
console.log(failures ? `${failures} FAILED` : `ALL ${rows.length} PASSED`);
process.exit(failures ? 1 : 0);
