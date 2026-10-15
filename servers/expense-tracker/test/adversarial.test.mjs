// Regressions for the hostile-input probes in docs/EXPENSE_AUDIT.md.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// D-R15: "today" is the LOCAL calendar date in every server; a UTC slice disagrees
// with it for any run before UTC midnight in a positive-offset zone.
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const M = await import(join(here, "..", "dist", "money.js"));

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-expense-adv-"));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), MCP_LICENSE_KEY: "", ...env },
  });
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
      let msg;
      try { msg = JSON.parse(line); } catch { nonJson.push(line); continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    const to = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method} ${JSON.stringify(params)}`)); } }, 10000);
    to.unref();
  });
  return {
    home, nonJson, send,
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (r.error) return { text: r.error.message, isError: true };
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

async function init(c) {
  await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "adv", version: "0" } });
  c.send && null;
}

const today = localDay();

test("regex safety: a catastrophic pattern is refused and never runs", () => {
  assert.equal(M.isSafeRegexSource("(a+)+$"), false);
  assert.equal(M.isSafeRegexSource("(a|a)*$"), false);
  assert.equal(M.isSafeRegexSource("x".repeat(101)), false);
  assert.equal(M.isSafeRegexSource("uber|bolt"), true);
  assert.equal(M.hasRegexMetacharacters("Uber"), false);
  assert.equal(M.hasRegexMetacharacters("uber|bolt"), true);
});

test("ISO 4217: real codes accepted, made-up codes rejected", () => {
  for (const c of ["EUR", "pln", "JPY", "GBP", "USD"]) assert.equal(M.isKnownCurrency(c), true, c);
  for (const c of ["XYZ", "ABC", "EU"]) assert.equal(M.isKnownCurrency(c), false, c);
});

test("hostile inputs: bounded, refused, and stdout stays JSON-RPC", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);

  // 1 MB free text is refused at the schema, not stored.
  const big = "M".repeat(1024 * 1024);
  assert.ok((await c.call("expense_add", { amount: 10, merchant: big })).isError);

  // Negative, non-finite and unrepresentable amounts.
  assert.ok((await c.call("expense_add", { amount: -5 })).isError);
  assert.ok((await c.call("expense_add", { amount: 1e308 })).isError);
  assert.ok((await c.call("expense_add", { amount: "12.34" })).isError);
  assert.ok((await c.call("expense_add", {})).isError);

  // Made-up currency and impossible date.
  assert.match((await c.call("expense_add", { amount: 10, currency: "XYZ" })).text, /ISO 4217/);
  assert.match((await c.call("expense_add", { amount: 10, date: "2026-13-45" })).text, /real calendar date/);

  // Receipts.
  assert.match((await c.call("expense_add", { amount: 10, receipt_path: "/nope/x.pdf" })).text, /not found/);
  assert.ok((await c.call("receipt_attach", { id: "nope", path: "/etc/passwd" })).isError);

  // An evil rule is refused, and a rule matching a long merchant returns promptly.
  const evil = await c.call("category_rules", { rules: [{ match: "(a+)+$", category: "Evil" }] });
  assert.ok(evil.isError);
  assert.match(evil.text, /not a safe regular expression/);
  await c.call("category_rules", { rules: [{ match: "uber|bolt", category: "Travel" }] });
  const t0 = Date.now();
  const long = await c.call("expense_add", { amount: 1, merchant: "a".repeat(400) + "!" });
  assert.ok(Date.now() - t0 < 3000, "rule matching must not backtrack");
  assert.ok(!long.isError);
  const hit = await c.call("expense_add", { amount: 1, merchant: "Bolt" });
  assert.match(hit.text, /Travel, from a category rule/);

  // Currency change that would rescale the minor units is refused.
  const added = await c.call("expense_add", { amount: 12.34, currency: "EUR" });
  const id = added.text.match(/Saved ([0-9a-f]+)/)[1];
  assert.match((await c.call("expense_update", { id, currency: "JPY" })).text, /decimals/);
  assert.ok(!(await c.call("expense_update", { id, currency: "JPY", amount: 1200 })).isError);

  // Export to an unwritable path fails cleanly and leaves nothing behind.
  const bad = await c.call("expense_export", { from: "2020-01-01", to: "2030-01-01", format: "csv", path: "/etc/passwd" });
  assert.ok(bad.isError);
  assert.ok(!existsSync("/etc/passwd.tmp"));

  assert.deepEqual(c.nonJson, [], "stdout carried a non-JSON line");
});

test("mixed currencies rebill as separate groups, never summed", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("expense_add", { amount: 61.5, currency: "EUR", vat_rate: 23, project: "Acme", billable: true, merchant: "Media Markt" });
  await c.call("expense_add", { amount: 23, currency: "PLN", vat_rate: 23, project: "Acme", billable: true, merchant: "Bolt" });
  const r = await c.call("expense_to_invoice", { project: "Acme", from: today, to: today });
  const out = JSON.parse(r.text);
  assert.deepEqual(out.currencies.sort(), ["EUR", "PLN"]);
  assert.equal(out.line_items_per_currency.length, 2);
  const eur = out.line_items_per_currency.find((g) => g.currency === "EUR");
  assert.equal(eur.items[0].unit_price, 50);   // 61.50 gross at 23% = 50.00 net
  assert.equal(eur.items[0].tax_rate, 23);
  assert.equal(eur.total_net, "EUR 50.00");
});

test("free export cap writes no partial file", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  const home = mkdtempSync(join(tmpdir(), "mcp-expense-out-"));
  const out = join(home, "x.csv");
  for (let i = 0; i < 3; i++) await c.call("expense_add", { amount: 1, currency: "EUR" });
  const okr = await c.call("expense_export", { from: "2000-01-01", to: "2100-01-01", format: "csv", path: out });
  assert.ok(!okr.isError);
  assert.ok(existsSync(out));
  const xlsx = join(home, "y.xlsx");
  const gatedR = await c.call("expense_export", { from: "2000-01-01", to: "2100-01-01", format: "xlsx", path: xlsx });
  assert.ok(!gatedR.isError, "a limit is information, not a transport error");
  assert.equal(existsSync(xlsx), false, "no partial file on a gated export");
});

test("expense_settings: an opted-in default VAT rate splits an expense that names no rate", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  const none = JSON.parse((await c.call("expense_settings", {})).text);
  assert.equal(none.default_vat_rate, null);
  const bare = await c.call("expense_add", { amount: 61.5, currency: "EUR", merchant: "Media Markt" });
  assert.match(bare.text, /No VAT rate was given/);
  await c.call("expense_settings", { default_vat_rate: 23 });
  const split = await c.call("expense_add", { amount: 61.5, currency: "EUR", merchant: "Media Markt" });
  assert.match(split.text, /Net EUR 50\.00, VAT EUR 11\.50 at 23% \(your expense_settings default_vat_rate\)/);
  const explicit = await c.call("expense_add", { amount: 61.5, currency: "EUR", vat_rate: 0 });
  assert.match(explicit.text, /No VAT rate was given/);
  assert.ok((await c.call("expense_settings", { default_currency: "XYZ" })).isError);
});

test("markup rebill is free and keeps the tax_rate on the net line", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("expense_settings", { default_vat_rate: 23 });
  await c.call("expense_add", { amount: 61.5, currency: "EUR", project: "Acme", billable: true, merchant: "Media Markt" });
  const r = await c.call("expense_to_invoice", { project: "Acme", from: today, to: today, markup_percent: 10 });
  assert.ok(!r.isError, r.text);
  const out = JSON.parse(r.text);
  const item = out.line_items_per_currency[0].items[0];
  assert.equal(item.unit_price, 55);      // net 50.00 + 10% markup
  assert.equal(item.tax_rate, 23);        // the invoice recomputes the VAT, never on the gross
  assert.equal(out.markup_percent, 10);
  // D-R4: the preview does not touch the ledger.
  assert.equal(out.marked_rebilled, false);
});

test("D-R4: expense_to_invoice does not mark rebilled, expense_mark_rebilled does", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("expense_add", { amount: 61.5, currency: "EUR", project: "Acme", billable: true, merchant: "Media Markt", vat_rate: 23 });
  const first = JSON.parse((await c.call("expense_to_invoice", { project: "Acme", from: today, to: today })).text);
  assert.equal(first.marked_rebilled, false);
  assert.match(first.next_step, /expense_mark_rebilled/);
  // still unbilled: the same call offers it again
  const again = JSON.parse((await c.call("expense_to_invoice", { project: "Acme", from: today, to: today })).text);
  assert.equal(again.count, 1);
  // mark_rebilled is gone from the preview tool entirely: it is not in the schema and it
  // does not stamp the ledger even when a caller still sends it.
  const schema = (await c.send("tools/list", {})).result.tools.find((x) => x.name === "expense_to_invoice");
  assert.equal(schema.inputSchema.properties.mark_rebilled, undefined);
  assert.ok(schema.inputSchema.properties.assume_vat_rate);
  const legacy = JSON.parse((await c.call("expense_to_invoice", { project: "Acme", from: today, to: today, mark_rebilled: true })).text);
  assert.equal(legacy.marked_rebilled, false);
  assert.equal(JSON.parse((await c.call("expense_to_invoice", { project: "Acme", from: today, to: today })).text).count, 1);
  // a range needs the currency of the invoice that was actually issued
  assert.match((await c.call("expense_mark_rebilled", { project: "Acme", from: today, to: today, invoice_number: "INV-2026-0001" })).text, /needs currency/);
  const marked = await c.call("expense_mark_rebilled", { project: "Acme", from: today, to: today, currency: "EUR", invoice_number: "INV-2026-0001" });
  assert.ok(!marked.isError, marked.text);
  const m = JSON.parse(marked.text);
  assert.equal(m.marked, 1);
  assert.equal(m.invoice_number, "INV-2026-0001");
  const third = JSON.parse((await c.call("expense_to_invoice", { project: "Acme", from: today, to: today })).text);
  assert.equal(third.count, 0);
  assert.ok((await c.call("expense_mark_rebilled", { ids: ["nope"], invoice_number: "INV-2026-0001" })).isError);
  assert.ok((await c.call("expense_mark_rebilled", {})).isError);
  assert.ok((await c.call("expense_mark_rebilled", { ids: [m.ids[0]] })).isError, "invoice_number is required");
});

test("D-R3: an expense with no VAT rate is never emitted as a silent net line", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("expense_add", { amount: 61.5, currency: "EUR", project: "Acme", billable: true, merchant: "Media Markt" });
  const unknown = JSON.parse((await c.call("expense_to_invoice", { project: "Acme", from: today, to: today })).text);
  const u = unknown.line_items_per_currency[0].items[0];
  assert.equal(u.unit_price, 61.5);   // gross rebilled as-is
  assert.equal(u.tax_rate, 0);
  assert.match(u.description, /tax_rate: 0 \(VAT unknown, gross rebilled as-is; pass assume_vat_rate to split\)/);
  assert.equal(unknown.vat_unknown_lines, 1);
  assert.match(unknown.vat_note, /taxed twice/);
  // D-R9: a default set AFTER the expense was entered does not rewrite it retroactively.
  await c.call("expense_settings", { default_vat_rate: 23 });
  const still = JSON.parse((await c.call("expense_to_invoice", { project: "Acme", from: today, to: today })).text);
  assert.equal(still.vat_assumed_lines, 0);
  assert.equal(still.vat_unknown_lines, 1);
  assert.equal(still.line_items_per_currency[0].items[0].unit_price, 61.5);
  // only an explicit assume_vat_rate on this call splits it
  const split = JSON.parse((await c.call("expense_to_invoice", { project: "Acme", from: today, to: today, assume_vat_rate: 23 })).text);
  const s = split.line_items_per_currency[0].items[0];
  assert.equal(s.unit_price, 50);
  assert.equal(s.tax_rate, 23);
  assert.match(s.description, /\[vat assumed 23%\]/);
  assert.equal(split.vat_assumed_lines, 1);
});

test("D-R9: a stored vat_rate of 0 is a known rate, not a gap", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("expense_settings", { default_vat_rate: 23 });
  await c.call("expense_add", { amount: 123, currency: "EUR", vat_rate: 0, project: "Acme", billable: true, merchant: "Exempt Ltd" });
  const r = JSON.parse((await c.call("expense_to_invoice", { project: "Acme", from: today, to: today, assume_vat_rate: 23 })).text);
  const line = r.line_items_per_currency[0].items[0];
  assert.equal(line.tax_rate, 0);
  assert.equal(line.unit_price, 123);           // not 100 + 23% tax
  assert.equal(r.vat_assumed_lines, 0);
  assert.equal(r.vat_unknown_lines, 0);
  assert.doesNotMatch(line.description, /vat assumed/);
});

test("D-R5: an invoice line reproduces the receipt gross exactly", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  // The invoice recomputes tax from the net, so the split has to survive that round trip.
  const cases = [
    { amount: 61.5, vat_rate: 23, gross: 6150 },
    { amount: 10, vat_rate: 8, gross: 1000 },
    { amount: 0.03, vat_rate: 23, gross: 3 },
  ];
  for (const k of cases) {
    await c.call("expense_add", { ...k, currency: "EUR", project: `P${k.gross}`, billable: true, merchant: "M" });
    const r = JSON.parse((await c.call("expense_to_invoice", { project: `P${k.gross}`, from: today, to: today })).text);
    const items = r.line_items_per_currency[0].items;
    // replay the invoice server's own arithmetic: round per line, then sum
    const total = items.reduce((n, i) => {
      const net = M.roundHalfUp(i.quantity * i.unit_price * 100);
      return n + net + (i.tax_rate ? M.roundHalfUp((net * i.tax_rate) / 100) : 0);
    }, 0);
    assert.equal(total, k.gross, `${k.amount} at ${k.vat_rate}% invoiced ${total} minor, receipt is ${k.gross}`);
  }
  // 0.03 at 23% cannot be reconciled by unit_price alone, so it carries a visible adjustment
  const tiny = JSON.parse((await c.call("expense_to_invoice", { project: "P3", from: today, to: today })).text);
  assert.equal(tiny.rounding_adjustment_lines, 1);
  assert.equal(tiny.line_items_per_currency[0].items.length, 2);
  assert.match(tiny.line_items_per_currency[0].items[1].description, /rounding adjustment so the line total is the receipt gross EUR 0\.03/);
});

test("D-R6: marking a range is scoped to one currency and to unbilled billable rows", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("expense_add", { amount: 61.5, currency: "EUR", vat_rate: 23, project: "Acme", billable: true, merchant: "Media Markt" });
  await c.call("expense_add", { amount: 23, currency: "PLN", vat_rate: 23, project: "Acme", billable: true, merchant: "Bolt" });
  await c.call("expense_add", { amount: 9, currency: "EUR", vat_rate: 23, project: "Acme", billable: false, merchant: "Private" });
  const prev = JSON.parse((await c.call("expense_to_invoice", { project: "Acme", from: today, to: today })).text);
  const eur = prev.line_items_per_currency.find((g) => g.currency === "EUR");
  assert.equal(eur.expense_ids.length, 1);
  const m = JSON.parse((await c.call("expense_mark_rebilled", { project: "Acme", from: today, to: today, currency: "EUR", invoice_number: "INV-1" })).text);
  assert.equal(m.marked, 1);
  assert.deepEqual(m.ids, eur.expense_ids);
  // the PLN group is untouched and still offered
  const after = JSON.parse((await c.call("expense_to_invoice", { project: "Acme", from: today, to: today })).text);
  assert.deepEqual(after.currencies, ["PLN"]);
});

test("D-R7: money fields cannot be edited on a rebilled expense without unlinking it", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("expense_add", { amount: 100, currency: "EUR", vat_rate: 23, project: "Acme", billable: true, merchant: "M" });
  const list = JSON.parse((await c.call("expense_list", { from: today, to: today })).text);
  const eid = list.expenses[0].id;
  await c.call("expense_mark_rebilled", { ids: [eid], invoice_number: "INV-1" });
  const blocked = await c.call("expense_update", { id: eid, amount: 200 });
  assert.ok(blocked.isError);
  assert.match(blocked.text, /was rebilled on INV-1/);
  assert.ok((await c.call("expense_update", { id: eid, vat_rate: 8 })).isError);
  assert.ok((await c.call("expense_update", { id: eid, currency: "PLN", amount: 200 })).isError);
  // a non-money field is still editable
  assert.ok(!(await c.call("expense_update", { id: eid, note: "corrected description" })).isError);
  // unlink_rebill clears BOTH rebill fields, so the next rebill cannot inherit INV-1
  const un = await c.call("expense_update", { id: eid, amount: 200, unlink_rebill: true });
  assert.ok(!un.isError, un.text);
  const after = JSON.parse((await c.call("expense_list", { from: today, to: today })).text).expenses[0];
  assert.equal(after.rebilled_at ?? null, null);
  assert.equal(after.rebilled_invoice ?? null, null);
});

test("D-R10: a category named __proto__ or constructor is counted, not dropped", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("expense_add", { amount: 10, currency: "EUR", category: "__proto__", merchant: "A" });
  await c.call("expense_add", { amount: 20, currency: "EUR", category: "constructor", merchant: "B" });
  await c.call("expense_add", { amount: 30, currency: "EUR", category: "office", merchant: "C" });
  const r = JSON.parse((await c.call("expense_summary", { from: today, to: today, group_by: "category" })).text);
  const eur = r.by_currency.find((g) => g.currency === "EUR");
  assert.equal(eur.count, 3);
  assert.equal(eur.total_gross, "EUR 60.00");
  assert.deepEqual(eur.groups.map((g) => g.key).sort(), ["__proto__", "constructor", "office"]);
  assert.equal(eur.groups.find((g) => g.key === "__proto__").gross, "EUR 10.00");
  assert.equal(eur.groups.find((g) => g.key === "constructor").gross, "EUR 20.00");
  assert.equal({}.rebilled_invoice, undefined);   // nothing was written through a prototype
});

test("D-R8: mileage currency is only accepted with your own rate", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  const relabel = await c.call("mileage_add", { km: 100, region: "PL", currency: "EUR", purpose: "client" });
  assert.ok(relabel.isError);
  assert.match(relabel.text, /currency is only accepted together with rate_per_km/);
  const table = await c.call("mileage_add", { km: 100, region: "PL", purpose: "client" });
  assert.ok(!table.isError, table.text);
  assert.match(table.text, /PLN 115\.00/);
  assert.match(table.text, /table rate PL 1\.15 PLN\/km, an approximation; pass rate_per_km for your exact scheme/);
  const own = await c.call("mileage_add", { km: 100, region: "PL", rate_per_km: 0.25, currency: "EUR", purpose: "client" });
  assert.ok(!own.isError, own.text);
  assert.match(own.text, /EUR 25\.00/);
  assert.match(own.text, /your rate_per_km/);
});

test("D-R3: expense_add accepts tax_rate and vat as aliases for vat_rate", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  const a = await c.call("expense_add", { amount: 61.5, currency: "EUR", tax_rate: 23, merchant: "A" });
  assert.match(a.text, /Net EUR 50\.00, VAT EUR 11\.50 at 23%/);
  const b = await c.call("expense_add", { amount: 61.5, currency: "EUR", vat: 23, merchant: "B" });
  assert.match(b.text, /Net EUR 50\.00, VAT EUR 11\.50 at 23%/);
});
