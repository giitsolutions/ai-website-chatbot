// Builds small, valid synthetic documents for tests (no real customer files, no dependencies).
//   makePdf([["line", "line"], ["page 2 line"]])          -> PDF Buffer, one array per page
//   makeImageOnlyPdf()                                    -> PDF with a drawing and no text
//   makeDocx([{ heading: "Title", level: 1 }, { text: "Paragraph" }]) -> DOCX Buffer

// PDF string with WinAnsi encoding: "€" is byte 128 (octal \200), "₹" is not in WinAnsi.
function pdfEscape(text) {
    return String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)").replace(/€/g, "\\200");
}

function buildPdf(pageStreams) {
    const objects = [];
    const pageCount = pageStreams.length;
    // 1 catalog, 2 pages, 3 font, then (page, content) pairs.
    objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    const kids = pageStreams.map((_, index) => `${4 + index * 2} 0 R`).join(" ");
    objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;
    objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    pageStreams.forEach((stream, index) => {
        const pageId = 4 + index * 2;
        objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
        objects[pageId + 1] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
    });
    let out = "%PDF-1.4\n";
    const offsets = [];
    for (let id = 1; id < objects.length; id++) {
        offsets[id] = Buffer.byteLength(out, "latin1");
        out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(out, "latin1");
    out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, "latin1");
}

function makePdf(pages) {
    return buildPdf(pages.map(lines => {
        const body = lines.map((line, index) => `${index === 0 ? "" : "0 -18 TD "}(${pdfEscape(line)}) Tj`).join("\n");
        return `BT\n/F1 12 Tf\n72 740 TD\n${body}\nET`;
    }));
}

function makeImageOnlyPdf() {
    // A filled rectangle: something is drawn, but there is no text to extract.
    return buildPdf(["0.5 g\n72 400 300 200 re f"]);
}

// ---- DOCX (a ZIP archive, stored without compression) ----

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();
function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
}

// options.deflate: compress entries (method 8). options.declaredSize: the uncompressed size
// written in the headers instead of the real one (to imitate a "zip bomb" that lies).
function zip(files, options = {}) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const [name, content] of Object.entries(files)) {
        const raw = Buffer.isBuffer(content) ? content : Buffer.from(content, "utf8");
        const data = options.deflate ? require("zlib").deflateRawSync(raw) : raw;
        const method = options.deflate ? 8 : 0;
        const declared = options.declaredSize === undefined ? raw.length : options.declaredSize;
        const nameBuffer = Buffer.from(name, "utf8");
        const crc = crc32(raw);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0, 6); local.writeUInt16LE(method, 8);
        local.writeUInt16LE(0, 10); local.writeUInt16LE(0, 12); local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18); local.writeUInt32LE(declared, 22); local.writeUInt16LE(nameBuffer.length, 26); local.writeUInt16LE(0, 28);
        locals.push(local, nameBuffer, data);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0, 8);
        central.writeUInt16LE(method, 10); central.writeUInt16LE(0, 12); central.writeUInt16LE(0, 14); central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20); central.writeUInt32LE(declared, 24); central.writeUInt16LE(nameBuffer.length, 28);
        central.writeUInt16LE(0, 30); central.writeUInt16LE(0, 32); central.writeUInt16LE(0, 34); central.writeUInt16LE(0, 36);
        central.writeUInt32LE(0, 38); central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBuffer);
        offset += 30 + nameBuffer.length + data.length;
    }
    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(0, 4); end.writeUInt16LE(0, 6);
    end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16); end.writeUInt16LE(0, 20);
    return Buffer.concat([...locals, ...centrals, end]);
}

function xmlEscape(text) {
    return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// A .docx whose parts are given as { name: content }, written with zip(files, options).
function makeDocxParts(parts, options = {}) {
    return zip(parts, options);
}

function makeDocx(blocks, options = {}) {
    const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
    const paragraphs = blocks.map(block => {
        const style = block.heading ? `<w:pPr><w:pStyle w:val="Heading${block.level || 1}"/></w:pPr>` : "";
        return `<w:p>${style}<w:r><w:t xml:space="preserve">${xmlEscape(block.heading || block.text)}</w:t></w:r></w:p>`;
    }).join("");
    const styles = [1, 2, 3].map(level =>
        `<w:style w:type="paragraph" w:styleId="Heading${level}"><w:name w:val="heading ${level}"/></w:style>`).join("");
    return zip({
        "[Content_Types].xml": '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>',
        "_rels/.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        "word/_rels/document.xml.rels": '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
        "word/styles.xml": `<?xml version="1.0" encoding="UTF-8"?><w:styles ${W}>${styles}</w:styles>`,
        "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${paragraphs}</w:body></w:document>`,
        ...(options.extraParts || {})
    }, options);
}

module.exports = { makePdf, makeImageOnlyPdf, makeDocx, makeDocxParts };
