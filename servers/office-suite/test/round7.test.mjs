// Round-7 fix (docs/USER_VALUE_R7.md): D-R29 - when the bundle renames a colliding tool
// (business_set -> invoice_business_set / docx_business_set) the child's own prose still
// named the tool that no longer exists. The proxy now rewrites the child's text and
// publishes a tools_map resource.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
// invoice and docx both register business_set, exactly like the real servers do.
const CHILD_IDS = ["time-tracker", "price-tracker", "spreadsheet", "invoice", "docx"];
const COLLIDING = new Set(["invoice", "docx"]);

function stubSource(id, collides) {
  return `
const ID = ${JSON.stringify(id)};
const COLLIDES = ${collides ? "true" : "false"};
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
const text = (t) => ({ content: [{ type: "text", text: t }] });
function handle(msg) {
  if (msg.id === undefined) return;
  const reply = (result) => send({ jsonrpc: "2.0", id: msg.id, result });
  const err = (c, m) => send({ jsonrpc: "2.0", id: msg.id, error: { code: c, message: m } });
  switch (msg.method) {
    case "initialize":
      return reply({ protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: ID, version: "0.0.0" } });
    case "tools/list": {
      const tools = [
        { name: ID.replace(/-/g, "_") + "_probe", description: "probe", inputSchema: { type: "object", properties: {} } },
        { name: "license_status", description: "s", inputSchema: { type: "object", properties: {} } },
        { name: "license_activate", description: "a", inputSchema: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } },
      ];
      if (COLLIDES) tools.push({ name: "business_set", description: "set business", inputSchema: { type: "object", properties: {} } });
      return reply({ tools });
    }
    case "resources/list":
    case "prompts/list":
      return err(-32601, "not supported");
    case "tools/call": {
      const name = msg.params.name;
      if (name === "license_status") return reply(text(JSON.stringify({ product: ID, pro: false })));
      if (name === "license_activate") return reply(text("Pro activated on " + ID));
      if (name === "business_set") return reply(text("Saved on " + ID + "."));
      // The defect text: a child telling the user to call a tool by its own name.
      return reply(text("No business details yet. Run business_set {name, address, email, vat_id} and create it again. (business_set_extra and my_business_set are other words.)"));
    }
    default:
      return err(-32601, "unknown method " + msg.method);
  }
}
`;
}

function suite() {
  const root = mkdtempSync(join(tmpdir(), "mcp-office-r7-"));
  const suiteDist = join(root, "servers", "office-suite", "dist");
  mkdirSync(suiteDist, { recursive: true });
  cpSync(dirname(ENTRY), suiteDist, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "r7-fixture", type: "module" }));
  mkdirSync(join(root, "node_modules"), { recursive: true });
  try {
    symlinkSync(join(here, "..", "..", "..", "node_modules", "@modelcontextprotocol"), join(root, "node_modules", "@modelcontextprotocol"), "dir");
  } catch { /* already there */ }
  for (const id of CHILD_IDS) {
    const d = join(root, "servers", id, "dist");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "index.js"), stubSource(id, COLLIDING.has(id)));
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
    send,
    get stderr() { return stderr; },
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

test("D-R29: a renamed tool is renamed in the child's text too, per child", async (t) => {
  const s = suite();
  t.after(() => s.close());
  await s.init();

  const list = await s.send("tools/list", {});
  const names = list.result.tools.map((x) => x.name);
  assert.ok(names.includes("invoice_business_set"), names.join(","));
  assert.ok(names.includes("docx_business_set"), names.join(","));
  assert.equal(names.includes("business_set"), false);

  // invoice's own prose must name invoice_business_set ...
  const inv = await s.call("invoice_probe", {});
  assert.match(inv.text, /Run invoice_business_set \{name, address, email, vat_id\}/);
  assert.equal(/Run business_set/.test(inv.text), false, inv.text);
  // ... and docx's the docx one: the rewrite is per child, not global.
  const dx = await s.call("docx_probe", {});
  assert.match(dx.text, /Run docx_business_set \{name, address, email, vat_id\}/);

  // whole words only: business_set_extra and my_business_set are left alone
  assert.match(inv.text, /business_set_extra and my_business_set are other words/);

  // a child that never collided keeps its text untouched
  const st = await s.call("spreadsheet_probe", {});
  assert.match(st.text, /Run business_set \{name, address, email, vat_id\}/);

  // the rename is announced once on startup
  assert.match(s.stderr, /renamed 2 colliding tools: (invoice\.business_set -> invoice_business_set|docx\.business_set -> docx_business_set)/);
});

test("D-R29: tools_map resource lists exposed name -> child.tool", async (t) => {
  const s = suite();
  t.after(() => s.close());
  await s.init();

  const list = await s.send("resources/list", {});
  const uris = list.result.resources.map((r) => r.uri);
  assert.ok(uris.includes("office://tools_map"), uris.join(","));

  const read = await s.send("resources/read", { uri: "office://tools_map" });
  const map = JSON.parse(read.result.contents[0].text);
  assert.deepEqual(map.renamed.sort((a, b) => a.exposed.localeCompare(b.exposed)), [
    { exposed: "docx_business_set", child: "docx.business_set" },
    { exposed: "invoice_business_set", child: "invoice.business_set" },
  ]);
  const byName = Object.fromEntries(map.tools.map((r) => [r.exposed, r.child]));
  assert.equal(byName["invoice_business_set"], "invoice.business_set");
  assert.equal(byName["spreadsheet_probe"], "spreadsheet.spreadsheet_probe");
});
