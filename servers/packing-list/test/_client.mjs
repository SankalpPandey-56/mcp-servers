// Shared stdio JSON-RPC client for the mcp-packing-list suites.
// One sandboxed data dir per client, so no test can see another's packing lists.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey(product = "packing-list") {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), product], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-packing-list-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

/** The shared business profile every suite runs against. No currency is used by this server. */
export function writeProfile(dataHome, patch = {}) {
  const dir = join(dataHome, "mcp-servers", "profile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "business.json"), JSON.stringify({
    name: "Nova Studio", address: "ul. Prosta 1, Warsaw", default_currency: "EUR",
    default_tax_rate: 23, payment_terms_days: 14, timezone: "Europe/Warsaw", ...patch,
  }, null, 2));
}

export function client({ dataHome, key } = {}) {
  const home = dataHome ?? join(mkdtempSync(join(tmpdir(), "mcp-packing-list-")), "data");
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
    async json(name, args) { const r = await this.call(name, args); if (r.isError) throw new Error(r.text); return JSON.parse(r.text); },
    close() { child.kill(); },
  };
}

export function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

export function storeDir(dataHome) { return join(dataHome, "mcp-servers", "packing-list"); }

/**
 * The worked shipment. Three ordered lines against work order WO-2026-0044 for Harbour Cafe,
 * packed into two cartons.
 *
 *   ordered   OAK-900   Oak shelf 900mm        12
 *             BRK-STL   Steel bracket          24
 *             (no sku)  Fixing pack             1
 *
 *   C01  Box 1 of 2   tare 800 g   40 x 30 x 25 cm = 30 000 cm3
 *        8 x OAK-900 @ 1 250 g = 10 000 g
 *        24 x BRK-STL @ 150 g  =  3 600 g
 *        net 13 600 g, gross 14 400 g
 *        volumetric at 5000: ceil(30000 / 5000 * 1000) = 6 000 g -> chargeable = 14 400 g (actual)
 *
 *   C02  Box 2 of 2   tare 600 g   40 x 30 x 20 cm = 24 000 cm3
 *        4 x OAK-900 @ 1 250 g = 5 000 g
 *        1 x Fixing pack, NOT weighed
 *        net 5 000 g (lower bound), gross 5 600 g (lower bound)
 *        volumetric at 5000: ceil(24000 / 5000 * 1000) = 4 800 g -> chargeable = 5 600 g (actual)
 *
 *   shipment: tare 1 400, net 18 600, gross 20 000, volumetric 10 800, chargeable 20 000
 *   at divisor 4000: C01 volumetric 7 500, C02 volumetric 6 000, chargeable 14 400 + 6 000 = 20 400
 */
export const REFERENCE = "WO-2026-0044";
export const CONSIGNEE = "Harbour Cafe";
export const PL_DATE = "2026-04-02";

export const CREATE = {
  reference: REFERENCE, consignee: CONSIGNEE, ship_to: "12 Dock Road, Bristol", date: PL_DATE,
};

export const EXPECTED = [
  { sku: "OAK-900", description: "Oak shelf 900mm", quantity: 12 },
  { sku: "BRK-STL", description: "Steel bracket", quantity: 24 },
  { description: "Fixing pack", quantity: 1 },
];

export const CARTONS = [
  { label: "Box 1 of 2", tare_grams: 800, length_cm: 40, width_cm: 30, height_cm: 25 },
  { label: "Box 2 of 2", tare_grams: 600, length_cm: 40, width_cm: 30, height_cm: 20 },
];

export const PACKED = [
  { carton: "C01", sku: "OAK-900", description: "Oak shelf 900mm", quantity: 8, unit_grams: 1250 },
  { carton: "C01", sku: "BRK-STL", description: "Steel bracket", quantity: 24, unit_grams: 150 },
  { carton: "C02", sku: "OAK-900", description: "Oak shelf 900mm", quantity: 4, unit_grams: 1250 },
  { carton: "C02", description: "Fixing pack", quantity: 1 },
];

export const C01 = { tare: 800, net: 13600, gross: 14400, volumetric5000: 6000, chargeable5000: 14400 };
export const C02 = { tare: 600, net: 5000, gross: 5600, volumetric5000: 4800, chargeable5000: 5600 };
export const SHIPMENT = { tare: 1400, net: 18600, gross: 20000, volumetric5000: 10800, chargeable5000: 20000, chargeable4000: 20400 };

/** Raise the worked packing list, fully expected, cartoned and packed. Returns the id. */
export async function seed(c, patch = {}) {
  const r = await c.call("packing_list_create", { ...CREATE, ...patch });
  if (r.isError) throw new Error(`packing_list_create: ${r.text}`);
  const id = JSON.parse(r.text).created.id;
  for (const e of EXPECTED) {
    const x = await c.call("packing_expect", { packing_list: id, ...e });
    if (x.isError) throw new Error(`packing_expect ${e.description}: ${x.text}`);
  }
  for (const k of CARTONS) {
    const x = await c.call("carton_add", { packing_list: id, ...k });
    if (x.isError) throw new Error(`carton_add ${k.label}: ${x.text}`);
  }
  for (const l of PACKED) {
    const x = await c.call("pack_item", { packing_list: id, ...l });
    if (x.isError) throw new Error(`pack_item ${l.description}: ${x.text}`);
  }
  return id;
}
