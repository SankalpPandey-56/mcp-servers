// Shared stdio JSON-RPC client for the mcp-petty-cash suites.
// One sandboxed data dir per client, so no test can see another's tin.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey(product = "petty-cash") {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), product], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-petty-cash-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

export function client({ dataHome, key } = {}) {
  const home = dataHome ?? join(mkdtempSync(join(tmpdir(), "mcp-petty-cash-")), "data");
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

export function storeDir(dataHome) { return join(dataHome, "mcp-servers", "petty-cash"); }

/** The worked float every unit assertion is recomputed from by hand: EUR 500.00 imprest. */
export const FLOAT = {
  name: "Office float",
  currency: "EUR",
  imprest_minor: 50000,
  custodian: "Anna Kowalska",
  opened: "2026-03-01",
};

/**
 * The worked month. Five vouchers totalling 20,194 minor units against a 50,000 imprest,
 * so the paperwork says 29,806 on 2026-03-31. The tin holds 29,795: eleven short.
 * The month is a past one on purpose, so the future-dated-voucher guard cannot make the
 * suite depend on the day it runs.
 */
export const MONTH = [
  { amount_minor: 1250, date: "2026-03-02", category: "postage", description: "Stamps", paid_to: "Post Office", receipt_ref: "R-101" },
  { amount_minor: 3480, date: "2026-03-05", category: "travel", description: "Taxi to client", paid_to: "City Cabs", receipt_ref: "R-102" },
  { amount_minor: 899, date: "2026-03-11", category: "office", description: "Milk and coffee", paid_to: "Corner Shop", receipt_ref: "R-103" },
  { amount_minor: 12500, date: "2026-03-18", category: "office", description: "Printer paper x5", paid_to: "Papermill", receipt_ref: "R-104" },
  { amount_minor: 2065, date: "2026-03-24", category: "travel", description: "Bus tickets", paid_to: "MPK", receipt_ref: "R-105" },
];

export const MONTH_TOTAL = 20194;
export const COUNT_DATE = "2026-03-31";
export const EXPECTED = 29806;
export const COUNTED = 29795;
export const DIFFERENCE = -11;
