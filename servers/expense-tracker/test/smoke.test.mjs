import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// D-R15: "today" is the LOCAL calendar date in every server; a UTC slice disagrees
// with it for any run before UTC midnight in a positive-offset zone.
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-expense-"));
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
  assert.equal(r.result.serverInfo.name, "mcp-expense-tracker");
  c.notify("notifications/initialized", {});
  return r.result;
}

const today = localDay();
const daysAgo = (n) => { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - n); return localDay(d); };

test("stdio: initialize, tools/list, expenses, rules, summary, mileage, rebill", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);

  const list = await c.send("tools/list", {});
  const names = list.result.tools.map((x) => x.name).sort();
  for (const n of [
    "expense_add", "expense_list", "expense_update", "expense_delete", "receipt_attach",
    "category_rules", "expense_summary", "mileage_add", "expense_export", "expense_to_invoice",
    "license_status", "license_activate",
  ]) assert.ok(names.includes(n), `missing tool ${n} (have ${names.join(",")})`);

  const res = await c.send("resources/list", {});
  assert.ok(res.result.resources.some((r) => r.uri === "expenses://month"), "expenses://month not registered");
  const prompts = await c.send("prompts/list", {});
  assert.ok(prompts.result.prompts.some((p) => p.name === "monthly_close"), "monthly_close prompt not registered");

  // one category rule, then three expenses in two currencies
  let r = await c.call("category_rules", { rules: [{ match: "adobe|figma", category: "software" }] });
  assert.equal(r.isError, false);
  assert.match(r.text, /Stored 1 category rules/);

  r = await c.call("expense_add", { amount: 61.5, currency: "EUR", merchant: "Adobe", date: daysAgo(3), vat_rate: 23, project: "Acme", billable: true });
  assert.equal(r.isError, false);
  assert.match(r.text, /EUR 61\.50/);
  assert.match(r.text, /software, from a category rule/);
  assert.match(r.text, /Net EUR 50\.00, VAT EUR 11\.50/);
  const id1 = r.text.match(/Saved ([0-9a-f]{8})/)[1];

  r = await c.call("expense_add", { amount: 123, currency: "PLN", merchant: "Orlen", category: "travel", date: daysAgo(2), vat_rate: 23, project: "Acme", billable: true });
  assert.match(r.text, /PLN 123\.00/);
  assert.match(r.text, /Net PLN 100\.00, VAT PLN 23\.00/);

  r = await c.call("expense_add", { amount: 12, currency: "EUR", merchant: "Figma", date: daysAgo(1) });
  assert.match(r.text, /software, from a category rule/);

  // list: totals per currency, not mixed
  const listed = JSON.parse((await c.call("expense_list", { from: daysAgo(10), to: today })).text);
  assert.equal(listed.count, 3);
  assert.deepEqual(listed.totals_per_currency.sort(), ["EUR 73.50", "PLN 123.00"]);

  // summary by category, per currency
  const sum = JSON.parse((await c.call("expense_summary", { from: daysAgo(10), to: today, group_by: "category" })).text);
  const eur = sum.by_currency.find((x) => x.currency === "EUR");
  const pln = sum.by_currency.find((x) => x.currency === "PLN");
  assert.equal(eur.groups.length, 1);
  assert.equal(eur.groups[0].key, "software");
  assert.equal(eur.groups[0].count, 2);
  assert.equal(eur.total_gross, "EUR 73.50");
  assert.equal(eur.total_vat, "EUR 11.50");
  assert.equal(pln.total_net, "PLN 100.00");

  // receipt: missing file refused, real file hashed
  const receipt = join(c.home, "receipt.pdf");
  writeFileSync(receipt, "receipt bytes");
  r = await c.call("receipt_attach", { id: id1, path: join(c.home, "nope.pdf") });
  assert.equal(r.isError, true);
  r = await c.call("receipt_attach", { id: id1, path: receipt });
  assert.equal(r.isError, false);
  assert.match(r.text, /sha256 [0-9a-f]{64}/);

  // mileage: default table
  r = await c.call("mileage_add", { km: 120, region: "PL", date: daysAgo(1), purpose: "client meeting", project: "Acme" });
  assert.equal(r.isError, false);
  assert.match(r.text, /120 kms on .* at 1\.15 PLN\/km \(table rate PL 1\.15 PLN\/km, an approximation; pass rate_per_km for your exact scheme\) = PLN 138\.00/);

  r = await c.call("mileage_add", { miles: 37, region: "UK", date: daysAgo(1), purpose: "site visit" });
  assert.match(r.text, /GBP 16\.65/);
  r = await c.call("mileage_add", { miles: 214, date: daysAgo(1), purpose: "conference" });
  assert.match(r.text, /table rate US 0\.7 USD\/mile, an approximation; pass rate_per_km for your exact scheme\) = USD 149\.80/);
  r = await c.call("mileage_add", { km: 83, region: "EU", date: daysAgo(1), purpose: "supplier" });
  assert.match(r.text, /EUR 24\.90/);
  r = await c.call("mileage_add", { km: 10, miles: 10, purpose: "both" });
  assert.equal(r.isError, true);

  // expense_to_invoice: invoice_create line shape
  const rebill = JSON.parse((await c.call("expense_to_invoice", { project: "Acme", from: daysAgo(10), to: today })).text);
  assert.ok(rebill.currencies.includes("EUR") && rebill.currencies.includes("PLN"));
  for (const g of rebill.line_items_per_currency) {
    for (const it of g.items) {
      assert.deepEqual(Object.keys(it).sort(), ["description", "quantity", "tax_rate", "unit_price"]);
      assert.equal(typeof it.description, "string");
      assert.equal(typeof it.quantity, "number");
      assert.equal(typeof it.unit_price, "number");
      assert.equal(typeof it.tax_rate, "number");
    }
  }
  const eurItems = rebill.line_items_per_currency.find((g) => g.currency === "EUR").items;
  assert.equal(eurItems.length, 1);                      // the billable Adobe expense
  assert.equal(eurItems[0].unit_price, 50);              // net of 23% VAT
  assert.equal(eurItems[0].tax_rate, 23);
  const plnItems = rebill.line_items_per_currency.find((g) => g.currency === "PLN").items;
  assert.equal(plnItems.length, 2);                      // Orlen plus the PL mileage
  // rebilled expenses are not offered twice, once they are actually marked (D-R4).
  // D-R6: a range is marked one currency at a time, against the invoice that carried it.
  assert.equal((await c.call("expense_mark_rebilled", { project: "Acme", from: daysAgo(10), to: today, invoice_number: "INV-A" })).isError, true);
  for (const cur of ["EUR", "PLN"]) {
    const mk = await c.call("expense_mark_rebilled", { project: "Acme", from: daysAgo(10), to: today, currency: cur, invoice_number: `INV-${cur}` });
    assert.equal(mk.isError, false, mk.text);
  }
  const again = JSON.parse((await c.call("expense_to_invoice", { project: "Acme", from: daysAgo(10), to: today })).text);
  assert.equal(again.count, 0);

  // export csv: header + one line per expense
  const csvPath = join(c.home, "out.csv");
  r = await c.call("expense_export", { from: daysAgo(10), to: today, format: "csv", path: csvPath });
  assert.equal(r.isError, false);
  const lines = readFileSync(csvPath, "utf8").trim().split("\n");
  assert.equal(lines.length, 1 + 7);                     // 3 expenses + 4 mileage rows
  assert.match(lines[0], /^id,date,currency,amount,gross,net,vat,vat_rate,/);

  // free tier: xlsx refused, nothing written
  const xlsxPath = join(c.home, "out.xlsx");
  r = await c.call("expense_export", { from: daysAgo(10), to: today, format: "xlsx", path: xlsxPath });
  assert.equal(r.isError, false, "a limit is not a transport error");
  assert.match(r.text, /Pro/);
  assert.equal(existsSync(xlsxPath), false, "no file may be written when the export is refused");

  // update and delete. D-R7: id1 is now on INV-EUR, so a money edit needs unlink_rebill.
  r = await c.call("expense_update", { id: id1, amount: 100 });
  assert.equal(r.isError, true);
  assert.match(r.text, /was rebilled on INV-EUR/);
  r = await c.call("expense_update", { id: id1, category: "design", amount: 100, unlink_rebill: true });
  assert.match(r.text, /"category": "design"/);
  assert.match(r.text, /EUR 100\.00/);
  r = await c.call("expense_delete", { id: id1 });
  assert.match(r.text, /Deleted/);
  r = await c.call("expense_delete", { id: id1 });
  assert.equal(r.isError, true);
});

test("free caps: 30-day window, 3 projects, 5 rules, 200-row csv export writes zero bytes", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);

  // window
  await c.call("expense_add", { amount: 10, currency: "EUR", merchant: "Old", date: daysAgo(90) });
  await c.call("expense_add", { amount: 20, currency: "EUR", merchant: "New", date: daysAgo(2) });
  const listed = JSON.parse((await c.call("expense_list", { from: daysAgo(365), to: today })).text);
  assert.equal(listed.count, 1, "free tier must not read past 30 days");
  assert.match(listed.note, /last 30 days/);

  // projects
  for (const p of ["P1", "P2", "P3"]) {
    const r = await c.call("expense_add", { amount: 5, currency: "EUR", project: p, date: today });
    assert.equal(r.isError, false);
  }
  let r = await c.call("expense_add", { amount: 5, currency: "EUR", project: "P4", date: today });
  assert.equal(r.isError, false);
  assert.match(r.text, /free tier tracks 3 projects/);
  const after = JSON.parse((await c.call("expense_list", { from: daysAgo(10), to: today, project: "P4" })).text);
  assert.equal(after.count, 0, "the refused expense must not be stored");

  // rules
  r = await c.call("category_rules", { rules: Array.from({ length: 6 }, (_, i) => ({ match: `m${i}`, category: "c" })) });
  assert.equal(r.isError, false);
  assert.match(r.text, /free tier stores 5/);
  assert.equal(JSON.parse((await c.call("category_rules", {})).text).count, 0);

  // 201 rows -> refused, zero bytes
  for (let i = 0; i < 197; i++) await c.call("expense_add", { amount: 1, currency: "EUR", merchant: `M${i}`, date: today });
  const listedAll = JSON.parse((await c.call("expense_list", { from: daysAgo(10), to: today })).text);
  assert.equal(listedAll.count, 201);
  const out = join(c.home, "big.csv");
  r = await c.call("expense_export", { from: daysAgo(10), to: today, format: "csv", path: out });
  assert.equal(r.isError, false);
  assert.match(r.text, /No file was written/);
  assert.equal(existsSync(out), false, "a refused export must write zero bytes");
});

test("pro: full history, xlsx export, markup rebill", async (t) => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "expense-tracker"], { encoding: "utf8" }).trim();
  const c = client({ MCP_LICENSE_KEY: key });
  t.after(() => c.close());
  await init(c);

  const st = await c.call("license_status", {});
  assert.match(st.text, /"tier": "pro"/);

  await c.call("expense_add", { amount: 10, currency: "EUR", merchant: "Old", date: daysAgo(200), project: "Zeta", billable: true, vat_rate: 20 });
  await c.call("expense_add", { amount: 20, currency: "EUR", merchant: "New", date: daysAgo(2), project: "Zeta", billable: true });
  for (const p of ["A", "B", "C", "D", "E"]) await c.call("expense_add", { amount: 1, currency: "EUR", project: p, date: today });

  const listed = JSON.parse((await c.call("expense_list", { from: daysAgo(365), to: today })).text);
  assert.equal(listed.count, 7, "pro reads the full history and every project");
  assert.equal(listed.note, undefined);

  const xlsxPath = join(c.home, "pro.xlsx");
  const r = await c.call("expense_export", { from: daysAgo(365), to: today, format: "xlsx", path: xlsxPath });
  assert.equal(r.isError, false, r.text);
  assert.ok(statSync(xlsxPath).size > 0, "pro xlsx export must produce a file");
  assert.equal(readFileSync(xlsxPath).slice(0, 2).toString("latin1"), "PK");

  const rebill = JSON.parse((await c.call("expense_to_invoice", { project: "Zeta", from: daysAgo(365), to: today, markup_percent: 10 })).text);
  assert.equal(rebill.count, 2);
  const items = rebill.line_items_per_currency[0].items;
  const old = items.find((i) => i.description.includes("Old"));
  // 10.00 gross at 20% -> VAT 1.67, net 8.33 -> +10% = 9.163. 9.16 + 20% tax is 10.99 against a
  // marked-up gross of 11.00, so D-R5 nudges unit_price to 9.17, which invoices to exactly 11.00.
  assert.equal(old.unit_price, 9.17);
  assert.equal(old.tax_rate, 20);
});
