// Adversarial input, docs/BANK_AUDIT.md part 1. Each test is one probe that changed the code.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const { readStatement } = await import(join(here, "..", "dist", "detect.js"));

function fixtureDir() { return mkdtempSync(join(tmpdir(), "bs-adv-")); }

/* ------------------------------------------------------------------ the reader */

test("a trailing minus is a debit, not income", () => {
  const csv = [
    "Date,Description,Amount,Currency",
    "2026-08-01,trailing minus,12.50-,EUR",
    "2026-08-02,trailing minus grouped,\"1.234,56-\",EUR",
    "2026-08-03,parens,(12.50),EUR",
    "2026-08-04,plain minus,-5.00,EUR",
    "2026-08-05,plain plus,7.00,EUR",
  ].join("\n");
  const r = readStatement(csv);
  assert.deepEqual(r.rows.map((x) => x.amount_minor), [-1250, -123456, -1250, -500, 700]);
});

test("a lone dash and an empty amount are skipped, not read as zero", () => {
  const csv = ["Date,Description,Amount,Currency", "2026-08-01,dash,-,EUR", "2026-08-02,empty,,EUR", "2026-08-03,real,-1.00,EUR"].join("\n");
  const r = readStatement(csv);
  assert.equal(r.rows.length, 1);
  assert.equal(r.skipped.length, 2);
  assert.deepEqual(r.skipped.map((s) => s.line), [2, 3]);
});

test("CR-only line endings, quoted commas and embedded newlines survive", () => {
  const csv = "Date,Description,Amount\r2026-08-01,\"ACME, Inc.\nInvoice 7\",-10.00\r2026-08-02,\"say \"\"hi\"\", ok\",-2.00\r";
  const r = readStatement(csv);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0].description, "ACME, Inc. Invoice 7");
  assert.equal(r.rows[1].description, 'say "hi", ok');
});

test("an ambiguous date column says which order it assumed", () => {
  const amb = readStatement("Date,Description,Amount\n03/04/2026,x,-1.00\n05/06/2026,y,-2.00\n");
  assert.equal(amb.date_order, "dmy");
  assert.equal(amb.date_order_inferred, true, "no value above 12 in either position: a guess was actually made");
  assert.ok(amb.notes.some((n) => n.includes("ambiguous")), amb.notes.join(" | "));
  assert.equal(amb.rows[0].date, "2026-04-03");
  const day = readStatement("Date,Description,Amount\n13/04/2026,x,-1.00\n05/06/2026,y,-2.00\n");
  assert.equal(day.date_order_inferred, false, "13 in the day position settles the column: certain, not a guess");
  assert.equal(day.rows[0].date, "2026-04-13");
});

test("mixed currencies inside one file are kept per row", () => {
  const r = readStatement("Date,Description,Amount,Currency\n2026-08-01,a,-10.00,EUR\n2026-08-02,b,-20.00,PLN\n2026-08-03,c,-30,JPY\n");
  assert.deepEqual(r.rows.map((x) => [x.currency, x.amount_minor]), [["EUR", -1000], ["PLN", -2000], ["JPY", -30]]);
});

test("a file with no header row is refused by name, a header-only file imports nothing", () => {
  assert.throws(() => readStatement("2026-08-01,Spotify,-9.99\n"), /no header row was found/);
  const r = readStatement("Date,Description,Amount,Currency\n");
  assert.equal(r.rows.length, 0);
  assert.equal(r.header_line, 1);
});

/* -------------------------------------------------------------------- the server */

function client(env) {
  const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MCP_LICENSE_KEY: "", ...env } });
  let buf = "";
  const waiters = new Map();
  const nonJson = [];
  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { nonJson.push(line); continue; }
      const w = waiters.get(msg.id);
      if (w) { waiters.delete(msg.id); w(msg); }
    }
  });
  child.stderr.resume();
  let id = 0;
  const send = (method, params) => new Promise((res) => { const n = ++id; waiters.set(n, res); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  return {
    nonJson,
    close: () => child.kill(),
    async start() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async call(name, args) {
      const m = await send("tools/call", { name, arguments: args });
      return m.result ?? m.error;
    },
  };
}

const textOf = (r) => r?.content?.[0]?.text ?? JSON.stringify(r);

test("a UTF-16 export imports instead of failing to find its header", async () => {
  const dir = fixtureDir();
  const csv = "Date,Description,Amount,Currency\n2026-08-01,Spotify,-9.99,EUR\n2026-08-02,Coffee,-3.50,EUR\n";
  const p = join(dir, "utf16.csv");
  writeFileSync(p, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(csv, "utf16le")]));
  const c = client({ XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "cfg") });
  await c.start();
  const out = JSON.parse(textOf(await c.call("statement_import", { path: p, account: "u16" })));
  assert.equal(out.imported, 2);
  assert.equal(out.currencies[0], "EUR");
  assert.equal(c.nonJson.length, 0);
  c.close();
});

test("a rule with an empty match is refused instead of categorising the whole ledger", async () => {
  const dir = fixtureDir();
  const p = join(dir, "s.csv");
  writeFileSync(p, "Date,Description,Amount\n2026-08-01,,-1.00\n2026-08-02,Coffee,-2.00\n");
  const c = client({ XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "cfg") });
  await c.start();
  await c.call("statement_import", { path: p, account: "e" });
  const bad = await c.call("category_rules", { rules: [{ match: "  ", category: "Everything" }] });
  assert.equal(bad.isError, true);
  assert.match(textOf(bad), /empty match/);
  const listed = JSON.parse(textOf(await c.call("category_rules", {})));
  assert.equal(listed.count, 0);
  // a real rule still works, and does not touch the row whose description is empty
  const good = JSON.parse(textOf(await c.call("category_rules", { rules: [{ match: "coffee", category: "meals" }] })));
  assert.equal(good.categorised, 1);
  c.close();
});

test("D-R52: writing rules reports the free limit and what is left, like the read path does", async () => {
  const dir = fixtureDir();
  const p = join(dir, "s.csv");
  writeFileSync(p, "Date,Description,Amount\n2026-08-01,Spotify,-9.99\n2026-08-02,Coffee,-2.00\n");
  const c = client({ XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "cfg") });
  await c.start();
  await c.call("statement_import", { path: p, account: "e" });
  const read = JSON.parse(textOf(await c.call("category_rules", {})));
  const written = JSON.parse(textOf(await c.call("category_rules", {
    rules: [{ match: "spotify", category: "Software" }, { match: "coffee", category: "Meals" }],
  })));
  assert.equal(written.rules, 2);
  assert.equal(written.categorised, 2);
  // the number the read path already reported, now on the write path too
  assert.equal(written.free_limit, read.free_limit);
  assert.equal(written.rules_remaining, read.free_limit - 2);
  c.close();
});

test("a catastrophic regex rule is refused as a regex and cannot hang the server", async () => {
  const dir = fixtureDir();
  const p = join(dir, "s.csv");
  writeFileSync(p, `Date,Description,Amount\n2026-08-01,${"a".repeat(60)}!,-1.00\n`);
  const c = client({ XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "cfg") });
  await c.start();
  const set = JSON.parse(textOf(await c.call("category_rules", { rules: [{ match: "(a+)+$", category: "Evil", regex: true }] })));
  assert.deepEqual(set.refused_as_regex, ["(a+)+$"]);
  const t0 = Date.now();
  const out = JSON.parse(textOf(await c.call("statement_import", { path: p, account: "ev" })));
  assert.equal(out.imported, 1);
  assert.ok(Date.now() - t0 < 5000, `import took ${Date.now() - t0} ms`);
  c.close();
});

test("export says when it replaced a file, and a directory that does not exist is named", async () => {
  const dir = fixtureDir();
  const p = join(dir, "s.csv");
  writeFileSync(p, "Date,Description,Amount\n2026-08-01,Coffee,-2.00\n");
  const key = process.env.BS_TEST_PRO_KEY;
  const c = client({ XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "cfg"), MCP_LICENSE_KEY: key ?? "" });
  await c.start();
  await c.call("statement_import", { path: p, account: "x" });
  const gatedOut = await c.call("statement_export", { from: "2026-08-01", to: "2026-08-31", format: "csv", path: join(dir, "out.csv") });
  if (!key) {
    // free tier: the gate answers, and never writes a partial file
    assert.equal(gatedOut.isError, undefined);
    assert.equal(existsSync(join(dir, "out.csv")), false);
    c.close();
    return;
  }
  const first = JSON.parse(textOf(gatedOut));
  assert.equal(first.overwrote_existing_file, undefined);
  const again = JSON.parse(textOf(await c.call("statement_export", { from: "2026-08-01", to: "2026-08-31", format: "csv", path: join(dir, "out.csv") })));
  assert.equal(again.overwrote_existing_file, true);
  assert.match(readFileSync(join(dir, "out.csv"), "utf8"), /^id,date,account/);
  const missing = await c.call("statement_export", { from: "2026-08-01", to: "2026-08-31", format: "csv", path: join(dir, "nope", "out.csv") });
  assert.equal(missing.isError, true);
  c.close();
});

test("two charges never produce a yearly cost", async () => {
  const dir = fixtureDir();
  const key = process.env.BS_TEST_PRO_KEY;
  if (!key) return; // recurring_detect is Pro; the free path is covered in smoke.test.mjs
  const today = new Date();
  const iso = (d) => new Date(today.getTime() - d * 86400000).toISOString().slice(0, 10);
  const csv = [
    "Date,Description,Amount,Currency",
    `${iso(45)},Adobe Systems,-61.50,EUR`,
    `${iso(31)},Adobe Systems,-61.50,EUR`,
    `${iso(62)},Spotify AB,-9.99,EUR`,
    `${iso(31)},Spotify AB,-9.99,EUR`,
    `${iso(1)},Spotify AB,-9.99,EUR`,
  ].join("\n");
  const p = join(dir, "s.csv");
  writeFileSync(p, csv);
  const c = client({ XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "cfg"), MCP_LICENSE_KEY: key });
  await c.start();
  await c.call("statement_import", { path: p, account: "r" });
  const out = JSON.parse(textOf(await c.call("recurring_detect", { months: 6 })));
  const adobe = out.charges.find((x) => x.counterparty.includes("Adobe"));
  const spotify = out.charges.find((x) => x.counterparty.includes("Spotify"));
  assert.equal(adobe.cadence_confirmed, false);
  assert.equal(adobe.annualised, null);
  assert.match(adobe.cadence_note, /the cadence is a guess/);
  assert.equal(spotify.cadence_confirmed, true);
  assert.equal(spotify.annualised, "EUR 119.88");
  c.close();
});
