// One-shot smoke for RESULT.md: initialize, tools/list, asset_add, maintenance_log,
// maintenance_due showing the asset. Pro key so the due report answers.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");
const dir = mkdtempSync(join(tmpdir(), "mcp-maintenance-log-smoke-"));
const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "maintenance-log"], { encoding: "utf8" }).trim();

const child = spawn(process.execPath, [ENTRY], {
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "cfg"), MCP_LICENSE_KEY: key },
});
let err = "";
child.stderr.on("data", (d) => { err += d.toString(); });
let buf = "";
const pending = new Map();
child.stdout.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let id = 0;
const send = (method, params) => new Promise((res) => {
  const myId = ++id;
  pending.set(myId, res);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
});

const init = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
console.log(`initialize: ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

const list = await send("tools/list", {});
console.log(`tools/list: ${list.result.tools.map((t) => t.name).join(", ")}`);

const call = async (name, args) => (await send("tools/call", { name, arguments: args })).result;

const added = await call("asset_add", { name: "Lathe", tag: "SN-88-4412", location: "Workshop bay 2", currency: "USD" });
const asset = JSON.parse(added.content[0].text).created;
console.log(`asset_add: ${asset.id} ${asset.name}`);

const logged = await call("maintenance_log", { asset: asset.id, date: "2020-01-06", work: "Oil and filter change", cost_cents: 12000, technician: "Anna", interval_days: 90 });
const entry = JSON.parse(logged.content[0].text);
console.log(`maintenance_log: ${entry.logged.date} ${entry.logged.work}, cost ${entry.logged.cost}, next_due ${entry.logged.next_due}`);

const due = await call("maintenance_due", { within_days: 30 });
const report = JSON.parse(due.content[0].text);
console.log(`maintenance_due: today ${report.today}; overdue_count ${report.overdue_count}; first overdue ${report.overdue[0].id} (${report.overdue[0].name}) next_due ${report.overdue[0].next_due} days_overdue ${report.overdue[0].days_overdue}`);

child.kill();
console.log(`stderr: ${err.trim()}`);
rmSync(dir, { recursive: true, force: true });
