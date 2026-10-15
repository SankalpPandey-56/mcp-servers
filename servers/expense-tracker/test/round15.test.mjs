/**
 * Round 15, docs/USER_VALUE_R15.md. D-R77: the free 30-day window used to clamp `from`
 * forward past `to` and then describe the result as "covers <cutoff> onwards", a sentence
 * about a range that cannot exist. Nothing was read and the note said the opposite.
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


test("D-R77: a range entirely older than the free window says nothing was read", async (t) => {
  const c = await init(client()); t.after(() => c.close());
  const r = await c.call("expense_list", { from: iso(-120), to: iso(-90) });
  const out = JSON.parse(r.text);
  assert.equal(out.count, 0);
  assert.equal(out.nothing_read, true, "the payload must say the window was never opened");
  assert.match(out.note, /Nothing was read/);
  assert.match(out.note, /never opened/);
  // Non-vacuity in the other direction: the old sentence claimed coverage, and must be gone.
  assert.doesNotMatch(out.note, /so this covers .* onwards/);
  // And the window it reports must never end before it begins: the pre-fix payload printed
  // from 2026-08-05 next to to 2026-06-30, a range that cannot exist.
  assert.equal(out.from, null, "no window was read, so none is reported");
});

test("D-R77: a range that straddles the cutoff is still shortened and named, not refused", async (t) => {
  const c = await init(client()); t.after(() => c.close());
  await c.call("expense_add", { date: iso(-2), merchant: "Figma", amount: 45, currency: "EUR", category: "software" });
  const r = await c.call("expense_summary", { from: iso(-120), to: iso(0), group_by: "category" });
  const out = JSON.parse(r.text);
  assert.ok(!out.nothing_read, "part of this range IS inside the window");
  assert.match(out.note, /Free tier reads the last 30 days/);
  assert.ok(out.from <= out.to);
  assert.equal(out.by_currency[0].currency, "EUR");
  assert.equal(out.by_currency[0].total_gross, "EUR 45.00");
});

test("D-R77: a range wholly inside the window carries no note at all", async (t) => {
  const c = await init(client()); t.after(() => c.close());
  const r = await c.call("expense_list", { from: iso(-5), to: iso(0) });
  const out = JSON.parse(r.text);
  assert.equal(out.note, undefined);
  assert.equal(out.nothing_read, undefined);
});
