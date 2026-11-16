// Extraction of a rendered script-built page (no network, no browser, no model). The fixture has the
// structure of a real shop page with all its text replaced by placeholder words. Run: npm run test:extraction-app-page
const fs = require("fs"), path = require("path"), Module = require("module");
const cheerio = require(require.resolve("cheerio", { paths: [path.join(__dirname, "..")] }));

const file = path.join(__dirname, "..", "ingest.js");
const m = new Module(file); m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
m._compile(fs.readFileSync(file, "utf8") + "\nmodule.exports.__x = { extractSections, createChunks, countTextWords, FOOTER_HEADING, ABOUT_HEADING };", file);
const { extractSections, createChunks, countTextWords, FOOTER_HEADING, ABOUT_HEADING } = m.exports.__x;

const results = [];
const check = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 140) });

const html = fs.readFileSync(path.join(__dirname, "fixtures", "rendered-app-page.html"), "utf8");
const sections = extractSections(cheerio.load(html), "Placeholder Title");
const textOf = section => section.blocks.join("\n");
const all = sections.map(section => `${section.heading}\n${textOf(section)}`).join("\n");
const words = countTextWords(all);
const chunks = createChunks(sections);
const footer = sections.find(section => section.isFooter);
const headingsInPage = cheerio.load(html)("main h1, main h2, main h3").length;

// The page shows about 475 words; the rest are menus, short button labels and the copyright line.
check("most visible words are kept (at least 440 of about 475)", words >= 440 && words <= 475, words);
check("split at headings: 13 sections", sections.length === 13, sections.map(section => section.heading).join(" | "));
check("not one big block: 9 chunks, none over 150 words", chunks.length === 9 && chunks.every(chunk => countTextWords(chunk.chunk) <= 150), chunks.map(chunk => countTextWords(chunk.chunk)).join(","));
check("every heading with text under it starts a section", sections.filter(section => !section.isFooter).length >= headingsInPage - 2, `${sections.length} sections, ${headingsInPage} headings`);
check("the 5 cards are stored together under one chunk", chunks.filter(chunk => (chunk.chunk.match(/₹/g) || []).length >= 10).length === 1, chunks.map(chunk => (chunk.chunk.match(/₹/g) || []).length).join(","));
check("prices in div and span are kept, the crossed-out one marked", (all.match(/was ₹[\d,]+ ₹[\d,]+/g) || []).length === 5, all.match(/was ₹[^\n]{0,30}/)?.[0]);
check("a rating is kept", /★ 7\.7/.test(all));
check("icons, initials and step numbers are not blocks", !sections.some(section => section.blocks.some(block => /^[*\s]*\p{L}{0,2}[*\s]*$|^\d+$/u.test(block))));
check("footer: one section with the contact lines", Boolean(footer) && footer.heading === FOOTER_HEADING && /desk@placeholder\.invalid/.test(textOf(footer)) && /\+77 7777777777/.test(textOf(footer)), footer ? textOf(footer).slice(0, 120) : "none");
check("footer: copyright line dropped", !/©/.test(all));
check("menu buttons are not kept (nav, footer columns, short card buttons)", !/\n(?:[a-z]+ ?){1,3}\n(?:[a-z]+ ?){1,3}\n(?:[a-z]+ ?){1,3}\n(?:[a-z]+ ?){1,3}\n(?:[a-z]+ ?){1,3}\n/i.test(textOf(footer || { blocks: [] })));

// Generic rules on small pages.
const read = page => extractSections(cheerio.load(page), "Title");
const textIn = page => read(page).map(section => `${section.heading}\n${textOf(section)}`).join("\n");
const WORDS = "<p>Ordinary visible words about what this business does for each of its customers every day.</p>";

check("row of menu links in divs is removed", !/Blog|Careers/.test(textIn(`<main><h1>A</h1>${WORDS}<div><a href="/1">Blog</a> | <a href="/2">Careers</a> | <a href="/3">Press</a></div></main>`)));
check("a sentence with a link inside it is kept", /Write to us on our contact page today/.test(textIn(`<main><h1>A</h1>${WORDS}<div>Write to us on our <a href="/c">contact page</a> today.</div></main>`)));
check("a card built as one link keeps its text", /A long description of the service/.test(textIn(`<main><h1>A</h1>${WORDS}<a href="/x"><div>Service</div><div>A long description of the service for visitors.</div></a></main>`)));
check("role=navigation and breadcrumbs are removed", !/Home-Crumb|Side-Menu/.test(textIn(`<main><h1>A</h1>${WORDS}<div role="navigation"><div>Side-Menu entry text</div></div><div class="breadcrumbs"><span>Home-Crumb trail here</span></div></main>`)));
check("hidden text is not read", !/Hidden-Text/.test(textIn(`<main><h1>A</h1>${WORDS}<div style="display: none">Hidden-Text one</div><div hidden>Hidden-Text two</div><div aria-hidden="true">Hidden-Text three</div></main>`)));
check("cookie banner with a button is removed", !/cookies/i.test(textIn(`<body><div><p>We use cookies to improve this website for you.</p><button>Accept</button></div><main><h1>A</h1>${WORDS}</main></body>`)));
check("cookie banner in the content without a main element is removed", !/cookies/i.test(textIn(`<body><h1>A</h1>${WORDS}<div class="cookie-notice"><span>This site uses cookies. By continuing you consent to this.</span></div></body>`)));
check("a bakery's cookies stay", /Our cookies are baked fresh/.test(textIn(`<main><h1>Cookies</h1>${WORDS}<div class="cookie-card"><div>Our cookies are baked fresh every morning.</div></div></main>`)));
check("a privacy page about cookies stays", /You can block cookies in your browser/.test(textIn(`<main><h1>Privacy</h1><section><h2>Cookies</h2><p>You can block cookies in your browser settings at any time you like.</p><a href="/more">Read our full policy page here</a></section></main>`)));
check("footer menu lists are removed, its text kept", (() => {
    const text = textIn(`<main><h1>A</h1>${WORDS}</main><footer><ul><li><a href="/1">Shipping</a></li><li><a href="/2">Returns</a></li></ul><p>Refunds are paid within 7 days of the return.</p><p>© 2020 Someone. All rights reserved.</p></footer>`);
    return /Refunds are paid within 7 days/.test(text) && !/Shipping|Returns|Someone/.test(text);
})());
check("a footer inside an article is still removed", !/Posted-By/.test(textIn(`<main><article><h1>A</h1>${WORDS}<footer>Posted-By somebody on a certain day</footer></article></main>`)));
check("main headings stay separate chunks when the sections are not tiny", (() => {
    const long = "Words about this subject that a visitor would want to read in full here, with a few more words so that it is not a tile.";
    return createChunks(read(`<main><h2>One</h2><p>${long}</p><h2>Two</h2><p>${long} More.</p></main>`)).length === 2;
})());
check("tiny tiles under main headings are still merged", createChunks(read(`<main><h2>Weekly plan</h2><p>Price 7 for a week.</p><h2>Monthly plan</h2><p>Price 20 for a month.</p></main>`)).length === 1);

// A grid of short buttons is a list; menus stay out.
const GRID = '<div><button>Rowing machines</button><button>Skipping ropes</button><button>Spin bikes</button></div>';
const gridText = textIn(`<main><h1>Our gear</h1>${WORDS}${GRID}</main>`);
check("3 short sibling buttons stay as a list in their section", /- Rowing machines\n- Skipping ropes\n- Spin bikes/.test(gridText), gridText);
check("the same buttons wrapped one by one stay as a list", /- Rowing machines/.test(textIn(`<main><h1>Our gear</h1>${WORDS}<div><div><button>Rowing machines</button></div><div><button>Skipping ropes</button></div><div><button>Spin bikes</button></div></div></main>`)));
check("linked pictures with short names stay as a list", /- Rowing machines/.test(textIn(`<main><h1>Our gear</h1>${WORDS}<div><a href="/1"><img src="a.png">Rowing machines</a><a href="/2"><img src="b.png">Skipping ropes</a><a href="/3"><img src="c.png">Spin bikes</a></div></main>`)));
check("2 short buttons are not a grid", !/View all|Sign up/.test(textIn(`<main><h1>A</h1>${WORDS}<div><button>View all</button><button>Sign up</button></div></main>`)));
check("repeats do not count: 3 'Add to cart' buttons are not a grid", !/Add to cart/.test(textIn(`<main><h1>A</h1>${WORDS}<div><button>Add to cart</button><button>Add to cart</button><button>Add to cart</button></div></main>`)));
for (const [name, page] of [
    ["in nav", `<nav><button>Home</button><button>About</button><button>Contact</button></nav><main><h1>A</h1>${WORDS}</main>`],
    ["in the page's header", `<header><div><button>Home</button><button>About</button><button>Contact</button></div></header><main><h1>A</h1>${WORDS}</main>`],
    ["in the footer", `<main><h1>A</h1>${WORDS}</main><footer><div><button>Home</button><button>About</button><button>Contact</button></div></footer>`],
    ["named a menu", `<main><h1>A</h1>${WORDS}<div class="side-menu"><button>Home</button><button>About</button><button>Contact</button></div></main>`],
    ["named tabs", `<main><h1>A</h1>${WORDS}<div id="tabs"><button>Home</button><button>About</button><button>Contact</button></div></main>`],
    ["a row of links without pictures", `<main><h1>A</h1>${WORDS}<div><a href="/1">Home</a><a href="/2">About</a><a href="/3">Contact</a></div></main>`]
]) check(`menu buttons stay out: ${name}`, !/Home|About|Contact\b/.test(textIn(page).replace(FOOTER_HEADING, "")), textIn(page));

// Metadata as one small section.
const META = `<head><title>Fitloop hire</title><meta name="description" content="Hire gear at home."><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"LocalBusiness","name":"Fitloop","areaServed":[{"@type":"City","name":"Greater Noida"},"Delhi"],"telephone":"+91 120 555","email":"desk@fit.test","address":{"@type":"PostalAddress","streetAddress":"1 Park Road","addressLocality":"Noida"},"openingHoursSpecification":{"dayOfWeek":["Monday","Friday"],"opens":"09:00","closes":"18:00"},"priceRange":"₹₹","sameAs":["https://x.test"]},{"@type":"Person","name":"Secret Founder","telephone":"999"},{"@type":"Product","name":"Spin bike","description":"A product text."}]}</script><script type="application/ld+json">{ broken</script></head>`;
const aboutOf = page => read(page).find(section => section.isAbout);
const facts = textOf(aboutOf(`<html>${META}<body><main><h1>A</h1>${WORDS}</main></body></html>`) || { blocks: [] });
check("about: title, description and JSON-LD facts are read", ["Website title: Fitloop hire", "Description: Hire gear at home.", "Name: Fitloop", "Areas served: Greater Noida, Delhi", "Phone: +91 120 555", "Email: desk@fit.test", "Address: 1 Park Road, Noida", "Opening hours: Monday, Friday 09:00-18:00", "Price range: ₹₹"].every(line => facts.includes(line)), facts);
check("about: people, products and social links are not business facts; broken JSON is ignored", !/Secret Founder|999|Spin bike|product text|x\.test/.test(facts), facts);
check("about: named 'About this website' and one chunk of its own", (() => { const about = createChunks(read(`<html>${META}<body><main><h1>A</h1><p>Short text here.</p></main></body></html>`)).filter(chunk => chunk.heading === ABOUT_HEADING); return about.length === 1 && /Areas served/.test(about[0].chunk); })());
check("about: a page with only a title has none", !aboutOf(`<html><head><title>Just a title</title></head><body><main><h1>A</h1>${WORDS}</main></body></html>`));
check("about: an HTML tag in a value is not kept", !/<b>/.test(textOf(aboutOf('<head><script type="application/ld+json">{"@type":"Organization","description":"<b>Bold</b> words"}</script></head><body><main><h1>A</h1></main></body>') || { blocks: [] })));

// Other kinds of websites (tests/fixtures/site-types.js).
const { SITES, SOCKS } = require(path.join(__dirname, "fixtures", "site-types"));
const stored = (site, page = "/") => { const list = extractSections(cheerio.load(SITES[site][page]), "Title"); return { list, text: list.map(section => `${section.heading}\n${textOf(section)}`).join("\n"), about: list.find(section => section.isAbout) }; };
const wordpress = Object.keys(SITES.wordpress).map(page => stored("wordpress", page).text).join("\n");
check("WordPress: menu, breadcrumbs, pagination and tag cloud are not content", !/Roofing|Plumbing|Solar|Next page|Archives|May 2024|\bStart\b|^- Home/m.test(wordpress), wordpress.slice(0, 200));
check("WordPress: footer built from a div keeps the phone, not the credit", /0821 555 0142/.test(wordpress) && !/Powered by/.test(wordpress));
const noArticle = SITES.wordpress["/services"].replace(/<\/?article>/g, "");
const noArticleText = read(noArticle).map(section => `${section.heading}\n${textOf(section)}`).join("\n");
check("WordPress without <article>: services kept; menu, tags and sidebar still out", /Lawn care/.test(noArticleText) && !/Roofing|Archives|Recent posts|^- Blog$/m.test(noArticleText), noArticleText.slice(0, 200));
check("a restaurant's list named menu keeps its prices", /Paneer: ₹180/.test(textIn(`<main><h1>Food</h1>${WORDS}<ul class="menu"><li>Paneer: ₹180</li><li>Dal: ₹140</li></ul></main>`)));
const shop = stored("grid");
check("shop: all 24 products and prices are kept", SOCKS.every((name, i) => shop.text.includes(`${name} socks ₹${299 + i * 25}`)), shop.text.slice(0, 200));
check("shop: filters, sort and pagination are not content", !/\bRugs\b|\bKids\b|Lowest price|Newest|Page two|- Red/.test(shop.text), shop.text.slice(0, 240));
check("buttons that choose something are not cards, whatever the container is called", !/Small|Medium|Large/.test(textIn(`<main><h1>A</h1>${WORDS}<div class="x1"><button aria-pressed="false">Small</button><button aria-pressed="false">Medium</button><button aria-pressed="true">Large</button></div></main>`)));
check("a class name that only contains a menu word is still a grid", /- Rowing machines/.test(textIn(`<main><h1>A</h1>${WORDS}<div class="canvas-resort-grid"><button>Rowing machines</button><button>Skipping ropes</button><button>Spin bikes</button></div></main>`)));
check("generic title and description: no About section", !stored("generic").about, stored("generic").about ? textOf(stored("generic").about) : "");
check("a real description next to a generic title is kept, without the title", (() => { const about = aboutOf('<head><title>Home | My Site</title><meta name="description" content="We clean swimming pools in Goa."></head><body><main><h1>A</h1></main></body>'); return about && /We clean swimming pools/.test(textOf(about)) && !/My Site/.test(textOf(about)); })());
check("no metadata at all: no About section", !stored("nometa").about);
const contradicted = textOf(stored("contradict").about || { blocks: [] });
check("metadata phone that the page contradicts is dropped", !/800 555/.test(contradicted), contradicted);
check("metadata phone with no phone on the page is kept", /Phone: \+91 120 555/.test(textOf(aboutOf('<head><script type="application/ld+json">{"@type":"Organization","telephone":"+91 120 555 0199"}</script></head><body><main><h1>A</h1><p>Some words.</p></main></body>') || { blocks: [] })));
check("the same number written differently is not a contradiction", /Phone: /.test(textOf(aboutOf('<head><script type="application/ld+json">{"@type":"Organization","telephone":"+91 120 555 0199"}</script></head><body><main><h1>A</h1><p>Call 120-555-0199 today.</p></main></body>') || { blocks: [] })));
const restaurant = textOf(stored("hinglish").about || { blocks: [] });
check("JSON-LD Restaurant is read; Product is not", /Cuisine: North Indian/.test(restaurant) && /0522 555 0160/.test(restaurant) && !/Gift voucher|0000/.test(restaurant), restaurant);
check("Hindi metadata is read", /भोपाल/.test(textOf(stored("hindi").about || { blocks: [] })));

// ---- Forms, footers and metadata on the app-like site types ----
const appTypes = require(path.join(__dirname, "fixtures", "app-site-types"));
const readPage = page => extractSections(cheerio.load(page), "Page");
const allOf = list => list.map(section => `${section.heading}\n${textOf(section)}`).join("\n");
const calculator = readPage(appTypes.SITES.calculator["/"]);
const calculatorText = allOf(calculator);
check("form: dropdown options become one readable line", /Capacity: options 1 T, 1\.5 T, 5 T, 9 T, 16 T, 25 T, 40 T/.test(calculatorText), calculatorText);
check("form: radio groups use their legend", /Body type: options Open Body, Closed Body/.test(calculatorText) && /Trip type: options One Way, Two Way/.test(calculatorText));
check("form: tabs, field labels and action buttons are kept", /Modes: Single Trip, Batch Upload/.test(calculatorText) && /Fields: Origin, Destination, Payload \(T\)/.test(calculatorText) && /Actions: Add stop, Calculate cost/.test(calculatorText));
check("form: typed values, hidden fields and secrets are never stored", !/Typed By A Visitor|77331|secret-token|hunter22|Password/.test(calculatorText), calculatorText);
check("form: a list of 200 countries is skipped", !/Country number/.test(calculatorText));
check("form: the placeholder option is not an option", !/Select capacity/.test(calculatorText));
const quote = allOf(readPage(appTypes.SITES.quote["/"]));
check("form: real form tag is read", /Home size: options 1 BHK, 2 BHK, 3 BHK, Villa/.test(quote) && /Extras: options Packing materials, Vehicle transport, Storage/.test(quote) && /Actions: Get my quote/.test(quote), quote);
check("form: login, search and newsletter forms are not facts", !/Username|Secret word|Search the site|Newsletter|Sign in/.test(quote), quote);
check("form: card numbers are never stored", !/4111|Card number/.test(quote));
const booking = allOf(readPage(appTypes.SITES.booking["/book"]));
check("form: booking page keeps treatments and dentists, not typed names or tokens", /Root canal/.test(booking) && /Dr\. Meera Joshi/.test(booking) && !/Typed Visitor|booking-token/.test(booking), booking);
check("form: a shop's filter controls are still not facts", !/\brugs\b/i.test(allOf(readPage(SITES.grid["/"]))));
check("form: a lone search box makes no form section", !readPage(`<main><h1>Tea</h1><p>We sell green tea from our own small garden in Darjeeling hills.</p><input placeholder="Search"><button>Go</button></main>`).some(section => section.isForm));
check("form: a page without a tool has no modes", !/Modes:/.test(allOf(readPage(`<main><h1>Tea</h1><p>We sell green tea from our own small garden in Darjeeling hills.</p><div role="tablist"><button role="tab">Details</button><button role="tab">Reviews</button></div></main>`))));
const tool = allOf(readPage(appTypes.SITES.tool["/"]));
check("tool: plain buttons above the tool are modes, without role=tab", /Modes: Quick Plan, Bulk Import/.test(tool), tool);
check("tool: a label before a dropdown names it", /Container size: options 20 ft, 40 ft, 45 ft/.test(tool) && /Cargo type: options Cartons, Drums, Pallets/.test(tool), tool);
check("tool: a label before a row of two buttons names it", /Stacking: options Stackable, Not stackable/.test(tool), tool);
check("tool: 'e.g.' is not a field name, labels are", /Fields: Destination port, Carton weight \(kg\)/.test(tool) && !/e\.g\./.test(tool), tool);
check("tool: a single button stays an action", /Actions: Show load plan/.test(tool), tool);
check("tool: navigation buttons are not modes", !/Pricing/.test(tool), tool);
check("tool: typed values stay out", !/4411|Mundra/.test(tool), tool);
check("footer: a labelled part of a copyright block after main", /Technology Partner: Quantiva Systems/.test(tool) && !/All rights reserved|Cargofy •/.test(tool), tool);
const branch = textOf(readPage(appTypes.SITES.branch["/"]).find(section => section.isFooter) || { blocks: [] });
check("footer: inside main, other separators", /FSSAI Licence: 11521999000123/.test(branch) && /Bank partner: Unity Cooperative Bank/.test(branch) && /Karve Road/.test(branch) && !/All rights reserved/.test(branch), branch);
check("footer: an article's own footer is not the page's", !readPage(`<main><article><h1>Post</h1><p>A long enough article text about tea and how we grow it in the hills.</p><footer>Posted by: Asha</footer></article></main>`).some(section => section.isFooter));
check("rows: tabs in a container named tabs are modes", /Modes: Single, Batch/.test(allOf(readPage(`<main><h1>Tool</h1><div class="tabs"><button role="tab">Single</button><button role="tab">Batch</button></div><select><option>One</option><option>Two</option></select></main>`))));
check("rows: tabs inside nav are not modes", !/Modes/.test(allOf(readPage(`<main><h1>Tool</h1><nav><button role="tab">Single</button><button role="tab">Batch</button></nav><select><option>One</option><option>Two</option></select></main>`))));
check("rows: a filter row is not modes", !/Rugs/.test(allOf(readPage(`<main><h1>Tool</h1><div class="filters"><button>Rugs</button><button>Mats</button></div><select><option>One</option><option>Two</option></select></main>`))));
check("rows: a page without a tool has no rows", !/Modes:|options/.test(allOf(readPage(`<main><h1>Tea</h1><p>We sell green tea from our own small garden in Darjeeling hills.</p><div><button>Add to cart</button><button>Wishlist</button></div></main>`))));
const calculatorFooter = textOf(calculator.find(section => section.isFooter) || { blocks: [] });
check("footer: a label on a copyright line is kept, the copyright is not", calculatorFooter === "Technical Partner: Zentrix Labs", calculatorFooter);
const legal = textOf(readPage(appTypes.SITES.legal["/"]).find(section => section.isFooter) || { blocks: [] });
check("footer: short labelled lines are kept", /GSTIN: 27ABCDE1234F1Z5/.test(legal) && /CIN: U72900/.test(legal) && /Registered office: 3rd Floor/.test(legal), legal);
check("footer: a value in its own link joins its label", /Grievance officer: Asha Menon/.test(legal), legal);
check("footer: menus, cookies and copyright stay out", !/Careers|Refund policy|Accept cookies|All rights reserved/.test(legal), legal);
const metadataOf = (head, body) => textOf(readPage(`<html><head>${head}</head><body><main><h1>Shop</h1>${body}</main></body></html>`).find(section => section.isAbout) || { blocks: [] });
const jsonLd = fields => `<script type="application/ld+json">${JSON.stringify({ "@type": "Organization", ...fields })}</script>`;
check("metadata: 'worldwide' goes when the page says one city", !/Worldwide/.test(metadataOf(jsonLd({ name: "A", areaServed: "Worldwide" }), "<p>We work only in Pune.</p>")));
check("metadata: another area goes when the page says only one", !/Nashik/.test(metadataOf(jsonLd({ name: "A", areaServed: "Nashik" }), "<p>We work only in Pune.</p>")));
check("metadata: the same area stays", /Areas served: Pune, Nashik/.test(metadataOf(jsonLd({ name: "A", areaServed: "Pune, Nashik" }), "<p>We work only in Pune.</p>")));
check("metadata: an area stays when the page says nothing about it", /Areas served: Worldwide/.test(metadataOf(jsonLd({ name: "A", areaServed: "Worldwide" }), "<p>We repair watches.</p>")));
check("metadata: a description claiming reach goes when the page limits it", !/worldwide/i.test(metadataOf(`<meta name="description" content="We ship worldwide."> ${jsonLd({ name: "A" })}`, "<p>We no longer ship to other cities.</p>")));
check("metadata: contradicted opening hours go", !/Opening hours/.test(metadataOf(jsonLd({ name: "A", openingHours: "Mo-Fr 09:00-17:00" }), "<p>Open daily 11:00 to 20:00.</p>")));
check("metadata: matching opening hours stay, in any format", /Opening hours/.test(metadataOf(jsonLd({ name: "A", openingHours: "Mo-Fr 09:00-17:00" }), "<p>Open daily 9 am to 5 pm.</p>")));

for (const r of results) console.log(`${r.result}  ${r.test}${r.result === "FAIL" && r.note ? `  [${r.note}]` : ""}`);
const failed = results.filter(r => r.result !== "PASS").length;
console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
process.exit(failed ? 1 : 0);
