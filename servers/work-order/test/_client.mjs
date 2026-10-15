// Shared stdio JSON-RPC client for the mcp-work-order suites.
// One sandboxed data dir per client, so no test can see another's board.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey(product = "work-order") {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), product], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-work-order-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

/** The shared business profile every suite runs against: EUR, 23% VAT, a real name. */
export function writeProfile(dataHome, patch = {}) {
  const dir = join(dataHome, "mcp-servers", "profile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "business.json"), JSON.stringify({
    name: "Nova Trades", address: "ul. Prosta 1, Warsaw", default_currency: "EUR",
    default_tax_rate: 23, payment_terms_days: 14, timezone: "Europe/Warsaw", ...patch,
  }, null, 2));
}

/** A client record in the invoice store, so work_order_create can resolve a real one. */
export function writeInvoiceClient(dataHome, client = {}) {
  const dir = join(dataHome, "mcp-servers", "invoice");
  mkdirSync(dir, { recursive: true });
  const c = {
    id: "a1b2c3d4", name: "Harbour Cafe", address: "12 Quay Street, Gdansk",
    email: "accounts@harbour.example", vat_id: "PL1234567890", created: "2026-01-05", ...client,
  };
  writeFileSync(join(dir, "clients.json"), JSON.stringify([c], null, 2));
  return c;
}

export function client({ dataHome, key } = {}) {
  const home = dataHome ?? join(mkdtempSync(join(tmpdir(), "mcp-work-order-")), "data");
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

export function storeDir(dataHome) { return join(dataHome, "mcp-servers", "work-order"); }

/** The worked order every unit assertion is recomputed from by hand. */
export const ORDER = {
  client: "Harbour Cafe",
  site_address: "12 Quay Street, Gdansk",
  requested_date: "2026-03-02",
  description: "Replace immersion heater and test",
  priority: "high",
};

/**
 * The worked job. Two labour lines and two parts lines, one of them marked up.
 *
 *   labour  3.5 h  x  8500        =  29,750
 *   labour  1.25 h x  8500        =  10,625
 *   parts   7      x  1299 + 15%  =  10,458   (unit 1494, NOT 10,457 from the line total)
 *   parts   2      x  4500 + 0%   =   9,000
 *                                    ------
 *   net                              59,833
 *   VAT 23% per line 6843+2444+2405+2070 = 13,762
 *   gross                            73,595
 */
export const LINES = [
  { kind: "labour", description: "Strip out and fit new element", hours: 3.5, rate_minor: 8500, date: "2026-03-04" },
  { kind: "labour", description: "Fill, test and certify", hours: 1.25, rate_minor: 8500, date: "2026-03-04" },
  { kind: "parts", description: "3kW immersion element", quantity: 7, unit_cost_minor: 1299, markup_percent: 15, date: "2026-03-04" },
  { kind: "parts", description: "Cylinder thermostat", quantity: 2, unit_cost_minor: 4500, date: "2026-03-04" },
];

export const HOURS = 4.75;
export const LABOUR_MINOR = 40375;
export const MATERIALS_MINOR = 19458;
export const PARTS_COST_MINOR = 18093;
export const NET_MINOR = 59833;
export const VAT_MINOR = 13762;
export const GROSS_MINOR = 73595;
