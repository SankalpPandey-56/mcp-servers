// Round 17, docs/USER_VALUE_R17.md, D-R85: an empty client_list must read as "no clients
// yet, but invoice_from_hours/invoice_create make one automatically" rather than a bare
// "Add one with client_add", which reads to a model as "this does not exist, ask first"
// even though the sentence it was given already named the client.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-invoice-r17-"));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), MCP_LICENSE_KEY: "", ...env },
  });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
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
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 15000);
    t.unref();
  });
  return {
    home,
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r17", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (!r.result) return { text: JSON.stringify(r.error), isError: true };
      return { text: r.result.content.map((x) => x.text).join("\n"), isError: r.result.isError === true };
    },
    close() { child.kill(); try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

test("D-R85: an empty client_list says invoice_from_hours/invoice_create create one automatically", async (t) => {
  const c = client(); t.after(() => c.close());
  await c.init();
  const r = await c.call("client_list", {});
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /No clients yet/);
  assert.match(r.text, /invoice_from_hours/);
  assert.match(r.text, /invoice_create/);
  assert.match(r.text, /automatically/);
});
