// Shared stdio JSON-RPC client for the mcp-dunning-letters suites.
// One sandboxed data dir per client, so no test can see another's register.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey(product = "dunning-letters") {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), product], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-dunning-letters-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

export function client({ dataHome, key } = {}) {
  const home = dataHome ?? join(mkdtempSync(join(tmpdir(), "mcp-dunning-letters-")), "data");
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

export function storeDir(dataHome) { return join(dataHome, "mcp-servers", "dunning-letters"); }

/**
 * The worked chase every unit assertion is recomputed from by hand.
 *
 * INV-1042 to Acme Ltd: USD 1,250.00 due 2026-06-01, default gaps, so the ladder is
 *   reminder 1: 2026-06-08   reminder 2: 2026-06-15   final notice: 2026-06-22
 * On 2026-07-01 it is 30 days late. At 2% per month pro-rata on a 30-day month the fee is
 *   125000 * 0.02 * (30 / 30) = 2500 minor units.
 * A part payment of USD 500.00 on 2026-06-20 leaves 75000 outstanding; on 2026-07-01 the
 * fee on the remainder is 75000 * 0.02 * 1 = 1500, and the final-notice total is 76500.
 *
 * All dates are in the past so the suite cannot depend on the day it runs.
 */
export const ACME = {
  client: "Acme Ltd",
  reference: "INV-1042",
  amount_minor: 125000,
  currency: "USD",
  due: "2026-06-01",
  issued: "2026-05-15",
  late_fee_percent_per_month: 2,
};
export const STAGE_DATES = ["2026-06-08", "2026-06-15", "2026-06-22"];
export const ON = "2026-07-01";
export const DAYS_LATE = 30;
export const FEE_FULL = 2500;
export const PART_PAY = 50000;
export const FEE_AFTER_PART = 1500;
export const TOTAL_AFTER_PART = 76500;
