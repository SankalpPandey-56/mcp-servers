// Two server processes on one data dir must not lose writes.
// Without the advisory lock around load-mutate-save, interleaved read-modify-write
// cycles silently drop roughly half of these adds.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// D-R15: "today" is the LOCAL calendar date in every server; a UTC slice disagrees
// with it for any run before UTC midnight in a positive-offset zone.
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

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
  child.stdout.on("data", (chunk) => {
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

test("two processes, one data dir: 40 concurrent expense_add all persist", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-exp-conc-"));
  const dataHome = join(sandbox, "data");
  const a = client(dataHome, "A");
  const b = client(dataHome, "B");
  const today = localDay();
  try {
    await Promise.all([a.init(), b.init()]);
    const calls = [];
    for (let i = 0; i < N; i++) {
      calls.push(a.call("expense_add", { amount: 1 + i / 100, currency: "EUR", merchant: `A${i}`, date: today }));
      calls.push(b.call("expense_add", { amount: 1 + i / 100, currency: "PLN", merchant: `B${i}`, date: today }));
    }
    const results = await Promise.all(calls);
    for (const r of results) assert.ok(r.result && !r.result.isError, `add failed: ${JSON.stringify(r)}`);

    const db = JSON.parse(readFileSync(join(dataHome, "mcp-servers", "expense-tracker", "data.json"), "utf8"));
    assert.equal(db.expenses.length, 2 * N, `expected ${2 * N} stored expenses, found ${db.expenses.length}`);
    assert.equal(new Set(db.expenses.map((e) => e.id)).size, 2 * N, "ids must be unique");
    assert.equal(db.expenses.filter((e) => e.currency === "EUR").length, N);
    assert.equal(db.expenses.filter((e) => e.currency === "PLN").length, N);
  } finally {
    a.close(); b.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
