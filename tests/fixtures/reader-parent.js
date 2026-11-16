// Test helper: a process that starts a long document parse, reports the reader's process ID on
// stdout, then exits abruptly while the reader is still working (simulates a server stop).
const path = require("path");
const { extractDocument } = require(path.join(__dirname, "..", "..", "documents.js"));
const { makePdf } = require(path.join(__dirname, "documents.js"));

const big = makePdf(Array.from({ length: 500 }, (_, i) => [`S${i}`, ...Array.from({ length: 220 }, (_, k) => `Line ${k} of page ${i}: the warranty and returns rules apply as written in this manual.`)]));
extractDocument(big, "pdf", "big.pdf", {
    timeoutMs: 120000,
    onReaderStart: pid => {
        process.stdout.write(`reader ${pid}\n`);
        setTimeout(() => process.exit(0), 300);
    }
}).catch(() => {});
