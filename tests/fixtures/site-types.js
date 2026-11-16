// Invented websites of different kinds, for tests/answer-eval.test.js and tests/extraction-app-page.test.js.
const links = list => list.map(([href, label]) => `<a href="${href}">${label}</a>`).join(" ");
const declined = kind => ({ kind, decline: true });

// ---- a) A classic multi-page site with real links, built like a WordPress theme ----
const WP_MENU = `<div class="menu-primary-container"><ul id="menu-primary" class="menu"><li><a href="/">Home</a></li><li><a href="/services">Services</a></li><li><a href="/blog">Blog</a></li><li><a href="/about">About</a></li><li><a href="/contact">Contact</a></li></ul></div>`;
const WP_SIDEBAR = `<div class="widget-area"><h3 class="widget-title">Tags</h3><div class="tagcloud">${links([["/tag/roofing", "Roofing"], ["/tag/plumbing", "Plumbing"], ["/tag/solar", "Solar panels"], ["/tag/lawns", "Lawns"], ["/tag/hedges", "Hedges"]])}</div><h3 class="widget-title">Archives</h3><ul><li><a href="/2024/05">May 2024</a></li><li><a href="/2024/04">April 2024</a></li></ul><h3 class="widget-title">Recent posts</h3><ul><li><a href="/blog/winter-lawn">Winter lawn care</a></li><li><a href="/blog/hedge-timing">When to trim a hedge</a></li></ul></div>`;
const wpPage = (title, crumb, main) => `<!doctype html><html><head><title>${title} - Greenthumb Gardens</title><meta name="description" content="Greenthumb Gardens looks after gardens in Mysuru."></head><body><div id="page"><div class="site-header">${WP_MENU}</div><div class="breadcrumbs">${links([["/", "Home"], ["/x", crumb]])}</div><div id="content"><article><h1>${title}</h1>${main}</article>${WP_SIDEBAR}</div><div class="site-footer"><p>Greenthumb Gardens, 8 Palace Road, Mysuru. Phone 0821 555 0142.</p><p>© Greenthumb Gardens. Powered by WordPress.</p></div></div></body></html>`;
const WORDPRESS = {
    "/": wpPage("Greenthumb Gardens", "Start", `<p>We design and look after private gardens, with a small team that has worked in the city for many years.</p><p>${links([["/services", "Our services"], ["/blog", "Latest posts"]])}</p>`),
    "/services": wpPage("Services", "Services", `<h2>Lawn care</h2><p>Mowing, feeding and repairing lawns every two weeks from ₹1,400 per visit.</p><h2>Hedge trimming</h2><p>Hedges are shaped twice a year, and all cuttings are taken away the same day.</p>`),
    "/about": wpPage("About", "About", `<p>Greenthumb Gardens was started in 2009 by two brothers who trained at the state horticulture college.</p>`),
    "/contact": wpPage("Contact", "Contact", `<p>Call us between 8:00 and 17:00 from Monday to Saturday, and we will visit your garden for a free quote.</p>`),
    "/blog": wpPage("Blog", "Blog", `<h2><a href="/blog/winter-lawn">Winter lawn care</a></h2><p>Feed the lawn before the first cold nights and stop mowing once the grass stops growing.</p><div class="nav-links">${links([["/blog/page/1", "1"], ["/blog/page/2", "2"], ["/blog/page/3", "3"], ["/blog/page/2", "Next page"]])}</div>`)
};
const WORDPRESS_QUESTIONS = [
    { kind: "exact", q: "How much does lawn care cost per visit?", must: [/1,?400/], page: "/services" },
    { kind: "paraphrase", q: "Who founded the business and when?", must: [/2009/, /brothers/i], page: "/about" },
    { kind: "contact", q: "How can I contact you?", must: [/0821 555 0142/], page: "/" },
    { kind: "products", q: "What services do you offer?", must: [/lawn/i, /hedge/i], never: [/roofing|plumbing|solar/i], page: "/services" },
    { kind: "follow-up", q: "What services do you offer?", previous: "How can I contact you?", must: [/lawn/i, /hedge/i], never: [/roofing|plumbing|solar/i], page: "/services" },
    { ...declined("menu-words"), q: "Do you install solar panels?", never: [/\byes\b/i] },
    { ...declined("menu-words"), q: "Do you do roofing work?", never: [/\byes\b/i] },
    { ...declined("unrelated"), q: "What is the capital of Australia?", never: [/canberra/i] }
];

// ---- b) A help centre with many pages that use the same words ----
const docsPage = (title, id, sections) => `<!doctype html><html><head><title>${title} - Tasklane Docs</title></head><body><nav>${links([["/", "Docs"], ["/projects", "Projects"], ["/members", "Members"], ["/api-keys", "API keys"], ["/billing", "Billing"], ["/exports", "Exports"], ["/webhooks", "Webhooks"], ["/sso", "Single sign-on"]])}</nav><main><h1 id="${id}">${title}</h1>${sections.map(([heading, text]) => `<h2 id="${heading.toLowerCase().replace(/\W+/g, "-")}">${heading}</h2><p>${text}</p>`).join("")}</main></body></html>`;
const DOCS = {
    "/": docsPage("Tasklane documentation", "docs", [["Getting started", "Tasklane is a project tracker. Create a project, add members, and start tracking tasks in your project."]]),
    "/projects": docsPage("Projects", "projects", [
        ["Create a project", "Open the Projects page and select New project. Give the project a name, and select Create."],
        ["Rename a project", "Open the project, then select Project settings and type the new project name."],
        ["Archive a project", "Open Project settings and select Archive. An archived project keeps its tasks and can be restored."],
        ["Delete a project", "Open Project settings and select Delete project. A deleted project cannot be restored after 30 days."],
        ["Project limits", "A project can have at most 2,000 open tasks. Larger projects should be split into two projects."],
        ["Project templates", "Select Save as template in Project settings to reuse the columns of a project in a new project."]
    ]),
    "/members": docsPage("Members", "members", [["Invite a member", "Open Project settings, select Members, and enter an email address. The invitation is valid for 7 days."], ["Member roles", "A project member is an Editor or a Viewer. Only an Owner can remove a project member."]]),
    "/api-keys": docsPage("API keys", "api-keys", [["Rotate an API key", "Open Developer settings and select Rotate key. The old key for the project stops working after 24 hours."], ["Key scopes", "A key is limited to one project unless it was created by an Owner."]]),
    "/billing": docsPage("Billing", "billing", [["Invoices", "Invoices are emailed on the first day of each month to the billing contact of the project."]]),
    "/exports": docsPage("Exports", "exports", [["Export a project", "Open Project settings, select Export, and choose CSV. A project export link stays valid for 48 hours."]]),
    "/webhooks": docsPage("Webhooks", "webhooks", [["Add a webhook", "Open Developer settings and select Add webhook. A project webhook is retried 5 times if it fails."]]),
    "/sso": docsPage("Single sign-on", "sso", [["Turn on single sign-on", "Single sign-on is available on the Enterprise plan. Ask your Owner to enter the SAML address."]])
};
const DOCS_QUESTIONS = [
    { kind: "exact", q: "How long does the old API key work after rotating it?", must: [/24 hours/i], page: "/api-keys" },
    { kind: "exact", q: "How long is a project export link valid?", must: [/48 hours/i], page: "/exports" },
    { kind: "competing-pages", q: "How do I delete a project and how long is a member invitation valid?", must: [/Delete project/i, /7 days/i], pages: ["/projects", "/members"] },
    { kind: "competing-pages", q: "How many open tasks can a project have, and how many times is a project webhook retried?", must: [/2,?000/, /5 times|five times/i], pages: ["/projects", "/webhooks"] },
    { kind: "paraphrase", q: "I no longer want to see a project but I may need its tasks later. What can I do?", must: [/archive/i], page: "/projects" },
    { kind: "follow-up", q: "And how long does it stay valid?", previous: "How do I export a project?", must: [/48 hours/i], page: "/exports" },
    { ...declined("not-on-site"), q: "Does Tasklane have a mobile app for Android?", never: [/\byes\b/i] },
    { ...declined("unrelated"), q: "Who painted the Mona Lisa?", never: [/vinci/i] }
];

// ---- c) A shop with a grid of 24 product cards and a sidebar of short filter buttons ----
const SOCKS = ["Alpine", "Bamboo", "Cedar", "Delta", "Ember", "Fjord", "Glacier", "Harbor", "Indigo", "Juniper", "Kestrel", "Lagoon", "Maple", "Nimbus", "Orchid", "Prairie", "Quartz", "Ridge", "Sierra", "Tundra", "Umber", "Violet", "Willow", "Zephyr"];
const priceOf = i => 299 + i * 25;
const SOCK_CARDS = SOCKS.map((name, i) => `<a class="card" href="/p/${name.toLowerCase()}"><img src="/i/${i}.png" alt=""><div class="card-name">${name} socks</div><div class="card-price">₹${priceOf(i)}</div></a>`).join("");
const gridPage = cards => `<!doctype html><html><head><title>All socks - Woolpath</title></head><body><header><nav>${links([["/", "Shop"], ["/care", "Care"]])}</nav></header><main><h1>All socks</h1><p>Woolpath knits warm wool socks in its own workshop. Every pair is knitted to order and posted within 3 days.</p><div class="filter-panel"><button>Red</button><button>Blue</button><button>Green</button><button>Under ₹500</button><button>Kids</button><button>Rugs</button></div><div class="sort-by"><button>Newest</button><button>Popular</button><button>Lowest price</button></div><div class="product-grid">${cards}</div><div class="pagination"><button>Previous</button><button>Page two</button><button>Next</button></div></main><footer><p>Woolpath Knitwear, write to orders@woolpath.test.</p></footer></body></html>`;
const GRID = {
    "/": gridPage(SOCK_CARDS),
    "/care": `<!doctype html><html><head><title>Sock care - Woolpath</title></head><body><main><h1>Sock care</h1><p>Wash wool socks cold and dry them flat, away from direct heat, so that they keep their shape.</p></main></body></html>`
};
const GRID_QUESTIONS = [
    { kind: "grid", q: "What does the Quartz socks pair cost?", must: [new RegExp(`${priceOf(SOCKS.indexOf("Quartz"))}`)], page: "/" },
    { kind: "grid", q: "How much are Alpine socks?", must: [new RegExp(`${priceOf(0)}`)], page: "/" },
    { kind: "grid", q: "How much are Zephyr socks?", must: [new RegExp(`${priceOf(23)}`)], page: "/" },
    { kind: "products", q: "What do you sell?", must: [/socks/i], never: [/\brugs\b/i], page: "/" },
    { kind: "follow-up", q: "What do you sell?", previous: "How should I wash them?", must: [/socks/i], never: [/\brugs\b/i], page: "/" },
    { ...declined("filter-words"), q: "Do you sell rugs?", never: [/\byes\b/i] },
    { ...declined("not-on-site"), q: "Do you sell leather boots?", never: [/\byes\b/i] },
    { ...declined("unrelated"), q: "What is the capital of Australia?", never: [/canberra/i] }
];

// ---- d) Metadata that contradicts the page, and metadata that says nothing ----
const CONTRADICT = {
    "/": `<!doctype html><html><head><title>Global Watch Experts</title><meta name="description" content="We repair every watch brand worldwide with free international shipping."><script type="application/ld+json">{"@type":"Organization","name":"Global Watch Experts","areaServed":"Worldwide","telephone":"+1 800 555 0100"}</script></head><body><main><h1>Tickwell watch repair</h1><p>Tickwell repairs mechanical watches at our single workshop. We work only in Pune, and we no longer post watches to other cities.</p><h2>Call us</h2><p>Our only phone number is 020 5550 7788, answered on weekdays from 10:00 to 18:00.</p><h2>Brands</h2><p>We repair Seiko, Citizen and HMT watches. We do not repair quartz or smart watches.</p></main></body></html>`
};
const CONTRADICT_QUESTIONS = [
    { kind: "contradiction", q: "Which areas do you serve?", must: [/Pune/], never: [/worldwide|international/i], page: "/" },
    { kind: "contradiction", q: "What is your phone number?", must: [/020 5550 7788/], never: [/800 555/], page: "/" },
    { kind: "contradiction", q: "Do you ship watches to other cities?", must: [/\b(?:no|not|only|no longer)\b/i], never: [/free international|worldwide/i], page: "/" },
    { kind: "exact", q: "Which watch brands do you repair?", must: [/Seiko/, /Citizen/, /HMT/], page: "/" },
    { kind: "follow-up", q: "What is your phone number?", previous: "Which brands do you repair?", must: [/020 5550 7788/], never: [/800 555/], page: "/" },
    { ...declined("not-on-site"), q: "Do you sell watch straps?", never: [/\byes\b/i] }
];
const GENERIC = {
    "/": `<!doctype html><html><head><title>Home | My Site</title><meta name="description" content="Welcome to my site. Just another website."><meta property="og:title" content="Home"></head><body><main><h1>Clearwater Pools</h1><p>Clearwater Pools cleans and repairs swimming pools at homes and hotels around Goa.</p><h2>Prices</h2><p>A weekly pool cleaning visit costs ₹2,200, and chemicals are included in that price.</p></main></body></html>`
};
const GENERIC_QUESTIONS = [
    { kind: "generic-meta", q: "What does this company do?", must: [/pool/i], never: [/just another/i], page: "/" },
    { kind: "exact", q: "How much is a weekly cleaning visit?", must: [/2,?200/], page: "/" },
    { kind: "follow-up", q: "Are chemicals included?", previous: "How much is a weekly cleaning visit?", must: [/included|yes/i], page: "/" },
    { ...declined("not-on-site"), q: "Do you build new swimming pools?", never: [/\byes\b/i] },
    { ...declined("unrelated"), q: "What is the capital of Australia?", never: [/canberra/i] }
];

// ---- e) Hinglish and Hindi pages, with other JSON-LD types ----
const HINGLISH = {
    "/": `<!doctype html><html lang="hi"><head><title>Sharma Rasoi</title><meta name="description" content="Sharma Rasoi - ghar jaisa khana, Lucknow mein."><script type="application/ld+json">[{"@context":"https://schema.org","@type":"Restaurant","name":"Sharma Rasoi","servesCuisine":"North Indian","telephone":"0522 555 0160","priceRange":"₹₹","address":{"@type":"PostalAddress","streetAddress":"12 Hazratganj","addressLocality":"Lucknow"},"openingHours":"Tu-Su 11:00-22:00"},{"@type":"Product","name":"Gift voucher","description":"A voucher for friends.","telephone":"0000"}]</script></head><body><main><h1>Sharma Rasoi mein aapka swagat hai</h1><p>Hamari rasoi mein roz taaza khana banta hai, bilkul ghar jaisa. Hum Lucknow ke andar 5 km tak free delivery dete hain.</p><h2>Menu</h2><ul><li>Paneer tikka: ₹180</li><li>Dal makhani: ₹140</li><li>Veg thali: ₹220</li></ul><h2>Order kaise karein</h2><p>Phone karke ya WhatsApp par order kijiye. Payment UPI ya cash se hoti hai.</p></main></body></html>`,
};
const HINGLISH_QUESTIONS = [
    { kind: "hinglish", q: "paneer tikka ka rate kya hai?", must: [/180/], page: "/" },
    { kind: "hinglish", q: "What is the price of a veg thali?", must: [/220/], page: "/" },
    { kind: "metadata", q: "What is your phone number?", must: [/0522 555 0160/], never: [/0000/], page: "/" },
    { kind: "metadata", q: "kitne baje khulte ho?", must: [/11/], page: "/" },
    { kind: "metadata", q: "Where are you located?", must: [/Hazratganj|Lucknow/], page: "/" },
    { kind: "follow-up", q: "aur dal makhani?", previous: "paneer tikka ka rate kya hai?", must: [/140/], page: "/" },
    { ...declined("not-on-site"), q: "Do you serve pizza?", never: [/\byes\b/i] },
    { ...declined("wrong-type-metadata"), q: "Do you sell gift vouchers?", never: [/\byes\b/i] }
];
const HINDI = {
    "/": `<!doctype html><html lang="hi"><head><title>गुप्ता किराना स्टोर</title><script type="application/ld+json">{"@type":"LocalBusiness","name":"गुप्ता किराना स्टोर","telephone":"0755 555 0121","address":"भोपाल"}</script></head><body><main><h1>गुप्ता किराना स्टोर</h1><p>हम भोपाल में किराने का सामान घर तक पहुंचाते हैं। दुकान सुबह 8 बजे से रात 9 बजे तक खुली रहती है।</p><h2>हमारे सामान</h2><ul><li>आटा: 45 रुपये किलो</li><li>चावल: 60 रुपये किलो</li><li>चीनी: 42 रुपये किलो</li></ul></main></body></html>`
};
const HINDI_QUESTIONS = [
    { kind: "hindi", q: "चावल का दाम क्या है?", must: [/60/], page: "/" },
    { kind: "hindi", q: "दुकान कब खुलती है?", must: [/8/], page: "/" },
    { kind: "metadata", q: "What is the phone number?", must: [/0755 555 0121/], page: "/" },
    { ...declined("not-on-site"), q: "क्या आप मोबाइल फोन बेचते हैं?", never: [/हां|हाँ/] },
    { ...declined("unrelated"), q: "What is the capital of Australia?", never: [/canberra/i] }
];

// ---- f) No metadata at all ----
const NOMETA = {
    "/": `<html><body><h1>Rivertown Bicycle Repair</h1><p>We fix punctures, brakes and gears for all kinds of bicycles while you wait, in the old market of Rivertown.</p><h2>Prices</h2><p>A puncture repair costs ₹120 and a full brake service costs ₹450.</p></body></html>`
};
const NOMETA_QUESTIONS = [
    { kind: "exact", q: "How much is a puncture repair?", must: [/120/], page: "/" },
    { kind: "products", q: "What services do you offer?", must: [/puncture/i, /brake/i], page: "/" },
    { kind: "follow-up", q: "And a brake service?", previous: "How much is a puncture repair?", must: [/450/], page: "/" },
    { ...declined("not-on-site"), q: "Do you sell new bicycles?", never: [/\byes\b/i] },
    { ...declined("single-item"), q: "Do you sell dumbbells?", never: [/dumbbell/i] },
    { ...declined("unrelated"), q: "What is the capital of Australia?", never: [/canberra/i] }
];

module.exports = {
    SITES: { wordpress: WORDPRESS, docs: DOCS, grid: GRID, contradict: CONTRADICT, generic: GENERIC, hinglish: HINGLISH, hindi: HINDI, nometa: NOMETA },
    QUESTIONS: { wordpress: WORDPRESS_QUESTIONS, docs: DOCS_QUESTIONS, grid: GRID_QUESTIONS, contradict: CONTRADICT_QUESTIONS, generic: GENERIC_QUESTIONS, hinglish: HINGLISH_QUESTIONS, hindi: HINDI_QUESTIONS, nometa: NOMETA_QUESTIONS },
    SOCKS
};
