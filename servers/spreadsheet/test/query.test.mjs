// D-6: sheet_query aggregation - group_by + aggregate + sort on an aggregate alias,
// so "which rep sold the most units in the North region, top 5" is one call.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { toNumber } from "../dist/sheet.js";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

class Client {
  constructor(env) {
    this.proc = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MCP_LICENSE_KEY: "", ...env } });
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
  async init() {
    const r = await this.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "query", version: "0" } });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    return r;
  }
  async call(name, args) {
    const r = await this.send("tools/call", { name, arguments: args });
    assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
    return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
  }
  stop() { this.proc.kill(); }
}

// Reps and their North-region units: Turing 650, Hopper 567, Linus 551, Lovelace 486, Liskov 290, Knuth 100.
const NORTH = { Turing: [400, 250], Hopper: [500, 67], Linus: [551], Lovelace: [486], Liskov: [200, 90], Knuth: [100] };

function fixture(dir) {
  const rows = [["Region", "Rep", "Units", "Revenue"]];
  for (const [rep, units] of Object.entries(NORTH)) {
    for (const u of units) rows.push(["North", rep, String(u), `"1,250.00"`]);
    rows.push(["South", rep, "1000", `"2,000.50"`]);
  }
  const p = join(dir, "sales.csv");
  writeFileSync(p, rows.map((r) => r.join(",")).join("\n") + "\n");
  return p;
}

test("toNumber coerces money-shaped text", () => {
  assert.equal(toNumber("1,250.00"), 1250);
  assert.equal(toNumber("$1,250.00"), 1250);
  assert.equal(toNumber("EUR 1.250,00"), 1250);
  assert.equal(toNumber(" 42 "), 42);
  assert.equal(toNumber("(300)"), -300);
  assert.equal(toNumber("12.5%"), 0.125);
  assert.equal(toNumber(""), null);
  assert.equal(toNumber("n/a"), null);
  assert.equal(toNumber(7), 7);
});

test("group_by + aggregate + sort by alias answers the top-5 question in one call", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mcp-sheet-query-"));
  mkdirSync(join(root, "data"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = fixture(root);
  const c = new Client({ XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "data") });
  t.after(() => c.stop());
  await c.init();

  const r = await c.call("sheet_query", {
    path: file,
    where: '[Region] = "North"',
    group_by: ["Rep"],
    aggregate: [{ col: "Units", fn: "sum", as: "total_units" }],
    sort: { col: "total_units", dir: "desc" },
    limit: 5,
    as: "json",
  });
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(JSON.parse(r.text), [
    { Rep: "Turing", total_units: 650 },
    { Rep: "Hopper", total_units: 567 },
    { Rep: "Linus", total_units: 551 },
    { Rep: "Lovelace", total_units: 486 },
    { Rep: "Liskov", total_units: 290 },
  ]);

  // several aggregates at once, including a row count and text-money sums
  const multi = await c.call("sheet_query", {
    path: file,
    where: '[Region] = "North"',
    group_by: ["Rep"],
    aggregate: [
      { col: "*", fn: "count", as: "orders" },
      { col: "Units", fn: "avg", as: "avg_units" },
      { col: "Units", fn: "min" },
      { col: "Units", fn: "max" },
      { col: "Revenue", fn: "sum", as: "revenue" },
    ],
    sort: { col: "Rep" },
    as: "json",
  });
  const byRep = Object.fromEntries(JSON.parse(multi.text).map((x) => [x.Rep, x]));
  assert.equal(byRep.Turing.orders, 2);
  assert.equal(byRep.Turing.avg_units, 325);
  assert.equal(byRep.Turing.min_Units, 250);
  assert.equal(byRep.Turing.max_Units, 400);
  assert.equal(byRep.Turing.revenue, 2500, "1,250.00 text must coerce to a number");
  assert.equal(byRep.Knuth.orders, 1);

  // group_by with no aggregate defaults to a row count, two group columns work
  const counts = await c.call("sheet_query", { path: file, group_by: ["Region", "Rep"], sort: { col: "count", dir: "desc" }, limit: 1, as: "json" });
  const top = JSON.parse(counts.text)[0];
  assert.equal(top.Region, "North");
  assert.equal(top.count, 2);

  // table output states groups vs rows
  const tbl = await c.call("sheet_query", { path: file, where: '[Region] = "North"', group_by: ["Rep"], aggregate: [{ col: "Units", fn: "sum", as: "total_units" }] });
  assert.match(tbl.text, /6 groups from 9 of 15 rows/);
  assert.match(tbl.text, /total_units/);

  // a bad aggregate column is a clear error, not a crash
  const bad = await c.call("sheet_query", { path: file, group_by: ["Nope"], aggregate: [{ col: "Units", fn: "sum" }] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /not found/);

  // sorting by an alias that does not exist names the available columns
  const badSort = await c.call("sheet_query", { path: file, group_by: ["Rep"], sort: { col: "total_units" } });
  assert.equal(badSort.isError, true);
  assert.match(badSort.text, /sort column "total_units" not found/);
});

// D-10: the result echoes the query that was actually run, so an unrequested filter is visible.
test("D-10: sheet_query echoes where, group_by, aggregate, sort and limit in the first line", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "mcp-sheet-echo-"));
  mkdirSync(join(root, "data"), { recursive: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = fixture(root);
  const c = new Client({ XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "data") });
  t.after(() => c.stop());
  await c.init();

  const narrowed = await c.call("sheet_query", {
    path: file,
    where: '[Region] = "North" AND [Rep] = "Turing"',
    group_by: ["Rep"],
    aggregate: [{ col: "Units", fn: "sum", as: "total_units" }],
    sort: { col: "total_units", dir: "desc" },
    limit: 5,
  });
  assert.equal(narrowed.isError, false, narrowed.text);
  assert.equal(
    narrowed.text.split("\n")[0],
    'Query: where [Region] = "North" AND [Rep] = "Turing"; group by Rep; sum Units as total_units; sort total_units desc; limit 5',
  );
  assert.match(narrowed.text.split("\n")[1], /1 groups from 2 of 15 rows/);

  // a plain filter with no grouping still states the filter
  const plain = await c.call("sheet_query", { path: file, where: '[Region] = "South"' });
  assert.equal(plain.text.split("\n")[0], 'Query: where [Region] = "South"');
  assert.match(plain.text.split("\n")[1], /6 of 15 rows match/);

  // an unfiltered read has no query line
  const all = await c.call("sheet_query", { path: file });
  assert.match(all.text.split("\n")[0], /^15 of 15 rows match/);
});
