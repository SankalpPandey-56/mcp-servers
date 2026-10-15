import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

/** Minimal stdio JSON-RPC client for one server process (same shape as smoke.test.mjs). */
function client(env) {
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-tt-spec-"));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_DATA_HOME: join(sandbox, "data"),
      XDG_CONFIG_HOME: join(sandbox, "config"),
      MCP_LICENSE_KEY: "",
      ...env,
    },
  });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", chunk => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 10000);
    t.unref();
  });
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return {
    send, notify, sandbox,
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned no result: ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map(c => c.text).join("\n"), isError: r.result.isError === true };
    },
    async init() {
      const r = await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "spec", version: "0.0.0" },
      });
      assert.equal(r.result.serverInfo.name, "mcp-time-tracker");
      notify("notifications/initialized");
      return r.result;
    },
    close() {
      child.kill();
      try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
    },
  };
}

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

test("spec tools are advertised by tools/list", async () => {
  const c = client({});
  try {
    await c.init();
    const list = await c.send("tools/list", {});
    const names = list.result.tools.map(t => t.name);
    for (const n of ["entry_log", "entry_list", "summary_day", "summary_week", "summary_client", "export_csv", "target_set", "target_check"])
      assert.ok(names.includes(n), `missing spec tool ${n}`);
  } finally { c.close(); }
});

test("entry_log creates an entry on today's local day and is visible via entry_list", async () => {
  const c = client({});
  try {
    await c.init();
    const res = await c.call("entry_log", { client: "acme", project: "api work", minutes: 45, note: "rest endpoints" });
    assert.match(res.text, /Logged 45 min for "acme" \(api work\)/);
    assert.match(res.text, new RegExp(localDay()));
    assert.match(res.text, /Entry id: /);
    const list = await c.call("entry_list", {});
    assert.match(list.text, /acme/);
    assert.match(list.text, /rest endpoints/);
  } finally { c.close(); }
});

test("summary_day totals minutes logged today, per project", async () => {
  const c = client({});
  try {
    await c.init();
    await c.call("entry_log", { client: "acme", minutes: 60 });
    await c.call("entry_log", { client: "globex", minutes: 30 });
    await c.call("entry_log", { client: "acme", minutes: 15 });
    const res = await c.call("summary_day", {});
    assert.match(res.text, /1.75 h across 3 entries/);
    assert.match(res.text, /acme/);
    assert.match(res.text, /globex/);
    // acme should be listed first (75 min > 30 min)
    const acmeAt = res.text.indexOf("acme");
    const globexAt = res.text.indexOf("globex");
    assert.ok(acmeAt >= 0 && globexAt > acmeAt, "projects not sorted by hours desc");
    const empty = await c.call("summary_day", { date: "2001-02-03" });
    assert.match(empty.text, /Day 2001-02-03: 0.00 h across 0 entries/);
  } finally { c.close(); }
});

test("summary_week includes today's entries in the Mon-Sun window", async () => {
  const c = client({});
  try {
    await c.init();
    await c.call("entry_log", { client: "acme", minutes: 90 });
    const res = await c.call("summary_week", {});
    assert.match(res.text, /Week of \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}: 1.50 h across 1 entry/);
    assert.match(res.text, /acme/);
  } finally { c.close(); }
});

test("summary_client aggregates all-time hours for one client", async () => {
  const c = client({});
  try {
    await c.init();
    await c.call("entry_log", { client: "acme", minutes: 60 });
    await c.call("entry_log", { client: "acme", minutes: 30 });
    await c.call("entry_log", { client: "globex", minutes: 45 });
    const res = await c.call("summary_client", { client: "acme" });
    assert.match(res.text, /Client "acme": 1.50 h across 2 entries/);
    assert.match(res.text, new RegExp(localDay()));
    assert.doesNotMatch(res.text, /globex/);
  } finally { c.close(); }
});

test("target_set persists and target_check reports percent + remaining", async () => {
  const c = client({});
  try {
    await c.init();
    const none = await c.call("target_check", {});
    assert.match(none.text, /No weekly target set/);
    const set = await c.call("target_set", { weekly_hours: 10 });
    assert.match(set.text, /Weekly target set: 10 h\/week/);
    await c.call("entry_log", { client: "acme", minutes: 150 }); // 2.5 h
    const res = await c.call("target_check", {});
    assert.match(res.text, /2\.50 h of 10 h target \(25%\)/);
    assert.match(res.text, /7\.50 h remaining/);
  } finally { c.close(); }
});

test("free tier: entry_log is gated at 100 stored entries", async () => {
  const c = client({});
  try {
    await c.init();
    // Seed the sandbox DB directly with 100 entries (keeps the test fast).
    const now = new Date();
    const entries = Array.from({ length: 100 }, (_, i) => ({
      id: `seed${String(i).padStart(3, "0")}`,
      project: "acme",
      task: null,
      tags: [],
      start: new Date(now.getTime() - (i + 1) * 3600000).toISOString(),
      end: new Date(now.getTime() - i * 3600000).toISOString(),
      seconds: 3600,
      note: null,
      billable: true,
      rateCents: 0,
      currency: "USD",
    }));
    mkdirSync(join(c.sandbox, "data", "mcp-servers", "time-tracker"), { recursive: true });
    writeFileSync(
      join(c.sandbox, "data", "mcp-servers", "time-tracker", "data.json"),
      JSON.stringify({ version: 1, running: null, entries, projects: {}, targetHours: 0 }),
    );
    const res = await c.call("entry_log", { client: "acme", minutes: 10 });
    assert.match(res.text, /free tier|upgrade|100 stored entries/i);
    assert.equal(res.isError, false);
  } finally { c.close(); }
});
