// Two server processes on one data dir must not lose writes.
// Same read-modify-write shape as the time-tracker loss measured in docs/AUDIT.md.
// Pro key: the free tier caps watches at 3.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const N = 20;
const KEY = execFileSync(process.execPath, [join(here, "..", "..", "..", "scripts", "sign-license.mjs"), "price-tracker"], { encoding: "utf8" }).trim();

function client(dataHome, tag) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dataHome, "cfg"), MCP_LICENSE_KEY: KEY },
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

test("two processes, one data dir: 40 concurrent price_add_manual all persist", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-pt-conc-"));
  const dataHome = join(sandbox, "data");
  const a = client(dataHome, "A");
  const b = client(dataHome, "B");
  try {
    await Promise.all([a.init(), b.init()]);
    const calls = [];
    for (let i = 0; i < N; i++) {
      for (const c of [a, b]) {
        calls.push(c.call("price_add_manual", {
          url: `https://example.invalid/item-${c.tag}-${i}`,
          price: `${100 + i}.00`, currency: "USD", label: `item ${c.tag} ${i}`,
        }));
      }
    }
    const results = await Promise.all(calls);
    assert.equal(results.length, 2 * N);
    for (const r of results) {
      assert.ok(r.result, `tools/call failed: ${JSON.stringify(r.error)}`);
      assert.notEqual(r.result.isError, true, `tool error: ${r.result.content?.[0]?.text}`);
    }
    const file = join(dataHome, "mcp-servers", "price-tracker", "watches.json");
    const db = JSON.parse(readFileSync(file, "utf8"));   // parses = valid JSON
    assert.equal(db.watches.length, 2 * N, `expected ${2 * N} watches, got ${db.watches.length}`);
    assert.equal(new Set(db.watches.map((w) => w.id)).size, 2 * N, "watch ids must be unique");
    assert.equal(new Set(db.watches.map((w) => w.url)).size, 2 * N, "urls must be unique");
    for (const w of db.watches) assert.equal(w.observations.length, 1);
  } finally {
    a.close(); b.close();
    try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
  }
});
