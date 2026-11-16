"use strict";

/*
    Document parsing in a separate child process, so a large or complex upload cannot block the
    server (chat answers keep working while it runs) and can be stopped (timeout, memory limit).
    A child process, not a worker thread: terminating a worker thread while it was still loading
    pdf.js crashed the whole server process (segmentation fault, reproduced); killing a child
    process cannot affect the server.

    - inspectDocxZip(): before mammoth reads a .docx (a ZIP file), every entry is really
      decompressed with a hard output limit. The sizes written in the ZIP headers are not
      trusted (a "zip bomb" can claim small sizes), so a 10 MB upload cannot expand to
      gigabytes in memory.
    - convertDocx(): mammoth with images skipped (only the text is used; no base64 copies).
    - extractPdfPages(): pdf.js, page by page, raw text lines.

    Used by documents.js (runDocumentWorker: one child process per job); the pure functions are
    exported for tests.
*/

const zlib = require("zlib");

const DEFAULT_LIMITS = {
    maxDocxUncompressedBytes: 100 * 1024 * 1024,
    maxDocxEntries: 5000,
    maxPdfPages: 500
};

function limitError(message, status = 422) {
    const error = new Error(message);
    error.expose = true;
    error.status = status;
    return error;
}

// Checks a .docx ZIP without trusting its size fields: every entry listed in the central
// directory (the list the ZIP reader uses) is decompressed with a hard limit on the total.
function inspectDocxZip(buffer, limits = DEFAULT_LIMITS) {
    const notValid = () => limitError("The file is not a valid Word (.docx) file.", 415);
    const tooLarge = () => limitError(
        `The Word document expands to more than ${Math.round(limits.maxDocxUncompressedBytes / 1024 / 1024)} MB of content when opened and was not processed.`, 413);

    // End of central directory: the last 22 bytes, or up to 64 KB earlier (comment).
    let end = -1;
    for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 0xffff); at--) {
        if (buffer.readUInt32LE(at) === 0x06054b50) { end = at; break; }
    }
    if (end < 0) throw notValid();
    const entryCount = buffer.readUInt16LE(end + 10);
    const centralSize = buffer.readUInt32LE(end + 12);
    const centralOffset = buffer.readUInt32LE(end + 16);
    // ZIP64 (sizes or counts that do not fit 32/16 bits) is never needed for a 10 MB .docx.
    if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw notValid();
    if (entryCount > limits.maxDocxEntries) {
        throw limitError(`The Word document contains more than ${limits.maxDocxEntries} internal parts and was not processed.`, 413);
    }
    if (centralOffset + centralSize > end) throw notValid();

    let total = 0;
    let at = centralOffset;
    for (let index = 0; index < entryCount; index++) {
        if (at + 46 > end || buffer.readUInt32LE(at) !== 0x02014b50) throw notValid();
        const flags = buffer.readUInt16LE(at + 8);
        const method = buffer.readUInt16LE(at + 10);
        const compressedSize = buffer.readUInt32LE(at + 20);
        const nameLength = buffer.readUInt16LE(at + 28);
        const extraLength = buffer.readUInt16LE(at + 30);
        const commentLength = buffer.readUInt16LE(at + 32);
        const localOffset = buffer.readUInt32LE(at + 42);
        if (flags & 0x1) throw limitError("Password-protected Word documents are not supported.", 415);
        if (compressedSize === 0xffffffff || localOffset === 0xffffffff) throw notValid();

        if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw notValid();
        const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
        if (dataStart + compressedSize > buffer.length) throw notValid();
        const data = buffer.subarray(dataStart, dataStart + compressedSize);

        const remaining = limits.maxDocxUncompressedBytes - total;
        let size;
        if (method === 0) {
            size = data.length;
        } else if (method === 8) {
            try {
                // One byte more than allowed: reaching it means "too large", whatever the header says.
                size = zlib.inflateRawSync(data, { maxOutputLength: Math.max(1, remaining + 1) }).length;
            } catch (error) {
                if (error.code === "ERR_BUFFER_TOO_LARGE" || error instanceof RangeError) throw tooLarge();
                throw notValid();
            }
        } else {
            throw notValid();
        }
        total += size;
        if (total > limits.maxDocxUncompressedBytes) throw tooLarge();
        at += 46 + nameLength + extraLength + commentLength;
    }
    return { entries: entryCount, uncompressedBytes: total };
}

async function convertDocx(buffer, limits = DEFAULT_LIMITS) {
    inspectDocxZip(buffer, limits);
    const mammoth = require("mammoth");
    const { value: html } = await mammoth.convertToHtml(
        { buffer },
        // Images are not read or base64-encoded: only the alt text is kept.
        { convertImage: mammoth.images.imgElement(image => ({ src: "", alt: image.altText || "" })) }
    );
    return { html };
}

let pdfjsPromise = null;
function loadPdfjs() {
    // pdf.js is an ES module; the legacy build runs in Node without a browser.
    if (!pdfjsPromise) pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.mjs");
    return pdfjsPromise;
}

// PDF text, page by page: { pageCount, pages: [{ page, lines: [...] }] } (lines not cleaned).
async function extractPdfPages(buffer, limits = DEFAULT_LIMITS) {
    const pdfjs = await loadPdfjs();
    const task = pdfjs.getDocument({
        data: new Uint8Array(buffer),
        isEvalSupported: false,
        disableFontFace: true,
        useSystemFonts: false,
        verbosity: 0
    });
    const pdf = await task.promise;
    try {
        if (pdf.numPages > limits.maxPdfPages) throw limitError(`The PDF has ${pdf.numPages} pages; at most ${limits.maxPdfPages} are supported.`, 400);
        const pages = [];
        for (let number = 1; number <= pdf.numPages; number++) {
            const page = await pdf.getPage(number);
            const content = await page.getTextContent();
            const lines = [];
            let current = "";
            for (const item of content.items) {
                if (typeof item.str !== "string") continue;
                current += item.str;
                if (item.hasEOL) {
                    lines.push(current);
                    current = "";
                }
            }
            if (current) lines.push(current);
            pages.push({ page: number, lines });
            page.cleanup();
        }
        return { pageCount: pdf.numPages, pages };
    } finally {
        await pdf.destroy();
    }
}

// Child-process mode (started by documents.js with --document-job): one job, then exit.
if (require.main === module && process.argv.includes("--document-job") && typeof process.send === "function") {
    // Stopping this process is the server's job (supervisor timeout, or documents.js by process ID
    // if the supervisor fails): a busy reader does not reliably notice a lost connection.
    process.once("message", ({ fileType, data, limits }) => {
        const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
        const job = fileType === "pdf" ? extractPdfPages(buffer, limits)
            : fileType === "docx" ? convertDocx(buffer, limits)
                : Promise.reject(limitError("Unsupported document type.", 415));
        job.then(
            result => ({ ok: true, result }),
            error => ({ ok: false, error: { message: error.message, expose: Boolean(error.expose), status: error.status } })
        ).then(reply => process.send(reply, () => process.exit(0)));
    });
}

module.exports = { DEFAULT_LIMITS, inspectDocxZip, convertDocx, extractPdfPages };
