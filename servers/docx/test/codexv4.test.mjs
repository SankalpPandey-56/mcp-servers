// Codex v4 review items 11, 12, 13, 14, 15.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "dist");
const ENTRY = join(DIST, "index.js");
const { buildDocx } = await import(join(DIST, "build.js"));
const { readDocx, fillDocx, stripInvalidXml } = await import(join(DIST, "wordxml.js"));
const { readZip, writeZip } = await import(join(DIST, "zip.js"));

const NUL = "\u0000";
const BEL = "\u0007";
const LONE_HIGH = "\uD800";
const C0 = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;
const BIZ = {
  name: "Acme Consulting", address: "1 Road\nWarsaw", email: "hi@acme.example",
  default_currency: "EUR", default_tax_rate: 0, payment_terms_days: 14, invoice_prefix: "INV",
};

function client(home) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "cfg"), MCP_LICENSE_KEY: "" },
  });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error(`timeout on ${method}`)); } }, 20000);
    t.unref();
  });
  return {
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "v4", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, JSON.stringify(r.error));
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

const template = (paraText) =>
  buildDocx({ title: "T", blocks: [{ type: "para", text: paraText }], business: BIZ, pro: true });

test("11: XML 1.0 disallowed code points are removed from every string that reaches document.xml, and the answer says so", async () => {
  assert.deepEqual(stripInvalidXml("a\tb\nc\rd"), { text: "a\tb\nc\rd", removed: 0 }, "TAB, LF and CR are legal");
  assert.deepEqual(stripInvalidXml(`Acme${NUL}Ltd${LONE_HIGH}x`), { text: "AcmeLtdx", removed: 2 });
  assert.deepEqual(stripInvalidXml("emoji \u{1f600} stays"), { text: "emoji \u{1f600} stays", removed: 0 },
    "a correctly paired surrogate is not a disallowed code point");

  // Template fill: the value is cleaned and the key is reported back.
  const tpl = await template("Dear {{client}}.");
  const res = fillDocx(tpl, { client: `Acme${NUL}Ltd` });
  assert.deepEqual(res.sanitized, ["client"]);
  const xml = readZip(res.buffer).find((e) => e.name === "word/document.xml").data.toString("utf8");
  assert.equal(C0.test(xml), false, "no C0 control survives into document.xml");
  assert.equal(readDocx(res.buffer).find((b) => b.type === "para" && b.text.startsWith("Dear")).text, "Dear AcmeLtd.");

  // Build path: doc_create over stdio reports the removal.
  const home = mkdtempSync(join(tmpdir(), "mcp-docx-v4-"));
  const c = client(home);
  try {
    await c.init();
    const out = join(home, "ctrl.docx");
    const r = await c.call("doc_create", {
      title: `Bad${NUL}Title`, sections: [{ paragraphs: [`Fee is 10${BEL} EUR`] }], out_path: out,
    });
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Removed 2 characters that XML 1\.0 cannot carry/, r.text);
    const raw = readFileSync(out);
    assert.equal(C0.test(readZip(raw).find((e) => e.name === "word/document.xml").data.toString("utf8")), false);
    const back = readDocx(raw);
    assert.ok(back.some((b) => b.text === "BadTitle"), JSON.stringify(back));
    assert.ok(back.some((b) => b.text === "Fee is 10 EUR"), JSON.stringify(back));
  } finally { c.close(); }
});

test("12: a placeholder split across runs is replaced in place; other runs, their bold and a hyperlink survive", async () => {
  const base = await template("MARKER");
  const entries = readZip(base);
  const doc = entries.find((e) => e.name === "word/document.xml");
  const before = doc.data.toString("utf8");
  const runs =
    '<w:t xml:space="preserve">Pay </w:t></w:r>' +
    '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">{{amo</w:t></w:r>' +
    '<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">unt}} now</w:t></w:r>' +
    '<w:hyperlink r:id="rId99"><w:r><w:rPr><w:color w:val="0563C1"/></w:rPr>' +
    '<w:t xml:space="preserve">the terms</w:t></w:r></w:hyperlink>' +
    '<w:r><w:t xml:space="preserve">.</w:t>';
  const after = before.replace(/<w:t(?:[^>]*)>MARKER<\/w:t>/, runs);
  assert.notEqual(after, before, "the split-run fixture did not apply");
  doc.data = Buffer.from(after, "utf8");
  const tpl = writeZip(entries);

  const res = fillDocx(tpl, { amount: "EUR 4,500.00" });
  assert.deepEqual(res.replaced, ["amount"]);
  const xml = readZip(res.buffer).find((e) => e.name === "word/document.xml").data.toString("utf8");

  assert.match(xml, /<w:hyperlink r:id="rId99"><w:r><w:rPr><w:color w:val="0563C1"\/><\/w:rPr><w:t[^>]*>the terms<\/w:t><\/w:r><\/w:hyperlink>/,
    "the hyperlink and the run inside it must be untouched after a fill");
  assert.equal((xml.match(/<w:b\/>/g) || []).length, (after.match(/<w:b\/>/g) || []).length,
    "no bold run property is dropped");
  assert.match(xml, /<w:rPr><w:b\/><\/w:rPr><w:t[^>]*>EUR 4,500\.00<\/w:t>/,
    "the value lands in the bold run that held the placeholder, keeping its formatting");
  assert.match(xml, /<w:t[^>]*>Pay <\/w:t>/, "the run before the placeholder keeps its own text");
  assert.match(xml, /<w:t[^>]*> now<\/w:t>/, "the tail of the second placeholder run is kept, not blanked");

  const para = readDocx(res.buffer).find((b) => b.type === "para" && b.text.startsWith("Pay"));
  assert.equal(para.text, "Pay EUR 4,500.00 nowthe terms.");
});

test("13: each ordered list block gets its own numbering instance", async () => {
  const buf = await buildDocx({
    title: "Lists",
    blocks: [
      { type: "bullets", items: ["a", "b"], ordered: true },
      { type: "para", text: "Between." },
      { type: "bullets", items: ["c"], ordered: true },
    ],
    business: BIZ, pro: true,
  });
  const xml = readZip(buf).find((e) => e.name === "word/document.xml").data.toString("utf8");
  const ids = new Set([...xml.matchAll(/<w:numId w:val="(\d+)"\s*\/>/g)].map((m) => m[1]));
  assert.equal(ids.size, 2, `the two numbered blocks must use two numbering instances, got ${[...ids]}`);
  const numbering = readZip(buf).find((e) => e.name === "word/numbering.xml").data.toString("utf8");
  for (const id of ids) assert.match(numbering, new RegExp(`<w:num w:numId="${id}"`), "each instance is defined");
});

test("14: a row wider than the header keeps every cell", async () => {
  const buf = await buildDocx({
    title: "Wide",
    blocks: [{ type: "table", headers: ["Item"], rows: [["Consulting", "USD 100"], ["Setup"]] }],
    business: BIZ, pro: true,
  });
  const table = readDocx(buf).find((b) => b.type === "table");
  assert.equal(table.headers.length, 2, `the header row is padded to the widest row: ${JSON.stringify(table.headers)}`);
  assert.deepEqual(table.rows, [["Consulting", "USD 100"], ["Setup", ""]],
    "no cell beyond the header count is discarded and a short row is padded");
});

test("15: two processes writing one out_path with overwrite false: exactly one wins, the other writes nothing", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-docx-v4-race-"));
  const tplPath = join(home, "t.docx");
  writeFileSync(tplPath, await template("Dear {{client}}."));
  const out = join(home, "filled.docx");
  const a = client(join(home, "a"));
  const b = client(join(home, "b"));
  try {
    await Promise.all([a.init(), b.init()]);
    const [ra, rb] = await Promise.all([
      a.call("doc_fill_template", { template_path: tplPath, values: { client: "Acme" }, out_path: out }),
      b.call("doc_fill_template", { template_path: tplPath, values: { client: "Beta Corp" }, out_path: out }),
    ]);
    const errors = [ra, rb].filter((r) => r.isError);
    assert.equal(errors.length, 1, `exactly one writer must be refused: ${ra.text} | ${rb.text}`);
    assert.match(errors[0].text, /already exists and nothing was written/);
    const winner = [ra, rb].find((r) => !r.isError);
    const text = readDocx(readFileSync(out)).find((x) => x.type === "para" && x.text.startsWith("Dear")).text;
    assert.ok(text === "Dear Acme." || text === "Dear Beta Corp.", text);
    assert.ok(winner.text.includes(out));
  } finally { a.close(); b.close(); }
});

test("D-R25: literal backslash-n in a string argument becomes a real paragraph break, stray whitespace collapses", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-docx-r25-"));
  const c = client(home);
  try {
    await c.init();
    const out = join(home, "escaped.docx");
    const r = await c.call("doc_create", {
      title: "Nova",
      sections: [{ paragraphs: ["proceed with confidence.\\n\\nBuilding on that   foundation, phase 2  starts."] }],
      out_path: out,
    });
    assert.equal(r.isError, false, r.text);
    const xml = readZip(readFileSync(out)).find((e) => e.name === "word/document.xml").data.toString("utf8");
    assert.equal(xml.includes("\\n"), false, "the two characters backslash-n must never reach the page");
    const back = readDocx(readFileSync(out)).filter((b) => b.type === "para");
    assert.deepEqual(back.map((b) => b.text), [
      "proceed with confidence.",
      "Building on that foundation, phase 2 starts.",
    ], "one blank line splits the argument into two paragraphs and runs of spaces collapse");
  } finally { c.close(); }
});

test("D-R26: a derived path never overwrites an earlier proposal, and proposal_update rewrites one in place", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-docx-r26-"));
  const c = client(home);
  try {
    await c.init();
    await c.call("business_set", { name: "Acme Consulting", default_currency: "EUR" });
    const args = {
      client: "Nova", project_title: "Nova engagement", summary: "Phase 1.",
      scope: ["a"], deliverables: ["b"], timeline: [{ phase: "Build", duration: "2 weeks" }],
      price: { amount: 1000, currency: "EUR", terms: "on delivery" },
    };
    const first = JSON.parse((await c.call("proposal_create", args)).text.split("\n\n")[1]);
    const second = JSON.parse((await c.call("proposal_create", args)).text.split("\n\n")[1]);
    assert.notEqual(first.file, second.file, "the second proposal must not land on the first one's file");
    assert.match(second.file, /-2\.docx$/);
    assert.notEqual(first.reference, second.reference);
    for (const f of [first.file, second.file]) assert.ok(readFileSync(f).length > 0, `${f} is missing`);
    assert.match(readDocx(readFileSync(first.file)).map((b) => b.text).join(" "), /EUR 1,000\.00/);

    // Update: same reference, same file, new figures, no third document.
    const upd = await c.call("proposal_update", { reference: first.reference, price: { amount: 1800, currency: "EUR", terms: "on delivery" } });
    assert.equal(upd.isError, false, upd.text);
    const after = JSON.parse(upd.text.split("\n\n")[1]);
    assert.equal(after.reference, first.reference);
    assert.equal(after.file, first.file, "an update rewrites the same file");
    const text = readDocx(readFileSync(first.file)).map((b) => b.text).join(" ");
    assert.match(text, /EUR 1,800\.00/, "the stored structured data was rebuilt with the new price");
    assert.equal(/EUR 1,000\.00/.test(text), false);
    assert.match(text, /Nova engagement/, "fields that were not passed come from the stored data");

    const docs = JSON.parse(readFileSync(join(home, "data", "mcp-servers", "docx", "documents.json"), "utf8"));
    assert.equal(docs.length, 2, `an update must not add a row: ${JSON.stringify(docs.map((d) => d.number))}`);
    assert.deepEqual(docs.map((d) => d.number), [first.reference, second.reference]);

    const missing = await c.call("proposal_update", { reference: "PROP-1999-0001", summary: "x" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /no proposal PROP-1999-0001/);
  } finally { c.close(); }
});
