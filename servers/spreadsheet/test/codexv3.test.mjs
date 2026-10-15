// Codex review v3, spreadsheet items 3, 4, 5, 6, 7, 8, 9, 13, 14, 16, 17.
// Every test below uses the minimal input named in the review.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { statSync } from "node:fs";
import { coerce, parseCsv } from "../dist/csv.js";
import { loadWorkbook, toNumber, guessHeaderRow, minMax } from "../dist/sheet.js";
import { compilePredicate } from "../dist/expr.js";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function tmpHome() {
  const root = mkdtempSync(join(tmpdir(), "mcp-spreadsheet-v3-"));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  return { root, env: { XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config") } };
}

class Client {
  constructor(env) {
    this.proc = spawn(process.execPath, [ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MCP_LICENSE_KEY: "", ...env },
    });
    this.buf = ""; this.pending = new Map(); this.id = 0; this.stderr = "";
    this.proc.stdout.on("data", (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const r = this.pending.get(msg.id);
        if (r) { this.pending.delete(msg.id); r(msg); }
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout on ${method}: ${this.stderr}`)), 20000);
      this.pending.set(id, (m) => { clearTimeout(t); res(m); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  async init() {
    await this.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "r5", version: "0" } });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
  }
  async call(name, args) {
    const r = await this.send("tools/call", { name, arguments: args });
    assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
    return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
  }
  stop() { this.proc.kill(); }
}


// ---------------------------------------------------------------- #4 / #7 parser
test("v3 #4: one locale-aware parser for csv coercion, aggregation and comparison", () => {
  // plain and english-grouped
  for (const [inp, want] of [["1,250.00", 1250], ["1250.00", 1250], ["12.5", 12.5], ["1,250", 1250]]) {
    assert.equal(coerce(inp), want, `coerce ${inp}`);
    assert.equal(toNumber(inp), want, `toNumber ${inp}`);
  }
  // unambiguous european shape: comma + exactly two digits at the end
  assert.equal(coerce("12,99"), 12.99);
  assert.equal(toNumber("12,99"), 12.99);
  assert.equal(coerce("1.234,56"), 1234.56);
  assert.equal(toNumber("1.234,56"), 1234.56);
  // space grouping with a decimal comma, currency stripped by the lenient parser
  assert.equal(toNumber("EUR 1 250,00"), 1250);
  assert.equal(toNumber("EUR 1 250,00"), 1250);
  // everything else that mixes separators stays text
  for (const inp of ["1,2500.00", "1,234,56", "12,345,67", "abc"]) {
    assert.equal(typeof coerce(inp), "string", `coerce ${inp} must stay text`);
  }
  // ambiguous "1.234" is a plain decimal, never 1234
  assert.equal(coerce("1.234"), 1.234);
  assert.equal(toNumber("1.234"), 1.234);
  // the old defects, verbatim
  assert.notEqual(toNumber("12,99"), 1299);
  assert.notEqual(toNumber("EUR 1 250,00"), 125000);
});

test("v3 #4: aggregation over a semicolon file with decimal commas", () => {
  const h = tmpHome();
  const f = join(h.root, "eu.csv");
  writeFileSync(f, "item;price\nx;12,99\ny;EUR 1 250,00\n");
  const t = loadWorkbook(f).get();
  assert.equal(t.matrix[1][1], 12.99);
  assert.equal(toNumber(t.matrix[2][1]), 1250);
});

test("v3 #7: comparisons keep preserved text as text", () => {
  // "007" was preserved as text by the csv layer, so it is not the number 7
  assert.equal(compilePredicate("[Code] = 7")({ Code: "007" }), false);
  assert.equal(compilePredicate('[Code] = "007"')({ Code: "007" }), true);
  // "12,99" is 12.99, so it is not greater than 13
  assert.equal(compilePredicate("[Price] > 13")({ Price: "12,99" }), false);
  assert.equal(compilePredicate("[Price] > 12")({ Price: "12,99" }), true);
  assert.equal(compilePredicate("[Price] > 13")({ Price: 12.99 }), false);
});

test("v3 #8: an ordered comparison of a number against non-numeric text is false", () => {
  assert.equal(compilePredicate("[v] > 2")({ v: "abc" }), false);
  assert.equal(compilePredicate("[v] < 2")({ v: "abc" }), false);
  assert.equal(compilePredicate("[v] > 2")({ v: "3" }), true);
});

// ---------------------------------------------------------------------- #5 safe ints
test("v3 #5: integers beyond MAX_SAFE_INTEGER stay strings", () => {
  assert.equal(coerce("9007199254740993"), "9007199254740993");
  assert.equal(typeof coerce("9007199254740993"), "string");
  assert.equal(coerce("9007199254740991"), 9007199254740991);
  const h = tmpHome();
  const f = join(h.root, "ids.csv");
  writeFileSync(f, "id\n9007199254740993\n");
  assert.equal(loadWorkbook(f).get().matrix[1][0], "9007199254740993");
});

// ------------------------------------------------------------------- #3 bad quoting
test("v3 #3: an unterminated quoted field is a parse error", () => {
  assert.throws(() => parseCsv('a,b\n"x,y\nz,w'), /unterminated quoted field/);
});

// ---------------------------------------------------------------- #6 early exit
test("v3 #6: limit/offset on a 50k-row csv stops parsing after the rows needed", async (t) => {
  const h = tmpHome();
  const f = join(h.root, "big.csv");
  const lines = ["id,name,amount"];
  for (let i = 1; i <= 50000; i++) lines.push(`${i},name-${i},${i}.50`);
  writeFileSync(f, lines.join("\n") + "\n");
  const size = statSync(f).size;

  // unit level: the loader reads and parses only the head of the file
  const budgeted = loadWorkbook(f, { rowBudget: 100 }).get();
  assert.equal(budgeted.matrix.length, 101, "header + 100 data rows");
  assert.equal(budgeted.partial, true);
  assert.equal(budgeted.matrix[1][0], 1);
  const full = loadWorkbook(f).get();
  assert.equal(full.matrix.length, 50001);
  assert.ok(!full.partial);

  // the parser itself stops: consumed bytes are a small fraction of the file
  const text = readFileSync(f, "utf8");
  const early = parseCsv(text, ",", { maxRows: 101 });
  assert.equal(early.complete, false);
  assert.equal(early.rows.length, 101);
  assert.ok(early.consumed < size / 20, `consumed ${early.consumed} of ${size}`);

  // and it is faster end to end through the tool
  const c = new Client(h.env);
  t.after(() => c.stop());
  await c.init();
  const t0 = Date.now();
  const r = await c.call("sheet_read", { path: f, limit: 5, offset: 10, as: "json" });
  const ms = Date.now() - t0;
  assert.equal(r.isError, false, r.text);
  const rows = JSON.parse(r.text.slice(r.text.indexOf("[")));
  assert.equal(rows.length, 5);
  assert.equal(rows[0].id, 11);
  assert.ok(ms < 5000, `sheet_read took ${ms}ms`);
});

// ------------------------------------------------------------------ #9 header guess
test("v3 #9: a one-cell title row is not the header row", () => {
  const h = tmpHome();
  const f = join(h.root, "title.csv");
  writeFileSync(f, "Sales report\nName,Amount\nA,1\n");
  const ls = loadWorkbook(f).get();
  assert.equal(guessHeaderRow(ls.matrix), 1);
  const wide = [["Total"], ["Name", "Amount"], ["A", 1]];
  assert.equal(guessHeaderRow(wide), 1);
  // a genuine single-column sheet still finds its header
  assert.equal(guessHeaderRow([["Name"], ["A"], ["B"]]), 0);
});

// -------------------------------------------------------------- #13 alias collision
test("v3 #13: an aggregate alias colliding with a group column is refused", async (t) => {
  const h = tmpHome();
  const f = join(h.root, "sales.csv");
  writeFileSync(f, "Region,Sales\nNorth,10\nNorth,5\nSouth,7\n");
  const c = new Client(h.env);
  t.after(() => c.stop());
  await c.init();
  const bad = await c.call("sheet_query", {
    path: f, group_by: ["Region"], aggregate: [{ col: "Sales", fn: "sum", as: "Region" }],
  });
  assert.equal(bad.isError, true, bad.text);
  assert.match(bad.text, /collides with group column "Region"/);

  const dup = await c.call("sheet_query", {
    path: f, group_by: ["Region"],
    aggregate: [{ col: "Sales", fn: "sum", as: "t" }, { col: "Sales", fn: "max", as: "t" }],
  });
  assert.equal(dup.isError, true, dup.text);
  assert.match(dup.text, /collides with aggregate "t"/);

  const ok = await c.call("sheet_query", {
    path: f, group_by: ["Region"], aggregate: [{ col: "Sales", fn: "sum", as: "total" }], as: "json",
  });
  assert.equal(ok.isError, false, ok.text);
  const rows = JSON.parse(ok.text.slice(ok.text.indexOf("[")));
  assert.deepEqual(rows.find((r) => r.Region === "North"), { Region: "North", total: 15 });
});

// ------------------------------------------------------------ #16 other sheets kept
test("v3 #16: append and overwrite keep the other sheets of an xlsx", async (t) => {
  const h = tmpHome();
  const f = join(h.root, "book.xlsx");
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Name", "Qty"], ["A", 1]]), "Sheet1");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["Note"], ["keep me"]]), "Sheet2");
  writeFileSync(f, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }));

  const c = new Client(h.env);
  t.after(() => c.stop());
  await c.init();
  const r = await c.call("sheet_write", { path: f, sheet: "Sheet1", mode: "append", rows: [{ Name: "B", Qty: 2 }] });
  assert.equal(r.isError, false, r.text);
  const after = XLSX.read(readFileSync(f), { cellDates: true });
  assert.deepEqual(after.SheetNames, ["Sheet1", "Sheet2"]);
  assert.equal(after.Sheets.Sheet2.A2.v, "keep me");
  assert.equal(after.Sheets.Sheet1.A3.v, "B");
  assert.match(r.text, /Sheets kept unchanged: "Sheet2"/);

  const o = await c.call("sheet_write", { path: f, sheet: "Sheet1", mode: "overwrite", rows: [{ Name: "C", Qty: 3 }] });
  assert.equal(o.isError, false, o.text);
  const after2 = XLSX.read(readFileSync(f), { cellDates: true });
  assert.deepEqual(after2.SheetNames, ["Sheet1", "Sheet2"]);
  assert.equal(after2.Sheets.Sheet2.A2.v, "keep me");
  assert.equal(after2.Sheets.Sheet1.A2.v, "C");
});

// ------------------------------------------------------------------- #17 date cells
test("v3 #17: xlsx date cells survive a convert to xlsx and keep their time", async (t) => {
  const h = tmpHome();
  const f = join(h.root, "dates.xlsx");
  const withTime = new Date(2026, 8, 3, 15, 30, 0);
  const dateOnly = new Date(2026, 8, 4, 0, 0, 0);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["When", "What"], [withTime, "a"], [dateOnly, "b"]], { cellDates: true }), "Sheet1");
  writeFileSync(f, XLSX.write(wb, { type: "buffer", bookType: "xlsx", cellDates: true }));

  const ls = loadWorkbook(f).get();
  assert.ok(ls.matrix[1][0] instanceof Date, "a date cell stays a Date in the model");

  const c = new Client(h.env);
  t.after(() => c.stop());
  await c.init();
  const out = join(h.root, "dates-out.xlsx");
  const r = await c.call("sheet_convert", { path: f, to: "xlsx", out_path: out });
  assert.equal(r.isError, false, r.text);
  const back = XLSX.read(readFileSync(out), { cellDates: true });
  const ws = back.Sheets[back.SheetNames[0]];
  assert.equal(ws.A2.t, "d", "still a date cell, not text");
  assert.equal(new Date(ws.A2.v).getHours(), 15);
  assert.equal(new Date(ws.A2.v).getMinutes(), 30);

  // ISO with the time only when there is one
  const j = await c.call("sheet_read", { path: f, as: "json" });
  const rows = JSON.parse(j.text.slice(j.text.indexOf("[")));
  assert.equal(rows[0].When, "2026-09-03T15:30:00");
  assert.equal(rows[1].When, "2026-09-04");
});

// -------------------------------------------------------------------- #14 big min/max
test("v3 #14: min/max over 150000 numbers does not blow the argument limit", () => {
  const nums = [];
  for (let i = 1; i <= 150000; i++) nums.push(i);
  assert.throws(() => Math.min(...nums), RangeError, "the spread this replaced does throw");
  assert.deepEqual(minMax(nums), { min: 1, max: 150000 });
  assert.equal(minMax([]), null);
});

test("v3 #14: min/max aggregates still return the right values", async (t) => {
  const h = tmpHome();
  const f = join(h.root, "many.csv");
  const lines = ["v"];
  for (let i = 1; i <= 4000; i++) lines.push(String(i));
  writeFileSync(f, lines.join("\n") + "\n");
  const c = new Client(h.env);
  t.after(() => c.stop());
  await c.init();
  const r = await c.call("sheet_query", {
    path: f, aggregate: [{ col: "v", fn: "min", as: "lo" }, { col: "v", fn: "max", as: "hi" }], as: "json",
  });
  assert.equal(r.isError, false, r.text);
  const rows = JSON.parse(r.text.slice(r.text.indexOf("[")));
  assert.equal(rows[0].hi, 4000);
  assert.equal(rows[0].lo, 1);
});

// --------------------------------------------------- #11 / #12 / #15 aggregate edges
test("v3 #11: a global aggregate over zero matching rows returns count 0", async (t) => {
  const h = tmpHome();
  const f = join(h.root, "z.csv");
  writeFileSync(f, "Region,Sales\nNorth,10\n");
  const c = new Client(h.env);
  t.after(() => c.stop());
  await c.init();
  const r = await c.call("sheet_query", { path: f, where: "1 = 0", aggregate: [{ col: "*", fn: "count", as: "n" }], as: "json" });
  assert.equal(r.isError, false, r.text);
  const rows = JSON.parse(r.text.slice(r.text.indexOf("[")));
  assert.deepEqual(rows, [{ n: 0 }]);
  const s = await c.call("sheet_query", { path: f, where: "1 = 0", aggregate: [{ col: "Sales", fn: "sum", as: "total" }], as: "json" });
  assert.deepEqual(JSON.parse(s.text.slice(s.text.indexOf("["))), [{ total: 0 }]);
});

test('v3 #12: sum over "*" is refused instead of returning the row count', async (t) => {
  const h = tmpHome();
  const f = join(h.root, "s.csv");
  writeFileSync(f, "Region,Sales\nNorth,10\nSouth,5\nEast,1\n");
  const c = new Client(h.env);
  t.after(() => c.stop());
  await c.init();
  const r = await c.call("sheet_query", { path: f, aggregate: [{ col: "*", fn: "sum", as: "total" }] });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /"\*" only works with count/);
});

test("v3 #15: an array append does not write the header row as data", async (t) => {
  const h = tmpHome();
  const f = join(h.root, "a.csv");
  writeFileSync(f, "Name,Qty\nA,1\n");
  const c = new Client(h.env);
  t.after(() => c.stop());
  await c.init();
  const r = await c.call("sheet_write", { path: f, mode: "append", rows: [["Name", "Qty"], ["B", 2]] });
  assert.equal(r.isError, false, r.text);
  assert.equal(readFileSync(f, "utf8").trim(), "Name,Qty\nA,1\nB,2");
  const bad = await c.call("sheet_write", { path: f, mode: "append", rows: [["Nope", "Qty"], ["C", 3]] });
  assert.equal(bad.isError, true, bad.text);
  assert.match(bad.text, /first array is the header row/);
});
