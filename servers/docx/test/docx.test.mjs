// Document engine: build, read back, markdown, template fill.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "dist");
const { buildDocx, toHtml } = await import(join(DIST, "build.js"));
const { readDocx, placeholdersIn, fillDocx } = await import(join(DIST, "wordxml.js"));
const { readZip, writeZip } = await import(join(DIST, "zip.js"));
const { parseMarkdown } = await import(join(DIST, "md.js"));

const BIZ = {
  name: "Acme Consulting", address: "1 Road\nWarsaw", email: "hi@acme.example",
  default_currency: "EUR", default_tax_rate: 0, payment_terms_days: 14, invoice_prefix: "INV",
};

test("doc_create output is a real .docx and reads back with headings, lists and tables", async () => {
  const blocks = [
    { type: "heading", level: 2, text: "Scope" },
    { type: "para", text: "We will build **the thing** for Beta Corp." },
    { type: "bullets", items: ["Discovery", "Build"], ordered: false },
    { type: "bullets", items: ["Phase one", "Phase two"], ordered: true },
    { type: "table", headers: ["Phase", "Duration"], rows: [["Discovery", "2 weeks"], ["Build", "4 weeks"]] },
  ];
  const buf = await buildDocx({ title: "Website rebuild", blocks, business: BIZ, pro: false, style: "proposal", recipient: "Beta Corp" });

  // A .docx is a ZIP with the OOXML parts in it.
  assert.equal(buf.subarray(0, 2).toString("latin1"), "PK");
  const names = readZip(buf).map((e) => e.name);
  assert.ok(names.includes("[Content_Types].xml"));
  assert.ok(names.includes("word/document.xml"));

  const back = readDocx(buf);
  const text = JSON.stringify(back);
  assert.ok(back.some((b) => b.type === "heading" && b.text === "Website rebuild"), text);
  assert.ok(back.some((b) => b.type === "heading" && b.text === "Scope"), text);
  // Inline markers are formatting, not literal characters, once in Word.
  assert.ok(back.some((b) => b.type === "para" && b.text === "We will build the thing for Beta Corp."), text);
  const lists = back.filter((b) => b.type === "bullets");
  assert.equal(lists.length, 2, `bullet and numbered lists must stay separate: ${text}`);
  assert.deepEqual(lists[0], { type: "bullets", items: ["Discovery", "Build"], ordered: false, levels: [0, 0] });
  assert.deepEqual(lists[1], { type: "bullets", items: ["Phase one", "Phase two"], ordered: true, levels: [0, 0] });
  const table = back.find((b) => b.type === "table");
  assert.deepEqual(table.headers, ["Phase", "Duration"]);
  assert.deepEqual(table.rows, [["Discovery", "2 weeks"], ["Build", "4 weeks"]]);

  // Free tier carries the branding line, Pro does not.
  const pro = await buildDocx({ title: "Website rebuild", blocks, business: BIZ, pro: true });
  const footerOf = (b) => readZip(b).filter((e) => /^word\/footer\d*\.xml$/.test(e.name)).map((e) => e.data.toString("utf8")).join("");
  assert.match(footerOf(buf), /Generated with mcp-docx/);
  assert.doesNotMatch(footerOf(pro), /Generated with mcp-docx/);
});

test("markdown: headings, lists, GFM pipe tables, code blocks and inline styles", async () => {
  const md = [
    "# Statement of work",
    "",
    "Intro with **bold** and *italic* and `code`.",
    "",
    "## Deliverables",
    "",
    "- Design files",
    "- Source code",
    "",
    "1. Kickoff",
    "2. Delivery",
    "",
    "| Item | Price |",
    "| --- | ---: |",
    "| Design | EUR 1,500.00 |",
    "| Build | EUR 3,000.00 |",
    "",
    "```",
    "npm run build",
    "```",
    "",
  ].join("\n");

  const blocks = parseMarkdown(md);
  const table = blocks.find((b) => b.type === "table");
  assert.deepEqual(table.headers, ["Item", "Price"]);
  assert.deepEqual(table.rows, [["Design", "EUR 1,500.00"], ["Build", "EUR 3,000.00"]]);
  assert.ok(blocks.some((b) => b.type === "code" && b.text === "npm run build"));
  assert.ok(blocks.some((b) => b.type === "bullets" && b.ordered === true && b.items.length === 2));

  const buf = await buildDocx({ title: "Statement of work", blocks: blocks.slice(1), business: BIZ, pro: true });
  const back = readDocx(buf);
  const backTable = back.find((b) => b.type === "table");
  assert.deepEqual(backTable.headers, ["Item", "Price"]);
  assert.deepEqual(backTable.rows, [["Design", "EUR 1,500.00"], ["Build", "EUR 3,000.00"]]);
  assert.ok(back.some((b) => b.type === "para" && b.text === "Intro with bold and italic and code."));

  const html = toHtml("Statement of work", blocks);
  assert.match(html, /<th>Item<\/th>/);
  assert.match(html, /<ol><li>Kickoff<\/li>/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<pre>npm run build<\/pre>/);
});

test("template fill: values land, unknown placeholders are reported, split runs are handled", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-docx-tpl-"));
  let buf = await buildDocx({
    title: "Agreement",
    blocks: [
      { type: "para", text: "Dear {{client}}, the fee is {{fee}}." },
      { type: "table", headers: ["Field", "Value"], rows: [["Client", "{{client}}"], ["Law", "{{law}}"]] },
    ],
    business: BIZ, pro: true,
  });

  // Word routinely breaks one typed placeholder into several runs after a spell-check
  // pass. Reproduce exactly that: {{client}} and {{fee}} each split across three w:r.
  const entries = readZip(buf);
  const doc = entries.find((e) => e.name === "word/document.xml");
  const before = doc.data.toString("utf8");
  const after = before.replace(
    /<w:t([^>]*)>Dear \{\{client\}\}, the fee is \{\{fee\}\}\.<\/w:t>/,
    '<w:t$1>Dear {{cli</w:t></w:r><w:r><w:t xml:space="preserve">ent}}, the fee is {{fe</w:t></w:r><w:r><w:t xml:space="preserve">e}}.</w:t>',
  );
  assert.notEqual(after, before, "the split-run fixture did not apply");
  doc.data = Buffer.from(after, "utf8");
  const tpl = join(dir, "template.docx");
  writeFileSync(tpl, writeZip(entries));

  const tplBuf = readFileSync(tpl);
  assert.deepEqual(placeholdersIn(tplBuf), ["client", "fee", "law"]);

  const res = fillDocx(tplBuf, { client: "Beta Corp", fee: "EUR 4,500.00" });
  assert.deepEqual(res.replaced.sort(), ["client", "fee"]);
  assert.deepEqual(res.unfilled, ["law"], "a placeholder with no value must be reported, not blanked");

  const back = readDocx(res.buffer);
  const para = back.find((b) => b.type === "para" && b.text.startsWith("Dear"));
  assert.equal(para.text, "Dear Beta Corp, the fee is EUR 4,500.00.",
    "a placeholder split across runs must still be replaced");
  const table = back.find((b) => b.type === "table");
  assert.deepEqual(table.rows, [["Client", "Beta Corp"], ["Law", "{{law}}"]]);
  // The rest of the package is untouched: same parts, same count.
  assert.deepEqual(readZip(res.buffer).map((e) => e.name), entries.map((e) => e.name));
});

test("underscore italics are intraword-safe: snake_case survives, _italic_ still works", async () => {
  const blocks = [
    { type: "para", text: "late_fee_percent" },
    { type: "para", text: "my_var_name and file_names_like_this" },
    { type: "para", text: "_italic_ word" },
    { type: "para", text: "snake_case and _italic_" },
    { type: "para", text: "a_b_c" },
  ];
  const buf = await buildDocx({ title: "Underscore check", blocks, business: BIZ, pro: true });

  const doc = readZip(buf).find((e) => e.name === "word/document.xml");
  const xml = doc.data.toString("utf8");
  // Snake-case identifiers must appear verbatim, underscores intact, in document.xml.
  assert.match(xml, /late_fee_percent/);
  assert.match(xml, /my_var_name/);
  assert.match(xml, /file_names_like_this/);
  assert.match(xml, /a_b_c/);
  // A true underscore-italic span is still rendered as italic (<w:i\/>), not literal underscores.
  assert.match(xml, /<w:i\/>[^]*?<w:t[^>]*>italic<\/w:t>/);

  const back = readDocx(buf);
  const textOf = (needle) => back.find((b) => b.type === "para" && b.text.includes(needle))?.text;
  assert.equal(textOf("late_fee_percent"), "late_fee_percent");
  assert.equal(textOf("my_var_name"), "my_var_name and file_names_like_this");
  assert.equal(textOf("italic word"), "italic word");
  assert.equal(textOf("snake_case"), "snake_case and italic");
  assert.equal(textOf("a_b_c"), "a_b_c");
});

test("doc_read refuses what is not a .docx with a message that names the reason", async () => {
  assert.throws(() => readDocx(Buffer.from("this is not a zip file at all")), /ZIP/);
});
