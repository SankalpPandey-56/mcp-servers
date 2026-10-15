/**
 * Round 17, docs/USER_VALUE_R17.md, D-R84: find_meeting_slots never said which days it
 * actually searched, so "this week" asked for on a Saturday silently became next Monday
 * with no warning anywhere in the payload or the answer.
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
  const home = mkdtempSync(join(tmpdir(), "mcp-r17-"));
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
  await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r17", version: "0" } });
  c.notify("notifications/initialized", {});
  return c;
}

const PROFILE = { name: "Nova Studio", email: "studio@nova.example", timezone: "Europe/Warsaw" };

test("D-R84: find_meeting_slots always reports the window it searched", async (t) => {
  const c = await init(client(PROFILE)); t.after(() => c.close());
  await c.call("contacts_set", { name: "Ann", zone: "America/New_York" });
  // 2026-09-05 is a Saturday. earliest_date pins the search so the test is deterministic.
  const r = await c.call("find_meeting_slots", {
    participants: [{ name: "Ann" }, { name: "Me" }],
    duration_minutes: 45, days: 5, earliest_date: "2026-09-05",
  });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Searched 2026-09-05 to 2026-09-09/);
  // The window runs Sat 09-05 through Wed 09-09: past the calendar week's Sunday boundary.
  assert.match(r.text, /past this calendar week's end/);
  assert.match(r.text, /Monday|09-07/);
});

test("D-R84: a window fully inside the current week carries no rollover warning", async (t) => {
  const c = await init(client(PROFILE)); t.after(() => c.close());
  await c.call("contacts_set", { name: "Ann", zone: "America/New_York" });
  // 2026-09-07 is a Monday; a 3-day search (Mon-Wed) never reaches Sunday.
  const r = await c.call("find_meeting_slots", {
    participants: [{ name: "Ann" }, { name: "Me" }],
    duration_minutes: 45, days: 3, earliest_date: "2026-09-07",
  });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Searched 2026-09-07 to 2026-09-09/);
  assert.doesNotMatch(r.text, /past this calendar week's end/);
});
