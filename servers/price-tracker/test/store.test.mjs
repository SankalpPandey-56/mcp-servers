/**
 * Codex v3 item 1 (P0): an unreadable price database must never be treated as
 * an empty one. Only ENOENT means "no data yet"; corrupt bytes are moved aside
 * and every tool fails until that is resolved.
 */
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "dist", "index.js");

const GARBAGE = '{"version":1,"watches":[{"id":"abc12345","url":"https://shop.example.com/p/1" ÿ not json';

function dataHome(bytes) {
  const root = mkdtempSync(join(tmpdir(), "pt-store-"));
  const dir = join(root, "data", "mcp-servers", "price-tracker");
  mkdirSync(dir, { recursive: true });
  if (bytes !== undefined) writeFileSync(join(dir, "watches.json"), bytes);
  return { home: join(root, "data"), dir, file: join(dir, "watches.json") };
}

async function loadIn(home) {
  process.env.XDG_DATA_HOME = home;
  return import(`../dist/store.js?${Math.random()}`);
}

test("a missing database file is an empty database", async () => {
  const { home } = dataHome();
  const store = await loadIn(home);
  assert.deepEqual(store.load(), { version: 1, watches: [] });
});

test("garbage bytes are preserved, not overwritten, and load fails loudly", async () => {
  const { home, dir, file } = dataHome(GARBAGE);
  const store = await loadIn(home);

  assert.throws(() => store.load(), (e) => {
    assert.equal(e.name, "StoreError");
    assert.match(e.message, /not valid JSON/);
    assert.match(e.message, /corrupt-/);
    return true;
  });

  // The original bytes survive under <file>.corrupt-<timestamp>.
  const kept = readdirSync(dir).filter((f) => f.startsWith("watches.json.corrupt-"));
  assert.equal(kept.length, 1, `expected one quarantined file, got ${JSON.stringify(readdirSync(dir))}`);
  assert.equal(readFileSync(join(dir, kept[0]), "utf8"), GARBAGE);
  assert.equal(existsSync(file), false);

  // The fault is sticky: no read and no write can happen while it stands.
  assert.throws(() => store.load(), (e) => e.name === "StoreError");
  assert.throws(() => store.save({ version: 1, watches: [] }), (e) => e.name === "StoreError");
});

test("JSON that is not a price-tracker database is quarantined too", async () => {
  const { home, dir } = dataHome('{"version":1,"watches":{"a":1}}');
  const store = await loadIn(home);
  assert.throws(() => store.load(), /not a price-tracker database/);
  assert.equal(readdirSync(dir).filter((f) => f.includes(".corrupt-")).length, 1);
});

/* The same fault seen through the server: every tool answers with an error. */

function client(env) {
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_CONFIG_HOME: join(tmpdir(), "pt-store-cfg"), MCP_LICENSE_KEY: "", ...env },
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
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const rid = ++id;
    const t = setTimeout(() => reject(new Error(`timeout on ${method}`)), 20000);
    pending.set(rid, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
  });
  return { send, stop: () => child.kill() };
}

test("every mutating tool reports the corrupt database instead of replacing it", async (t) => {
  const { home, dir, file } = dataHome(GARBAGE);
  const c = client({ XDG_DATA_HOME: home });
  t.after(() => c.stop());

  await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "store", version: "0" } });

  const calls = [
    ["price_add_manual", { url: "https://shop.example.com/p/1", price: "10.00", currency: "USD" }],
    ["watch_remove", { id: "abc12345" }],
    ["watch_list", {}],
  ];
  for (const [name, args] of calls) {
    const r = await c.send("tools/call", { name, arguments: args });
    const body = (r.result?.content ?? []).map((x) => x.text).join("\n");
    assert.equal(r.result?.isError, true, `${name} did not report an error: ${body}`);
    assert.match(body, /not valid JSON|corrupt-/, `${name}: ${body}`);
  }

  // Nothing was written back over the bad file, and the bytes are still there.
  assert.equal(existsSync(file), false);
  const kept = readdirSync(dir).filter((f) => f.startsWith("watches.json.corrupt-"));
  assert.equal(kept.length, 1);
  assert.equal(readFileSync(join(dir, kept[0]), "utf8"), GARBAGE);
});
