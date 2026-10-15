// Two server processes on one data dir must not lose writes, and must never hand out
// the same task id twice: the id counter lives in the file, so an unlocked
// load-mutate-save cycle would reissue it.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const N = 20;

function client(dataHome, tag) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dataHome, "cfg"), MCP_LICENSE_KEY: "" },
  });
  child.stderr.resume();
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
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 30000);
    t.unref();
  });
  return {
    tag, send,
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "conc", version: "0.0.0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: (name, args) => send("tools/call", { name, arguments: args ?? {} }),
    close() { child.kill(); },
  };
}

test("two processes, one data dir: 40 concurrent task_add all persist with unique ids", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-kb-conc-"));
  const dataHome = join(sandbox, "data");
  const a = client(dataHome, "A");
  const b = client(dataHome, "B");
  try {
    await Promise.all([a.init(), b.init()]);
    // both writers target ONE board, so both compete for the same id counter
    await a.call("task_add", { project: "Shared Board", title: "seed" });
    const calls = [];
    for (let i = 0; i < N; i++) {
      for (const c of [a, b]) calls.push(c.call("task_add", { project: "Shared Board", title: `t-${c.tag}-${i}` }));
    }
    const results = await Promise.all(calls);
    assert.equal(results.length, 2 * N);
    for (const r of results) {
      assert.ok(r.result, `tools/call failed: ${JSON.stringify(r.error)}`);
      assert.notEqual(r.result.isError, true, `tool error: ${r.result.content?.[0]?.text}`);
    }
    const file = join(dataHome, "mcp-servers", "kanban", "data.json");
    const db = JSON.parse(readFileSync(file, "utf8"));            // parses = valid JSON
    assert.equal(db.tasks.length, 2 * N + 1, `expected ${2 * N + 1} tasks, got ${db.tasks.length}`);
    const ids = new Set(db.tasks.map(t => t.id));
    assert.equal(ids.size, 2 * N + 1, "task ids must be unique");
    assert.equal(Object.keys(db.boards).length, 1, "one board, not one per writer");
    assert.equal(db.boards["shared board"].counter, 2 * N + 1);
    for (const t of ["A", "B"]) {
      assert.equal(db.tasks.filter(x => x.title.startsWith(`t-${t}-`)).length, N);
    }
  } finally {
    a.close(); b.close();
    try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
  }
});
