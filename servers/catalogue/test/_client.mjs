// Shared stdio JSON-RPC client for the mcp-catalogue suites.
// One sandboxed data dir per client, so no test can see another's catalogue.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey(product = "catalogue") {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), product], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-catalogue-") {
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
  const home = dataHome ?? join(mkdtempSync(join(tmpdir(), "mcp-catalogue-")), "data");
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

export function storeDir(dataHome) { return join(dataHome, "mcp-servers", "catalogue"); }

/**
 * The worked catalogue. Four SKUs, one of them on a three-step valid_from ladder, and two
 * rate cards.
 */
export const SKUS = [
  { sku: "WEB-AUDIT", name: "Website audit", unit: "each", price_minor: 39000, valid_from: "2025-01-01" },
  { sku: "WEB-AUDIT", name: "Website audit", unit: "each", price_minor: 45000, valid_from: "2026-01-01" },
  { sku: "WEB-AUDIT", name: "Website audit", unit: "each", price_minor: 49500, valid_from: "2026-07-01" },
  { sku: "HOST-MO", name: "Managed hosting", unit: "month", price_minor: 3999, valid_from: "2025-01-01" },
  { sku: "COPY-1K", name: "Copywriting", unit: "1000 words", price_minor: 12000, valid_from: "2025-01-01" },
];

export const RATES = [
  { role: "senior developer", hourly_minor: 8500, valid_from: "2025-01-01" },
  { role: "junior developer", hourly_minor: 4500, valid_from: "2025-01-01" },
];

/**
 * The worked resolution, priced as of 2026-03-15, EUR, tier standard, VAT 23% throughout.
 *
 *   WEB-AUDIT        3  x  45000  =  135,000   (the 2026-01-01 row, not 39000 and not 49500)
 *   HOST-MO         12  x   3999  =   47,988
 *   senior developer 7.5 h x 8500 =   63,750
 *   junior developer 3.25 h x 4500 =  14,625
 *                                     -------
 *   net                               261,363
 *   VAT 23% per line 31050 + 11037 + 14663 + 3364 = 60,114
 *   gross                             321,477
 */
export const LINES = [
  { sku: "WEB-AUDIT", quantity: 3 },
  { sku: "HOST-MO", quantity: 12 },
  { role: "senior developer", hours: 7.5 },
  { role: "junior developer", hours: 3.25 },
];

export const RESOLVE_DATE = "2026-03-15";
export const NET_MINOR = 261363;
export const VAT_MINOR = 60114;
export const GROSS_MINOR = 321477;
export const LINE_GROSS = [135000, 47988, 63750, 14625];

/** Load the worked catalogue into a running server. */
export async function seed(c) {
  for (const s of SKUS) {
    const r = await c.call("sku_set", { ...s, vat_rate: 23 });
    if (r.isError) throw new Error(`sku_set ${s.sku} ${s.valid_from}: ${r.text}`);
  }
  for (const r of RATES) {
    const x = await c.call("rate_set", r);
    if (x.isError) throw new Error(`rate_set ${r.role}: ${x.text}`);
  }
}
