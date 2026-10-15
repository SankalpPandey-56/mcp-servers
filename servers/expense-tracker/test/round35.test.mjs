// Loop 35, defect ledger D-R41 (docs/USER_VALUE_R9.md): expense_export {project: "..."}
// used to say only "Wrote N expenses" while a line the project filter dropped (an
// unprojected mileage line) left the week total short without a word. The response must
// now count what the filters excluded and name the active filter.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function client(sandbox = mkdtempSync(join(tmpdir(), "mcp-ex-r35-"))) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(sandbox, "data"), XDG_CONFIG_HOME: join(sandbox, "cfg"), MCP_LICENSE_KEY: "" },
  });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    const to = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method}`)); } }, 25000);
    to.unref();
  });
  return {
    sandbox,
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (!r.result) return { text: JSON.stringify(r.error), isError: true };
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    init: async () => {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r35", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    },
    close: () => { child.kill(); try { rmSync(sandbox, { recursive: true, force: true }); } catch {} },
  };
}

test("D-R41: a project-filtered export counts and names the expenses it left out", async (t) => {
  const c = client(); t.after(() => c.close());
  await c.init();
  const day = today();
  await c.call("expense_add", { amount: 61.50, currency: "EUR", merchant: "Taxi", project: "Nova Labs", date: day });
  await c.call("expense_add", { amount: 34.50, currency: "PLN", merchant: "Airport drive", date: day });
  const out = join(c.sandbox, "week.csv");
  const r = await c.call("expense_export", { from: day, to: day, format: "csv", path: out, project: "Nova Labs" });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Wrote 1 expenses/);
  assert.match(r.text, /1 more expense in this period was left out by the project "Nova Labs" filter/);
});

test("D-R41: an unfiltered export carries no exclusion note", async (t) => {
  const c = client(); t.after(() => c.close());
  await c.init();
  const day = today();
  await c.call("expense_add", { amount: 61.50, currency: "EUR", merchant: "Taxi", project: "Nova Labs", date: day });
  await c.call("expense_add", { amount: 34.50, currency: "PLN", merchant: "Airport drive", date: day });
  const out = join(c.sandbox, "all.csv");
  const r = await c.call("expense_export", { from: day, to: day, format: "csv", path: out });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Wrote 2 expenses/);
  assert.doesNotMatch(r.text, /left out/);
});

test("D-R41: a filter that excludes nothing stays silent about exclusions", async (t) => {
  const c = client(); t.after(() => c.close());
  await c.init();
  const day = today();
  await c.call("expense_add", { amount: 61.50, currency: "EUR", merchant: "Taxi", project: "Nova Labs", date: day });
  const out = join(c.sandbox, "nova.csv");
  const r = await c.call("expense_export", { from: day, to: day, format: "csv", path: out, project: "Nova Labs" });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Wrote 1 expenses/);
  assert.doesNotMatch(r.text, /left out/);
});
