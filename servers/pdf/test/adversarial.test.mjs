// Adversarial regressions for mcp-pdf, from docs/PDF_AUDIT.md.
// Every test here pins a defect that was found by probing the built server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PDFDocument, StandardFonts, PDFName, rgb } from "pdf-lib";
import { client, proKey, sandbox, makePdf } from "./_client.mjs";

const sha = (f) => createHash("sha256").update(readFileSync(f)).digest("hex");

/** A PDF that claims PDF/A-1b for itself with an XMP pdfaid packet and an output intent. */
async function makePdfaPdf(path) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([595.28, 841.89]).drawText("ARCHIVE COPY", { x: 60, y: 760, size: 14, font });
  const xmp = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/">` +
    `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about=""` +
    ` xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>1</pdfaid:part>` +
    `<pdfaid:conformance>B</pdfaid:conformance></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const ref = doc.context.register(doc.context.stream(xmp, { Type: "Metadata", Subtype: "XML" }));
  doc.catalog.set(PDFName.of("Metadata"), ref);
  doc.catalog.set(PDFName.of("OutputIntents"), doc.context.obj([
    doc.context.obj({ Type: "OutputIntent", S: "GTS_PDFA1", OutputConditionIdentifier: doc.context.obj("sRGB") }),
  ]));
  writeFileSync(path, await doc.save({ useObjectStreams: false }));
  return path;
}

/** A filled AcroForm: the values live in the fields, not in the page content stream. */
async function makeFormPdf(path) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText("Application form", { x: 60, y: 760, size: 16, font });
  const form = doc.getForm();
  const a = form.createTextField("applicant.name");
  a.setText("Lucky Strike Software");
  a.addToPage(page, { x: 60, y: 700, width: 300, height: 24, font });
  const b = form.createTextField("total.due");
  b.setText("3075.00");
  b.addToPage(page, { x: 60, y: 660, width: 300, height: 24, font });
  writeFileSync(path, await doc.save({ useObjectStreams: false }));
  return path;
}

test("an out_path that is also an input is refused, with and without overwrite", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-selfout-");
  const src = await makePdf(join(dir, "a.pdf"), 3, "A");
  const before = sha(src);
  const c = client({ dataHome, key: proKey(), cwd: dir });
  await c.init();
  // pdf_pages onto its own input took a 3-page file to 1 page and every later read was wrong.
  for (const args of [
    { path: src, pages: "1", out_path: src, overwrite: true },
    { path: src, pages: "1", out_path: "a.pdf", overwrite: true },
  ]) {
    const t = await c.text("pdf_pages", args);
    assert.match(t, /is also an input of this operation/);
    assert.match(t, /Nothing was written/);
  }
  const m = await c.text("pdf_merge", { paths: [src, src], out_path: src, overwrite: true });
  assert.match(m, /is also an input of this operation/);
  const r = await c.text("pdf_rotate", { path: src, degrees: 90, out_path: src, overwrite: true });
  assert.match(r, /is also an input of this operation/);
  const s = await c.text("pdf_split", { path: src, ranges: "1,2", out_path_pattern: join(dir, "a.pdf"), overwrite: true });
  assert.match(s, /is also an input|no \{n\} or \{range\}/);
  // A different path is still fine.
  const good = await c.text("pdf_pages", { path: src, pages: "1", out_path: join(dir, "a-out.pdf") });
  assert.match(good, /Extracted 1 page/);
  c.close();
  assert.equal(sha(src), before, "the input must be byte-identical after every refusal");
});

test("stamp text: a newline separates words, a Polish stroke is transliterated, CJK is removed", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-stamptext-");
  const src = await makePdf(join(dir, "s.pdf"), 1, "S");
  const c = client({ dataHome, key: proKey(), cwd: dir });
  await c.init();
  const nl = await c.text("pdf_stamp", { path: src, text: "PAID\nIN FULL", out_path: join(dir, "nl.pdf") });
  assert.match(nl, /Stamped "PAID IN FULL"/, "a dropped newline ran the words together as PAIDIN FULL");
  const pl = await c.text("pdf_stamp", { path: src, text: "OPŁACONE 已付款", out_path: join(dir, "pl.pdf") });
  assert.match(pl, /Stamped "OPLACONE"/, "dropping the stroke silently spelled OPACONE");
  assert.match(pl, /replaced with the nearest Latin form/);
  assert.match(pl, /3 characters were removed/);
  const cjk = await c.text("pdf_stamp", { path: src, text: "已付款", out_path: join(dir, "cjk.pdf") });
  assert.match(cjk, /empty after removing characters/);
  assert.ok(!existsSync(join(dir, "cjk.pdf")));
  c.close();
});

test("font_size is bounded and an overlong stamp says it runs off the page", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-fit-");
  const src = await makePdf(join(dir, "s.pdf"), 1, "S");
  const c = client({ dataHome, key: proKey(), cwd: dir });
  await c.init();
  for (const size of [-20, 0, 1e6]) {
    const t = await c.text("pdf_stamp", { path: src, text: "PAID", font_size: size, out_path: join(dir, `f${size}.pdf`) });
    assert.match(t, /font_size must be greater than 0 and at most 1600/);
  }
  const long = await c.text("pdf_stamp", { path: src, text: "X".repeat(500), out_path: join(dir, "long.pdf"), position: "bottom-left" });
  assert.match(long, /wider than the page and part of it is drawn off the edge/);
  assert.match(long, /the smallest size this server will use/);
  c.close();
});

test("a PDF/A claim is reported, and every write path says the claim no longer holds", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-pdfa-");
  const src = await makePdfaPdf(join(dir, "archive.pdf"));
  const other = await makePdf(join(dir, "o.pdf"), 2, "O");
  const before = sha(src);
  const c = client({ dataHome, key: proKey(), cwd: dir });
  await c.init();
  const info = JSON.parse(await c.text("pdf_info", { path: src }));
  assert.equal(info.pdfa_claim, "PDF/A-1b");
  const st = await c.text("pdf_stamp", { path: src, text: "PAID", out_path: join(dir, "p.pdf") });
  assert.match(st, /claims PDF\/A-1b conformance.*no longer guaranteed/s);
  const mg = await c.text("pdf_merge", { paths: [src, other], out_path: join(dir, "m.pdf") });
  assert.match(mg, /it is not PDF\/A-1b/);
  const pg = await c.text("pdf_pages", { path: src, pages: "1", out_path: join(dir, "x.pdf") });
  assert.match(pg, /it is not PDF\/A-1b/);
  c.close();
  assert.equal(sha(src), before);
});

test("pdf_text reads the values of a filled form, which are not in the page content", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-form-");
  const src = await makeFormPdf(join(dir, "form.pdf"));
  const c = client({ dataHome, cwd: dir });
  await c.init();
  const t = await c.text("pdf_text", { path: src });
  assert.match(t, /Application form/);
  assert.match(t, /This PDF is a form with 2 fields/);
  assert.match(t, /applicant\.name: Lucky Strike Software/);
  assert.match(t, /total\.due: 3075\.00/);
  c.close();
});

test("pdf_text caps one answer and names the pages argument that continues it", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-textcap-");
  // 400 pages of dense text: past the 200,000-character limit for one answer.
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 400; n++) {
    const page = doc.addPage([595.28, 841.89]);
    for (let l = 0; l < 12; l++) {
      page.drawText(`page ${n} line ${l} ` + "lorem ipsum dolor sit amet consectetur ".repeat(2), { x: 40, y: 780 - l * 20, size: 9, font });
    }
  }
  const src = join(dir, "long.pdf");
  writeFileSync(src, await doc.save({ useObjectStreams: false }));
  const c = client({ dataHome, cwd: dir });
  await c.init();
  const t = await c.text("pdf_text", { path: src });
  assert.ok(t.length < 260_000, `answer was ${t.length} characters`);
  assert.match(t, /Stopped after page \d+ of 400 requested pages/);
  assert.match(t, /call pdf_text again with pages: "\d+-"/);
  const cont = /pages: "(\d+)-"/.exec(t)[1];
  const rest = await c.text("pdf_text", { path: src, pages: `${cont}-` });
  assert.match(rest, new RegExp(`--- page ${cont} ---`));
  c.close();
});

test("rotate says when nothing turned, and that 450 is 90", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-rot-");
  const src = await makePdf(join(dir, "r.pdf"), 2, "R");
  const c = client({ dataHome, cwd: dir });
  await c.init();
  const zero = await c.text("pdf_rotate", { path: src, degrees: 0, out_path: join(dir, "z.pdf") });
  assert.match(zero, /every page came out at the rotation it already had/);
  const over = await c.text("pdf_rotate", { path: src, degrees: 450, out_path: join(dir, "o.pdf") });
  assert.match(over, /450 degrees is the same as 90 degrees/);
  assert.match(over, /"to": 90/);
  c.close();
});

test("a 200 MB input is refused before it is read, and a 2000-page file is handled", async (ctx) => {
  const { dir, dataHome } = sandbox("mcp-pdf-scale-");
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  const small = await makePdf(join(dir, "s.pdf"), 1, "S");
  const huge = join(dir, "huge.pdf");
  const fh = await import("node:fs");
  const fd = fh.openSync(huge, "w");
  fh.writeSync(fd, readFileSync(small));
  const chunk = Buffer.alloc(1024 * 1024, 0x20);
  for (let i = 0; i < 200; i++) fh.writeSync(fd, chunk);
  fh.closeSync(fd);
  assert.ok(statSync(huge).size > 200 * 1024 * 1024);
  const c = client({ dataHome, key: proKey(), cwd: dir });
  await c.init();
  const t = await c.text("pdf_info", { path: huge });
  assert.match(t, /refuses inputs over 100.0 MB/);
  const big = await makePdf(join(dir, "big.pdf"), 2000, "BIG");
  const info = JSON.parse(await c.text("pdf_info", { path: big }));
  assert.equal(info.pages, 2000);
  assert.match(info.page_sizes_truncated, /showing 20 of 2000/);
  const sp = await c.text("pdf_split", { path: big, ranges: "1-1000,1001-", out_path_pattern: join(dir, "part-{n}.pdf") });
  assert.match(sp, /"pages": 1000/);
  const rot = await c.text("pdf_rotate", { path: big, degrees: 90, out_path: join(dir, "bigrot.pdf") });
  assert.match(rot, /Rotated 2000 pages/);
  c.close();
});

test("a truncated PDF and a wrong header are both refused with nothing written", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-malformed-");
  const good = await makePdf(join(dir, "g.pdf"), 3, "G");
  const bytes = readFileSync(good);
  const trunc = join(dir, "trunc.pdf");
  writeFileSync(trunc, bytes.subarray(0, Math.floor(bytes.length * 0.6)));
  const badhead = join(dir, "badhead.pdf");
  writeFileSync(badhead, Buffer.concat([Buffer.from("NOT A PDF\n".repeat(120)), bytes]));
  const c = client({ dataHome, key: proKey(), cwd: dir });
  await c.init();
  assert.match(await c.text("pdf_info", { path: trunc }), /could not be parsed as a PDF/);
  assert.match(await c.text("pdf_text", { path: trunc }), /could not be parsed as a PDF/);
  assert.match(await c.text("pdf_info", { path: badhead }), /does not start with %PDF-/);
  const m = await c.text("pdf_merge", { paths: [good, trunc], out_path: join(dir, "m.pdf") });
  assert.match(m, /could not be parsed as a PDF/);
  assert.ok(!existsSync(join(dir, "m.pdf")), "a refused merge must leave no output behind");
  c.close();
});

test("object streams and a cross-reference stream are read, written and re-read", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-objstm-");
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= 4; n++) doc.addPage([595.28, 841.89]).drawText(`PAGE ${n} OBJSTM`, { x: 60, y: 760, size: 18, font });
  const src = join(dir, "objstm.pdf");
  writeFileSync(src, await doc.save({ useObjectStreams: true }));
  const raw = readFileSync(src).toString("latin1");
  assert.match(raw, /\/ObjStm/, "the fixture must actually use object streams");
  assert.match(raw, /\/Type\s*\/XRef/, "the fixture must actually use a cross-reference stream");
  const c = client({ dataHome, key: proKey(), cwd: dir });
  await c.init();
  assert.equal(JSON.parse(await c.text("pdf_info", { path: src })).pages, 4);
  assert.match(await c.text("pdf_text", { path: src }), /PAGE 3 OBJSTM/);
  const out = join(dir, "x.pdf");
  assert.match(await c.text("pdf_pages", { path: src, pages: "2,4", out_path: out }), /Extracted 2 pages/);
  assert.match(await c.text("pdf_text", { path: out }), /PAGE 2 OBJSTM[\s\S]*PAGE 4 OBJSTM/);
  c.close();
});

test("ranges: 0, 3-1, a-b and a page past the end are refused; 1- and duplicates are honoured", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-ranges-");
  const src = await makePdf(join(dir, "a.pdf"), 3, "A");
  const c = client({ dataHome, key: proKey(), cwd: dir });
  await c.init();
  const bad = { "0": /page numbers start at 1/, "3-1": /runs backwards; write it as 1-3/, "a-b": /cannot read "a-b"/, "1--3": /cannot read "1--3"/, "": /empty page range/, "1-9999": /past the end: the file has 3 pages/ };
  for (const [spec, re] of Object.entries(bad)) {
    const t = await c.text("pdf_pages", { path: src, pages: spec, out_path: join(dir, "bad.pdf") });
    assert.match(t, re, `range ${JSON.stringify(spec)}`);
    assert.ok(!existsSync(join(dir, "bad.pdf")), `range ${JSON.stringify(spec)} wrote a file`);
  }
  const open = JSON.parse((await c.text("pdf_pages", { path: src, pages: "1-", out_path: join(dir, "open.pdf") })).split("\n\n")[1]);
  assert.deepEqual(open.kept, [1, 2, 3]);
  const dup = await c.text("pdf_pages", { path: src, pages: "1,1,1", out_path: join(dir, "dup.pdf") });
  assert.match(dup, /"kept": \[\s*1,\s*1,\s*1/);
  assert.match(dup, /2 pages were asked for more than once/);
  assert.match(await c.text("pdf_split", { path: src, ranges: "1-2,1-2", out_path_pattern: join(dir, "{range}.pdf") }), /produces the path .* twice/);
  c.close();
});

test("merging the same file three times gives three copies of it and leaves it untouched", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-thrice-");
  const src = await makePdf(join(dir, "a.pdf"), 3, "A");
  const before = sha(src);
  const c = client({ dataHome, cwd: dir });
  await c.init();
  const out = join(dir, "thrice.pdf");
  const t = await c.text("pdf_merge", { paths: [src, src, src], out_path: out });
  assert.match(t, /Merged 3 files into 9 pages/);
  assert.equal(JSON.parse(await c.text("pdf_info", { path: out })).pages, 9);
  const text = await c.text("pdf_text", { path: out });
  assert.equal(text.match(/PAGE 1 A/g).length, 3);
  c.close();
  assert.equal(sha(src), before);
});

test("an image-only page reports that it has no text and no OCR happened", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-imageonly-");
  const doc = await PDFDocument.create();
  doc.addPage([300, 300]).drawRectangle({ x: 10, y: 10, width: 280, height: 280, color: rgb(0.2, 0.4, 0.6) });
  const src = join(dir, "img.pdf");
  writeFileSync(src, await doc.save({ useObjectStreams: false }));
  const c = client({ dataHome, cwd: dir });
  await c.init();
  const t = await c.text("pdf_text", { path: src });
  assert.match(t, /no text operators on the page/);
  assert.match(t, /there is no OCR here/);
  c.close();
});

test("opacity outside 0..1 and an unreadable colour are refused with nothing written", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-opacity-");
  const src = await makePdf(join(dir, "a.pdf"), 1, "A");
  const c = client({ dataHome, key: proKey(), cwd: dir });
  await c.init();
  for (const opacity of [5, 0, -1]) {
    const t = await c.text("pdf_stamp", { path: src, text: "PAID", opacity, out_path: join(dir, "o.pdf") });
    assert.match(t, /opacity must be greater than 0 and at most 1/);
    assert.ok(!existsSync(join(dir, "o.pdf")));
  }
  const bad = await c.text("pdf_stamp", { path: src, text: "PAID", color: "#zz", out_path: join(dir, "c.pdf") });
  assert.match(bad, /cannot read "#zz" as a colour/);
  assert.ok(!existsSync(join(dir, "c.pdf")));
  const good = await c.text("pdf_stamp", { path: src, text: "PAID", color: "red", out_path: join(dir, "red.pdf") });
  assert.match(good, /"color": "red"/);
  c.close();
});

test("stdout carries JSON-RPC only, and the source makes no network call", async () => {
  const { dir, dataHome } = sandbox("mcp-pdf-transport-");
  const src = await makePdf(join(dir, "a.pdf"), 2, "A");
  // The shared client throws on any stdout line that is not JSON, so a clean run of
  // several calls plus the stderr banner is the assertion.
  const c = client({ dataHome, key: proKey(), cwd: dir });
  await c.init();
  await c.text("pdf_info", { path: src });
  await c.text("pdf_text", { path: src });
  await c.text("pdf_stamp", { path: src, text: "PAID", out_path: join(dir, "p.pdf") });
  await c.send("resources/list", {});
  await c.send("prompts/list", {});
  c.close();
  const srcDir = join(import.meta.dirname, "..", "src");
  const { readdirSync } = await import("node:fs");
  let hits = [];
  for (const f of readdirSync(srcDir)) {
    const body = readFileSync(join(srcDir, f), "utf8");
    for (const line of body.split("\n")) {
      if (/\bfetch\s*\(|node:https?|node:net|node:dns|XMLHttpRequest|https?:\/\//.test(line) && !/mcp\.zovo\.one|github\.com|aiim\.org|w3\.org|adobe:ns|Hopding/.test(line)) hits.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(hits, [], "the server must make no network call");
});
