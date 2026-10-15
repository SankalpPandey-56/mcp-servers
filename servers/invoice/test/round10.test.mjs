// Round-10 fix (docs/USER_VALUE_R10.md):
// D-R46 - invoice_create / invoice_from_hours: keep the D-R24 rule (unit_price_minor x
// quantity always equals the printed line gross) by default, but when a unit price
// carries more precision than the currency's minor unit, a rounding_note now says how
// far the total sits from the exact converted amount, and round_total: true switches
// the line to the other basis: round the exact total once so it matches the exact
// converted amount to the cent (unit_price is then reported, not multiplied).
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
  const home = mkdtempSync(join(tmpdir(), "mcp-invoice-r10-"));
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
  await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r10", version: "0" } });
  return c;
}

test("D-R46: computeTotals default basis still holds D-R24 and reports the exact drift", () => {
  // The R10 repro: 4 x 104.535 USD (90 EUR/h at ECB 1.1615).
  const t = computeTotals([{ description: "Consulting", quantity: 4, unit_price: 104.535, tax_rate: 23 }], "USD");
  const l = t.lines[0];
  assert.equal(l.unit_price_minor, 10454);          // rounded to the nearest cent
  assert.equal(l.gross_minor, 41816);               // 10454 x 4, the D-R24 basis
  assert.equal(l.unit_price_minor * l.quantity, l.gross_minor);
  assert.equal(l.exact_gross_minor, 41814);         // 4 x 104.535 x 100, rounded once
  assert.equal(l.round_total, false);
  assert.equal(t.rounding_drift_minor, 2);          // 41816 - 41814, USD 0.02 above exact
});

test("D-R46: round_total switches the line to the exact converted total", () => {
  const t = computeTotals([{ description: "Consulting", quantity: 4, unit_price: 104.535, tax_rate: 0, round_total: true }], "USD");
  const l = t.lines[0];
  assert.equal(l.gross_minor, 41814);               // the exact converted total, to the cent
  assert.equal(l.round_total, true);
  assert.equal(t.rounding_drift_minor, 0);          // round_total lines are excluded from drift
  assert.equal(t.total_minor, 41814);
});

test("D-R46: invoice_create names the drift in a rounding_note", async (t) => {
  const c = await ready(t);
  await c.call("business_set", { name: "Validator Ltd", default_currency: "USD", default_tax_rate: 0 });
  const r = await c.call("invoice_create", {
    client: "Nova",
    items: [{ description: "Consulting", quantity: 4, unit_price: 104.535, tax_rate: 23 }],
  });
  assert.equal(r.isError, false, r.text);
  const body = JSON.parse(firstJsonObject(r.text));
  assert.equal(body.total, "USD 514.34");           // 418.16 + 96.18 tax (23% of 418.16)
  assert.match(r.text, /rounding_note:.*USD 0\.02 above the exact/);
  assert.match(r.text, /round_total: true/);
});

test("D-R46: invoice_create with round_total on the item has no rounding_note", async (t) => {
  const c = await ready(t);
  await c.call("business_set", { name: "Validator Ltd", default_currency: "USD", default_tax_rate: 0 });
  const r = await c.call("invoice_create", {
    client: "Nova",
    items: [{ description: "Consulting", quantity: 4, unit_price: 104.535, tax_rate: 0, round_total: true }],
  });
  assert.equal(r.isError, false, r.text);
  const body = JSON.parse(firstJsonObject(r.text));
  assert.equal(body.total, "USD 418.14");
  assert.equal(/rounding_note/.test(r.text), false, r.text);
});

test("D-R46: invoice_from_hours fx conversion carries a rounding_note by default, none with round_total", async (t) => {
  const c = await ready(t);
  await c.call("business_set", { name: "Validator Ltd", default_currency: "EUR", default_tax_rate: 0 });

  const drift = await c.call("invoice_from_hours", {
    client: "Nova", hours: 4, rate: 90, currency: "EUR",
    target_currency: "USD", fx_rates: { EUR: 1.1615 },
  });
  assert.equal(drift.isError, false, drift.text);
  const driftBody = JSON.parse(firstJsonObject(drift.text));
  assert.equal(driftBody.total, "USD 418.16");
  assert.match(drift.text, /rounding_note:.*USD 0\.02 above the exact/);

  const exact = await c.call("invoice_from_hours", {
    client: "Nova", hours: 4, rate: 90, currency: "EUR",
    target_currency: "USD", fx_rates: { EUR: 1.1615 }, round_total: true,
  });
  assert.equal(exact.isError, false, exact.text);
  const exactBody = JSON.parse(firstJsonObject(exact.text));
  assert.equal(exactBody.total, "USD 418.14");      // exact 4 x 90 x 1.1615, to the cent
  assert.equal(/rounding_note/.test(exact.text), false, exact.text);
});

test("D-R46: a whole-cent unit price never drifts, round_total or not", () => {
  const a = computeTotals([{ description: "x", quantity: 3, unit_price: 90, tax_rate: 0 }], "EUR");
  const b = computeTotals([{ description: "x", quantity: 3, unit_price: 90, tax_rate: 0, round_total: true }], "EUR");
  assert.equal(a.total_minor, 27000);
  assert.equal(b.total_minor, 27000);
  assert.equal(a.rounding_drift_minor, 0);
});

test("D-R48: business_set infers a timezone from the address when none is given", async (t) => {
  const c = await ready(t);
  const r = await c.call("business_set", { name: "Lucky Strike Software", address: "1 Rynek, Warsaw", vat_id: "PL1234567890" });
  assert.equal(r.isError, false, r.text);
  const body = JSON.parse(firstJsonObject(r.text));
  assert.equal(body.timezone, "Europe/Warsaw");
  assert.equal(body.timezone_source, "inferred from address");
  assert.match(r.text, /Inferred timezone Europe\/Warsaw from "Warsaw"/);
});

test("D-R48: 'Austin, TX' infers America/Chicago", async (t) => {
  const c = await ready(t);
  const r = await c.call("business_set", { name: "Nova LLC", address: "500 Congress Ave, Austin, TX" });
  assert.equal(r.isError, false, r.text);
  const body = JSON.parse(firstJsonObject(r.text));
  assert.equal(body.timezone, "America/Chicago");
  assert.equal(body.timezone_source, "inferred from address");
});

test("D-R48: an unrecognized address infers nothing, and says so", async (t) => {
  const c = await ready(t);
  const r = await c.call("business_set", { name: "Mystery Co", address: "42 Nowhere Lane, Zzyzxville" });
  assert.equal(r.isError, false, r.text);
  const body = JSON.parse(firstJsonObject(r.text));
  assert.equal(body.timezone, undefined);
  assert.match(r.text, /Could not infer a timezone from the address/);
});

test("D-R48: an explicit timezone always wins and is never overridden by inference", async (t) => {
  const c = await ready(t);
  const r = await c.call("business_set", { name: "Lucky Strike Software", address: "1 Rynek, Warsaw", timezone: "Europe/Berlin" });
  assert.equal(r.isError, false, r.text);
  const body = JSON.parse(firstJsonObject(r.text));
  assert.equal(body.timezone, "Europe/Berlin");
  assert.equal(body.timezone_source, undefined);
});

test("D-R48: a second business_set with an address does not clobber an already-stored timezone", async (t) => {
  const c = await ready(t);
  await c.call("business_set", { name: "Lucky Strike Software", timezone: "Asia/Tokyo" });
  const r = await c.call("business_set", { name: "Lucky Strike Software", address: "1 Rynek, Warsaw" });
  assert.equal(r.isError, false, r.text);
  const body = JSON.parse(firstJsonObject(r.text));
  assert.equal(body.timezone, "Asia/Tokyo", "an address on a later call must not silently move an already-set zone");
});
