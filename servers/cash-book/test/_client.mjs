// Shared stdio JSON-RPC client and store seeders for the mcp-cash-book suites.
// One sandboxed data dir per client, so no test can see another's books.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey(product = "cash-book") {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), product], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-cash-book-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

export function client({ dataHome, key } = {}) {
  const home = dataHome ?? join(mkdtempSync(join(tmpdir(), "mcp-cash-book-")), "data");
  const env = { ...process.env, XDG_DATA_HOME: home, XDG_CONFIG_HOME: join(home, "..", "config") };
  if (key) env.MCP_LICENSE_KEY = key; else delete env.MCP_LICENSE_KEY;
  const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env });
  child.stderr.resume();
  const stdoutLines = [];
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      stdoutLines.push(line);
      if (!line.trim()) continue;
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
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 30000);
    t.unref();
  });
  return {
    home, send, stdoutLines,
    get tail() { return buf; },
    async init() {
      const r = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
      return r.result;
    },
    async tools() { return (await send("tools/list", {})).result.tools; },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (!r.result) return { text: JSON.stringify(r.error), isError: true };
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: r.result.isError === true };
    },
    async json(name, args) { const r = await this.call(name, args); return r.isError ? r : JSON.parse(r.text); },
    close() { child.kill(); },
  };
}

export function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

export function storeDir(dataHome, name) { return join(dataHome, "mcp-servers", name); }

function put(dataHome, server, file, value) {
  const dir = storeDir(dataHome, server);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, file), typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n");
}

/**
 * The six sibling stores are seeded on disk directly rather than through their own
 * servers. Spawning mcp-invoice to create an invoice would test mcp-invoice; what this
 * suite has to pin down is what THIS server derives from a given set of rows, so the rows
 * are written in the exact shape each sibling's own src/store.ts declares, and a contract
 * test greps those files for the fields this server depends on.
 */
export const seed = {
  invoices: (h, rows) => put(h, "invoice", "invoices.json", rows),
  clients: (h, rows) => put(h, "invoice", "clients.json", rows),
  business: (h, biz) => put(h, "invoice", "business.json", biz),
  creditNotes: (h, rows) => put(h, "billing-docs", "credit-notes.json", rows),
  purchaseOrders: (h, rows) => put(h, "billing-docs", "purchase-orders.json", rows),
  deposits: (h, rows) => put(h, "deposits", "deposits.json", rows),
  assets: (h, rows) => put(h, "asset-register", "assets.json", rows),
  expenses: (h, rows) => put(h, "expense-tracker", "data.json", { version: 1, expenses: rows, rules: [], settings: {} }),
  bank: (h, rows) => put(h, "bank-statement", "data.json", { version: 1, accounts: [{ name: "main", currency: "EUR", created: "2026-01-01T00:00:00.000Z" }], transactions: rows, rules: [] }),
  raw: put,
};

/** One computed invoice line in the shape servers/invoice writes. */
export function line(description, netMinor, taxRate = 0) {
  const tax = Math.round((netMinor * taxRate) / 100);
  return {
    description, quantity: 1, unit_price_minor: netMinor, tax_rate: taxRate,
    gross_minor: netMinor, discount_minor: 0, net_minor: netMinor,
    tax_minor: tax, exact_gross_minor: netMinor, round_total: false,
  };
}

/** An invoice in the shape servers/invoice/src/store.ts stores one. */
export function invoice(o) {
  const net = o.net_minor ?? 100000;
  const rate = o.tax_rate ?? 0;
  const tax = o.tax_minor ?? Math.round((net * rate) / 100);
  const paid = o.paid_minor ?? 0;
  const total = o.total_minor ?? net + tax;
  return {
    number: o.number,
    client_id: o.client_id ?? "cl_acme",
    client: o.client ?? { name: "Acme Ltd" },
    issue_date: o.issue_date,
    due_date: o.due_date ?? o.issue_date,
    currency: o.currency ?? "EUR",
    decimals: 2,
    lines: [line(o.description ?? "Consulting", net, rate)],
    subtotal_minor: net, discount_percent: 0, discount_minor: 0, net_minor: net,
    tax_lines: rate ? [{ rate, net_minor: net, tax_minor: tax }] : (o.tax_lines ?? []),
    tax_minor: tax, total_minor: total,
    status: paid >= total ? "paid" : paid > 0 ? "partial" : "unpaid",
    paid_date: o.paid_date,
    paid_minor: paid,
    payments: o.payments,
    created: `${o.issue_date}T09:00:00.000Z`,
    branded: false,
  };
}

/** A credit note in the shape servers/billing-docs stores one: every money field NEGATIVE. */
export function creditNote(o) {
  const net = -Math.abs(o.net_minor);
  const rate = o.tax_rate ?? 0;
  const tax = -Math.abs(Math.round((Math.abs(net) * rate) / 100));
  return {
    id: o.id, invoice_number: o.invoice_number,
    invoice_total_minor: o.invoice_total_minor ?? Math.abs(net),
    invoice_issue_date: o.invoice_issue_date ?? o.issue_date,
    basis: "amount",
    client_id: "cl_acme", client: { name: "Acme Ltd" },
    issue_date: o.issue_date, currency: o.currency ?? "EUR", decimals: 2,
    lines: [line(o.reason ?? "Credit", net, rate)],
    subtotal_minor: net, discount_percent: 0, discount_minor: 0, net_minor: net,
    tax_lines: rate ? [{ rate, net_minor: net, tax_minor: tax }] : [],
    tax_minor: tax, total_minor: o.total_minor ?? net + tax,
    reason: o.reason ?? "Goodwill",
    created: `${o.issue_date}T09:00:00.000Z`, branded: false,
  };
}

/** A deposit in the shape servers/deposits stores one. */
export function deposit(o) {
  const applications = o.applications ?? [];
  const refunds = o.refunds ?? [];
  const applied = applications.reduce((a, x) => a + x.amount_minor, 0);
  const refunded = refunds.reduce((a, x) => a + x.amount_minor, 0);
  const held = o.amount_minor - applied - refunded;
  return {
    id: o.id, client_id: "cl_acme", client: { name: o.client ?? "Acme Ltd" },
    amount_minor: o.amount_minor, currency: o.currency ?? "EUR", decimals: 2,
    kind: o.kind ?? "retainer", received_date: o.received_date, reference: o.reference,
    applications, refunds,
    status: held > 0 ? "held" : applied > 0 ? "applied" : "refunded",
    created: `${o.received_date}T09:00:00.000Z`, updated: `${o.received_date}T09:00:00.000Z`, branded: false,
  };
}

/** An asset in the shape servers/asset-register stores one. */
export function asset(o) {
  return {
    id: o.id, name: o.name, scheme: "pl", category: "487", category_name: "Computers and computer sets",
    cost_minor: o.cost_minor, currency: o.currency ?? "EUR", residual_minor: 0,
    purchase_date: o.in_service_date, in_service_date: o.in_service_date,
    method: "straight-line", life_years: 3.33, life_source: "annex", rate_pct: 30,
    created: `${o.in_service_date}T09:00:00.000Z`, updated: `${o.in_service_date}T09:00:00.000Z`,
  };
}

export function expense(o) {
  return {
    id: o.id, date: o.date, amount_minor: o.amount_minor, currency: o.currency ?? "EUR",
    category: o.category, merchant: o.merchant, billable: false,
    vat_rate: o.vat_rate, created: `${o.date}T09:00:00.000Z`,
  };
}

export function txn(o) {
  return {
    id: o.id, account: "main", date: o.date, description: o.description ?? o.id,
    amount_minor: o.amount_minor, currency: o.currency ?? "EUR", bank: "test",
    dedupe: o.id, imported: `${o.date}T10:00:00.000Z`,
  };
}

export const PERIOD = { from: "2026-06-01", to: "2026-06-30" };

/**
 * The worked month. Every figure the unit suite asserts is recomputed by hand from these
 * rows in the table in docs/CASH_BOOK_RESULT.md.
 */
export function workedMonth(dataHome) {
  seed.business(dataHome, {
    name: "Zovo", address: "1 Test Street", default_currency: "EUR", default_tax_rate: 23,
    payment_terms_days: 14, invoice_prefix: "INV",
  });
  seed.clients(dataHome, [{ id: "cl_acme", name: "Acme Ltd", created: "2026-01-01T00:00:00.000Z" }]);
  seed.invoices(dataHome, [
    invoice({
      number: "INV-2026-0001", issue_date: "2026-06-03", due_date: "2026-07-03",
      net_minor: 100000, tax_rate: 23, paid_minor: 123000, paid_date: "2026-06-20",
      payments: [{ date: "2026-06-20", amount_minor: 63000, method: "transfer" }],
    }),
    invoice({ number: "INV-2026-0002", issue_date: "2026-06-10", due_date: "2026-07-10", net_minor: 50000 }),
  ]);
  seed.creditNotes(dataHome, [
    creditNote({ id: "CN-2026-0001", invoice_number: "INV-2026-0002", issue_date: "2026-06-25", net_minor: 10000 }),
  ]);
  seed.deposits(dataHome, [
    deposit({
      id: "DEP-2026-0001", amount_minor: 100000, received_date: "2026-06-01",
      applications: [{ date: "2026-06-18", invoice_number: "INV-2026-0001", amount_minor: 60000 }],
    }),
  ]);
  seed.expenses(dataHome, [
    expense({ id: "exp_1", date: "2026-06-05", amount_minor: 12300, vat_rate: 23, category: "travel", merchant: "Rail" }),
    expense({ id: "exp_2", date: "2026-06-12", amount_minor: 5000, category: "software", merchant: "Editor" }),
  ]);
  seed.assets(dataHome, [
    asset({ id: "ASSET-2026-0001", name: "Laptop", cost_minor: 600000, in_service_date: "2026-04-20" }),
    asset({ id: "ASSET-2026-0002", name: "Server", cost_minor: 1200000, in_service_date: "2026-06-15" }),
  ]);
  seed.bank(dataHome, [
    txn({ id: "tx1", date: "2026-06-01", amount_minor: 100000, description: "Acme retainer" }),
    txn({ id: "tx2", date: "2026-06-05", amount_minor: -12300, description: "Rail" }),
    txn({ id: "tx3", date: "2026-06-15", amount_minor: -1200000, description: "Server" }),
    txn({ id: "tx4", date: "2026-06-20", amount_minor: 63000, description: "Acme INV-0001" }),
    txn({ id: "tx5", date: "2026-06-22", amount_minor: -7500, description: "Unknown withdrawal" }),
  ]);
}

/** Every account balance of a trial_balance answer, as a plain object of minor units. */
export function balances(tb) {
  return Object.fromEntries(tb.accounts.map((a) => [a.account, a.balance_minor]));
}
