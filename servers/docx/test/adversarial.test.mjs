// Adversarial probes: hostile sizes, hostile content, hostile paths.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "dist");
const { buildDocx, toHtml } = await import(join(DIST, "build.js"));
const { readDocx, assertDocx, fillDocx, placeholdersIn } = await import(join(DIST, "wordxml.js"));
const { readZip, writeZip } = await import(join(DIST, "zip.js"));
const { parseMarkdown } = await import(join(DIST, "md.js"));

const BIZ = {
  name: "Acme Consulting", default_currency: "EUR", default_tax_rate: 0,
  payment_terms_days: 14, invoice_prefix: "INV",
};
const build = (blocks, title = "T") => buildDocx({ title, blocks, style: "plain", business: BIZ, pro: false });

/** The generated package must be a readable ZIP whose document.xml is well-formed XML. */
function assertWellFormed(buf) {
  const entries = readZip(buf);              // throws on a bad central directory or CRC layout
  const doc = entries.find((e) => e.name === "word/document.xml");
  assert.ok(doc, "word/document.xml is present");
  const s = doc.data.toString("utf8");
  const re = /<\/?([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>|<\?[\s\S]*?\?>|<!--[\s\S]*?-->/g;
  const stack = [];
  let m, last = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) assert.ok(!s.slice(last, m.index).includes("<"), "no raw < in character data");
    last = re.lastIndex;
    if (m[0].startsWith("<?") || m[0].startsWith("<!--")) continue;
    if (m[0].startsWith("</")) assert.equal(stack.pop(), m[1], `close tag matches: ${m[1]}`);
    else if (!m[3]) stack.push(m[1]);
  }
  assert.equal(stack.length, 0, "every element is closed");
  assert.ok(!s.slice(last).includes("<"), "nothing unparsed at the end");
  return s;
}

test("a 1 MB markdown source and a 5000-row table both build a well-formed package", async () => {
  let md = "# Big\n\n";
  while (md.length < 1024 * 1024) md += "Lorem ipsum dolor sit amet consectetur adipiscing elit. ".repeat(10) + "\n\n";
  const big = parseMarkdown(md);
  assert.ok(big.length > 1000, `1 MB of markdown parsed into ${big.length} blocks`);
  assertWellFormed(await build(big));

  let t = "| A | B | C |\n| --- | --- | --- |\n";
  for (let i = 0; i < 5000; i++) t += `| r${i} | v${i} | ${i * 3} |\n`;
  const tbl = parseMarkdown(t);
  assert.equal(tbl.length, 1);
  assert.equal(tbl[0].rows.length, 5000, "every row survives the parse");
  const xml = assertWellFormed(await build(tbl));
  assert.equal((xml.match(/<w:tr[\s>]/g) ?? []).length, 5001, "5000 body rows plus the header row");
});

test("markdown nesting is kept, clamped to the nine list levels Word has", async () => {
  let md = "";
  for (let i = 0; i < 200; i++) md += " ".repeat(i * 2) + `- level ${i}\n`;
  const blocks = parseMarkdown(md);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].items.length, 200);
  assert.deepEqual(blocks[0].levels.slice(0, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 8]);
  const buf = await build(blocks);
  assertWellFormed(buf);
  const back = readDocx(buf).find((b) => b.type === "bullets");
  assert.deepEqual(back.levels.slice(0, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 8], "w:ilvl round-trips");
  const html = toHtml("T", blocks);
  assert.ok(/<li>level 0<ul><li>level 1<ul>/.test(html), "nested markdown becomes nested lists inside their own <li>");
});

test("HTML and script in the markdown stay inert: escaped in the HTML export, plain text in the .docx", async () => {
  const md = `# Title <script>alert(1)</script>\n\n` +
    `Body with <b>bold</b> and <img src=x onerror="alert(2)"> inline.\n\n` +
    `| <script>a</script> | b |\n| --- | --- |\n| <i>c</i> | d |\n`;
  const blocks = parseMarkdown(md);
  const xml = assertWellFormed(await build(blocks, "Title <script>alert(1)</script>"));
  assert.ok(!/<script/i.test(xml), "no live script element in document.xml");
  assert.ok(xml.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "the script text is escaped character data");

  const html = toHtml("Title <script>alert(1)</script>", blocks);
  assert.ok(!/<script/i.test(html), "no live script element in the HTML export");
  assert.ok(!/onerror=(?!&quot;)/i.test(html), "no live event handler attribute");
  assert.ok(html.includes("&lt;script&gt;a&lt;/script&gt;"), "script inside a table cell is escaped too");
});

test("a ZIP that is not a Word package is refused before anything is written", () => {
  const zip = writeZip([{ name: "hello.txt", data: Buffer.from("not a docx") }]);
  assert.throws(() => readDocx(zip), /no word\/document\.xml/);
  assert.throws(() => assertDocx(zip, "/tmp/x.docx"), /is a ZIP but has no word\/document\.xml/);
  assert.throws(() => readDocx(Buffer.from("plain text, not a zip at all")), /not a ZIP archive/);
});

test("a .docx carrying 50 MB of media still reads back its text", async () => {
  const base = await build([{ type: "heading", level: 1, text: "Media doc" }, { type: "para", text: "body text here" }]);
  const entries = readZip(base);
  entries.push({ name: "word/media/image1.bin", data: Buffer.alloc(50 * 1024 * 1024, 7) });
  const big = writeZip(entries);
  const blocks = readDocx(big);
  assert.ok(blocks.some((b) => b.type === "para" && b.text.includes("body text here")));
});

test("a placeholder inside a table cell and inside a header or footer is filled; unfilled ones are reported", async () => {
  // Hand-built parts so the header/footer path is exercised without a Word round-trip.
  const base = await build([{ type: "para", text: "x" }]);
  const entries = readZip(base);
  const p = (runs) => `<w:p>${runs.map((r) => `<w:r><w:t xml:space="preserve">${r}</w:t></w:r>`).join("")}</w:p>`;
  const wrap = (body) =>
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${body}</w:hdr>`;
  const doc = entries.find((e) => e.name === "word/document.xml");
  doc.data = Buffer.from(doc.data.toString("utf8").replace(
    "<w:sectPr",
    `<w:tbl><w:tr><w:tc>${p(["Party A"])}</w:tc><w:tc>${p(["{{par", "ty_a}}"])}</w:tc></w:tr>` +
    `<w:tr><w:tc>${p(["Never"])}</w:tc><w:tc>${p(["{{never_given}}"])}</w:tc></w:tr></w:tbl><w:sectPr`,
  ), "utf8");
  entries.push({ name: "word/header9.xml", data: Buffer.from(wrap(p(["Header for ", "{{part", "y_b}}"])), "utf8") });
  entries.push({ name: "word/footer9.xml", data: Buffer.from(wrap(p(["Footer {{date}}"])), "utf8") });
  const tpl = writeZip(entries);

  assert.deepEqual(placeholdersIn(tpl), ["party_a", "never_given", "party_b", "date"]);
  const res = fillDocx(tpl, { party_a: "Acme", party_b: "Lucky Strike", date: "2026-09-03" });
  assert.deepEqual(res.replaced.sort(), ["date", "party_a", "party_b"]);
  assert.deepEqual(res.unfilled, ["never_given"], "an unfilled placeholder is reported, never blanked");
  const out = readZip(res.buffer);
  assert.deepEqual(out.map((e) => e.name), entries.map((e) => e.name), "the package part list is unchanged");
  const table = readDocx(res.buffer).find((b) => b.type === "table");
  assert.deepEqual(table.rows, [["Never", "{{never_given}}"]]);
  assert.deepEqual(table.headers, ["Party A", "Acme"], "a placeholder split across runs inside a cell is filled");
  // Replacement now happens inside the runs that hold the placeholder characters, so the
  // filled value sits in the run that carried "{{part" and the leading run keeps its own
  // text: read the joined paragraph text, not one run's bytes.
  const partText = (name) => out.find((e) => e.name === name).data.toString("utf8").replace(/<[^>]+>/g, "");
  assert.ok(partText("word/header9.xml").includes("Header for Lucky Strike"), partText("word/header9.xml"));
  assert.ok(partText("word/footer9.xml").includes("Footer 2026-09-03"), partText("word/footer9.xml"));
});

test("stdout carries no console output and the source makes no network call", () => {
  const src = ["index", "build", "md", "store", "wordxml", "zip", "blocks"]
    .map((f) => readFileSync(join(here, "..", "src", `${f}.ts`), "utf8")).join("\n");
  assert.equal(/console\.(log|info|warn|error)/.test(src), false, "nothing writes to stdout outside the transport");
  assert.equal(/\bfetch\s*\(|node:https?|node:net|node:dns|require\("https?"\)/.test(src), false, "no network call");
});
