// Local TEST HOST for the embeddable widget: serves the files in this demo/ folder on
// their own origin (default http://localhost:5050), so the widget runs on a "customer
// website" that is a different site from the chatbot server (http://localhost:3000).
// Not part of the product. No dependencies. Run: npm run demo:host  (or: node demo/serve.js 5051)
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.argv[2] || process.env.DEMO_PORT || 5050);
const ROOT = __dirname;
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".svg": "image/svg+xml" };

const server = http.createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405).end();
        return;
    }
    const pathname = decodeURIComponent(new URL(req.url, "http://host").pathname);
    const name = pathname === "/" ? "customer-site.html" : pathname.slice(1);
    const file = path.join(ROOT, name);
    // Only files directly inside demo/, never the server script itself.
    if (path.dirname(file) !== ROOT || name === "serve.js" || !TYPES[path.extname(file)]) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
    }
    fs.readFile(file, (error, data) => {
        if (error) {
            res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
            return;
        }
        res.writeHead(200, { "Content-Type": TYPES[path.extname(file)], "Cache-Control": "no-store" });
        res.end(req.method === "HEAD" ? undefined : data);
    });
});

server.on("error", error => {
    console.error(error.code === "EADDRINUSE" ? `Port ${PORT} is in use. Try: node demo/serve.js ${PORT + 1}` : error.message);
    process.exit(1);
});

// Loopback only: this test page is never reachable from other computers.
server.listen(PORT, "127.0.0.1", () => {
    console.log("Test host (pretend customer website) is running.");
    console.log(`  Open:  http://localhost:${PORT}/            (origin http://localhost:${PORT})`);
    console.log(`  Also:  http://127.0.0.1:${PORT}/            (a DIFFERENT origin, for the allowed-websites test)`);
    console.log("Keep this window open while testing. Press Ctrl+C to stop.");
});
