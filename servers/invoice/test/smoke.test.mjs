import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-invoice-"));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config"),
      MCP_LICENSE_KEY: "",
      ...env,
    },
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
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
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
    home, child, send,
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

async function init(c) {
  const r = await c.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  assert.ok(r.result?.serverInfo, "initialize failed");
  assert.equal(r.result.serverInfo.name, "mcp-invoice");
  c.notify("notifications/initialized", {});
  return r.result;
}

test("stdio: initialize, tools/list, full invoice lifecycle, PDF", async (t) => {
  const c = client();
  t.after(() => c.close());

  await init(c);

  const list = await c.send("tools/list", {});
  const names = list.result.tools.map((x) => x.name).sort();
  for (const n of [
    "business_set", "client_add", "client_delete", "client_list", "invoice_create", "invoice_from_hours",
    "invoice_get", "invoice_list", "invoice_mark_paid", "invoice_pdf", "overdue_report",
    "license_activate", "license_status",
  ]) assert.ok(names.includes(n), `missing tool ${n} (have ${names.join(",")})`);

  const res = await c.send("resources/list", {});
  assert.ok(res.result.resources.some((r) => r.uri === "invoices://open"), "invoices://open not registered");

  let r = await c.call("business_set", {
    name: "Lucky Strike Software", address: "ul. Testowa 1\n00-001 Warsaw", email: "support@zovo.one",
    vat_id: "PL1234567890", iban: "PL61109010140000071219812874", bank: "Test Bank",
    default_currency: "EUR", default_tax_rate: 23, payment_terms_days: 14,
  });
  assert.equal(r.isError, false);
  assert.match(r.text, /Business profile saved/);

  r = await c.call("client_add", { name: "Acme GmbH", address: "Hauptstr. 5\nBerlin", email: "ap@acme.example", vat_id: "DE999999999" });
  assert.match(r.text, /Added client Acme GmbH/);

  r = await c.call("client_list", {});
  assert.match(r.text, /Acme GmbH/);

  r = await c.call("invoice_create", {
    client: "Acme GmbH",
    items: [
      { description: "Backend development, sprint 14. A deliberately long description so the PDF table has to wrap it across more than one line.", quantity: 12, unit_price: 90 },
      { description: "Server hosting", quantity: 1, unit_price: 50, tax_rate: 8 },
    ],
    issue_date: "2026-03-02", due_days: 14, notes: "Thanks for your business.",
  });
  assert.equal(r.isError, false);
  const number = r.text.match(/INV-2026-\d{4}/)[0];
  assert.equal(number, "INV-2026-0001");
  assert.match(r.text, /EUR 1382\.40/); // 1080.00 + 50.00 + 248.40 + 4.00
  const created = JSON.parse(r.text.slice(r.text.indexOf("{"), r.text.lastIndexOf("}") + 1));
  assert.equal(created.total_minor, 108000 + 5000 + 24840 + 400);
  assert.equal(created.status, "unpaid");

  r = await c.call("invoice_get", { number });
  const inv = JSON.parse(r.text);
  assert.equal(inv.number, number);
  assert.equal(inv.tax_lines.length, 2);

  const out = join(c.home, "acme.pdf");
  r = await c.call("invoice_pdf", { number, out_path: out });
  assert.equal(r.isError, false);
  assert.ok(existsSync(out), "PDF not written");
  const head = readFileSync(out).subarray(0, 5).toString("latin1");
  assert.equal(head, "%PDF-");
  const size = statSync(out).size;
  assert.ok(size > 1024, `PDF too small: ${size} bytes`);
  assert.match(r.text, /Generated with mcp-invoice by theluckystrike/); // free-tier note

  r = await c.call("invoice_mark_paid", { number, paid_date: "2026-03-10" });
  assert.match(r.text, /marked paid/);

  r = await c.call("invoice_list", { status: "paid" });
  assert.match(r.text, new RegExp(number));
  r = await c.call("invoice_list", { status: "unpaid" });
  assert.match(r.text, /No invoices match/);

  r = await c.call("invoice_from_hours", { client: "Acme GmbH", hours: 3.5, rate: 100, issue_date: "2026-03-05" });
  assert.match(r.text, /INV-2026-0002/);

  // numbering never repeats
  const numbers = new Set();
  r = await c.call("invoice_list", {});
  for (const m of r.text.matchAll(/INV-2026-\d{4}/g)) numbers.add(m[0]);
  assert.equal(numbers.size, 2);

  // overdue_report is free (D-5 style fix, D-8): it must answer, not sell
  r = await c.call("overdue_report", {});
  assert.equal(r.isError, false);
  assert.doesNotMatch(r.text, /Pro feature/);
  assert.doesNotMatch(r.text, /mcp\.zovo\.one\/buy\/invoice/);
  const free_rep = JSON.parse(r.text);
  assert.equal(typeof free_rep.count, "number");
});

test("free tier blocks a 4th invoice in a calendar month; Pro allows it", async (t) => {
  const key = execFileSync(process.execPath,
    [join(REPO, "scripts", "sign-license.mjs"), "invoice"], { encoding: "utf8" }).trim();
  assert.match(key, /^MCPL1\./);

  const free = client();
  t.after(() => free.close());
  await init(free);
  await free.call("business_set", { name: "Solo Dev", default_currency: "EUR" });

  const mk = (c, n) => c.call("invoice_create", {
    client: "Repeat Client",
    items: [{ description: `Job ${n}`, quantity: 1, unit_price: 100 }],
    issue_date: "2026-04-10",
  });

  for (let i = 1; i <= 3; i++) {
    const r = await mk(free, i);
    assert.equal(r.isError, false);
    assert.match(r.text, /Created invoice INV-2026-000\d/);
  }
  const blocked = await mk(free, 4);
  assert.equal(blocked.isError, false, "gate must not be an error result");
  assert.match(blocked.text, /free tier allows 3 invoices per calendar month/i);
  assert.match(blocked.text, /mcp\.zovo\.one\/buy\/invoice/);
  const after = await free.call("invoice_list", {});
  assert.equal(JSON.parse(after.text).count, 3, "blocked invoice must not be stored");

  const pro = client({ MCP_LICENSE_KEY: key });
  t.after(() => pro.close());
  await init(pro);
  const st = await pro.call("license_status", {});
  assert.match(st.text, /"tier": "pro"/);
  await pro.call("business_set", { name: "Solo Dev", default_currency: "EUR", invoice_prefix: "ACME" });
  for (let i = 1; i <= 4; i++) {
    const r = await mk(pro, i);
    assert.equal(r.isError, false);
    assert.match(r.text, /Created invoice ACME-2026-000\d/, `pro invoice ${i} was blocked: ${r.text}`);
  }
  const proList = await pro.call("invoice_list", {});
  assert.equal(JSON.parse(proList.text).count, 4);

  // overdue_report is free, and identical on Pro
  const rep = await pro.call("overdue_report", { as_of: "2026-06-01" });
  assert.equal(rep.isError, false);
  const parsed = JSON.parse(rep.text);
  assert.equal(parsed.count, 4);
  assert.ok(parsed.invoices[0].days_overdue > 0);
  assert.deepEqual(parsed.totals_per_currency, ["EUR 400.00"]);

  // Pro PDF carries no branding footer
  const out = join(pro.home, "pro.pdf");
  const pr = await pro.call("invoice_pdf", { number: "ACME-2026-0001", out_path: out });
  assert.equal(pr.isError, false);
  assert.doesNotMatch(pr.text, /Generated with mcp-invoice/);
  const bytes = readFileSync(out).toString("latin1");
  assert.ok(bytes.startsWith("%PDF-"));
  assert.ok(statSync(out).size > 1024);
});

test("D-8: every money value carries its currency code, and a bare client is flagged", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("business_set", { name: "Solo Dev", default_currency: "EUR", default_tax_rate: 23 });

  // Client named but never added: created from the name alone, no address.
  const r = await c.call("invoice_create", {
    client: "Acme",
    items: [{ description: "API work", quantity: 12, unit_price: 90 }],
    issue_date: "2026-05-04",
  });
  assert.equal(r.isError, false);

  // Line amounts, not just the total, carry the code.
  assert.match(r.text, /"unit_price": "EUR 90\.00"/);
  assert.match(r.text, /"amount": "EUR 1080\.00"/);
  assert.match(r.text, /"subtotal": "EUR 1080\.00"/);
  assert.match(r.text, /"total": "EUR 1328\.40"/);
  assert.match(r.text, /"balance_due": "EUR 1328\.40"/);
  // no bare money value is printed without a code
  assert.doesNotMatch(r.text, /"(unit_price|amount|subtotal|total|balance_due)": "[0-9]/);

  // The auto-created client is named, and the fix is spelled out.
  assert.match(r.text, /BILL TO block will show only "Acme"/);
  assert.match(r.text, /created from the name alone, with no address/);
  assert.match(r.text, /client_add \{name: "Acme", address:/);

  // Once the address exists the note is gone.
  await c.call("client_add", { name: "Acme", address: "Hauptstr. 5\nBerlin" });
  const r2 = await c.call("invoice_create", {
    client: "Acme",
    items: [{ description: "API work", quantity: 1, unit_price: 10 }],
    issue_date: "2026-05-05",
  });
  assert.doesNotMatch(r2.text, /BILL TO block will show only/);

  // The PDF prints the code on the line amounts too.
  const out = join(c.home, "codes.pdf");
  const number = r.text.match(/INV-2026-\d{4}/)[0];
  const p = await c.call("invoice_pdf", { number, out_path: out });
  assert.equal(p.isError, false);
  assert.ok(statSync(out).size > 1024);
});

test("D-R2: a missing business profile never blocks an invoice, and the PDF renders", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  // No business_set at all.
  const r = await c.call("invoice_create", {
    client: "Acme",
    items: [{ description: "Design review", quantity: 2.5, unit_price: 90 }],
    issue_date: "2026-09-02",
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Created invoice INV-2026-0001/);
  assert.match(r.text, /No business profile yet: the PDF shows a placeholder issuer\. Run business_set \{name, address, vat_id, iban\} and render the PDF again\./);
  assert.match(r.text, /"total": "EUR 225\.00"/);

  const h = await c.call("invoice_from_hours", { client: "Acme", hours: 3, rate: 100, currency: "USD", issue_date: "2026-09-02" });
  assert.equal(h.isError, false, h.text);
  assert.match(h.text, /"total": "USD 300\.00"/);
  assert.match(h.text, /No business profile yet/);

  // The PDF renders with the placeholder issuer.
  const out = join(c.home, "placeholder.pdf");
  const p = await c.call("invoice_pdf", { number: "INV-2026-0001", out_path: out });
  assert.equal(p.isError, false, p.text);
  assert.equal(readFileSync(out).subarray(0, 5).toString(), "%PDF-");
  assert.ok(statSync(out).size > 1024);
  assert.match(p.text, /No business profile yet/);
  assert.match(p.text, /Wrote PDF invoice/);
  const pdf = readFileSync(out, "latin1");
  assert.ok(pdf.includes("Your business"), "the placeholder issuer is printed on the page");

  // Once the profile exists the note is gone.
  await c.call("business_set", { name: "Zovo Studio" });
  const p2 = await c.call("invoice_pdf", { number: "INV-2026-0001", out_path: out });
  assert.doesNotMatch(p2.text, /No business profile yet/);
});

test("D-R7: business_set accepts tax_rate aliases and warns about unknown keys", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  const b = await c.call("business_set", { name: "Zovo Studio", tax_rate: 23 });
  assert.equal(b.isError, false, b.text);
  assert.match(b.text, /"default_tax_rate": 23/);
  assert.match(b.text, /Read tax_rate: 23 as default_tax_rate: 23\./);

  const r = await c.call("invoice_create", {
    client: "Acme",
    items: [{ description: "Design review", quantity: 2.5, unit_price: 90 }, { description: "Expenses", quantity: 1, unit_price: 50 }],
    issue_date: "2026-09-02",
  });
  assert.match(r.text, /"total": "EUR 338\.25"/);

  // vat_rate and vat are aliases too
  assert.match((await c.call("business_set", { name: "Zovo Studio", vat_rate: 19 })).text, /"default_tax_rate": 19/);
  assert.match((await c.call("business_set", { name: "Zovo Studio", vat: 7 })).text, /"default_tax_rate": 7/);

  // an unknown key is reported, not dropped in silence
  const u = await c.call("business_set", { name: "Zovo Studio", company_vat: 23, iban_number: "PL01" });
  assert.match(u.text, /Warning: ignored unknown fields company_vat, iban_number\./);
  assert.match(u.text, /Accepted fields: name, address, email, phone, timezone, vat_id, iban, bank, logo_path, default_currency, default_tax_rate, payment_terms_days, invoice_prefix/);

  // items take the same alias
  await c.call("business_set", { name: "Zovo Studio", default_tax_rate: 0 });
  const i = await c.call("invoice_create", {
    client: "Acme",
    items: [{ description: "Work", quantity: 1, unit_price: 100, vat_rate: 23 }],
    issue_date: "2026-09-03",
  });
  assert.match(i.text, /"tax_rate": "23%"/);
  assert.match(i.text, /"total": "EUR 123\.00"/);
});

test("D-R6: the wording says PDF only when the file is a PDF", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("business_set", { name: "Zovo Studio" });
  await c.call("invoice_create", { client: "Acme", items: [{ description: "Work", quantity: 1, unit_price: 10 }], issue_date: "2026-09-02" });
  const pdf = join(c.home, "ok.pdf");
  const a = await c.call("invoice_pdf", { number: "INV-2026-0001", out_path: pdf });
  assert.match(a.text, /Wrote PDF invoice/);
  assert.doesNotMatch(a.text, /HTML invoice/);
  const html = join(c.home, "wrong.html");
  const b = await c.call("invoice_pdf", { number: "INV-2026-0001", out_path: html });
  assert.match(b.text, /Wrote HTML invoice \(print to PDF\)/);
  assert.match(b.text, /holds PDF bytes despite the \.html name\. Use a \.pdf path\./);
});

test("D-R87: invoice_mark_paid ADDS to paid_minor, two partials sum instead of the second erasing the first", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("business_set", { name: "Zovo Studio" });
  await c.call("invoice_create", {
    client: "Acme", items: [{ description: "Work", quantity: 1, unit_price: 1000 }], issue_date: "2026-09-02",
  });
  const number = "INV-2026-0001";

  // First partial: EUR 200.00 of EUR 1,000.00.
  let r = await c.call("invoice_mark_paid", { number, amount: 200, paid_date: "2026-09-03", method: "bank transfer", reference: "REF-1" });
  assert.equal(r.isError, false);
  assert.match(r.text, /marked partial on 2026-09-03/);
  assert.match(r.text, /Added EUR 200\.00 \(total received EUR 200\.00\), balance due EUR 800\.00\./);
  let inv = JSON.parse((await c.call("invoice_get", { number })).text);
  assert.equal(inv.paid_minor, 20000, "first partial recorded");
  assert.equal(inv.status, "partial");
  assert.equal(inv.payments.length, 1);
  assert.deepEqual(inv.payments[0], { date: "2026-09-03", amount_minor: 20000, method: "bank transfer", reference: "REF-1" });

  // Second partial: EUR 300.00 more. Before the fix this SET paid_minor to 30000
  // and silently lost the first EUR 200.00 (docs/DEPOSITS_RESULT.md).
  r = await c.call("invoice_mark_paid", { number, amount: 300, paid_date: "2026-09-10" });
  assert.equal(r.isError, false);
  assert.match(r.text, /Added EUR 300\.00 \(total received EUR 500\.00\), balance due EUR 500\.00\./);
  inv = JSON.parse((await c.call("invoice_get", { number })).text);
  assert.equal(inv.paid_minor, 50000, "both partials summed, neither payment was lost");
  assert.equal(inv.status, "partial");
  assert.equal(inv.payments.length, 2);
  assert.equal(inv.payments[1].amount_minor, 30000);

  // Overpayment is refused by name, states the open balance, and changes nothing.
  r = await c.call("invoice_mark_paid", { number, amount: 600 });
  assert.equal(r.isError, true);
  assert.match(r.text, /owes EUR 500\.00/);
  assert.match(r.text, /EUR 500\.00 of EUR 1000\.00 already received/);
  assert.match(r.text, /overpay it by EUR 100\.00/);
  inv = JSON.parse((await c.call("invoice_get", { number })).text);
  assert.equal(inv.paid_minor, 50000, "the refused overpayment changed nothing");
  assert.equal(inv.payments.length, 2, "no payment row for a refused overpayment");

  // No-amount call still means "paid in full": adds exactly the remaining balance.
  r = await c.call("invoice_mark_paid", { number, paid_date: "2026-09-15" });
  assert.equal(r.isError, false);
  assert.match(r.text, /marked paid on 2026-09-15/);
  assert.match(r.text, /Added EUR 500\.00 \(total received EUR 1000\.00\)\./);
  inv = JSON.parse((await c.call("invoice_get", { number })).text);
  assert.equal(inv.paid_minor, 100000);
  assert.equal(inv.status, "paid");
  assert.equal(inv.payments.length, 3);
  assert.equal(inv.payments[2].amount_minor, 50000);

  // Calling it again on a fully paid invoice adds nothing and says so.
  r = await c.call("invoice_mark_paid", { number });
  assert.equal(r.isError, false);
  assert.match(r.text, /already paid in full: EUR 1000\.00 of EUR 1000\.00 received\. Nothing was added\./);
  inv = JSON.parse((await c.call("invoice_get", { number })).text);
  assert.equal(inv.payments.length, 3, "no extra payment row when nothing was added");
});
