// D-R14: a multi-currency unbilled set now has a path to ONE invoice.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const today = localDay();

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-expense-fx-"));
  mkdirSync(join(home, "data"), { recursive: true });
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), MCP_LICENSE_KEY: "", ...env },
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
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    const to = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method}`)); } }, 10000);
    to.unref();
  });
  return {
    send,
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (r.error) return { text: r.error.message, isError: true };
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

async function seeded(t) {
  const c = client();
  t.after(() => c.close());
  await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fx", version: "0" } });
  await c.call("expense_add", { amount: 12.4, currency: "EUR", project: "Nova", billable: true, merchant: "Rail", vat_rate: 0 });
  await c.call("expense_add", { amount: 8.39, currency: "GBP", project: "Nova", billable: true, merchant: "Mileage", vat_rate: 0 });
  return c;
}

test("D-R14: mixed currencies without fx_rates state the exact argument to pass", async (t) => {
  const c = await seeded(t);
  const r = await c.call("expense_to_invoice", { project: "Nova", from: today, to: today });
  const out = JSON.parse(r.text);
  assert.deepEqual(out.currencies.slice().sort(), ["EUR", "GBP"]);
  assert.equal(out.target_currency, null);
  assert.match(out.fx_note, /target_currency/);
  assert.match(out.fx_note, /fx_rates/);
  assert.match(out.fx_note, /expense_to_invoice \{/);
});

test("D-R14: target_currency + fx_rates return ONE converted group", async (t) => {
  const c = await seeded(t);
  const r = await c.call("expense_to_invoice", {
    project: "Nova", from: today, to: today,
    target_currency: "USD", fx_rates: { EUR: 1.08, GBP: 1.27 },
  });
  assert.equal(r.isError, false, r.text);
  const out = JSON.parse(r.text);
  assert.deepEqual(out.currencies, ["USD"]);
  assert.equal(out.line_items_per_currency.length, 1);
  const g = out.line_items_per_currency[0];
  assert.equal(g.currency, "USD");
  assert.equal(g.items.length, 2);
  assert.equal(out.converted_lines, 2);
  assert.equal(g.expense_ids.length, 2);
  const eur = g.items.find((i) => i.description.includes("Rail"));
  const gbp = g.items.find((i) => i.description.includes("Mileage"));
  assert.equal(eur.unit_price, 13.39);  // 12.40 x 1.08 = 13.392 -> 13.39
  assert.equal(gbp.unit_price, 10.66);  // 8.39 x 1.27 = 10.6553 -> 10.66
  assert.match(eur.description, /\[converted from EUR 12\.40 at 1\.08\]$/);
  assert.match(gbp.description, /\[converted from GBP 8\.39 at 1\.27\]$/);
  assert.equal(g.total_net, "USD 24.05");
  assert.deepEqual(out.fx_rates_used, { EUR: 1.08, GBP: 1.27 });
});

test("D-R14: a missing rate is refused and names the argument, and fx_rates alone is refused", async (t) => {
  const c = await seeded(t);
  const miss = await c.call("expense_to_invoice", { project: "Nova", from: today, to: today, target_currency: "USD", fx_rates: { EUR: 1.08 } });
  assert.equal(miss.isError, true);
  assert.match(miss.text, /no rate for GBP/);
  assert.match(miss.text, /"GBP": <rate>/);
  const noTarget = await c.call("expense_to_invoice", { project: "Nova", from: today, to: today, fx_rates: { EUR: 1.08 } });
  assert.equal(noTarget.isError, true);
  assert.match(noTarget.text, /needs target_currency/);
});

test("D-R14: target_currency with nothing to convert leaves the lines alone", async (t) => {
  const c = client();
  t.after(() => c.close());
  await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "fx", version: "0" } });
  await c.call("expense_add", { amount: 12.4, currency: "USD", project: "Nova", billable: true, merchant: "Rail", vat_rate: 0 });
  const r = await c.call("expense_to_invoice", { project: "Nova", from: today, to: today, target_currency: "USD" });
  assert.equal(r.isError, false, r.text);
  const out = JSON.parse(r.text);
  assert.equal(out.converted_lines, 0);
  assert.deepEqual(out.currencies, ["USD"]);
  assert.equal(out.line_items_per_currency[0].items[0].unit_price, 12.4);
  assert.doesNotMatch(out.line_items_per_currency[0].items[0].description, /converted from/);
});
