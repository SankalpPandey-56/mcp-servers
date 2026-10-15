// D-R14: invoice_create must not bill a EUR line under a USD heading.
// D-R15: "today" is the LOCAL calendar date in invoice, expense-tracker and time-tracker.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const SERVERS = join(here, "..", "..");

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-invoice-r5-"));
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

async function ready(t) {
  const c = client();
  t.after(() => c.close());
  await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r5", version: "0" } });
  return c;
}

test("D-R14: items that mix currencies are refused with the conversion argument", async (t) => {
  const c = await ready(t);
  const r = await c.call("invoice_create", {
    client: "Nova", currency: "USD",
    items: [
      { description: "Consulting", quantity: 6.5, unit_price: 85, tax_rate: 0, currency: "USD" },
      { description: "Train ticket", quantity: 1, unit_price: 12.4, tax_rate: 0, currency: "EUR" },
    ],
  });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /mix currencies \(USD, EUR\)/);
  assert.match(r.text, /expense_to_invoice/);
  assert.match(r.text, /target_currency/);
  assert.match(r.text, /fx_rates/);
  // Nothing was issued: the invoice number was not burned.
  const list = await c.call("invoice_list", {});
  assert.match(list.text, /No invoices match/);
});

test("D-R14: a single item currency that disagrees with the invoice currency is refused", async (t) => {
  const c = await ready(t);
  const r = await c.call("invoice_create", {
    client: "Nova", currency: "USD",
    items: [{ description: "Train ticket", quantity: 1, unit_price: 12.4, tax_rate: 0, currency: "EUR" }],
  });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /items are in EUR but the invoice currency is USD/);
});

test("D-R14: agreeing item currencies are accepted, and set the invoice currency when it is omitted", async (t) => {
  const c = await ready(t);
  const ok1 = await c.call("invoice_create", {
    client: "Nova", currency: "USD",
    items: [
      { description: "Consulting", quantity: 6.5, unit_price: 85, tax_rate: 0, currency: "USD" },
      { description: "Train ticket", quantity: 1, unit_price: 13.39, tax_rate: 0, currency: "usd" },
    ],
  });
  assert.equal(ok1.isError, false, ok1.text);
  assert.match(ok1.text, /"currency": "USD"/);
  const ok2 = await c.call("invoice_create", {
    client: "Nova",
    items: [{ description: "Consulting", quantity: 1, unit_price: 100, tax_rate: 0, currency: "GBP" }],
  });
  assert.equal(ok2.isError, false, ok2.text);
  assert.match(ok2.text, /"currency": "GBP"/);
});

test("D-R15: invoice, expense-tracker and time-tracker agree on today for a fixed TZ", () => {
  const script = `
    const inv = await import(${JSON.stringify(join(SERVERS, "invoice", "dist", "money.js"))});
    const exp = await import(${JSON.stringify(join(SERVERS, "expense-tracker", "dist", "money.js"))});
    const tt  = await import(${JSON.stringify(join(SERVERS, "time-tracker", "dist", "day.js"))});
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    process.stdout.write(JSON.stringify({
      invoice: inv.isoDate(),
      expense: exp.isoToday(),
      time: tt.localToday(),
      local: d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()),
      utc: d.toISOString().slice(0, 10),
    }));
  `;
  // Asia/Bangkok is UTC+7 with no DST, so between 00:00 and 07:00 local the UTC date is
  // still yesterday. That is exactly the window D-R15 was observed in.
  for (const TZ of ["Asia/Bangkok", "UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
    const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, TZ }, encoding: "utf8",
    });
    const r = JSON.parse(out);
    assert.equal(r.invoice, r.local, `invoice disagrees with the local date in ${TZ}`);
    assert.equal(r.expense, r.local, `expense-tracker disagrees with the local date in ${TZ}`);
    assert.equal(r.time, r.local, `time-tracker disagrees with the local date in ${TZ}`);
    assert.equal(r.invoice, r.expense);
    assert.equal(r.expense, r.time);
  }
});

test("D-R15: an invoice issued in a positive-offset zone carries the local date", () => {
  const script = `
    const inv = await import(${JSON.stringify(join(SERVERS, "invoice", "dist", "money.js"))});
    process.stdout.write(inv.isoDate(new Date("2026-09-02T23:36:00Z")));
  `;
  const bangkok = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: "Asia/Bangkok" }, encoding: "utf8" });
  assert.equal(bangkok, "2026-09-03");
  const utc = execFileSync(process.execPath, ["--input-type=module", "-e", script], { env: { ...process.env, TZ: "UTC" }, encoding: "utf8" });
  assert.equal(utc, "2026-09-02");
});
