// Round-7 fixes (docs/USER_VALUE_R7.md):
// D-R24 - unit_price_minor x quantity must equal the stored line gross.
// D-R28 - invoice_from_hours converts with target_currency + fx_rates and echoes entry_ids
//         back with an instruction to close the hours in the time tracker.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { computeTotals } from "../dist/money.js";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-invoice-r7-"));
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
    const to = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method}`)); } }, 20000);
    to.unref();
  });
  return {
    send,
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

/** The response is prose around one JSON block; take the first balanced object. */
function firstJsonObject(text) {
  const start = text.indexOf("{");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error("no JSON object in: " + text);
}

async function ready(t) {
  const c = client();
  t.after(() => c.close());
  await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r7", version: "0" } });
  return c;
}

test("D-R24: the line gross is the STORED unit price times the quantity", () => {
  // The round-7 invoice: EUR 90/h converted at the ECB 2026-09-02 rate 1.1578.
  const unitPrice = 90 * 1.1578;                    // 104.202
  const t = computeTotals([{ description: "Consulting", quantity: 6, unit_price: unitPrice, tax_rate: 0 }], "USD");
  const line = t.lines[0];
  assert.equal(line.unit_price_minor, 10420);
  assert.equal(line.gross_minor, 62520);            // was 62521 before the fix
  assert.equal(line.unit_price_minor * line.quantity, line.gross_minor);
  assert.equal(t.subtotal_minor, 62520);
  assert.equal(t.total_minor, 62520);
});

test("D-R24: the identity holds for whole quantities, currencies and tax rates", () => {
  const cases = [
    { q: 6, p: 104.202, cur: "USD" },
    { q: 3, p: 33.335, cur: "EUR" },
    { q: 7, p: 12.9949, cur: "PLN" },
    { q: 12, p: 90, cur: "EUR" },
    { q: 5, p: 1234.5, cur: "JPY" },     // 0 decimals
    { q: 4, p: 10.1235, cur: "KWD" },    // 3 decimals
  ];
  for (const { q, p, cur } of cases) {
    const t = computeTotals([{ description: "x", quantity: q, unit_price: p, tax_rate: 23 }], cur);
    const l = t.lines[0];
    assert.equal(l.unit_price_minor * q, l.gross_minor, `${q} x ${p} ${cur}`);
  }
});

test("D-R28: invoice_from_hours converts with target_currency + fx_rates and the line adds up", async (t) => {
  const c = await ready(t);
  await c.call("business_set", { name: "Validator Ltd", default_currency: "EUR", default_tax_rate: 0 });
  const r = await c.call("invoice_from_hours", {
    client: "Nova", hours: 6, rate: 90, currency: "EUR",
    target_currency: "USD", fx_rates: { EUR: 1.1578 },
    tax_rate: 0, due_days: 30, entry_ids: ["e1", "e2"],
  });
  assert.equal(r.isError, false, r.text);
  const body = JSON.parse(firstJsonObject(r.text));
  assert.equal(body.currency, "USD");
  assert.equal(body.rate_currency, "EUR");
  assert.equal(body.target_currency, "USD");
  assert.equal(body.fx_rate_used, 1.1578);
  assert.equal(body.lines.length, 1);
  assert.match(body.lines[0].description, /\[converted from EUR 90\.00\/h at 1\.1578\]/);
  const row = JSON.stringify(body.lines[0]);
  assert.match(row, /104\.20/);                                // 90 x 1.1578 = 104.202
  assert.match(row, /625\.20/);                                // 104.20 x 6, not 625.21
  assert.match(r.text, /USD 625\.20/);
  assert.equal(/625\.21/.test(r.text), false, r.text);
  // D-R28: the response tells the model to close the hours, with the new number in it
  assert.deepEqual(body.entry_ids, ["e1", "e2"]);
  assert.match(r.text, /entry_mark_billed \{ids: \["e1","e2"\], invoice_number: "INV-\d{4}-0001"\}/);
});

test("D-R28: fx_rates without target_currency, and a missing rate, name the exact fix", async (t) => {
  const c = await ready(t);
  await c.call("business_set", { name: "Validator Ltd", default_currency: "EUR" });
  const noTarget = await c.call("invoice_from_hours", { client: "Nova", hours: 1, rate: 90, currency: "EUR", fx_rates: { EUR: 1.1578 } });
  assert.equal(noTarget.isError, true, noTarget.text);
  assert.match(noTarget.text, /fx_rates needs target_currency/);
  const noRate = await c.call("invoice_from_hours", { client: "Nova", hours: 1, rate: 90, currency: "EUR", target_currency: "USD" });
  assert.equal(noRate.isError, true, noRate.text);
  assert.match(noRate.text, /no rate for EUR/);
  assert.match(noRate.text, /fx_rates: \{"EUR": <rate>\}/);
});
