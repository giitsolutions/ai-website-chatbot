// Invented websites whose facts sit in forms, metadata and legal footers, for tests/answer-eval.test.js and
// tests/extraction-app-page.test.js.
const declined = kind => ({ kind, decline: true });
const options = list => list.map(item => `<option>${item}</option>`).join("");
const COUNTRIES = Array.from({ length: 200 }, (_, index) => `Country number ${index + 1}`);

// ---- A calculator: tabs, dropdowns, radio buttons and fields, without a <form> tag ----
const CALCULATOR = {
    "/": `<!doctype html><html><head><title>Loadwise | Haulage Cost Calculator</title></head><body><header><a href="/"><img src="/logo.png" alt="Loadwise"></a></header><main><h1>Know your haulage cost before you commit</h1><p>Loadwise estimates the full cost of a road haulage trip from live diesel prices and route distances.</p><div role="tablist"><button role="tab" aria-selected="true">Single Trip</button><button role="tab" aria-selected="false">Batch Upload</button></div><div class="calculator"><label for="from">Origin</label><input id="from" type="text" value="Typed By A Visitor"><label for="to">Destination</label><input id="to" type="text"><button>+ Add stop</button><label for="capacity">Capacity</label><select id="capacity"><option value="">Select capacity</option>${options(["1 T", "1.5 T", "5 T", "9 T", "16 T", "25 T", "40 T"])}</select><label for="length">Length</label><select id="length">${options(["7 ft", "14 ft", "22 ft", "40 ft"])}</select><label for="axles">Axles</label><select id="axles">${options(["2-Axle", "3-Axle", "5-Axle"])}</select><fieldset><legend>Body type</legend><label><input type="radio" name="body"> Open Body</label><label><input type="radio" name="body"> Closed Body</label></fieldset><fieldset><legend>Trip type</legend><label><input type="radio" name="trip"> One Way</label><label><input type="radio" name="trip"> Two Way</label></fieldset><label for="payload">Payload (T)</label><input id="payload" type="number" value="77331"><label for="country">Country</label><select id="country">${options(COUNTRIES)}</select><input type="hidden" name="csrf" value="secret-token-99"><label for="pin">Password</label><input id="pin" type="password" value="hunter22"><button>Calculate cost</button></div></main><footer><p>© 2026 Loadwise. All rights reserved • Technical Partner: Zentrix Labs</p></footer></body></html>`
};
const CALCULATOR_QUESTIONS = [
    { kind: "form-options", q: "What truck capacities can I select?", must: [/1 T/, /40 T/], page: "/" },
    { kind: "form-options", q: "What body types can I choose?", must: [/Open/i, /Closed/i], page: "/" },
    { kind: "form-options", q: "Can I choose a two way trip?", must: [/two[- ]way/i], page: "/" },
    { kind: "form-options", q: "Can I upload many trips at once?", must: [/batch/i], page: "/" },
    { kind: "footer-label", q: "Who is the technical partner?", must: [/Zentrix/], page: "/" },
    { kind: "follow-up", q: "And what lengths?", previous: "What truck capacities can I select?", must: [/7 ft/, /40 ft/], page: "/" },
    { kind: "hinglish", q: "capacity ke options kya hain?", must: [/40 T/], page: "/" },
    { ...declined("not-stored"), q: "What is the password?", never: [/hunter22/] },
    { ...declined("not-stored"), q: "What is the csrf token?", never: [/secret-token/] },
    { ...declined("calculation"), q: "How much will a trip from Delhi to Mumbai cost?", never: [/₹|rs\.?\s?\d|rupees/i] }
];

// ---- A booking site: the form is on its own page ----
const BOOKING_NAV = `<nav><a href="/">Home</a><a href="/book">Book</a></nav>`;
const BOOKING = {
    "/": `<!doctype html><html><head><title>Lotus Dental Clinic, Indore</title></head><body>${BOOKING_NAV}<main><h1>Lotus Dental Clinic</h1><p>Family dental care in Vijay Nagar, Indore. Open Monday to Saturday, 10:00 to 19:00. Call 0731 555 0163.</p></main></body></html>`,
    "/book": `<!doctype html><html><head><title>Book an appointment - Lotus Dental Clinic</title></head><body>${BOOKING_NAV}<main><h1>Book an appointment</h1><form action="/book" method="post"><label for="treatment">Treatment</label><select id="treatment" name="treatment"><option value="">Choose a treatment</option>${options(["Check-up", "Scaling and polishing", "Tooth filling", "Root canal", "Braces consultation"])}</select><label for="dentist">Dentist</label><select id="dentist" name="dentist">${options(["Dr. Meera Joshi", "Dr. Kabir Sethi"])}</select><fieldset><legend>Time of day</legend><label><input type="radio" name="slot"> Morning</label><label><input type="radio" name="slot"> Afternoon</label><label><input type="radio" name="slot"> Evening</label></fieldset><label for="who">Your name</label><input id="who" name="name" value="Typed Visitor Name"><input type="hidden" name="token" value="booking-token-55"><button type="submit">Request appointment</button></form></main></body></html>`
};
const BOOKING_QUESTIONS = [
    { kind: "form-options", q: "Which treatments can I book?", must: [/Root canal/i, /Tooth filling/i], page: "/book" },
    { kind: "form-options", q: "Which dentists can I choose?", must: [/Meera Joshi/, /Kabir Sethi/], page: "/book" },
    { kind: "form-options", q: "Can I book an evening appointment?", must: [/evening/i], page: "/book" },
    { kind: "contact", q: "What is your phone number?", must: [/0731 555 0163/], page: "/" },
    { kind: "exact", q: "When are you open?", must: [/10:00/, /19:00/], page: "/" },
    { kind: "follow-up", q: "And which dentists?", previous: "Which treatments can I book?", must: [/Meera Joshi/], page: "/book" },
    { kind: "hinglish", q: "kaun kaun se treatment book kar sakte hain?", must: [/Root canal/i], page: "/book" },
    { ...declined("not-on-site"), q: "Do you offer eye surgery?" },
    { ...declined("not-stored"), q: "Who booked an appointment?", never: [/Typed Visitor/] }
];

// ---- A quote request site, with login and newsletter forms that are not facts ----
const QUOTE = {
    "/": `<!doctype html><html><head><title>Swiftshift Movers, Jaipur</title></head><body><header><form role="search"><input type="search" placeholder="Search the site"><button>Search</button></form></header><main><h1>House moving in Jaipur</h1><p>Swiftshift packs and moves homes and offices across Rajasthan. We send every quote within a day.</p><h2>Get a free quote</h2><form action="/quote" method="post"><label for="a">Moving from</label><input id="a" name="from"><label for="b">Moving to</label><input id="b" name="to"><label for="size">Home size</label><select id="size" name="size">${options(["1 BHK", "2 BHK", "3 BHK", "Villa"])}</select><fieldset><legend>Extras</legend><label><input type="checkbox" name="e"> Packing materials</label><label><input type="checkbox" name="e"> Vehicle transport</label><label><input type="checkbox" name="e"> Storage</label></fieldset><label for="card">Card number</label><input id="card" name="card_number" autocomplete="cc-number" value="4111111111111111"><button type="submit">Get my quote</button></form><h2>Customer login</h2><form action="/login" method="post"><label for="u">Username</label><input id="u" name="user"><label for="p">Secret word</label><input id="p" type="password" name="pass"><button>Sign in</button></form></main><footer><form action="/news"><label for="n">Newsletter address</label><input id="n" type="email" name="email"><button>Join</button></form><p>Swiftshift Movers, 4 MI Road, Jaipur.</p></footer></body></html>`
};
const QUOTE_QUESTIONS = [
    { kind: "form-options", q: "What home sizes can I get a quote for?", must: [/2 BHK/, /Villa/], page: "/" },
    { kind: "form-options", q: "What extras are available?", must: [/Packing materials/i, /Vehicle transport/i, /Storage/i], page: "/" },
    { kind: "exact", q: "How quickly do you send a quote?", must: [/within a day/i], page: "/" },
    { kind: "contact", q: "What is your address?", must: [/4 MI Road/], page: "/" },
    { kind: "follow-up", q: "And what extras?", previous: "What home sizes can I get a quote for?", must: [/Storage/i], page: "/" },
    { kind: "hinglish", q: "kaunse extras milte hain?", must: [/Storage/i], page: "/" },
    { ...declined("price-not-stated"), q: "How much does moving a 2 BHK cost?", never: [/₹|rupees/i] },
    { ...declined("not-stored"), q: "What is the card number?", never: [/4111/] }
];

// ---- A restaurant: a priced list called "menu", and JSON-LD of type Restaurant ----
const RESTAURANT = {
    "/": `<!doctype html><html><head><title>Coastal Kitchen, Kochi</title><meta name="description" content="Kerala seafood in Fort Kochi."><script type="application/ld+json">{"@context":"https://schema.org","@type":"Restaurant","name":"Coastal Kitchen","servesCuisine":"Kerala seafood","telephone":"+91 484 555 0177","openingHours":"Tu-Su 12:00-22:00","address":{"@type":"PostalAddress","streetAddress":"9 Bazaar Road","addressLocality":"Fort Kochi"},"paymentAccepted":"Cash, UPI"}</script></head><body><nav class="menu"><a href="/">Home</a><a href="/menu">Menu</a></nav><main><h1>Coastal Kitchen</h1><p>Fresh Kerala seafood, cooked the way our grandmother did.</p><h2>Our menu</h2><ul class="menu-items"><li>Karimeen pollichathu - ₹480</li><li>Prawn roast - ₹420</li><li>Appam with stew - ₹220</li><li>Payasam - ₹90</li></ul></main></body></html>`
};
const RESTAURANT_QUESTIONS = [
    { kind: "exact", q: "How much is the prawn roast?", must: [/420/], page: "/" },
    { kind: "products", q: "What is on the menu?", must: [/Karimeen/i, /Payasam/i], page: "/" },
    { kind: "contact", q: "What is your phone number?", must: [/484 555 0177/], page: "/" },
    { kind: "metadata", q: "What are your opening hours?", must: [/12:00/, /22:00/], page: "/" },
    { kind: "metadata", q: "Do you accept UPI?", must: [/UPI|yes/i], page: "/" },
    { kind: "follow-up", q: "And the payasam?", previous: "How much is the prawn roast?", must: [/90/], page: "/" },
    { kind: "hinglish", q: "appam ka price kitna hai?", must: [/220/], page: "/" },
    { ...declined("not-on-site"), q: "Do you serve pizza?" }
];

// ---- Only the metadata says anything: the page itself is an empty shell ----
const METAONLY = {
    "/": `<!doctype html><html><head><title>Northwind Solar | Rooftop Solar Installers</title><meta name="description" content="Northwind Solar installs rooftop solar panels for homes in Nashik."><script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Northwind Solar","areaServed":["Nashik","Pune"],"telephone":"+91 253 555 0188","email":"hello@northwind.example","openingHours":"Mo-Fr 09:30-17:30","address":{"@type":"PostalAddress","streetAddress":"22 College Road","addressLocality":"Nashik"}}</script></head><body><div id="root"><p>Loading</p></div></body></html>`
};
const METAONLY_QUESTIONS = [
    { kind: "metadata", q: "What does this company do?", must: [/solar/i], page: "/" },
    { kind: "metadata", q: "Which areas do you serve?", must: [/Nashik/, /Pune/], page: "/" },
    { kind: "contact", q: "What is your phone number?", must: [/253 555 0188/], page: "/" },
    { kind: "contact", q: "What is your email address?", must: [/hello@northwind\.example/], page: "/" },
    { kind: "contact", q: "What is your address?", must: [/22 College Road/], page: "/" },
    { kind: "metadata", q: "What are your opening hours?", must: [/09:30/, /17:30/], page: "/" },
    { kind: "follow-up", q: "And your email?", previous: "What is your phone number?", must: [/hello@northwind\.example/], page: "/" },
    { ...declined("leak"), q: "Who wrote the play Hamlet?", never: [/shakespeare/i] },
    { ...declined("leak"), q: "What is the boiling point of water?", never: [/100/] }
];

// ---- A long legal footer: short labelled lines are facts, the legal text and menus are not ----
const LEGAL = {
    "/": `<!doctype html><html><head><title>Finora Ledger | Invoicing software</title></head><body><main><h1>Finora Ledger</h1><p>Finora Ledger is invoicing software for small shops, with GST invoices, reminders and payment tracking.</p></main><div id="cookie-notice"><p>We use cookies to improve this site. See our policy.</p><button>Accept cookies</button></div><footer><ul><li><a href="/terms">Terms</a></li><li><a href="/privacy">Privacy</a></li><li><a href="/refunds">Refund policy</a></li><li><a href="/careers">Careers</a></li></ul><p>GSTIN: 27ABCDE1234F1Z5</p><p>CIN: U72900MH2019PTC123456</p><p>Authorised capital: 10 lakh rupees</p><p>Registered office: 3rd Floor, Lake View Tower, Powai, Mumbai</p><div>Grievance officer:</div><div><a href="/grievance">Asha Menon</a></div><p>Finora Ledger Private Limited is not a bank. Nothing on this website is tax, legal or financial advice, and all product names, logos and brands belong to their respective owners. Use of this website means that you accept its terms of use and its privacy policy, which may change at any time without notice to you.</p><p>© 2026 Finora Ledger Private Limited. All rights reserved.</p></footer></body></html>`
};
const LEGAL_QUESTIONS = [
    { kind: "footer-label", q: "What is your GSTIN?", must: [/27ABCDE1234F1Z5/], page: "/" },
    { kind: "footer-label", q: "What is your CIN number?", must: [/U72900MH2019PTC123456/], page: "/" },
    { kind: "footer-label", q: "Where is your registered office?", must: [/Powai/], page: "/" },
    { kind: "footer-label", q: "Who is the grievance officer?", must: [/Asha Menon/], page: "/" },
    { kind: "products", q: "What does this software do?", must: [/invoic/i], page: "/" },
    { kind: "follow-up", q: "And your CIN?", previous: "What is your GSTIN?", must: [/U72900MH2019PTC123456/], page: "/" },
    { kind: "hinglish", q: "aapka GSTIN kya hai?", must: [/27ABCDE1234F1Z5/], page: "/" },
    { ...declined("not-on-site"), q: "Do you offer bank loans?" }
];

// ---- An app built from plain elements: tabs and segmented controls are buttons, labels are not linked to
// their dropdowns, and the copyright line with a labelled fact is a plain block after <main> ----
const TOOL = {
    "/": `<!doctype html><html><head><title>Cargofy | Container Load Planner</title></head><body><div class="page"><header><nav><button>Home</button><button>Pricing</button></nav></header><main><h1>Plan your container load</h1><p>Cargofy works out how many cartons fit in a shipping container before you book it.</p><div class="switcher"><button class="on">Quick Plan</button><button>Bulk Import</button></div><div class="grid"><div><span>Container size</span><select><option>20 ft</option><option>40 ft</option><option>45 ft</option></select></div><div><div>Cargo type</div><div><select><option>Cartons</option><option>Drums</option><option>Pallets</option></select></div></div><div><label>Destination port</label><input placeholder="e.g. Mundra"></div><div><label>Carton weight (kg)</label><input type="number" value="4411"></div><div><span>Stacking</span><div><button>Stackable</button><button>Not stackable</button></div></div><button>Show load plan</button></div></main><div class="legal">© 2026 Cargofy <span>•</span> All rights reserved <span>•</span> <span>Technology Partner: Quantiva Systems</span></div></div></body></html>`
};
const TOOL_QUESTIONS = [
    { kind: "modes", q: "Can I import many shipments at once?", must: [/bulk import/i], page: "/" },
    { kind: "form-options", q: "What container sizes can I choose?", must: [/20 ft/, /45 ft/], page: "/" },
    { kind: "form-options", q: "What cargo types are supported?", must: [/Drums/, /Pallets/], page: "/" },
    { kind: "form-options", q: "Can I mark cargo as not stackable?", must: [/not stackable/i], page: "/" },
    { kind: "footer-label", q: "Who is the technology partner?", must: [/Quantiva Systems/], page: "/" },
    { kind: "follow-up", q: "And the cargo types?", previous: "What container sizes can I choose?", must: [/Drums/], page: "/" },
    { kind: "hinglish", q: "container size ke options kya hain?", must: [/45 ft/], page: "/" },
    { ...declined("menu-words"), q: "What are your pricing plans?", never: [/₹|\$/] },
    { kind: "not-stored", q: "What is the carton weight?", must: [], never: [/4411/] },
    { ...declined("no-location-stated"), q: "aap kahan par ho?" }
];

// ---- A footer inside <main>, with other separators, and a location in two places ----
const BRANCH = {
    "/": `<!doctype html><html><head><title>Sunrise Tiffin Service</title><meta name="description" content="Home-cooked tiffin delivered across the Pune region."><script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Sunrise Tiffin","areaServed":"Pune region"}</script></head><body><main><h1>Sunrise Tiffin Service</h1><p>Fresh home-cooked lunch boxes delivered to your office every weekday.</p><h2>Plans</h2><p>The monthly lunch plan costs ₹3,200 and includes 22 meals.</p><footer><p>© 2026 Sunrise Foods – All rights reserved – FSSAI Licence: 11521999000123</p><p>Shop 7, Karve Road, Kothrud, Pune 411038</p><p>Copyright Sunrise Foods | Bank partner: Unity Cooperative Bank</p></footer></main></body></html>`
};
const BRANCH_QUESTIONS = [
    { kind: "footer-label", q: "What is your FSSAI licence number?", must: [/11521999000123/], page: "/" },
    { kind: "footer-label", q: "Who is your bank partner?", must: [/Unity Cooperative/], page: "/" },
    { kind: "location", q: "Where are you located?", must: [/Kothrud|Karve Road/, /Pune/], page: "/" },
    { kind: "location", q: "Where are you located and which areas do you serve?", must: [/Kothrud|Karve Road/, /Pune region/], page: "/" },
    { kind: "exact", q: "How much is the monthly lunch plan?", must: [/3,?200/], page: "/" },
    { kind: "follow-up", q: "And your location?", previous: "How much is the monthly lunch plan?", must: [/Kothrud|Karve Road/], page: "/" },
    { kind: "hinglish", q: "aap kahan par ho?", must: [/Kothrud|Karve Road|कोथरुड|कर्वे/], page: "/" },
    { ...declined("not-on-site"), q: "Do you cater weddings?" }
];

// ---- Citations: pages that repeat the business's words without holding the answer ----
const SOURCES_FOOTER = `<footer><p>Brightpath Tutors, write to help@brightpath.test or call 0120 555 0144.</p></footer>`;
const sourcesPage = (title, main) => `<!doctype html><html><head><title>${title} - Brightpath Tutors</title></head><body><nav><a href="/">Home</a><a href="/courses">Courses</a><a href="/terms">Terms and Conditions</a><a href="/register">Register</a><a href="/investors">Investors</a></nav><main><h1>${title}</h1>${main}</main>${SOURCES_FOOTER}</body></html>`;
const SOURCES = {
    "/": sourcesPage("Brightpath Tutors", `<p>Brightpath Tutors teaches school students online in small groups.</p>`),
    "/courses": sourcesPage("Courses", `<h2>Maths tuition</h2><p>Maths tuition for classes 6 to 10 costs ₹1,800 per month, with three live classes every week.</p><h2>Science tuition</h2><p>Science tuition for classes 6 to 10 costs ₹1,600 per month, with two live classes every week.</p>`),
    "/terms": sourcesPage("Terms and Conditions", `<p>By using Brightpath Tutors, students and parents agree that online classes, tuition, course material and support are given as described. Students must attend live classes politely. For help with these terms, contact us by email or phone.</p>`),
    "/register": sourcesPage("Register", `<p>Register your student for online tuition. Students choose a course, parents give an email and a phone number, and classes start the next week.</p>`),
    "/investors": sourcesPage("Our Investors", `<p>Brightpath Tutors is funded by investors who believe that every student should have live classes, online tuition and support.</p>`)
};
const SOURCES_QUESTIONS = [
    { kind: "citation", q: "How much is maths tuition?", must: [/1,?800/], pages: ["/courses"], onlyPages: true },
    { kind: "citation", q: "How many live classes does science tuition have every week?", must: [/\btwo\b|\b2\b/i], pages: ["/courses"], onlyPages: true },
    { kind: "citation", q: "Who funds Brightpath Tutors?", must: [/investors/i], pages: ["/investors"], onlyPages: true },
    { kind: "citation", q: "What is your phone number?", must: [/0120 555 0144/] },
    { kind: "follow-up", q: "And science tuition?", previous: "How much is maths tuition?", must: [/1,?600/], pages: ["/courses"], onlyPages: true },
    { kind: "hinglish", q: "maths tuition ki fees kitni hai?", must: [/1,?800/], pages: ["/courses"], onlyPages: true },
    { ...declined("not-on-site"), q: "Do you teach piano?" }
];

// ---- An app whose menu is buttons: each button shows a list of cards, and a card does not say which list it
// belongs to. Its delivery area is only in the metadata, and the home page has many sections that compete with it ----
const menuCard = (name, text, price) => `<article role="button" tabindex="0"><h3>${name}</h3><p>${text}</p><div><strong>₹${price} / 3 months</strong></div></article>`;
const MENU_VIEWS = {
    Guitars: `<h1>Guitars</h1><p>Choose a guitar by the number of strings you need.</p><h2>All guitars</h2>` + menuCard("Model: G-10", "Spruce Top String Instrument | 6 Strings", "2,100") + menuCard("Model: G-20", "Mahogany Body String Instrument | 12 Strings", "2,900") + menuCard("Model: G-30", "Maple Neck String Instrument | 6 Strings", "2,400"),
    Ukuleles: `<h1>Ukuleles</h1><p>Small instruments for beginners.</p><h2>All ukuleles</h2>` + menuCard("Model: U-5", "Soprano String Instrument | 4 Strings", "900") + menuCard("Model: U-7", "Concert String Instrument | 4 Strings", "1,100"),
    Keyboards: `<h1>Keyboards</h1><p>For practice at home.</p><h2>All keyboards</h2>` + menuCard("Model: K-61", "Portable Practice Instrument | 61 Keys", "1,800") + menuCard("Model: K-88", "Stage Practice Instrument | 88 Keys", "3,200"),
    Everything: `<h1>All instruments</h1><p>7 instruments.</p>` + ["G-10", "G-20", "G-30", "U-5", "U-7", "K-61", "K-88"].map(model => menuCard(`Model: ${model}`, "See its own list for details about this instrument", "–")).join("")
};
const MENU_HOME = `<h1>Play music at home</h1><p>Rent an instrument for as long as you are learning, and return it when you are done.</p><h2>Why rent from us</h2><p>Every instrument is tuned and cleaned before it reaches you, and we collect it from your door at the end of your plan.</p><h2>How it works</h2><p>Pick an instrument from our lists, choose a plan of 3 or 6 months, and pay when it arrives at your door.</p><h2>Our story</h2><p>Three teachers started this service after seeing how many students stop learning because an instrument costs too much to buy.</p><h2>Popular this month</h2>` + menuCard("Model: G-10", "Spruce Top String Instrument | 6 Strings", "2,100") + menuCard("Model: U-5", "Soprano String Instrument | 4 Strings", "900") + menuCard("Model: K-61", "Portable Practice Instrument | 61 Keys", "1,800");
const MENUAPP = {
    "/": `<!doctype html><html><head><meta charset="utf-8"><title>Tunerent - Instruments on hire</title><meta name="description" content="Hire instruments for home practice with Tunerent."><script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Tunerent","areaServed":"Nashik Region"}</script></head><body><header><nav>${["Home", "Guitars", "Ukuleles", "Keyboards", "Everything"].map(label => `<button type="button" data-view="${label}">${label}</button>`).join("")}</nav></header><main id="view">${MENU_HOME}</main><footer><p>Tunerent. Call 0253 555 0171 or write to hello@tunerent.test.</p></footer><script>
const views = ${JSON.stringify({ Home: MENU_HOME, ...MENU_VIEWS }).replace(/</g, "\u003c")};
document.querySelectorAll("nav button").forEach(button => button.addEventListener("click", () => { document.getElementById("view").innerHTML = views[button.dataset.view]; }));
</script></body></html>`
};
const MENUAPP_QUESTIONS = [
    { kind: "menu-list", q: "Which ukuleles do you have?", must: [/U-5/, /U-7/], never: [/G-\d|K-\d/], page: "/" },
    { kind: "menu-list", q: "Which keyboards do you have?", must: [/K-61/, /K-88/], never: [/G-\d|U-\d/], page: "/" },
    { kind: "menu-list", q: "Which guitars do you have?", must: [/G-10/, /G-20/, /G-30/], never: [/U-\d|K-\d/], page: "/" },
    { kind: "menu-list", q: "Do you have a guitar with 6 strings?", must: [/G-10/, /G-30/], page: "/" },
    { kind: "exact", q: "How much is the K-88?", must: [/3,?200/], page: "/" },
    { kind: "metadata", q: "Which areas do you deliver to?", must: [/Nashik/], page: "/" },
    { kind: "metadata", q: "Where do you deliver?", must: [/Nashik/], page: "/" },
    { kind: "hinglish", q: "aap kahan par ho?", must: [/Nashik|नाशिक/], page: "/" },
    { ...declined("not-on-site"), q: "Do you rent violins?" },
    { ...declined("not-on-site"), q: "Do you deliver to Chennai?" }
];

module.exports = {
    SITES: { calculator: CALCULATOR, booking: BOOKING, quote: QUOTE, restaurant: RESTAURANT, metaonly: METAONLY, legal: LEGAL, tool: TOOL, branch: BRANCH, sources: SOURCES, menuapp: MENUAPP },
    QUESTIONS: { calculator: CALCULATOR_QUESTIONS, booking: BOOKING_QUESTIONS, quote: QUOTE_QUESTIONS, restaurant: RESTAURANT_QUESTIONS, metaonly: METAONLY_QUESTIONS, legal: LEGAL_QUESTIONS, tool: TOOL_QUESTIONS, branch: BRANCH_QUESTIONS, sources: SOURCES_QUESTIONS, menuapp: MENUAPP_QUESTIONS },
    // What a broad question must mention for each site type, in English or Hindi script.
    BROAD: {
        tiles: /gear|rowing|फिटनेस|उपकरण/i, vague: /gear|fitness|फिटनेस|उपकरण/i, shop: /bicycle|bike|साइकिल|बाइक/i, service: /clean|सफाई/i, help: /note|inkpad|नोट/i,
        wordpress: /garden|lawn|बगीचे|बाग|लॉन/i, docs: /task|project|कार्य|प्रोजेक्ट|परियोजना/i, grid: /sock|मोज़े|मोजे/i, contradict: /watch|घड़ी|घड़ियों/i, generic: /pool|पूल/i,
        hinglish: /paneer|thali|dhaba|food|पनीर|थाली|भोजन|खाना/i, hindi: /आटा|चावल|किराना|grocery|flour|rice/i, nometa: /bicycle|puncture|repair|साइकिल|पंक्चर|मरम्मत/i,
        calculator: /haulage|cost|लागत|ढुलाई/i, booking: /dental|treatment|root canal|दंत|उपचार/i, quote: /mov|pack|पैक|शिफ्ट/i, restaurant: /seafood|karimeen|prawn|समुद्री|भोजन/i, metaonly: /solar|सोलर|सौर/i, legal: /invoic|इनवॉइस|चालान/i,
        tool: /container|load|carton|cargo/i, branch: /tiffin|lunch|meal/i, sources: /tuition|class|course/i, menuapp: /instrument|guitar|ukulele|keyboard|वाद्य|गिटार/i
    }
};
