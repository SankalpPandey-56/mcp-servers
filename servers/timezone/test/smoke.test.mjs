import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-timezone-"));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config"),
      MCP_LICENSE_KEY: "",
      ...env,
    },
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
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    const to = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method}`)); } }, 20000);
    to.unref();
  });
  return {
    home, child, send,
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

async function init(c) {
  const r = await c.send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0" },
  });
  assert.ok(r.result?.serverInfo, "initialize failed");
  assert.equal(r.result.serverInfo.name, "mcp-timezone");
  c.notify("notifications/initialized", {});
  return r.result;
}

const THREE = [
  { name: "Me", zone: "Warsaw" },
  { name: "Client", zone: "New York" },
  { name: "Designer", zone: "London" },
];

test("stdio: initialize, tools/list, convert_time known answer", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);

  const list = await c.send("tools/list", {});
  const names = list.result.tools.map((x) => x.name).sort();
  assert.deepEqual(names, [
    "business_days", "contacts_list", "contacts_set", "convert_time", "dst_changes",
    "find_meeting_slots", "ics_create", "license_activate", "license_status", "now", "overlap",
  ]);
  for (const tool of list.result.tools) {
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} has no description`);
    assert.ok(tool.inputSchema, `${tool.name} has no input schema`);
  }

  // 15:00 in Warsaw on 2026-09-10 is 09:00 in New York and 18:30 in Kolkata
  const conv = await c.call("convert_time", {
    time: "2026-09-10 15:00", from_zone: "Warsaw", to_zones: ["New York", "India", "UTC"],
  });
  assert.equal(conv.isError, false, conv.text);
  assert.match(conv.text, /America\/New_York: 2026-09-10 09:00 Thu/);
  assert.match(conv.text, /Asia\/Kolkata: 2026-09-10 18:30 Thu/);
  assert.match(conv.text, /UTC instant: 2026-09-10T13:00:00\.000Z/);

  // an unknown place must suggest, not guess
  const bad = await c.call("convert_time", { time: "2026-09-10 15:00", from_zone: "Warsawa", to_zones: ["UTC"] });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Did you mean/);

  const now = await c.call("now", { zones: ["Warsaw", "Tokyo"] });
  assert.match(now.text, /Europe\/Warsaw/);
  assert.match(now.text, /Asia\/Tokyo/);

  const ov = await c.call("overlap", { zones: ["Warsaw", "New York"], date: "2026-09-10" });
  assert.match(ov.text, /Overlap: 2h 0m/, ov.text);

  const dst = await c.call("dst_changes", { zone: "Warsaw", year: 2026 });
  assert.match(dst.text, /2026-03-29T01:00:00\.000Z/);
  assert.match(dst.text, /2026-10-25T01:00:00\.000Z/);

  const bd = await c.call("business_days", { from: "2026-09-01", to: "2026-09-30", zone: "Warsaw", holidays: ["2026-09-15"] });
  assert.match(bd.text, /21 business day\(s\) of 30 calendar day\(s\)/);
});

test("find_meeting_slots: 3 participants, every slot inside every window", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);

  const r = await c.call("find_meeting_slots", {
    participants: THREE, duration_minutes: 60, days: 5, earliest_date: "2026-09-07",
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /slot\(s\) fit all 3 participants/);

  const lines = r.text.split("\n").filter((l) => /^\s+Me \d\d:\d\d/.test(l));
  assert.ok(lines.length >= 3, `expected several ranked slots, got:\n${r.text}`);
  for (const l of lines) {
    for (const m of l.matchAll(/(Me|Client|Designer) (\d\d):(\d\d)-(\d\d):(\d\d)/g)) {
      const start = Number(m[2]) * 60 + Number(m[3]);
      const end = Number(m[4]) * 60 + Number(m[5]);
      assert.ok(start >= 9 * 60, `${m[1]} starts at ${m[2]}:${m[3]}, before 09:00`);
      assert.ok(end <= 17 * 60, `${m[1]} ends at ${m[4]}:${m[5]}, after 17:00`);
    }
  }
  // ranked: the printed fairness scores are non-decreasing
  const scores = [...r.text.matchAll(/fairness (\d+\.\d\d)h/g)].map((m) => Number(m[1]));
  assert.ok(scores.length >= 3);
  for (let i = 1; i < scores.length; i++) assert.ok(scores[i] >= scores[i - 1], "not ranked by fairness");

  // a genuinely impossible pair says so instead of inventing a slot
  const none = await c.call("find_meeting_slots", {
    participants: [{ name: "A", zone: "New York" }, { name: "B", zone: "Bangalore" }],
    earliest_date: "2026-09-07",
  });
  assert.equal(none.isError, false);
  assert.match(none.text, /No slot fits everyone's working hours/);
});

test("free tier: a 4th participant is refused, Pro allows it", async (t) => {
  const key = execFileSync(process.execPath,
    [join(REPO, "scripts", "sign-license.mjs"), "timezone"], { encoding: "utf8" }).trim();
  assert.match(key, /^MCPL1\./);

  const free = client();
  t.after(() => free.close());
  await init(free);
  const st = await free.call("license_status", {});
  assert.match(st.text, /"tier": "free"/);

  const four = [...THREE, { name: "PM", zone: "Lisbon" }];
  const blocked = await free.call("find_meeting_slots", { participants: four, earliest_date: "2026-09-07" });
  assert.equal(blocked.isError, false, "a gate must not be an error result");
  assert.match(blocked.text, /free tier plans up to 3/i);
  assert.match(blocked.text, /mcp\.zovo\.one\/buy\/timezone/);

  const longSearch = await free.call("find_meeting_slots", { participants: THREE, days: 14, earliest_date: "2026-09-07" });
  assert.match(longSearch.text, /free tier searches up to 5 days/i);
  const rec = await free.call("find_meeting_slots", { participants: THREE, recurring: true, earliest_date: "2026-09-07" });
  assert.match(rec.text, /recurring-slot search/i);

  const pro = client({ MCP_LICENSE_KEY: key });
  t.after(() => pro.close());
  await init(pro);
  assert.match((await pro.call("license_status", {})).text, /"tier": "pro"/);
  const allowed = await pro.call("find_meeting_slots", { participants: four, days: 14, earliest_date: "2026-09-07", recurring: true });
  assert.equal(allowed.isError, false, allowed.text);
  assert.match(allowed.text, /fit all 4 participants/, allowed.text);
  assert.match(allowed.text, /Recurring \(works on all \d+ searched weekdays/);
});

test("contacts_set / contacts_list, the resource and the free contact limit", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);

  const set = await c.call("contacts_set", { name: "Maria", zone: "Lisbon", work_start: "10:00", work_end: "18:00" });
  assert.equal(set.isError, false, set.text);
  assert.match(set.text, /Saved Maria: Europe\/Lisbon, 10:00-18:00/);
  await c.call("contacts_set", { name: "Raj", zone: "Bangalore" });

  const list = await c.call("contacts_list", {});
  assert.match(list.text, /2 contact\(s\)/);
  assert.match(list.text, /Maria: Europe\/Lisbon/);
  assert.match(list.text, /Raj: Asia\/Kolkata/);

  const res = await c.send("resources/read", { uri: "tz://contacts" });
  assert.ok(res.result, JSON.stringify(res.error));
  assert.match(res.result.contents[0].text, /Maria\tEurope\/Lisbon/);

  const prompt = await c.send("prompts/get", { name: "schedule_with", arguments: { names: "Maria,Raj" } });
  assert.ok(prompt.result, JSON.stringify(prompt.error));
  const ptext = prompt.result.messages[0].content.text;
  assert.match(ptext, /Maria: zone Europe\/Lisbon, works 10:00-18:00/);
  assert.match(ptext, /Raj: zone Asia\/Kolkata/);

  for (const n of ["C3", "C4", "C5"]) await c.call("contacts_set", { name: n, zone: "UTC" });
  const sixth = await c.call("contacts_set", { name: "C6", zone: "UTC" });
  assert.equal(sixth.isError, false);
  assert.match(sixth.text, /free tier keeps 5/i);
  assert.match((await c.call("contacts_list", {})).text, /5 contact\(s\)/);
});

test("ics_create writes a valid file and the free monthly cap holds", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);

  const out = join(c.home, "kickoff.ics");
  const r = await c.call("ics_create", {
    title: "Kickoff with Acme", start: "2026-09-10 15:00", zone: "Warsaw",
    duration_minutes: 45, attendees: ["maria@acme.com"], description: "Scope and timeline",
    out_path: out,
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /DTSTART 2026-09-10T13:00:00\.000Z \(UTC\)/);
  const text = readFileSync(out, "utf8");
  assert.ok(text.startsWith("BEGIN:VCALENDAR\r\n"));
  assert.ok(text.includes("DTSTART:20260910T130000Z"), text);
  assert.ok(/\r\nUID:.+\r\n/.test(text), "UID missing");
  assert.ok(text.endsWith("END:VCALENDAR\r\n"));

  await c.call("ics_create", { title: "Two", start: "2026-09-11 15:00", zone: "Warsaw", duration_minutes: 30, out_path: join(c.home, "b.ics") });
  await c.call("ics_create", { title: "Three", start: "2026-09-12 15:00", zone: "Warsaw", duration_minutes: 30, out_path: join(c.home, "c.ics") });
  const fourth = await c.call("ics_create", { title: "Four", start: "2026-09-13 15:00", zone: "Warsaw", duration_minutes: 30, out_path: join(c.home, "d.ics") });
  assert.equal(fourth.isError, false);
  assert.match(fourth.text, /free tier writes 3/i);
});
