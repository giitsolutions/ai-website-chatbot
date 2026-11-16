// Uploaded documents: validation and extraction (no server, no model, no database). Run: npm test
const path = require("path");
const { validateUpload, extractDocument, documentChunks, indexDocument, pdfPageSections, MAX_DOCUMENT_BYTES } = require("../documents.js");
const { makePdf, makeImageOnlyPdf, makeDocx } = require("./fixtures/documents.js");

const longPdfForMemory = () => makePdf(Array.from({ length: 200 }, (_, i) => [`Section ${i + 1}`, ...Array.from({ length: 40 }, (_, k) => `Line ${k + 1} of page ${i + 1}: the warranty and returns rules apply as written in this manual.`)]));
const results = [];
const check = (test, pass, note = "") => results.push({ test, result: pass ? "PASS" : "FAIL", note: String(note).slice(0, 110) });
const rejects = (fn, status, pattern) => {
    try {
        fn();
        return false;
    } catch (error) {
        return error.expose === true && error.status === status && pattern.test(error.message);
    }
};

(async () => {
    const pdf = makePdf([
        ["Returns Procedure", "Open the Returns screen in the warehouse system.", "Scan the parcel barcode and choose a reason code."],
        ["Escalation", "Photograph damaged parcels and email the claims team within 48 hours."]
    ]);
    const docx = makeDocx([
        { heading: "Warranty Manual", level: 1 },
        { text: "All rowing machines carry a 5-year frame warranty and a 2-year warranty on parts. Keep the receipt as proof of purchase for any claim." },
        { heading: "Claims", level: 2 },
        { text: "Send the serial number, a photograph of the fault and the proof of purchase to the service desk. A technician replies within two working days." }
    ]);

    // ---- Validation ----
    // Headings inside PDF pages (numbered sections; numbered lists stay lists; page breaks).
    const sop = pdfPageSections(4, ["Refund Processing SOP", "2 Approval", "Refunds above 500 euro need a manager.", "2.1 Verify the request", "1. Open the refund form", "2. Check the order number", "3. Compare the amount with the invoice", "2.2 Approve the refund", "The team lead approves within two working days."]);
    check("PDF headings: numbered headings inside a page become sections", JSON.stringify(sop.sections.map(section => section.heading)) === JSON.stringify(["2 Approval", "2.1 Verify the request", "2.2 Approve the refund"]), JSON.stringify(sop.sections.map(section => section.heading)));
    check("PDF headings: a numbered list (1. 2. 3.) stays inside its section", sop.sections[1].blocks.length === 3 && sop.sections[1].blocks[0] === "1. Open the refund form");
    check("PDF headings: every section keeps its page number", sop.sections.every(section => section.page === 4));
    const continued = pdfPageSections(5, ["the refund is paid back to the original card.", "3 Records", "Keep the form for seven years."], sop.lastHeading);
    check("PDF headings: text continuing on the next page keeps the previous heading and its own page", continued.sections[0].heading === "2.2 Approve the refund" && continued.sections[0].page === 5 && continued.sections[1].heading === "3 Records", JSON.stringify(continued.sections.map(section => [section.heading, section.page])));
    const sentences = pdfPageSections(2, ["Overview", "1 The form must be signed.", "2 Keep a copy."]);
    check("PDF headings: numbered sentences are not headings", sentences.sections.length === 1 && sentences.sections[0].heading === "Overview" && sentences.sections[0].blocks.length === 2);
    check("PDF headings: a page without headings or title is 'Page N'", pdfPageSections(7, ["This page starts with a sentence.", "More text."]).sections[0].heading === "Page 7");
    check("valid PDF accepted", validateUpload("SOP Returns.pdf", pdf).fileType === "pdf");
    check("valid DOCX accepted", validateUpload("manual.DOCX", docx).fileType === "docx");
    check("unsupported extension refused (415)", rejects(() => validateUpload("notes.txt", Buffer.from("hello")), 415, /not supported/));
    check("legacy .doc refused with advice (415)", rejects(() => validateUpload("old.doc", Buffer.from("x")), 415, /save them as \.docx/));
    check("text file renamed to .pdf refused (signature)", rejects(() => validateUpload("fake.pdf", Buffer.from("just text")), 415, /not a valid PDF/));
    check("PDF renamed to .docx refused (signature)", rejects(() => validateUpload("fake.docx", pdf), 415, /not a valid Word/));
    check("empty file refused", rejects(() => validateUpload("empty.pdf", Buffer.alloc(0)), 400, /empty/));
    check("file over the size limit refused (413)", rejects(() => validateUpload("big.pdf", Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(MAX_DOCUMENT_BYTES)])), 413, /larger than/));
    check("folder parts of a file name are dropped", validateUpload("..\\..\\secret\\plan.pdf", pdf).filename === "plan.pdf");
    check("missing file name refused", rejects(() => validateUpload("", pdf), 400, /name is missing/));

    // ---- PDF: one section per page, with its page number ----
    const pdfExtract = await extractDocument(pdf, "pdf", "SOP Returns.pdf");
    const pdfChunks = documentChunks(pdfExtract);
    check("PDF: page count read", pdfExtract.pageCount === 2, pdfExtract.pageCount);
    check("PDF: text and page numbers kept per section", pdfChunks.length === 2 && pdfChunks[0].page === 1 && /Scan the parcel barcode/.test(pdfChunks[0].chunk) && pdfChunks[1].page === 2 && /within 48 hours/.test(pdfChunks[1].chunk), JSON.stringify(pdfChunks).slice(0, 110));
    check("PDF: a page title becomes the section heading", pdfChunks[0].heading === "Returns Procedure" && pdfChunks[1].heading === "Escalation");

    // ---- DOCX: headings and paragraphs ----
    const docxExtract = await extractDocument(docx, "docx", "manual.docx");
    const docxChunks = documentChunks(docxExtract);
    check("DOCX: headings found", docxExtract.sections.map(section => section.heading).join("|") === "Warranty Manual|Claims", docxExtract.sections.map(section => section.heading).join("|"));
    check("DOCX: paragraphs kept under their headings", docxChunks.some(chunk => chunk.heading === "Claims" && /serial number/.test(chunk.chunk)) && docxChunks.some(chunk => /5-year frame warranty/.test(chunk.chunk)), JSON.stringify(docxChunks).slice(0, 110));

    // ---- Image-only PDF: refused, never stored empty ----
    const scan = makeImageOnlyPdf();
    check("image-only PDF passes the format check", validateUpload("scan.pdf", scan).fileType === "pdf");
    const scanExtract = await extractDocument(scan, "pdf", "scan.pdf");
    check("image-only PDF: no text extracted", scanExtract.sections.length === 0);
    let scanError = null;
    try {
        await indexDocument({ chatbotId: "00000000-0000-4000-8000-000000000000", documentId: "00000000-0000-4000-8000-000000000001", filename: "scan.pdf", fileType: "pdf", buffer: scan });
    } catch (error) {
        scanError = error;
    }
    check("image-only PDF: indexing refused with a visible reason (422), before any storage", scanError?.status === 422 && /scanned images/.test(scanError.message), scanError?.message);

    // ---- Corrupt files fail with an error, not a crash ----
    let corrupt = null;
    try {
        await extractDocument(Buffer.from("%PDF-1.4\nthis is not really a pdf"), "pdf", "broken.pdf");
    } catch (error) {
        corrupt = error;
    }
    check("corrupt PDF: extraction throws (reported as failed)", Boolean(corrupt));

    // ---- Resource limits: .docx expansion, parse timeout, server stays responsive ----
    const { inspectDocxZip, DEFAULT_LIMITS } = require("../documentWorker.js");
    const { MAX_DOCX_UNCOMPRESSED_BYTES } = require("../documents.js");
    const settle = promise => promise.then(value => ({ value }), error => ({ error }));
    const blocks = [{ heading: "Manual", level: 1 }, { text: "The frame warranty is five years for every rowing machine we sell." }];

    const compressed = makeDocx(blocks, { deflate: true });
    check("compressed .docx (normal size) passes the expansion check", inspectDocxZip(compressed).uncompressedBytes < 10000);
    const compressedText = await settle(extractDocument(compressed, "docx", "compressed.docx"));
    check("compressed .docx still extracts its text", compressedText.value?.sections.some(s => /five years/.test(s.blocks.join(" "))), compressedText.error?.message);

    // Honest headers: 110 MB of zeros, about 110 KB compressed (within the 10 MB upload limit).
    const bomb = makeDocx(blocks, { deflate: true, extraParts: { "word/media/padding.bin": Buffer.alloc(MAX_DOCX_UNCOMPRESSED_BYTES + 10 * 1024 * 1024) } });
    check("zip bomb fixture fits the upload size limit", bomb.length < MAX_DOCUMENT_BYTES && validateUpload("bomb.docx", bomb).fileType === "docx", `${bomb.length} bytes`);
    const bombResult = await settle(extractDocument(bomb, "docx", "bomb.docx"));
    check("zip bomb: refused before mammoth (413, clear reason)", bombResult.error?.expose === true && bombResult.error.status === 413 && /expands to more than 100 MB/.test(bombResult.error.message), bombResult.error?.message);

    // Lying headers: the ZIP claims each part is 10 bytes; the real size is measured.
    const liar = makeDocx(blocks, { deflate: true, declaredSize: 10, extraParts: { "word/media/padding.bin": Buffer.alloc(3 * 1024 * 1024) } });
    let liarError = null;
    try { inspectDocxZip(liar, { ...DEFAULT_LIMITS, maxDocxUncompressedBytes: 1024 * 1024 }); } catch (error) { liarError = error; }
    check("zip with false (small) size headers: the real expanded size is measured and refused", liarError?.status === 413, liarError?.message);

    const manyParts = {};
    for (let i = 0; i < 30; i++) manyParts[`word/part${i}.xml`] = "<x/>";
    let partsError = null;
    try { inspectDocxZip(makeDocx(blocks, { extraParts: manyParts }), { ...DEFAULT_LIMITS, maxDocxEntries: 20 }); } catch (error) { partsError = error; }
    check("zip with too many internal parts refused (413)", partsError?.status === 413 && /internal parts/.test(partsError.message), partsError?.message);

    let truncatedError = null;
    try { inspectDocxZip(compressed.subarray(0, compressed.length - 30)); } catch (error) { truncatedError = error; }
    check("truncated .docx refused as invalid (415)", truncatedError?.status === 415, truncatedError?.message);

    const timedOut = await settle(extractDocument(pdf, "pdf", "slow.pdf", { timeoutMs: 1 }));
    check("parse timeout: the reader is stopped and a clear reason given (422)", timedOut.error?.expose === true && timedOut.error.status === 422 && /took longer than/.test(timedOut.error.message), timedOut.error?.message);
    // Stopping the reader at many different moments (while it starts, loads pdf.js, parses) must never
    // crash this process. With a worker thread this crashed the whole process (segfault) 2 runs out of 3.
    let stoppedSafely = 0;
    for (const ms of [1, 3, 8, 15, 30, 60, 120, 250, 400, 600, 900, 1200]) {
        for (const [buffer, type] of [[pdf, "pdf"], [compressed, "docx"]]) {
            const stopped = await settle(extractDocument(buffer, type, `stop.${type}`, { timeoutMs: ms }));
            if (stopped.value || /took longer than/.test(stopped.error?.message || "")) stoppedSafely++;
        }
    }
    check("reader stopped 24 times at different moments: this process keeps running, every result is clean", stoppedSafely === 24, `${stoppedSafely}/24`);

    const tinyMemory = await settle(extractDocument(longPdfForMemory(), "pdf", "big.pdf", { memoryMb: 8, timeoutMs: 60000 }));
    check("reader out of memory: stopped with a clear reason (422), this process unaffected", tinyMemory.error?.expose === true && tinyMemory.error.status === 422 && /too much memory/.test(tinyMemory.error.message), tinyMemory.error?.message);

    const afterTimeout = await settle(extractDocument(pdf, "pdf", "again.pdf"));
    check("after a timeout, the next document is read normally", afterTimeout.value?.sections.length === 2, afterTimeout.error?.message);

    // Parsing runs in a reader process started by a supervisor thread: timers on the main thread
    // keep running meanwhile, including while the reader process is being started.
    const longPdf = makePdf(Array.from({ length: 300 }, (_, i) => [`Section ${i + 1}`, ...Array.from({ length: 30 }, (_, k) => `Line ${k + 1} of page ${i + 1}: the warranty and returns rules apply as written.`)]));
    // (Parsed on the main thread, this PDF blocks it for the whole parse: no timer tick at all.
    // A reader process started from the main thread blocks it ~0.6 s on the development laptop.)
    let maxGap = 0;
    let ticks = 0;
    let last = Date.now();
    const ticker = setInterval(() => { const now = Date.now(); maxGap = Math.max(maxGap, now - last); last = now; ticks++; }, 10);
    const started = Date.now();
    const longResult = await settle(extractDocument(longPdf, "pdf", "long.pdf"));
    const parseMs = Date.now() - started;
    clearInterval(ticker);
    maxGap = Math.max(maxGap, Date.now() - last);
    check("300-page PDF parsed while the main thread stays responsive (timer keeps ticking, max gap < 250 ms)", longResult.value?.pageCount === 300 && ticks >= 10 && maxGap < 250, `parse ${parseMs} ms, ${ticks} ticks, max gap ${maxGap} ms`);

    // Cleanup: a reader stopped for time or memory no longer exists afterwards.
    const isRunning = pid => {
        try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
    };
    const waitGone = async pid => {
        for (let i = 0; i < 50 && isRunning(pid); i++) await new Promise(resolve => setTimeout(resolve, 100));
        return !isRunning(pid);
    };
    const stoppedForTime = await settle(extractDocument(longPdf, "pdf", "slow.pdf", { timeoutMs: 300 }));
    check("cleanup: the reader stopped for time is gone (process no longer exists)",
        /took longer than/.test(stoppedForTime.error?.message || "") && Number.isInteger(stoppedForTime.error?.readerPid) && await waitGone(stoppedForTime.error.readerPid), `pid ${stoppedForTime.error?.readerPid}`);
    const stoppedForMemory = await settle(extractDocument(longPdfForMemory(), "pdf", "big.pdf", { memoryMb: 8, timeoutMs: 60000 }));
    check("cleanup: the reader stopped for memory is gone (process no longer exists)",
        /too much memory/.test(stoppedForMemory.error?.message || "") && Number.isInteger(stoppedForMemory.error?.readerPid) && await waitGone(stoppedForMemory.error.readerPid), `pid ${stoppedForMemory.error?.readerPid}`);

    // ---- Reader failures other than time and memory; supervisor failures; server stop ----
    const documents = require("../documents.js");
    const { spawn, execFileSync } = require("child_process");
    const busyPdf = () => makePdf(Array.from({ length: 500 }, (_, i) => [`S${i}`, ...Array.from({ length: 220 }, (_, k) => `Line ${k} of page ${i}: the warranty and returns rules apply as written in this manual.`)]));
    const startLong = (extra = {}) => {
        let pid = null;
        const job = settle(documents.extractDocument(busyPdf(), "pdf", "busy.pdf", { timeoutMs: 120000, ...extra, onReaderStart: started => { pid = started; } }));
        return { job, pid: () => pid };
    };
    const waitFor = async (condition, ms = 10000) => {
        for (let waited = 0; waited < ms && !condition(); waited += 20) await new Promise(resolve => setTimeout(resolve, 20));
        return condition();
    };
    const readerProcesses = () => execFileSync("powershell", ["-NoProfile", "-Command",
        "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*documentWorker.js*--document-job*' } | ForEach-Object { $_.ProcessId }"], { encoding: "utf8" })
        .split(/\s+/).filter(Boolean).map(Number);
    const readersBefore = new Set(readerProcesses());
    const nextWorks = async () => (await settle(extractDocument(pdf, "pdf", "next.pdf"))).value?.sections.length === 2;

    // A reader killed by something else is an unexpected stop, not "too much memory".
    const killed = startLong();
    await waitFor(() => killed.pid());
    process.kill(killed.pid());
    const killedResult = await killed.job;
    check("reader killed from outside: reported as an unexpected stop, not as a memory problem",
        /stopped unexpectedly/.test(killedResult.error?.message || "") && !/memory/.test(killedResult.error?.message || "") && killedResult.error?.expose !== true, killedResult.error?.message);
    check("after a killed reader, the next document is read normally", await nextWorks());

    // The supervisor thread is lost while a reader works: the job fails clearly, the reader is
    // stopped at once (it would otherwise run on untimed), and a new supervisor takes over.
    const orphaned = startLong();
    await waitFor(() => orphaned.pid());
    await new Promise(resolve => setTimeout(resolve, 300));
    const lostPid = orphaned.pid();
    await documents._readerSupervisorForTests().terminate();
    const lostResult = await orphaned.job;
    const lostStart = Date.now();
    const lostGone = await waitFor(() => !isRunning(lostPid), 3000);
    check("supervisor lost mid-job: job rejected with a clear reason", /reader supervisor stopped/.test(lostResult.error?.message || ""), lostResult.error?.message);
    check("supervisor lost mid-job: its reader process is stopped within 1 s (not left running)", lostGone && Date.now() - lostStart < 1000, `pid ${lostPid}, gone after ${Date.now() - lostStart} ms`);
    check("after losing the supervisor, a new one reads the next document", await nextWorks());

    // The supervisor stops answering (backstop): it is replaced and the reader is stopped.
    const hung = startLong({ backstopMs: 2500 });
    const hungResult = await hung.job;
    check("supervisor not answering: job rejected after the backstop, reader stopped",
        /did not answer/.test(hungResult.error?.message || "") && Number.isInteger(hungResult.error?.readerPid) && await waitFor(() => !isRunning(hungResult.error.readerPid), 3000), hungResult.error?.message);
    check("after a backstop, the next document is read normally", await nextWorks());

    // The server process stops abruptly while a reader works: the reader does not outlive it.
    const parent = spawn(process.execPath, [path.join(__dirname, "fixtures", "reader-parent.js")], { stdio: ["ignore", "pipe", "ignore"] });
    let parentOut = "";
    parent.stdout.on("data", chunk => { parentOut += chunk; });
    await new Promise(resolve => parent.on("exit", resolve));
    const parentReader = Number((parentOut.match(/reader (\d+)/) || [])[1]);
    check("server process stops mid-parse: its reader process does not outlive it",
        Number.isInteger(parentReader) && await waitFor(() => !isRunning(parentReader), 3000), `reader ${parentReader}`);

    await new Promise(resolve => setTimeout(resolve, 500));
    const leftover = readerProcesses().filter(pid => !readersBefore.has(pid));
    check("no reader processes left behind by any of these tests", leftover.length === 0, JSON.stringify(leftover));

    console.table(results);
    const failed = results.filter(r => r.result !== "PASS").length;
    console.log(failed ? `${failed} FAILED of ${results.length}` : `ALL ${results.length} PASSED`);
    process.exit(failed ? 1 : 0);
})();
