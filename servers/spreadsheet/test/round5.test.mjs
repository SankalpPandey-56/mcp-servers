// Round-5 defects: D-R11 (tool descriptions claim the file case), D-R12 (money ending in
// .00 was written as text), D-R13 (a money formula emitted raw floats).
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { coerce } from "../dist/csv.js";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function tmpHome() {
  const root = mkdtempSync(join(tmpdir(), "mcp-spreadsheet-r5-"));
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

test("D-R12: coerce decides by pattern, not by string length", () => {
  // Money that ends in .00 is a NUMBER. The old length test made these text.
  assert.equal(coerce("1250.00"), 1250);
  assert.equal(coerce("12.00"), 12);
  assert.equal(coerce("403.00"), 403);
  assert.equal(coerce("0.00"), 0);
  assert.equal(coerce("1,250.00"), 1250);
  assert.equal(coerce("-1,250.00"), -1250);
  assert.equal(coerce("33.16"), 33.16);
  assert.equal(coerce("403.10"), 403.1);
  for (const v of ["1250.00", "12.00", "1,250.00"]) assert.equal(typeof coerce(v), "number", v);
  // Ambiguous or identifier-shaped strings stay text.
  assert.equal(coerce("007"), "007");
  assert.equal(coerce("0123"), "0123");
  // v3 #4 supersedes the original D-R12 expectation for these two: a comma followed by
  // exactly two digits at the end, with dots grouping, is the unambiguous European shape.
  assert.equal(coerce("1.250,00"), 1250);
  assert.equal(coerce("1,25"), 1.25);
  assert.equal(coerce("1,2500.00"), "1,2500.00");
  assert.equal(coerce("$1,250.00"), "$1,250.00");
  assert.equal(coerce("-"), "-");
  assert.equal(coerce("1."), "1.");
  for (const v of ["007", "1,2500.00", "$1,250.00"]) assert.equal(typeof coerce(v), "string", v);
});

test("D-R12: sheet_convert writes .00 money as numeric xlsx cells", async (t) => {
  const h = tmpHome();
  const csv = join(h.root, "costs.csv");
  writeFileSync(csv, 'Date,Supplier,Amount\n2026-09-01,Acme,"1,250.00"\n2026-09-01,Globex,1250.00\n2026-09-01,Initech,12.00\n2026-09-01,Hooli,007\n2026-09-01,Stark,"1.250,00"\n');
  const c = new Client(h.env);
  t.after(() => c.stop());
  await c.init();
  const out = join(h.root, "costs.xlsx");
  const r = await c.call("sheet_convert", { path: csv, to: "xlsx", out_path: out });
  assert.equal(r.isError, false, r.text);
  const wb = XLSX.read(readFileSync(out));
  const ws = wb.Sheets[wb.SheetNames[0]];
  assert.equal(ws.C2.t, "n"); assert.equal(ws.C2.v, 1250);   // "1,250.00"
  assert.equal(ws.C3.t, "n"); assert.equal(ws.C3.v, 1250);   // 1250.00
  assert.equal(ws.C4.t, "n"); assert.equal(ws.C4.v, 12);     // 12.00
  assert.equal(ws.C5.t, "s"); assert.equal(ws.C5.v, "007");  // identifier, stays text
  assert.equal(ws.C6.t, "n"); assert.equal(ws.C6.v, 1250);   // v3 #4: European "1.250,00"
});

test("D-R13: a VAT column over 2-decimal money is rounded to 2 decimals", async (t) => {
  const h = tmpHome();
  const csv = join(h.root, "amounts.csv");
  writeFileSync(csv, "Supplier,Amount\nAcme,1250\nGlobex,33.16\n");
  const c = new Client(h.env);
  t.after(() => c.stop());
  await c.init();
  const out = join(h.root, "vat.xlsx");
  const r = await c.call("sheet_add_column", { path: csv, name: "Amount with VAT", formula: "[Amount] * 1.23", out_path: out });
  assert.equal(r.isError, false, r.text);
  const wb = XLSX.read(readFileSync(out));
  const ws = wb.Sheets[wb.SheetNames[0]];
  assert.equal(ws.C2.v, 1537.5);   // 1250 x 1.23
  assert.equal(ws.C3.v, 40.79);    // 33.16 x 1.23 = 40.7868 rounded
  assert.match(r.text, /rounded to 2 decimals/);
});

test("D-R13: decimals overrides the inferred precision", async (t) => {
  const h = tmpHome();
  const csv = join(h.root, "amounts.csv");
  writeFileSync(csv, "Supplier,Amount\nGlobex,33.16\n");
  const c = new Client(h.env);
  t.after(() => c.stop());
  await c.init();
  const out = join(h.root, "vat4.xlsx");
  const r = await c.call("sheet_add_column", { path: csv, name: "VAT", formula: "[Amount] * 1.23", decimals: 4, out_path: out });
  assert.equal(r.isError, false, r.text);
  const wb = XLSX.read(readFileSync(out));
  assert.equal(wb.Sheets[wb.SheetNames[0]].C2.v, 40.7868);
  const out0 = join(h.root, "vat0.xlsx");
  const r0 = await c.call("sheet_add_column", { path: csv, name: "VAT", formula: "[Amount] * 1.23", decimals: 0, out_path: out0 });
  assert.equal(r0.isError, false, r0.text);
  const wb0 = XLSX.read(readFileSync(out0));
  assert.equal(wb0.Sheets[wb0.SheetNames[0]].C2.v, 41);
});

test("D-R11/D-R19: sheet_info, sheet_read, sheet_query and sheet_stats lead with the client-directed claim", async (t) => {
  const h = tmpHome();
  const c = new Client(h.env);
  t.after(() => c.stop());
  await c.init();
  const r = await c.send("tools/list", {});
  const byName = new Map(r.result.tools.map((x) => [x.name, x]));
  // D-R19: the first sentence is an imperative aimed at the client, because in round 6
  // the model reached for a built-in file reader and never called these tools at all.
  const CLAIM = "Call this tool for any spreadsheet or CSV file path; built-in file readers cannot parse spreadsheets and must not be used for them.";
  for (const n of ["sheet_info", "sheet_read", "sheet_query", "sheet_stats"]) {
    assert.ok(byName.has(n), `${n} missing`);
    const d = byName.get(n).description;
    assert.ok(d.startsWith(CLAIM), `${n} does not lead with the claim: ${d.slice(0, 90)}`);
    assert.ok(d.length < 220, `${n} description is ${d.length} chars, must stay under 220`);
  }
});
