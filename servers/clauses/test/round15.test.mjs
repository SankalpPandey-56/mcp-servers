/**
 * Round 15, docs/USER_VALUE_R15.md. D-R80: clause_add collided with the 25 STARTER clauses
 * that ship with this server, and the error said only that the title "already exists" and
 * offered clause_update - which reads as "you wrote this before". A model spent four extra
 * calls searching for a clause of the caller's that was never there.
 */
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function client(profile) {
  const home = mkdtempSync(join(tmpdir(), "mcp-r15-"));
  const data = join(home, "data");
  if (profile) {
    mkdirSync(join(data, "mcp-servers", "profile"), { recursive: true });
    writeFileSync(join(data, "mcp-servers", "profile", "business.json"), JSON.stringify(profile));
  }
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(home, "cfg"), MCP_LICENSE_KEY: "" },
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
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    const to = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method}`)); } }, 25000);
    to.unref();
  });
  return {
    home, data, send,
    notify: (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n"),
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (!r.result) return { text: JSON.stringify(r.error), isError: true };
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}
async function init(c) {
  await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r15", version: "0" } });
  c.notify("notifications/initialized", {});
  return c;
}
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);


test("D-R80: a collision with a starter clause says it is a starter", async (t) => {
  const c = await init(client()); t.after(() => c.close());
  const r = await c.call("clause_add", {
    title: "Payment Terms", category: "payment", jurisdiction: "PL",
    body: "The Client shall pay each invoice within {{payment_days}} days of the invoice date.",
  });
  assert.ok(r.isError);
  assert.match(r.text, /STARTER clause/);
  assert.match(r.text, /payment-terms/);
  assert.match(r.text, /you have not saved a clause by this name/);
  // It names the two ways out, and one of them keeps both clauses.
  assert.match(r.text, /Payment Terms \(PL\)/);
  assert.match(r.text, /clause_update \{id: "payment-terms"\}/);
});

test("D-R80: a collision with the caller's OWN clause still says that, and differently", async (t) => {
  const c = await init(client()); t.after(() => c.close());
  const first = await c.call("clause_add", { title: "Retainer Scope", category: "scope", body: "Body one." });
  assert.ok(!first.isError, first.text);
  const r = await c.call("clause_add", { title: "Retainer Scope", category: "scope", body: "Body two." });
  assert.ok(r.isError);
  assert.match(r.text, /it is one of yours/);
  assert.doesNotMatch(r.text, /STARTER/);
});

test("D-R80: a title that collides with nothing is still saved", async (t) => {
  const c = await init(client()); t.after(() => c.close());
  const r = await c.call("clause_add", {
    title: "Payment Terms (Poland)", category: "payment", jurisdiction: "PL", tags: ["retainer"],
    body: "The Client shall pay each invoice within {{payment_days}} days.",
  });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /payment-terms-poland/);
});
