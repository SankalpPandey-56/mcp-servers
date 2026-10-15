// Shared stdio JSON-RPC client for the mcp-change-order suites.
// One sandboxed data dir per client, so no test can see another's change orders.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey(product = "change-order") {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), product], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-change-order-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

/** The shared business profile every suite runs against: EUR, 23% VAT, a real name. */
export function writeProfile(dataHome, patch = {}) {
  const dir = join(dataHome, "mcp-servers", "profile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "business.json"), JSON.stringify({
    name: "Nova Studio", address: "ul. Prosta 1, Warsaw", default_currency: "EUR",
    default_tax_rate: 23, payment_terms_days: 14, timezone: "Europe/Warsaw", ...patch,
  }, null, 2));
}

export function client({ dataHome, key } = {}) {
  const home = dataHome ?? join(mkdtempSync(join(tmpdir(), "mcp-change-order-")), "data");
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

export function storeDir(dataHome) { return join(dataHome, "mcp-servers", "change-order"); }

/**
 * The worked change order. Against quote Q-2026-0003 for Harbour Cafe, EUR, whose
 * original value is 2,000,000 minor (EUR 20,000.00), VAT 23% from the shared profile.
 *
 *   L01 added    Extra landing page          2 x 45000                       +90,000
 *   L02 removed  Managed hosting            12 x  3999                       -47,988
 *   L03 changed  Website audit     was 3 x 45000 (135,000), now 5 x 42000 (210,000)  +75,000
 *                                                                            --------
 *   delta net                                                                117,012
 *   VAT 23% per item: 20700 + (-11037) + (-31050) + 48300 =                   26,913
 *   delta gross                                                              143,925
 *
 *   running value once approved: 2,000,000 + 117,012 = 2,117,012
 *
 * The invoice payload carries FOUR items (the changed line is a reversal and a revised
 * item): 2 x 450.00, -12 x 39.99, -3 x 450.00, 5 x 420.00 in MAJOR units, and the same
 * four in MINOR units for quote_create, which is not ready because two quantities are
 * negative.
 */
export const REFERENCE = "Q-2026-0003";
export const CLIENT = "Harbour Cafe";
export const ORIGINAL_MINOR = 2000000;
export const CO_DATE = "2026-03-10";

export const CREATE = {
  reference: REFERENCE, client: CLIENT, title: "Second landing page, drop hosting, widen the audit",
  date: CO_DATE, original_value_minor: ORIGINAL_MINOR,
};

export const LINES = [
  { kind: "added", description: "Extra landing page", quantity: 2, unit_price_minor: 45000, reason: "Client asked for a second page after the kickoff", date: "2026-03-10" },
  { kind: "removed", description: "Managed hosting", quantity: 12, unit_price_minor: 3999, reason: "Client hosts in-house from April", date: "2026-03-11" },
  { kind: "changed", description: "Website audit", quantity: 5, unit_price_minor: 42000, was_quantity: 3, was_unit_price_minor: 45000, reason: "Two more sites in scope, volume price agreed", date: "2026-03-12" },
];

export const LINE_DELTAS = [90000, -47988, 75000];
export const NET_DELTA_MINOR = 117012;
export const VAT_DELTA_MINOR = 26913;
export const GROSS_DELTA_MINOR = 143925;
export const ITEM_VALUES = [90000, -47988, -135000, 210000];
export const CURRENT_AFTER_APPROVAL = ORIGINAL_MINOR + NET_DELTA_MINOR;

/** Raise the worked change order with its three lines. Returns the id. */
export async function seed(c, patch = {}) {
  const r = await c.call("change_order_create", { ...CREATE, ...patch });
  if (r.isError) throw new Error(`change_order_create: ${r.text}`);
  const id = JSON.parse(r.text).created.id;
  for (const l of LINES) {
    const x = await c.call("change_order_add_line", { change_order: id, ...l });
    if (x.isError) throw new Error(`change_order_add_line ${l.description}: ${x.text}`);
  }
  return id;
}

/** Send and approve a change order. */
export async function approve(c, id, sentOn = "2026-03-13", approvedOn = "2026-03-15") {
  for (const [status, date] of [["sent", sentOn], ["approved", approvedOn]]) {
    const r = await c.call("change_order_status", { change_order: id, status, date });
    if (r.isError) throw new Error(`change_order_status ${status}: ${r.text}`);
  }
}
