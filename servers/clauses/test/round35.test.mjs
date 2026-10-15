// Loop 35, defect ledger D-R81 (docs/USER_VALUE_R15.md): on the free tier clause_search
// skips the tag filter and said so, but did not name the free tool that has the answer -
// clause_list returns every clause's tags. The skip message must now point at it.
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

function client(sandbox = mkdtempSync(join(tmpdir(), "mcp-cl-r35-"))) {
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

test("D-R81: the free-tier tag-skip note names clause_list as the free path", async (t) => {
  const c = client(); t.after(() => c.close());
  await c.init();
  const r = await c.call("clause_search", { query: "payment", tags: ["retainer"] });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /tag filter \(retainer\) was not applied/);
  assert.match(r.text, /clause_list is free and returns every clause's tags/);
});

test("D-R81: a search without tags carries no tag-skip note at all", async (t) => {
  const c = client(); t.after(() => c.close());
  await c.init();
  const r = await c.call("clause_search", { query: "payment" });
  assert.ok(!r.isError, r.text);
  assert.doesNotMatch(r.text, /was not applied/);
  assert.doesNotMatch(r.text, /clause_list is free/);
});
