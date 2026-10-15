/**
 * Adversarial probes for mcp-recurring (docs/RECURRING_AUDIT.md, part 1).
 *
 * Each test pins a defect found by probing the built server over stdio, or a guard added
 * because of one. Nothing here touches the network and every run gets a fresh
 * XDG_DATA_HOME, so the invoice number series starts at 0001 in every case.
 */
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function rpc(env) {
  const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  const nonJson = [];
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { nonJson.push(line); continue; }
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method}`)); } }, 60000);
    t.unref();
  });
  return {
    nonJson, send,
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

function box(extra = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-recurring-adv-"));
  const c = rpc({
    ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"),
    MCP_LICENSE_KEY: "", ...extra,
  });
  c.home = home;
  c.data = join(home, "data");
  return c;
}

async function init(c) {
  const r = await c.send("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "adv", version: "0" },
  });
  assert.equal(r.result?.serverInfo?.name, "mcp-recurring");
  c.notify = undefined;
  return r.result;
}

const ITEM = [{ description: "Retainer", quantity: 1, unit_price: 10 }];
const base = (extra = {}) => ({ client: "Probe", items: ITEM, every: "monthly", start_date: "2026-08-01", ...extra });

test("bad arguments are refused, never stored", async (t) => {
  const c = box();
  await init(c);
  t.after(() => c.close());

  // Missing required arguments and wrong types stop at the schema.
  for (const [args, needle] of [
    [{}, "Required at client"],
    [{ ...base(), items: "nope" }, "Expected array, received string"],
    [{ ...base(), every: { days: 0 } }, "greater than or equal to 1"],
    [{ ...base(), every: { days: 100000 } }, "less than or equal to 3650"],
    [{ ...base(), items: [{ description: "x", quantity: 1, unit_price: 1e308 }] }, "unit_price is out of range"],
    [{ ...base(), items: Array.from({ length: 1000 }, (_, i) => ({ description: `l${i}`, quantity: 1, unit_price: 1 })) }, "at most 200 line items"],
  ]) {
    const r = await c.call("schedule_create", args);
    assert.ok(r.isError, `expected an error for ${JSON.stringify(args).slice(0, 80)}`);
    assert.match(r.text, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  // Dates are checked as real calendar dates, not just as strings.
  for (const [args, needle] of [
    [base({ start_date: "2026-13-45" }), "start_date must be a real calendar date"],
    [base({ start_date: "1900" }), "start_date must be a real calendar date"],
    [base({ start_date: "2100" }), "start_date must be a real calendar date"],
    [base({ end_date: "2025-01-01" }), "end_date 2025-01-01 is before start_date"],
  ]) {
    const r = await c.call("schedule_create", args);
    assert.ok(r.isError, `expected an error for ${JSON.stringify(args).slice(0, 80)}`);
    assert.ok(r.text.includes(needle), `got: ${r.text.slice(0, 200)}`);
  }

  // A four-digit year IS a valid start date once written in full.
  assert.equal((await c.call("schedule_create", base({ start_date: "2100-01-01" }))).isError, false);
  assert.equal((await c.call("schedule_create", base({ start_date: "1900-01-01" }))).isError, false);
});

test("an unknown currency code is refused before it can reach a PDF", async (t) => {
  const c = box();
  await init(c);
  t.after(() => c.close());
  const r = await c.call("schedule_create", base({ currency: "XYZ" }));
  assert.ok(r.isError);
  assert.match(r.text, /not an ISO 4217 currency code/);

  assert.equal((await c.call("schedule_create", base({ currency: "pln" }))).isError, false);
  const u = await c.call("schedule_update", { id: "Probe", currency: "ZZZ" });
  assert.ok(u.isError);
  assert.match(u.text, /not an ISO 4217 currency code/);
});

test("one run is capped, so a mistyped as_of cannot bill a century", async (t) => {
  const c = box();
  await init(c);
  t.after(() => c.close());
  await c.call("schedule_create", base({ client: "Century", start_date: "2026-01-01" }));

  const dry = await c.call("invoice_generate_due", { as_of: "2126-01-01", dry_run: true });
  const d = JSON.parse(dry.text);
  assert.equal(d.would_create.length, 60);
  assert.ok(d.still_due_after_this_run > 1100, `remaining was ${d.still_due_after_this_run}`);
  assert.match(d.note, /at most 60 invoices/);
  assert.equal(existsSync(join(c.data, "mcp-servers", "invoice", "invoices.json")), false);

  const run = await c.call("invoice_generate_due", { as_of: "2126-01-01" });
  assert.match(run.text, /created 60 invoices/);
  assert.match(run.text, /still due; call invoice_generate_due again/);
  const invoices = JSON.parse(readFileSync(join(c.data, "mcp-servers", "invoice", "invoices.json"), "utf8"));
  assert.equal(invoices.length, 60);
  assert.equal(new Set(invoices.map((i) => i.number)).size, 60);
  assert.equal(readdirSync(join(c.data, "mcp-servers", "invoice", "pdf")).length, 60);
  // Oldest first, and the run continues where it stopped.
  assert.equal(invoices[0].issue_date, "2026-01-01");
  const next = await c.call("invoice_generate_due", { as_of: "2126-01-01" });
  assert.match(next.text, /created 60 invoices, skipped 60 already invoiced/);
});

test("as_of before the start date, and a paused schedule, generate nothing", async (t) => {
  const c = box();
  await init(c);
  t.after(() => c.close());
  await c.call("schedule_create", base({ client: "Quiet" }));

  const past = await c.call("invoice_generate_due", { as_of: "2020-01-01" });
  assert.match(past.text, /created 0 invoices, skipped 0/);
  assert.equal(existsSync(join(c.data, "mcp-servers", "invoice", "invoices.json")), false);

  await c.call("schedule_pause", { id: "Quiet" });
  const paused = await c.call("invoice_generate_due", { as_of: "2026-12-31" });
  assert.match(paused.text, /created 0 invoices/);
  assert.equal(existsSync(join(c.data, "mcp-servers", "invoice", "invoices.json")), false);
});

test("deleting a schedule stops generation and re-creating it warns instead of silently double-billing", async (t) => {
  const c = box();
  await init(c);
  t.after(() => c.close());
  await c.call("schedule_create", base({ client: "Gone", start_date: "2026-08-01" }));
  const first = await c.call("invoice_generate_due", { as_of: "2026-09-03" });
  assert.match(first.text, /created 2 invoices/);

  const del = await c.call("schedule_delete", { id: "Gone" });
  assert.match(del.text, /history rows are kept/);
  assert.match((await c.call("invoice_generate_due", { as_of: "2026-09-03" })).text, /created 0 invoices/);

  await c.call("schedule_create", base({ client: "Gone", start_date: "2026-08-01" }));
  const again = await c.call("invoice_generate_due", { as_of: "2026-09-03" });
  assert.match(again.text, /Warning: 2 of these repeat a period another schedule for the same client already invoiced/);
});

test("a corrupt history file is quarantined and never re-bills", async (t) => {
  const c = box();
  await init(c);
  t.after(() => c.close());
  await c.call("schedule_create", base({ client: "Corrupt", start_date: "2026-08-01" }));
  assert.match((await c.call("invoice_generate_due", { as_of: "2026-09-03" })).text, /created 2 invoices/);

  const hist = join(c.data, "mcp-servers", "recurring", "history.json");
  writeFileSync(hist, "{{{ not json");
  for (const args of [{}, { dry_run: true }]) {
    const r = await c.call("invoice_generate_due", args);
    assert.ok(r.isError, `expected the corrupt marker to block ${JSON.stringify(args)}`);
    assert.match(r.text, /data file is corrupt; moved to/);
  }
  const invoices = JSON.parse(readFileSync(join(c.data, "mcp-servers", "invoice", "invoices.json"), "utf8"));
  assert.equal(invoices.length, 2, "a corrupt history must never re-bill");
  assert.ok(existsSync(`${hist}.corrupt`));
});

test("a corrupt schedules file blocks every tool that reads it", async (t) => {
  const c = box();
  await init(c);
  t.after(() => c.close());
  await c.call("schedule_create", base({ client: "Corrupt" }));
  writeFileSync(join(c.data, "mcp-servers", "recurring", "schedules.json"), "[[[bad");
  for (const name of ["schedule_list", "schedule_create", "invoice_generate_due", "forecast", "schedule_upcoming"]) {
    const r = await c.call(name, name === "schedule_create" ? base() : {});
    assert.ok(r.isError, `${name} should refuse a corrupt store`);
    assert.match(r.text, /data file is corrupt/);
  }
});

test("a missing business profile generates with a named placeholder issuer", async (t) => {
  const c = box();
  await init(c);
  t.after(() => c.close());
  await c.call("schedule_create", base({ client: "NoBiz", start_date: "2026-09-01" }));
  const r = await c.call("invoice_generate_due", { as_of: "2026-09-03" });
  assert.equal(r.isError, false);
  assert.match(r.text, /No business profile yet: generated PDFs show a placeholder issuer/);
  const pdfDir = join(c.data, "mcp-servers", "invoice", "pdf");
  const pdf = readFileSync(join(pdfDir, readdirSync(pdfDir)[0]), "latin1");
  assert.ok(pdf.startsWith("%PDF-"));
  assert.ok(pdf.includes("(Your business)"), "the placeholder issuer must be printed, not an empty name");
});

test("stdout carries JSON-RPC only, and src makes no network call", async (t) => {
  const c = box();
  await init(c);
  t.after(() => c.close());
  await c.call("schedule_create", base());
  await c.call("invoice_generate_due", { as_of: "2026-09-03" });
  await c.call("schedule_list", {});
  await c.call("forecast", {});
  assert.deepEqual(c.nonJson, []);

  const src = readdirSync(join(here, "..", "src"))
    .map((f) => readFileSync(join(here, "..", "src", f), "utf8")).join("\n");
  assert.equal(/\bfetch\s*\(|https?:\/\/[a-z]|node:http|node:net|node:dns/.test(src.replace(/https:\/\/mcp\.zovo\.one[^\s"']*/g, "")), false,
    "src must not reach the network");
  assert.equal(/console\.(log|info|warn)\s*\(/.test(src), false, "nothing may write to stdout but the transport");
});

test("what is due includes the periods that already fell due and were never invoiced", async (t) => {
  const c = box();
  await init(c);
  t.after(() => c.close());
  await c.call("schedule_create", base({ client: "Backlog", start_date: "2026-01-31" }));
  const u = JSON.parse((await c.call("schedule_upcoming", {})).text);
  assert.ok(u.past_due_not_yet_invoiced, "a past-due unbilled period must be reported");
  assert.ok(u.past_due_not_yet_invoiced.count >= 1);
  assert.equal(u.past_due_not_yet_invoiced.periods[0].period, "2026-01-31");
  assert.match(u.past_due_not_yet_invoiced.hint, /invoice_generate_due/);
});

test("schedule_skip closes one period for good and leaves the rest billing", async (t) => {
  const c = box();
  await init(c);
  t.after(() => c.close());
  await c.call("schedule_create", base({ client: "Acme", start_date: "2026-08-31" }));

  const bad = await c.call("schedule_skip", { id: "Acme", period: "2026-10-15" });
  assert.ok(bad.isError);
  assert.match(bad.text, /is not an occurrence of/);

  const ok1 = await c.call("schedule_skip", { id: "Acme", period: "2026-10-31" });
  assert.equal(ok1.isError, false);
  assert.match(ok1.text, /Skipped Acme 2026-10-31/);

  const r = await c.call("invoice_generate_due", { as_of: "2026-12-01" });
  assert.match(r.text, /skipped 1 already invoiced/);
  const numbers = JSON.parse(readFileSync(join(c.data, "mcp-servers", "invoice", "invoices.json"), "utf8"))
    .map((i) => i.issue_date).sort();
  assert.deepEqual(numbers, ["2026-08-31", "2026-09-30", "2026-11-30"], "October must not be billed, the others must");

  // A billed period cannot be skipped after the fact, and undo restores a skipped one.
  const late = await c.call("schedule_skip", { id: "Acme", period: "2026-08-31" });
  assert.ok(late.isError);
  assert.match(late.text, /was already invoiced as INV-2026-0001/);
  assert.equal((await c.call("schedule_skip", { id: "Acme", period: "2026-10-31", undo: true })).isError, false);
  assert.match((await c.call("invoice_generate_due", { as_of: "2026-12-01" })).text, /created 1 invoice/);
});

test("a paused schedule is still visible in the forecast instead of reading as zero", async (t) => {
  const c = box();
  await init(c);
  t.after(() => c.close());
  await c.call("schedule_create", { client: "Acme", items: [{ description: "Hours", quantity: 12, unit_price: 90 }], every: "monthly", start_date: "2026-08-31" });
  await c.call("schedule_pause", { id: "Acme" });
  const f = JSON.parse((await c.call("forecast", { months: 3 })).text);
  assert.deepEqual(f.per_month, []);
  assert.ok(f.paused_not_included, "a paused schedule must not silently disappear from the forecast");
  assert.equal(f.paused_not_included.schedules[0].client, "Acme");
  assert.match(f.paused_not_included.hint, /schedule_skip/);
});

test("a skipped period leaves the forecast and the upcoming list", async (t) => {
  const c = box();
  await init(c);
  t.after(() => c.close());
  await c.call("schedule_create", { client: "Acme", items: [{ description: "Hours", quantity: 12, unit_price: 90 }], every: "monthly", start_date: "2026-08-31" });
  const before = JSON.parse((await c.call("forecast", { months: 3 })).text);
  const months = before.per_month.map((m) => m.month);
  await c.call("schedule_skip", { id: "Acme", period: months[1] === "2026-10" ? "2026-10-31" : `${months[1]}-30` });
  const after = JSON.parse((await c.call("forecast", { months: 3 })).text);
  assert.equal(after.per_month.length, before.per_month.length - 1, "the skipped month must leave the forecast");
  assert.ok(after.excluded_already_invoiced_or_skipped, "and be reported as excluded, not silently dropped");
});
