/**
 * Round 15, docs/USER_VALUE_R15.md. D-R82, the D-R64 species in a third server: asked for
 * "a slot that works for all three of us", the model produced NO tool call and asked the
 * user what timezone they are in - a fact the shared business profile has carried since
 * D-R31, and that this same server already reads for `now` and for the ICS organizer.
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


const PROFILE = { name: "Nova Studio", email: "studio@nova.example", timezone: "Europe/Warsaw" };

async function withContacts(t, profile = PROFILE) {
  const c = await init(client(profile)); t.after(() => c.close());
  await c.call("contacts_set", { name: "Ann", zone: "America/New_York" });
  await c.call("contacts_set", { name: "Kenji", zone: "Asia/Tokyo" });
  return c;
}

test("D-R82: a participant with no zone takes it from the saved contact", async (t) => {
  const c = await withContacts(t);
  const r = await c.call("find_meeting_slots", {
    participants: [{ name: "Ann" }, { name: "Kenji" }], duration_minutes: 60, days: 5,
  });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Ann: America\/New_York, from your saved contact "Ann"/);
  assert.match(r.text, /Kenji: Asia\/Tokyo, from your saved contact "Kenji"/);
});

test("D-R82: the caller needs no zone of their own - the shared profile supplies it", async (t) => {
  const c = await withContacts(t);
  const r = await c.call("find_meeting_slots", {
    participants: [{ name: "Me" }, { name: "Ann" }, { name: "Kenji" }], duration_minutes: 60, days: 5,
  });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /Me: Europe\/Warsaw, from your shared business profile/);
});

test("D-R82: an explicit zone still wins and is not annotated", async (t) => {
  const c = await withContacts(t);
  const r = await c.call("find_meeting_slots", {
    participants: [{ name: "Ann", zone: "Europe/Lisbon" }, { name: "Kenji" }], duration_minutes: 60, days: 5,
  });
  assert.ok(!r.isError, r.text);
  assert.doesNotMatch(r.text, /Ann: .*from your saved contact/);
  assert.match(r.text, /Kenji: Asia\/Tokyo, from your saved contact/);
});

test("D-R82: with no contact and no profile it refuses by naming both fixes, not by asking", async (t) => {
  const c = await init(client()); t.after(() => c.close());
  const r = await c.call("find_meeting_slots", { participants: [{ name: "Me" }, { name: "Ann" }] });
  assert.ok(r.isError);
  assert.match(r.text, /contacts_set \{name, zone\}/);
  assert.match(r.text, /business_set \{timezone/);
});

test("D-R82: contacts_list shows the caller's own zone alongside the contacts", async (t) => {
  const c = await withContacts(t);
  const r = await c.call("contacts_list", {});
  assert.match(r.text, /You: Europe\/Warsaw/);
  assert.match(r.text, /never need to pass your own zone/);
  assert.match(r.text, /Ann: America\/New_York/);
});

test("D-R82: with no profile, contacts_list says how to set the home zone once", async (t) => {
  const c = await init(client()); t.after(() => c.close());
  const r = await c.call("contacts_list", {});
  assert.match(r.text, /You: no timezone yet/);
  assert.match(r.text, /business_set \{timezone/);
});

// days: 7 so the window always holds weekdays; days: 3 from a Friday night is a weekend and found no slot on 2026-09-05
test("a saved contact's own working hours are used when none are passed", async (t) => {
  const c = await init(client(PROFILE)); t.after(() => c.close());
  await c.call("contacts_set", { name: "Ann", zone: "America/New_York", work_start: "11:00", work_end: "15:00" });
  const wide = await c.call("find_meeting_slots", { participants: [{ name: "Ann", zone: "America/New_York" }], duration_minutes: 60, days: 7 });
  const narrow = await c.call("find_meeting_slots", { participants: [{ name: "Ann" }], duration_minutes: 60, days: 7 });
  const count = (s) => Number((s.match(/^(\d+) slot/) || [])[1] ?? 0);
  assert.ok(count(narrow.text) > 0, narrow.text);
  assert.ok(count(narrow.text) < count(wide.text), `saved 11:00-15:00 must be narrower than the 09:00-17:00 default: ${count(narrow.text)} vs ${count(wide.text)}`);
});
