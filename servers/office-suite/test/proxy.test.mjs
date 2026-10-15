// Regressions for the office-suite proxy findings in docs/CODEX_REVIEW_V2.md.
//
// The suite resolves its children as ../../<id>/dist/index.js relative to its own dist
// directory, so the test builds a throwaway tree of that exact shape inside the package,
// drops the real built suite into it and points it at stub children. The stubs are plain
// stdio JSON-RPC servers: no SDK, so their behaviour (a flood of stderr, a rejected
// license key) is exactly what the test needs to provoke.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const CHILD_IDS = ["time-tracker", "price-tracker", "spreadsheet", "invoice", "expense-tracker"];

/** 200 KB is well past the OS pipe buffer (64 KB on Linux, 8-64 KB on macOS). */
const STDERR_BYTES = 200 * 1024;

function stubSource({ id, loud, rejectLicense }) {
  return `
const LOUD = ${loud ? "true" : "false"};
const REJECT = ${rejectLicense ? "true" : "false"};
const ID = ${JSON.stringify(id)};
let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString();
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (line) handle(JSON.parse(line));
  }
});
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const text = (t, isError) => ({ content: [{ type: "text", text: t }], isError: isError === true });
function handle(msg) {
  if (msg.id === undefined) return; // notification
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  const err = (code, message) => send({ jsonrpc: "2.0", id: msg.id, error: { code, message } });
  switch (msg.method) {
    case "initialize":
      return reply({
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: ID, version: "0.0.0" },
      });
    case "tools/list":
      return reply({ tools: [
        { name: ID.replace(/-/g, "_") + "_probe", description: "probe", inputSchema: { type: "object", properties: {} } },
        { name: "license_status", description: "s", inputSchema: { type: "object", properties: {} } },
        { name: "license_activate", description: "a", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
      ] });
    case "resources/list":
    case "prompts/list":
      return err(-32601, "not supported");
    case "tools/call": {
      const name = msg.params.name;
      if (name === "license_activate") {
        return reply(REJECT ? text("Error: key rejected by " + ID, true) : text("Pro activated on " + ID));
      }
      if (name === "license_status") return reply(text(JSON.stringify({ product: ID, pro: false })));
      if (LOUD) {
        // Write past the pipe buffer BEFORE answering. Unless the parent drains this
        // stream, the write blocks here and the tools/call below never goes out.
        process.stderr.write("x".repeat(${STDERR_BYTES}) + "\\n");
      }
      return reply(text("ok from " + ID));
    }
    default:
      return err(-32601, "unknown method " + msg.method);
  }
}
`;
}

/** Build the throwaway monorepo tree and spawn the real suite inside it. */
function suite({ loudChild = "time-tracker", rejectLicenseChild = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "mcp-office-proxy-"));
  const suiteDist = join(root, "servers", "office-suite", "dist");
  mkdirSync(suiteDist, { recursive: true });
  cpSync(dirname(ENTRY), suiteDist, { recursive: true });
  // The copied suite must still resolve @modelcontextprotocol/sdk.
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "proxy-fixture", type: "module" }));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  try {
    require("node:fs").symlinkSync(join(here, "..", "..", "..", "node_modules", "@modelcontextprotocol"), join(root, "node_modules", "@modelcontextprotocol"), "dir");
  } catch { /* set up below instead */ }
  for (const id of CHILD_IDS) {
    const d = join(root, "servers", id, "dist");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "index.js"), stubSource({ id, loud: id === loudChild, rejectLicense: id === rejectLicenseChild }));
  }
  const child = spawn(process.execPath, [join(suiteDist, "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(root, "data"), XDG_CONFIG_HOME: join(root, "config"), MCP_LICENSE_KEY: "" },
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    }
  });
  let id = 0;
  const send = (method, params, timeoutMs = 15000) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, timeoutMs);
    t.unref();
  });
  return {
    root, send,
    get stderr() { return stderr; },
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async call(name, args, timeoutMs) {
      const r = await send("tools/call", { name, arguments: args ?? {} }, timeoutMs);
      assert.ok(r.result, `tools/call ${name}: ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: r.result.isError === true };
    },
    close() { try { child.kill(); } catch {} rmSync(root, { recursive: true, force: true }); },
  };
}

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

test("D-P25: a child that floods stderr does not stall a tools/call", async (t) => {
  const s = suite({ loudChild: "time-tracker" });
  t.after(() => s.close());
  await s.init();
  const started = Date.now();
  // 200 KB of child stderr arrives before the answer. With an undrained pipe the child
  // blocks in write() and this call never returns.
  const r = await s.call("time_tracker_probe", {}, 10000);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /ok from time-tracker/);
  assert.ok(Date.now() - started < 10000);
  // the flood is forwarded to our stderr, tagged with the child it came from
  assert.match(s.stderr, /\[time-tracker\] x{100}/);
  // and the suite is still usable afterwards
  assert.match((await s.call("invoice_probe", {}, 10000)).text, /ok from invoice/);
});

test("D-P24: license_activate fails unless every child accepts the key", async (t) => {
  const s = suite({ rejectLicenseChild: "invoice" });
  t.after(() => s.close());
  await s.init();
  const bad = await s.call("license_activate", { key: "MCPL1.aaa.bbb" }, 15000);
  assert.equal(bad.isError, true, bad.text);
  assert.match(bad.text, /1 of 5 servers did not accept the key \(invoice\)/);
  assert.match(bad.text, /FAILED\s+invoice: Error: key rejected by invoice/);
  assert.match(bad.text, /OK\s+time-tracker: Pro activated on time-tracker/);
  // every connected child is listed, accepted or not
  for (const id of CHILD_IDS) assert.match(bad.text, new RegExp(`${id}:`));

  const s2 = suite({});
  t.after(() => s2.close());
  await s2.init();
  const good = await s2.call("license_activate", { key: "MCPL1.aaa.bbb" }, 15000);
  assert.equal(good.isError, false, good.text);
  assert.match(good.text, /Activated on all 5 servers/);
});
