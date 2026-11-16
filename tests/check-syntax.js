// Syntax-checks every test file and the inline <script> blocks of the public pages.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const os = require("os");

const root = path.join(__dirname, "..");
let failures = 0;

for (const file of fs.readdirSync(__dirname).filter(f => f.endsWith(".js"))) {
    try { execFileSync(process.execPath, ["--check", path.join(__dirname, file)], { stdio: "pipe" }); }
    catch (error) { failures++; console.error(`Syntax error in tests/${file}:\n${error.stderr}`); }
}

for (const page of ["public/index.html", "public/widget.html"]) {
    const html = fs.readFileSync(path.join(root, page), "utf8");
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join("\n;\n");
    const tmp = path.join(os.tmpdir(), `inline-${path.basename(page)}.js`);
    fs.writeFileSync(tmp, scripts);
    try { execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" }); }
    catch (error) { failures++; console.error(`Syntax error in inline script of ${page}:\n${error.stderr}`); }
    finally { fs.rmSync(tmp, { force: true }); }
}

console.log(failures ? `${failures} file(s) with syntax errors` : "All files pass the syntax check.");
process.exitCode = failures ? 1 : 0;
