// Codex v3 #1 (P0): a corrupt data file is never read as an empty database.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function client(sandbox) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(sandbox, "data"), XDG_CONFIG_HOME: join(sandbox, "config"), MCP_LICENSE_KEY: "" },
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
  return {
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      const text = r.result ? r.result.content.map(c => c.text).join("\n") : JSON.stringify(r.error);
      return { text, isError: r.result ? r.result.isError === true : true };
    },
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "corrupt", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    },
    close() { child.kill(); try { rmSync(sandbox, { recursive: true, force: true }); } catch {} },
  };
}

const GARBAGE = '{"version":1,"expenses":[{"id":"aa"  <<< truncated by a crash';

test("#1 P0: garbage in data.json is quarantined byte-for-byte and every tool refuses", async (t) => {
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-exp-corrupt-"));
  const dir = join(sandbox, "data", "mcp-servers", "expense-tracker");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "data.json"), GARBAGE);

  const c = client(sandbox);
  t.after(() => c.close());
  await c.init();

  const add = await c.call("expense_add", { amount: 61.5, currency: "EUR", merchant: "Media Markt" });
  assert.equal(add.isError, true, add.text);
  assert.match(add.text, /data file is corrupt; moved to .*\.corrupt-/);
  assert.match(add.text, /nothing was written/);

  const moved = readdirSync(dir).filter(f => f.includes(".corrupt-"));
  assert.equal(moved.length, 1, JSON.stringify(readdirSync(dir)));
  assert.equal(readFileSync(join(dir, moved[0]), "utf8"), GARBAGE, "the original bytes must survive untouched");
  assert.equal(readdirSync(dir).includes("data.json"), false, "no empty database was written over the corrupt one");

  const read = await c.call("expense_list", {});
  assert.equal(read.isError, true, read.text);
  assert.match(read.text, /data file is corrupt/);
});
