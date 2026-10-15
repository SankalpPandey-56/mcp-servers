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

/** Minimal stdio JSON-RPC client for the bundle process. */
function client(env) {
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-office-suite-"));
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
  let stderr = "";
  child.stderr.on("data", d => { stderr += d.toString(); });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", chunk => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}: ${stderr}`)); } }, 20000);
    t.unref();
  });
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return {
    send, notify, sandbox,
    get stderr() { return stderr; },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned no result: ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map(c => c.text).join("\n"), isError: r.result.isError === true };
    },
    async init() {
      const r = await send("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke", version: "0.0.0" },
      });
      assert.equal(r.result.serverInfo.name, "office-suite");
      notify("notifications/initialized");
      return r.result;
    },
    close() {
      child.kill();
      try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
    },
  };
}

test("bundle proxies tools/list, forwards calls, and aggregates license_status", async () => {
  const c = client({});
  try {
    await c.init();

    const list = await c.send("tools/list", {});
    const names = list.result.tools.map(t => t.name);
    for (const n of ["timer_start", "price_check", "sheet_info", "invoice_create"]) {
      assert.ok(names.includes(n), `missing proxied tool ${n}`);
    }
    assert.equal(names.filter(n => n === "license_status").length, 1, "exactly one license_status");
    assert.equal(names.filter(n => n === "license_activate").length, 1, "exactly one license_activate");

    // timer_start through the proxy
    const start = await c.call("timer_start", { project: "acme", task: "office-suite smoke" });
    assert.equal(start.isError, false);
    assert.match(start.text, /Started timer for "acme"/);

    // invoice_create through the proxy
    await c.call("business_set", { name: "Test Co", default_currency: "EUR" });
    const inv = await c.call("invoice_create", {
      client: "Acme Corp",
      items: [{ description: "Consulting", quantity: 2, unit_price: 90 }],
    });
    assert.equal(inv.isError, false, inv.text);
    assert.match(inv.text, /INV/);

    // license_status aggregates all children
    const status = await c.call("license_status");
    assert.equal(status.isError, false);
    const parsed = JSON.parse(status.text);
    assert.equal(parsed.product, "bundle");
    for (const id of ["time-tracker", "price-tracker", "spreadsheet", "invoice"]) {
      assert.ok(parsed.children[id], `license_status missing child ${id}`);
    }

    // unknown tool: clean error, not a thrown exception
    const bad = await c.call("no_such_tool", {});
    assert.equal(bad.isError, true);
    assert.match(bad.text, /unknown tool/);

    const res = await c.send("resources/list", {});
    assert.ok(Array.isArray(res.result.resources));
    const prm = await c.send("prompts/list", {});
    assert.ok(Array.isArray(prm.result.prompts));
  } finally {
    c.close();
  }
});
