// D-R83: a URL handed to `path` must be refused by name, not resolved as a relative
// filesystem path (which used to leak the server's own cwd in the error text).
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function tmpHome() {
  const root = mkdtempSync(join(tmpdir(), "mcp-spreadsheet-"));
  mkdirSync(join(root, "data"), { recursive: true });
  mkdirSync(join(root, "config"), { recursive: true });
  return { root, env: { XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config") } };
}

class Client {
  constructor(env) {
    this.proc = spawn(process.execPath, [ENTRY], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, MCP_LICENSE_KEY: "", ...env },
    });
    this.buf = "";
    this.pending = new Map();
    this.id = 0;
    this.proc.stdout.on("data", (d) => {
      this.buf += d.toString();
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        const r = this.pending.get(msg.id);
        if (r) { this.pending.delete(msg.id); r(msg); }
      }
    });
    this.stderr = "";
    this.proc.stderr.on("data", (d) => { this.stderr += d.toString(); });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`timeout on ${method}: ${this.stderr}`)), 20000);
      this.pending.set(id, (m) => { clearTimeout(t); res(m); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params) { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }
  async init() {
    const r = await this.send("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke", version: "0" },
    });
    this.notify("notifications/initialized", {});
    return r;
  }
  async call(name, args) {
    const r = await this.send("tools/call", { name, arguments: args });
    assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
    return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
  }
  stop() { this.proc.kill(); }
}

test("sheet_info refuses a URL instead of resolving it against cwd", async (t) => {
  const { env } = tmpHome();
  const c = new Client(env);
  t.after(() => c.stop());
  await c.init();
  const r = await c.call("sheet_info", { path: "http://127.0.0.1:8794/data.xlsx" });
  assert.equal(r.isError, true);
  assert.match(r.text, /is a URL, not a file path/);
  assert.match(r.text, /sheet_load/);
  assert.doesNotMatch(r.text, /file not found/);
  // never leaks the server's cwd
  assert.equal(r.text.includes(process.cwd()), false);
});

test("sheet_read refuses a URL the same way", async (t) => {
  const { env } = tmpHome();
  const c = new Client(env);
  t.after(() => c.stop());
  await c.init();
  const r = await c.call("sheet_read", { path: "https://example.com/data.csv" });
  assert.equal(r.isError, true);
  assert.match(r.text, /is a URL, not a file path/);
});
