// Shared stdio JSON-RPC client for the mcp-deposits suites. One sandboxed data dir per
// client, so no test can see another's register.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey(product = "deposits") {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), product], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-deposits-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

export function client({ dataHome, key } = {}) {
  const home = dataHome ?? join(mkdtempSync(join(tmpdir(), "mcp-deposits-")), "data");
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
    close() { child.kill(); },
  };
}

export function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

/**
 * A minimal invoice store in the sandbox, written directly rather than through the
 * invoice server: applying a deposit needs an invoice to exist, and spawning a second
 * server to make one would test that server, not this one. The shape is
 * servers/invoice/src/store.ts `Invoice`, and the numbers are the ones the engine's own
 * computeTotals produces for the same items.
 */
export function seedInvoice(dataHome, invoice) {
  const dir = join(dataHome, "mcp-servers", "invoice");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "invoices.json");
  const all = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
  all.push(invoice);
  writeFileSync(file, JSON.stringify(all, null, 2));
  return invoice;
}

export function readInvoices(dataHome) {
  const file = join(dataHome, "mcp-servers", "invoice", "invoices.json");
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : [];
}

export function depositsDir(dataHome) { return join(dataHome, "mcp-servers", "deposits"); }

/** One line, one VAT rate, no discount: gross = qty x unit, tax = round(gross x rate / 100). */
export function simpleInvoice(number, { qty = 10, unit = 9000, rate = 23, currency = "EUR", client = "Acme Ltd", date = "2026-09-01" } = {}) {
  const gross = Math.round(qty * unit);
  const tax = Math.round(gross * rate / 100);
  return {
    number, client_id: "c1", client: { name: client },
    issue_date: date, due_date: date, currency, decimals: 2,
    lines: [{
      description: "Development", quantity: qty, unit_price_minor: unit, tax_rate: rate,
      gross_minor: gross, discount_minor: 0, net_minor: gross, tax_minor: tax,
      exact_gross_minor: gross, round_total: false,
    }],
    subtotal_minor: gross, discount_percent: 0, discount_minor: 0, net_minor: gross,
    tax_lines: [{ rate, base_minor: gross, tax_minor: tax }],
    tax_minor: tax, total_minor: gross + tax,
    status: "unpaid", paid_minor: 0, created: `${date}T00:00:00.000Z`, branded: true,
  };
}
