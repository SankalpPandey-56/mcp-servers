// Shared stdio JSON-RPC client for the mcp-delivery-schedule suites.
// One sandboxed data dir per client, so no test can see another's schedules.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey(product = "delivery-schedule") {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), product], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-delivery-schedule-") {
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

export function client({ dataHome, key, env: extraEnv } = {}) {
  const home = dataHome ?? join(mkdtempSync(join(tmpdir(), "mcp-delivery-schedule-")), "data");
  const env = { ...process.env, XDG_DATA_HOME: home, XDG_CONFIG_HOME: join(home, "..", "config"), ...extraEnv };
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

export function storeDir(dataHome) { return join(dataHome, "mcp-servers", "delivery-schedule"); }

/**
 * The worked schedule. Website rebuild phase one for Harbour Cafe, delivered against
 * work order WO-2026-0011 dated 2026-04-01, EUR, VAT 23% from the shared profile.
 *
 *   D01 Wireframes            due 2026-04-10  EUR    900.00  started 04-03, delivered 04-09, accepted 04-12
 *   D02 Page copy             due 2026-04-20  EUR    479.88  delivered 04-24 (FOUR days late), accepted 04-27
 *   D03 Built site            due 2026-05-01  EUR  2,100.00  started 04-25, never delivered
 *   D04 Handover training     due 2026-05-08  not separately priced, still planned
 *
 * Read as at 2026-05-05:  D03 is LATE by four days, D02 is on the record as delivered
 *                         late by four days, D04 is not yet due, nothing is due today.
 * Read as at 2026-04-22:  D02 is LATE by two days and has not been delivered yet, D03
 *                         is still planned and not yet due. The same D02 reads two ways.
 * Read as at 2026-05-01:  D03 is DUE TODAY, not late.
 *
 * Milestone payload as at 2026-05-05, over the two accepted deliverables:
 *   net  90000 + 47988                       = 137,988
 *   VAT  23% per line: 20700 + 11037         =  31,737
 *   total                                    = 169,725
 */
export const REFERENCE = "WO-2026-0011";
export const REFERENCE_DATE = "2026-04-01";
export const CLIENT = "Harbour Cafe";

export const CREATE = {
  reference: REFERENCE,
  reference_date: REFERENCE_DATE,
  client: CLIENT,
  title: "Website rebuild, phase one",
};

export const DELIVERABLES = [
  { description: "Wireframes for the five main pages", due_date: "2026-04-10", value_minor: 90000 },
  { description: "Copy for the five main pages", due_date: "2026-04-20", value_minor: 47988 },
  { description: "Built and deployed site", due_date: "2026-05-01", value_minor: 210000 },
  { description: "Handover training session", due_date: "2026-05-08" },
];

export const MOVES = [
  { deliverable: "D01", status: "in_progress", date: "2026-04-03" },
  { deliverable: "D01", status: "delivered", date: "2026-04-09" },
  { deliverable: "D01", status: "accepted", date: "2026-04-12", note: "Signed off on the call, no changes" },
  { deliverable: "D02", status: "delivered", date: "2026-04-24" },
  { deliverable: "D02", status: "accepted", date: "2026-04-27", note: "Accepted with two typo fixes noted" },
  { deliverable: "D03", status: "in_progress", date: "2026-04-25" },
];

export const VALUE_MINOR = 347988;          // the three priced deliverables
export const ACCEPTED_NET_MINOR = 137988;   // D01 + D02
export const ACCEPTED_VAT_MINOR = 31737;    // 20700 + 11037, rounded per line
export const ACCEPTED_TOTAL_MINOR = 169725;
export const AS_OF_LATE = "2026-05-05";
export const AS_OF_EARLIER = "2026-04-22";
export const AS_OF_DUE_TODAY = "2026-05-01";

/** Open the worked schedule with its four deliverables and six dated moves. */
export async function seed(c, patch = {}) {
  const r = await c.call("delivery_schedule_create", { ...CREATE, ...patch });
  if (r.isError) throw new Error(`delivery_schedule_create: ${r.text}`);
  const id = JSON.parse(r.text).created.id;
  for (const d of DELIVERABLES) {
    const x = await c.call("deliverable_add", { schedule: id, ...d });
    if (x.isError) throw new Error(`deliverable_add ${d.description}: ${x.text}`);
  }
  for (const m of MOVES) {
    const x = await c.call("deliverable_status", { schedule: id, ...m });
    if (x.isError) throw new Error(`deliverable_status ${m.deliverable} ${m.status}: ${x.text}`);
  }
  return id;
}
