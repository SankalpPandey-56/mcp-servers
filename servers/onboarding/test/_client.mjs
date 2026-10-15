// Shared stdio JSON-RPC client for the mcp-onboarding suites.
// One sandboxed data home per client, so no test can see another's hires.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey(product = "onboarding") {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), product], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-onboarding-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

/** Kept for compatibility with suites that call it; onboarding reads no business profile. */
export function writeProfile(dataHome) {
  const dir = join(dataHome, "mcp-servers", "profile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "business.json"), JSON.stringify({ name: "Nova Studio" }, null, 2));
}

export function client({ dataHome, key } = {}) {
  const home = dataHome ?? join(mkdtempSync(join(tmpdir(), "mcp-onboarding-")), "data");
  const env = { ...process.env, MCP_ONBOARDING_HOME: home };
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

export function storeDir(dataHome) { return join(dataHome, ".mcp-onboarding", "store.json"); }

/** An ISO date n days from today, so suites with a fixed 'today' in the past stay time-robust. */
export function daysFromNow(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * The worked hire, started ten days ago so one task is overdue:
 *
 *   K01 Workspace and laptop issued        it       due  start+0  done
 *   K02 HR welcome and paperwork            hr       due  start+0  done
 *   K03 Email and calendars set up          it       due  start+1  done
 *   K04 GitHub, CI and deploy access        it       due  start+3  skipped
 *   K05 Intro plan with direct manager      manager  due  start+5  todo (overdue)
 *   K06 Dev-team review                    manager  due  start+14 todo
 *
 * done=3, skipped=1, todo=2, tasks=6 => percent_complete 50.0, overdue=1.
 */
export const HIRE_NAME = "Rhea van der Meer";
export const HIRE_ROLE = "engineer";
export const HIRE_START = daysFromNow(-10);
export const TASKS = [
  { text: "Workspace and laptop issued", owner: "it", due_offset: 0 },
  { text: "HR welcome and paperwork", owner: "hr", due_offset: 0 },
  { text: "Email and calendars set up", owner: "it", due_offset: 1 },
  { text: "GitHub, CI and deploy access", owner: "it", due_offset: 3 },
  { text: "Intro plan with direct manager", owner: "manager", due_offset: 5 },
  { text: "Dev-team review", owner: "manager", due_offset: 14 },
];
export const DONE_IDS = { K01: 0, K02: 1, K03: 2 };
export const SKIPPED_ID = "K04";

/** Add the worked hire (no tasks), returns its id and detail. */
export async function seedHire(c, name = HIRE_NAME, role = HIRE_ROLE, start = HIRE_START) {
  const r = await c.call("onboarding_hire_add", { name, role, start_date: start });
  if (r.isError) throw new Error(`onboarding_hire_add: ${r.text}`);
  return JSON.parse(r.text).created;
}

/** Add the worked hire AND its six tasks, return { hire, tasks } map by K-id. */
export async function seedHireTasks(c, name = HIRE_NAME, role = HIRE_ROLE, start = HIRE_START) {
  const hire = await seedHire(c, name, role, start);
  const tasks = {};
  for (let i = 0; i < TASKS.length; i++) {
    const x = await c.call("onboarding_task_add", { hire: hire.id, ...TASKS[i] });
    if (x.isError) throw new Error(`onboarding_task_add ${TASKS[i].text}: ${x.text}`);
    tasks[`K${String(i + 1).padStart(2, "0")}`] = JSON.parse(x.text).added;
  }
  return { hire, tasks };
}

/** Add the worked hire with its tasks and mark K01/K02/K03 done, K04 skipped (the run analog). */
export async function seed(c, name = HIRE_NAME, role = HIRE_ROLE, start = HIRE_START) {
  const { hire, tasks } = await seedHireTasks(c, name, role, start);
  for (const id of Object.keys(DONE_IDS)) {
    const d = await c.call("onboarding_task_done", { hire: hire.id, task: id, status: "done" });
    if (d.isError) throw new Error(`onboarding_task_done ${id}: ${d.text}`);
  }
  const s = await c.call("onboarding_task_done", { hire: hire.id, task: SKIPPED_ID, status: "skipped" });
  if (s.isError) throw new Error(`onboarding_task_done ${SKIPPED_ID}: ${s.text}`);
  return { hire, tasks };
}