// Round 27, docs/USER_VALUE_R27.md.
//
// D-R95: a hand-written shared business profile that used `vat_rate` (an alias
// `business_set` accepts, but `getBusiness` used to map only the exact key
// `default_tax_rate`) silently lost the VAT rate: an invoice came back at 0% tax with
// nothing in the response saying a rate had been dropped.
//
// D-R96: `invoice_get` and the balance `invoice_mark_paid` reports had no idea a credit
// note existed against an invoice in the billing-docs store, while
// `statement-of-account` already nets credit notes correctly. This mirrors that netting
// with a read-only, best-effort peek at billing-docs' `credit-notes.json`.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function client(home, env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), MCP_LICENSE_KEY: "", ...env },
  });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const r = pending.get(m.id);
      if (r) { pending.delete(m.id); r(m); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 15000);
    t.unref();
  });
  return {
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r27", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (!r.result) return { text: JSON.stringify(r.error), isError: true };
      return { text: r.result.content.map((x) => x.text).join("\n"), isError: r.result.isError === true };
    },
    close() { child.kill(); },
  };
}

test("D-R95: a hand-written profile using vat_rate instead of default_tax_rate still carries the rate", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-invoice-r27-"));
  try {
    // Hand-write the shared profile the way something other than business_set might:
    // vat_rate instead of the canonical default_tax_rate.
    const profileDir = join(home, "data", "mcp-servers", "profile");
    mkdirSync(profileDir, { recursive: true });
    writeFileSync(join(profileDir, "business.json"), JSON.stringify({
      name: "Lucky Strike Software", default_currency: "EUR", vat_rate: 23,
    }));

    const c = client(home);
    await c.init();
    try {
      const r = await c.call("invoice_create", {
        client: "Nova Labs",
        items: [{ description: "Consulting", quantity: 1, unit_price: 900 }],
      });
      assert.ok(!r.isError, r.text);
      assert.match(r.text, /"tax_rate": "23%"/, `expected the 23% rate from vat_rate to survive: ${r.text}`);
      assert.match(r.text, /"total": "EUR 1107\.00"/, `900 + 23% VAT should be EUR 1107.00: ${r.text}`);
    } finally { c.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("D-R96: invoice_get and invoice_mark_paid net a credit note from the billing-docs store", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-invoice-r27b-"));
  try {
    const c = client(home);
    await c.init();
    let number;
    try {
      const biz = await c.call("business_set", { name: "Lucky Strike Software", default_currency: "EUR" });
      assert.ok(!biz.isError, biz.text);
      const created = await c.call("invoice_create", {
        client: "Nova Labs",
        items: [{ description: "Consulting", quantity: 1, unit_price: 1107, tax_rate: 0 }],
      });
      assert.ok(!created.isError, created.text);
      number = created.text.match(/(INV-\d{4}-\d{4})/)[1];

      // No credit note yet: invoice_get shows no credited field, open == total.
      const before = await c.call("invoice_get", { number });
      assert.ok(!before.isError, before.text);
      const beforeJson = JSON.parse(before.text);
      assert.equal(beforeJson.credited_minor, 0);
      assert.equal(beforeJson.open_minor, 110700);
    } finally { c.close(); }

    // Plant a credit note directly in billing-docs' own data directory, in the same
    // shape @theluckystrike/mcp-billing-docs/src/store.ts writes (CN-2026-0001 against
    // this invoice, EUR 500.00, stored NEGATIVE the way a credit note's totals are).
    const billingDocsDir = join(home, "data", "mcp-servers", "billing-docs");
    mkdirSync(billingDocsDir, { recursive: true });
    writeFileSync(join(billingDocsDir, "credit-notes.json"), JSON.stringify([{
      id: "CN-2026-0001", invoice_number: number, invoice_total_minor: 110700,
      invoice_issue_date: "2026-09-01", basis: "amount", client: { name: "Nova Labs" },
      issue_date: "2026-09-02", currency: "EUR", decimals: 2, lines: [],
      subtotal_minor: -50000, discount_percent: 0, discount_minor: 0, net_minor: -50000,
      tax_lines: [], tax_minor: 0, total_minor: -50000, reason: "Goodwill", created: new Date().toISOString(),
      branded: true,
    }]));

    const c2 = client(home);
    await c2.init();
    try {
      const after = await c2.call("invoice_get", { number });
      assert.ok(!after.isError, after.text);
      const afterJson = JSON.parse(after.text);
      assert.equal(afterJson.credited_minor, 50000, "CN-2026-0001 credits EUR 500.00");
      assert.equal(afterJson.open_minor, 60700, "EUR 1,107.00 - EUR 500.00 credited = EUR 607.00 open");
      assert.match(after.text, /"credited": "EUR 500\.00"/, after.text);

      const list = await c2.call("invoice_list", {});
      assert.ok(!list.isError, list.text);
      assert.match(list.text, /"credited": "EUR 500\.00"/, list.text);
      assert.match(list.text, /"balance_due": "EUR 607\.00"/, list.text);

      // paid_minor alone (60700 of 110700) still reads as "partial" - a credit note is
      // not a payment, status is untouched - but the balance shown nets the credit:
      // 1,107.00 - 607.00 paid - 500.00 credited = 0 open, so no "balance due" is shown.
      const paid = await c2.call("invoice_mark_paid", { number, amount: 607 });
      assert.ok(!paid.isError, paid.text);
      assert.match(paid.text, /marked partial/, paid.text);
      assert.match(paid.text, /credited EUR 500\.00/, paid.text);
      assert.doesNotMatch(paid.text, /balance due/, "607.00 paid + 500.00 credited clears the invoice entirely");
    } finally { c2.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
