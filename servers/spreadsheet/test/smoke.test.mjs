import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

function tmpHome() {
  const root = mkdtempSync(join(tmpdir(), "mcp-spreadsheet-"));
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
    this.buf = "";
    this.pending = new Map();
    this.id = 0;
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
    this.stderr = "";
    this.proc.stderr.on("data", (d) => { this.stderr += d.toString(); });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout on ${method}: ${this.stderr}`)), 20000);
      this.pending.set(id, (m) => { clearTimeout(t); res(m); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params) { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }
  async init() {
    const r = await this.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    });
    this.notify("notifications/initialized", {});
    return r;
  }
  async call(name, args) {
    const r = await this.send("tools/call", { name, arguments: args });
    assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
    return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
  }
  stop() { this.proc.kill(); }
}

function fixture(dir) {
  const rows = [
    ["Order Id", "Customer", "Region", "Qty", "Unit Price", "Status"],
    [1, "Acme Ltd", "North West", 4, 12.5, "open"],
    [2, "Beta, Inc", "South", 10, 3, "closed"],
    [3, "Gamma GmbH", "North East", 2, 99.99, "open"],
    [4, "Delta SA", "South", 7, 20, "open"],
    [5, "Epsilon", "North West", 0, 5.25, "closed"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Orders");
  const p = join(dir, "orders.xlsx");
  XLSX.writeFile(wb, p);
  return p;
}

test("stdio: initialize, tools/list, and the full read-query-edit-convert path", async (t) => {
  const { root, env } = tmpHome();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = fixture(root);
  const c = new Client(env);
  t.after(() => c.stop());

  const init = await c.init();
  assert.equal(init.result.serverInfo.name, "mcp-spreadsheet");

  const list = await c.send("tools/list", {});
  const names = list.result.tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "license_activate", "license_status", "sheet_add_column", "sheet_convert",
    "sheet_find", "sheet_info", "sheet_query", "sheet_read", "sheet_stats", "sheet_write",
  ]);

  // sheet_info
  const info = JSON.parse((await c.call("sheet_info", { path: file })).text);
  assert.equal(info.sheets.length, 1);
  assert.equal(info.sheets[0].name, "Orders");
  assert.equal(info.sheets[0].rowCount, 5);
  assert.equal(info.sheets[0].headerRow, 1);
  const cols = Object.fromEntries(info.sheets[0].columns.map((c) => [c.name, c.type]));
  assert.equal(cols["Qty"], "number");
  assert.equal(cols["Customer"], "text");

  // resource template
  const res = await c.send("resources/read", { uri: `sheet://${encodeURIComponent(file)}` });
  assert.match(res.result.contents[0].text, /"Orders"/);

  // sheet_read
  const read = await c.call("sheet_read", { path: file, limit: 2, as: "csv" });
  assert.match(read.text, /Order Id,Customer,Region,Qty,Unit Price,Status/);
  assert.match(read.text, /"Beta, Inc"/);

  // sheet_query
  const q = await c.call("sheet_query", {
    path: file,
    where: '[Qty] > 3 AND ([Status] = "open" OR [Region] contains "north")',
    select: ["Customer", "Qty"],
    sort: { col: "Qty", dir: "desc" },
    as: "json",
  });
  const qrows = JSON.parse(q.text);
  // Beta, Inc has Qty 10 but is closed and in the South, so the OR group excludes it
  assert.deepEqual(qrows, [
    { Customer: "Delta SA", Qty: 7 },
    { Customer: "Acme Ltd", Qty: 4 },
  ]);

  // sheet_stats
  const st = JSON.parse((await c.call("sheet_stats", { path: file, columns: ["Qty"] })).text);
  assert.equal(st.columns[0].sum, 23);
  assert.equal(st.columns[0].median, 4);
  assert.equal(st.columns[0].max, 10);
  assert.equal(st.columns[0].empty, 0);

  // sheet_find
  const f = JSON.parse((await c.call("sheet_find", { path: file, text: "gamma" })).text);
  assert.equal(f.matches, 1);
  assert.equal(f.hits[0].cell, "B4");

  // sheet_add_column with a formula, source untouched
  const plus = join(root, "orders-total.xlsx");
  const add = await c.call("sheet_add_column", { path: file, name: "Total", formula: "[Qty] * [Unit Price]", out_path: plus });
  assert.equal(add.isError, false);
  assert.ok(existsSync(plus));
  const back = XLSX.utils.sheet_to_json(XLSX.read(readFileSync(plus)).Sheets["Orders"], { header: 1 });
  assert.deepEqual(back[0], ["Order Id", "Customer", "Region", "Qty", "Unit Price", "Status", "Total"]);
  assert.equal(back[1][6], 50);
  assert.equal(back[2][6], 30);
  const orig = XLSX.utils.sheet_to_json(XLSX.read(readFileSync(file)).Sheets["Orders"], { header: 1 });
  assert.equal(orig[0].length, 6, "source file must not be modified");

  // sheet_convert to csv, verify bytes on disk
  const csvOut = join(root, "orders.csv");
  await c.call("sheet_convert", { path: plus, to: "csv", out_path: csvOut });
  const csv = readFileSync(csvOut, "utf8");
  assert.equal(csv.split("\n")[0], "Order Id,Customer,Region,Qty,Unit Price,Status,Total");
  assert.match(csv, /^3,Gamma GmbH,North East,2,99.99,open,199.98$/m);
  assert.match(csv, /"Beta, Inc"/);

  // the csv round trips back through the server
  const csvInfo = JSON.parse((await c.call("sheet_info", { path: csvOut })).text);
  assert.equal(csvInfo.format, "csv");
  assert.equal(csvInfo.delimiter, ",");
  assert.equal(csvInfo.sheets[0].rowCount, 5);
});

test("safety: missing files, clobbering and bad expressions are refused with a clear message", async (t) => {
  const { root, env } = tmpHome();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = fixture(root);
  const c = new Client(env);
  t.after(() => c.stop());
  await c.init();

  const missing = await c.call("sheet_info", { path: join(root, "nope.xlsx") });
  assert.equal(missing.isError, true);
  assert.match(missing.text, /file not found/);

  const clobber = await c.call("sheet_write", { path: file, mode: "new_file", rows: [{ a: 1 }] });
  assert.equal(clobber.isError, true);
  assert.match(clobber.text, /already exists/);

  const badExpr = await c.call("sheet_query", { path: file, where: "[Qty] >" });
  assert.equal(badExpr.isError, true);
  assert.match(badExpr.text, /Error:/);

  const badCol = await c.call("sheet_query", { path: file, select: ["Nope"] });
  assert.equal(badCol.isError, true);
  assert.match(badCol.text, /not found/);
});

test("free write cap: 300 rows write in full, 600 rows write nothing at all", async (t) => {
  const { root, env } = tmpHome();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rows = Array.from({ length: 300 }, (_, i) => ({ n: i + 1, label: `row ${i + 1}` }));
  const big = Array.from({ length: 600 }, (_, i) => ({ n: i + 1, label: `row ${i + 1}` }));

  // free: 300 rows is under the 500-row free cap, so the file is complete
  const free = new Client(env);
  t.after(() => free.stop());
  await free.init();
  const status = JSON.parse((await free.call("license_status", {})).text);
  assert.equal(status.tier, "free");
  const freeOut = join(root, "free.csv");
  const fr = await free.call("sheet_write", { path: freeOut, mode: "new_file", rows });
  assert.equal(fr.isError, false, fr.text);
  assert.doesNotMatch(fr.text, /Nothing was written/);
  assert.equal(readFileSync(freeOut, "utf8").trim().split("\n").length, 301);

  // free: 600 rows is over the cap - D-1: refuse, write zero bytes, no partial file
  const bigOut = join(root, "free-600.csv");
  const br = await free.call("sheet_write", { path: bigOut, mode: "new_file", rows: big });
  assert.equal(br.isError, false, "an over-cap write is a gated message, not an error");
  assert.match(br.text, /Nothing was written/);
  assert.match(br.text, /600 rows/);
  assert.match(br.text, /at most 500 rows/);
  assert.match(br.text, /Free workaround:/);
  assert.match(br.text, /mcp\.zovo\.one\/buy\/spreadsheet/);
  assert.equal(existsSync(bigOut), false, "no file may be created when the write is refused");

  // the same refusal for sheet_convert, and the source is left alone
  const conv = await free.call("sheet_convert", { path: freeOut, to: "json", out_path: join(root, "free-conv.json") });
  assert.equal(conv.isError, false);
  assert.doesNotMatch(conv.text, /Nothing was written/, "300 rows converts fine on free");
  const src600 = join(root, "src600.csv");
  writeFileSync(src600, "n,label\n" + big.map((r) => `${r.n},${r.label}`).join("\n") + "\n");
  const convOut = join(root, "src600.json");
  const cv = await free.call("sheet_convert", { path: src600, to: "json", out_path: convOut });
  assert.match(cv.text, /Nothing was written/);
  assert.equal(existsSync(convOut), false);
  const addOut = join(root, "src600-plus.csv");
  const ac = await free.call("sheet_add_column", { path: src600, name: "double", formula: "[n] * 2", out_path: addOut });
  assert.match(ac.text, /Nothing was written/);
  assert.equal(existsSync(addOut), false);
  assert.equal(readFileSync(src600, "utf8").trim().split("\n").length, 601, "the source must be untouched");

  // pro
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "spreadsheet"], { encoding: "utf8" }).trim();
  assert.match(key, /^MCPL1\./);
  const pro = new Client({ ...env, MCP_LICENSE_KEY: key });
  t.after(() => pro.stop());
  await pro.init();
  const pstatus = JSON.parse((await pro.call("license_status", {})).text);
  assert.equal(pstatus.tier, "pro");
  const proOut = join(root, "pro.csv");
  const pr = await pro.call("sheet_write", { path: proOut, mode: "new_file", rows: big });
  assert.equal(pr.isError, false, pr.text);
  assert.doesNotMatch(pr.text, /Nothing was written/);
  assert.equal(readFileSync(proOut, "utf8").trim().split("\n").length, 601);
});
