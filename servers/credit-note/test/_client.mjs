// Shared stdio JSON-RPC client for the mcp-credit-note suites.
// One sandboxed data dir per client, so no test can see another's store.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey(product = "credit-note") {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), product], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-credit-note-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

export function client({ dataHome, key } = {}) {
  const home = dataHome ?? join(mkdtempSync(join(tmpdir(), "mcp-credit-note-")), "data");
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

export function storeDir(dataHome) { return join(dataHome, "mcp-servers", "credit-note"); }

/**
 * The worked credit note every unit assertion is recomputed from by hand.
 * Returned goods against INV-2026-0042, EUR, issued 2026-03-05:
 *   line 1: 3 x 2499 @ 23%  -> gross 7497, tax round(7497*0.23)=round(1724.31)=1724, total 9221
 *   line 2: 1 x  999 @ 23%  -> gross  999, tax  round(229.77)=230,               total 1229
 *   line 3: 1 x 1200 @  0%  -> gross 1200, tax 0,                                total 1200
 * subtotal 9696, tax 1954, total 11650. 23% base is 8496 (7497+999), not 9696.
 */
export const WORKED = {
  recipient: "Acme GmbH",
  reason: "returned_goods",
  currency: "EUR",
  invoice_ref: "INV-2026-0042",
  reason_detail: "Two cables returned unopened",
  issue_date: "2026-03-05",
  notes: "Credit settled against the next invoice.",
  lines: [
    { description: "Returned: USB-C cable", quantity: 3, unit_price_minor: 2499, tax_rate: 23 },
    { description: "Returned: cable adapter", quantity: 1, unit_price_minor: 999, tax_rate: 23 },
    { description: "Express shipping refunded", quantity: 1, unit_price_minor: 1200 },
  ],
};
export const WORKED_SUBTOTAL = 9696;
export const WORKED_TAX = 1954;
export const WORKED_TOTAL = 11650;
export const WORKED_TAX_BASE_23 = 8496;

/** The rounding edge: 2.5 x 3333 = 8332.5 rounds HALF-UP to 8333, never banker's 8332. */
export const HALF_LINE = { description: "Half-day consultancy refunded", quantity: 2.5, unit_price_minor: 3333 };
export const HALF_GROSS = 8333;
