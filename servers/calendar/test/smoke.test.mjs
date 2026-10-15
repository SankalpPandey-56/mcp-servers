// End to end over stdio JSON-RPC, the way a client drives it.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");
const ics = await import(join(here, "..", "dist", "ics.js"));

const CRLF = (lines) => lines.join("\r\n") + "\r\n";

/**
 * Six events: two that overlap, one weekly recurrence, one whole day, one with
 * attendees, one marked free. Folded, escaped and TZID lines are all present because
 * every real export has them.
 */
const FIXTURE = CRLF([
  "BEGIN:VCALENDAR",
  "VERSION:2.0",
  "PRODID:-//Google Inc//Google Calendar 70.9054//EN",
  "CALSCALE:GREGORIAN",
  "X-WR-CALNAME:Work",
  "BEGIN:VTIMEZONE",
  "TZID:Europe/Warsaw",
  "BEGIN:DAYLIGHT", "DTSTART:19700329T020000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0200", "TZNAME:CEST", "END:DAYLIGHT",
  "END:VTIMEZONE",
  // 1: kickoff, TZID, folded summary
  "BEGIN:VEVENT", "UID:kickoff@fixture",
  "DTSTART;TZID=Europe/Warsaw:20260309T100000", "DTEND;TZID=Europe/Warsaw:20260309T110000",
  "SUMMARY:Acme\\, Ltd kickoff with the whole",
  "  delivery team",
  "LOCATION:Room 4",
  "END:VEVENT",
  // 2: overlaps event 1 by 30 minutes
  "BEGIN:VEVENT", "UID:clash@fixture",
  "DTSTART;TZID=Europe/Warsaw:20260309T103000", "DTEND;TZID=Europe/Warsaw:20260309T113000",
  "SUMMARY:Dentist", "END:VEVENT",
  // 3: weekly recurrence, three Tuesdays
  "BEGIN:VEVENT", "UID:standup@fixture",
  "DTSTART:20260310T080000Z", "DTEND:20260310T081500Z",
  "RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3", "SUMMARY:Standup", "END:VEVENT",
  // 4: whole day
  "BEGIN:VEVENT", "UID:offsite@fixture",
  "DTSTART;VALUE=DATE:20260311", "DTEND;VALUE=DATE:20260312", "SUMMARY:Offsite", "END:VEVENT",
  // 5: client call with attendees and a DURATION instead of DTEND
  "BEGIN:VEVENT", "UID:clientcall@fixture",
  "DTSTART:20260312T140000Z", "DURATION:PT1H",
  "SUMMARY:Client call", "DESCRIPTION:Scope and rate\\nBring the estimate",
  "ORGANIZER;CN=\"Mike\":mailto:mike@example.com",
  "ATTENDEE;CN=Maria;RSVP=TRUE:mailto:maria@acme.com",
  "ATTENDEE;CN=Tom Rivera;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:tom@nova.example",
  "END:VEVENT",
  // 6: free/transparent, so it must not count as busy
  "BEGIN:VEVENT", "UID:fyi@fixture",
  "DTSTART:20260313T090000Z", "DTEND:20260313T170000Z",
  "TRANSP:TRANSPARENT", "SUMMARY:Conference (watching)", "END:VEVENT",
  "END:VCALENDAR",
]);

const SECOND = CRLF([
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Apple Inc.//macOS 15//EN",
  "BEGIN:VEVENT", "UID:family@fixture", "DTSTART:20260309T090000Z", "DTEND:20260309T093000Z",
  "SUMMARY:School run", "END:VEVENT",
  "END:VCALENDAR",
]);

function client(env) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MCP_LICENSE_KEY: "", ...env },
  });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
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
    send,
    async init() {
      const r = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return r;
    },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `${name} failed: ${JSON.stringify(r.error)}`);
      return { text: r.result.content?.[0]?.text ?? "", isError: r.result.isError === true };
    },
    close() { child.kill(); },
  };
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-cal-"));
  const fixture = join(dir, "work.ics");
  writeFileSync(fixture, FIXTURE, "utf8");
  const second = join(dir, "family.ics");
  writeFileSync(second, SECOND, "utf8");
  return {
    dir, fixture, second,
    env: { XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "cfg") },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const proKey = () => execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "calendar"], { encoding: "utf8" }).trim();

test("initialize, tools/list, and the whole free-tier flow", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    const init = await c.init();
    assert.equal(init.result.serverInfo.name, "mcp-calendar");

    const list = await c.send("tools/list", {});
    const names = list.result.tools.map(t => t.name).sort();
    for (const want of ["calendars_list", "conflicts", "event_export", "event_to_time_entry", "events_list",
      "events_search", "free_busy", "ics_forget", "ics_import", "license_activate", "license_status", "next_event"]) {
      assert.ok(names.includes(want), `missing tool ${want}; got ${names.join(", ")}`);
    }

    // import
    const imp = await c.call("ics_import", { path: s.fixture, name: "work" });
    assert.equal(imp.isError, false, imp.text);
    assert.match(imp.text, /6 event definition\(s\), 1 recurring/);
    assert.match(imp.text, /named "Work" in the file/);

    const cals = await c.call("calendars_list", {});
    assert.match(cals.text, /work \(6 event definition\(s\)/);

    // events_list: the weekly recurrence is expanded, the folded summary is joined
    const ev = await c.call("events_list", { from: "2026-03-09", to: "2026-03-25", zone: "UTC" });
    assert.equal(ev.isError, false, ev.text);
    assert.match(ev.text, /Acme, Ltd kickoff with the whole delivery team/);
    assert.equal((ev.text.match(/Standup/g) ?? []).length, 3, `expected three Standup occurrences:\n${ev.text}`);
    assert.match(ev.text, /all day\s+Offsite/);
    assert.match(ev.text, /09:00-10:00 {1,}Acme/);       // 10:00 Warsaw is 09:00Z in March
    const ids = [...ev.text.matchAll(/id (\S+)/g)].map(m => m[1]);
    assert.ok(ids.length >= 8, `expected at least 8 rows, got ${ids.length}`);

    // events_search
    const search = await c.call("events_search", { query: "kickoff", from: "2026-03-01", to: "2026-03-20" });
    assert.match(search.text, /1 match\(es\)/);
    const byAttendee = await c.call("events_search", { query: "maria@acme.com", from: "2026-03-01", to: "2026-03-20" });
    assert.match(byAttendee.text, /Client call/);

    // free_busy: the kickoff is busy, the transparent conference is not
    const fb = await c.call("free_busy", { from: "2026-03-09", to: "2026-03-13", work_start: "09:00", work_end: "17:00", zone: "UTC" });
    assert.equal(fb.isError, false, fb.text);
    assert.match(fb.text, /busy\s+09:00-10:30/);          // kickoff and dentist merged
    assert.match(fb.text, /2026-03-13 Fri[\s\S]*free\s+09:00-17:00/, `a TRANSPARENT event must not be busy:\n${fb.text}`);

    // conflicts
    const cf = await c.call("conflicts", { from: "2026-03-09", to: "2026-03-13" });
    assert.equal(cf.isError, false, cf.text);
    assert.match(cf.text, /1 overlapping pair\(s\)/);
    assert.match(cf.text, /30 min overlap/);
    assert.match(cf.text, /Dentist/);

    // next_event does not fail with an empty future
    const ne = await c.call("next_event", {});
    assert.equal(ne.isError, false, ne.text);

    // export a window and read the file back through the parser
    const out = join(s.dir, "out.ics");
    const exp = await c.call("event_export", { from: "2026-03-09", to: "2026-03-13", out_path: out });
    assert.equal(exp.isError, false, exp.text);
    assert.match(exp.text, /Wrote 6 event\(s\)/);
    const round = ics.parseIcs(readFileSync(out, "utf8"));
    assert.equal(round.events.length, 6);
    assert.equal(round.skipped, 0);
    const summaries = round.events.map(e => e.summary);
    assert.ok(summaries.includes("Acme, Ltd kickoff with the whole delivery team"), summaries.join(" | "));
    assert.ok(summaries.includes("Standup"));
    // and the re-read instants match what was listed
    const first = round.events.find(e => e.summary.startsWith("Acme"));
    assert.equal(first.start.zone, "UTC");
    assert.equal(ics.expandEvent(first, { fromUtc: new Date("2026-03-01T00:00:00Z"), toUtc: new Date("2026-04-01T00:00:00Z"), defaultZone: "UTC" })[0].startUtc.toISOString(), "2026-03-09T09:00:00.000Z");

    // D-R61: ORGANIZER and both ATTENDEE lines round-trip byte-for-byte after unfolding,
    // and an event with no attendees (the kickoff) exports none.
    const exportedLines = ics.unfold(readFileSync(out, "utf8"));
    const clientCallIdx = exportedLines.findIndex(l => l === "SUMMARY:Client call");
    assert.ok(clientCallIdx >= 0, exportedLines.join("\n"));
    let veventStart = clientCallIdx;
    while (exportedLines[veventStart] !== "BEGIN:VEVENT") veventStart--;
    let veventEnd = clientCallIdx;
    while (exportedLines[veventEnd] !== "END:VEVENT") veventEnd++;
    const clientCallBlock = exportedLines.slice(veventStart, veventEnd + 1);
    assert.ok(clientCallBlock.includes("ORGANIZER;CN=\"Mike\":mailto:mike@example.com"), clientCallBlock.join("\n"));
    assert.ok(clientCallBlock.includes("ATTENDEE;CN=Maria;RSVP=TRUE:mailto:maria@acme.com"), clientCallBlock.join("\n"));
    assert.ok(
      clientCallBlock.includes("ATTENDEE;CN=Tom Rivera;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:tom@nova.example"),
      clientCallBlock.join("\n"),
    );
    assert.equal(clientCallBlock.filter(l => l.startsWith("ATTENDEE")).length, 2, clientCallBlock.join("\n"));

    const kickoffIdx = exportedLines.findIndex(l => l.startsWith("SUMMARY:Acme"));
    assert.ok(kickoffIdx >= 0);
    let koStart = kickoffIdx;
    while (exportedLines[koStart] !== "BEGIN:VEVENT") koStart--;
    let koEnd = kickoffIdx;
    while (exportedLines[koEnd] !== "END:VEVENT") koEnd++;
    const kickoffBlock = exportedLines.slice(koStart, koEnd + 1);
    assert.ok(!kickoffBlock.some(l => l.startsWith("ATTENDEE") || l.startsWith("ORGANIZER")), kickoffBlock.join("\n"));

    // events_list shows the attendees too, not just the model's own prose about them
    assert.match(ev.text, /Client call.*with Maria <maria@acme\.com>, Tom Rivera <tom@nova\.example>/);

    // export by id
    const byId = join(s.dir, "one.ics");
    const one = await c.call("event_export", { ids: [ids[0]], out_path: byId });
    assert.match(one.text, /Wrote 1 event\(s\)/);
    assert.equal(ics.parseIcs(readFileSync(byId, "utf8")).events.length, 1);

    // event_to_time_entry: the shape the time-tracker's entry_add takes
    const callId = [...ev.text.matchAll(/Client call\s+id (\S+)/g)].map(m => m[1])[0]
      ?? ids.find(i => i.includes("2026")) ?? ids[0];
    const te = await c.call("event_to_time_entry", { event_id: callId, project: "Acme", rate: "120 euros an hour" });
    assert.equal(te.isError, false, te.text);
    const json = JSON.parse(te.text.slice(te.text.indexOf("{")));
    assert.equal(json.project, "Acme");
    assert.equal(json.billable, true);
    assert.ok(typeof json.start === "string" && json.start.endsWith("Z"));
    assert.ok(typeof json.end === "string" && json.end.endsWith("Z"));
    assert.ok(new Date(json.end) > new Date(json.start));
    assert.equal(json.rate, "120 euros an hour");
    assert.ok(typeof json.note === "string" && json.note.length > 0);

    // the resource and the prompt
    const res = await c.send("resources/read", { uri: "calendar://today" });
    assert.ok(res.result.contents[0].text.length > 0);
    const pr = await c.send("prompts/get", { name: "plan_my_day", arguments: { project: "Acme" } });
    assert.match(pr.result.messages[0].content.text, /events_list/);
    assert.match(pr.result.messages[0].content.text, /event_to_time_entry/);

    // free tier: a third calendar is refused with the upgrade path, not an error
    const second = await c.call("ics_import", { path: s.second, name: "family" });
    assert.equal(second.isError, false, second.text);
    const third = await c.call("ics_import", { text: SECOND, name: "third" });
    assert.equal(third.isError, false, third.text);
    assert.match(third.text, /Pro feature/);
    assert.match(third.text, /mcp\.zovo\.one\/buy\/calendar/);
    const after = await c.call("calendars_list", {});
    assert.ok(!after.text.includes("third"), after.text);

    // free tier: a window wider than 31 days is refused the same way
    const wide = await c.call("events_list", { from: "2026-01-01", to: "2026-06-30", zone: "UTC" });
    assert.match(wide.text, /Pro feature/);

    // a URL import is Pro, and nothing is fetched on the free tier
    const url = await c.call("ics_import", { url: "https://example.com/basic.ics", name: "feed" });
    assert.match(url.text, /Pro feature/);

    // ics_forget removes it
    const forget = await c.call("ics_forget", { name: "family" });
    assert.match(forget.text, /Forgot "family"/);
    const left = await c.call("calendars_list", {});
    assert.ok(!left.text.includes("family"), left.text);
  } finally {
    c.close(); s.cleanup();
  }
});

test("Pro removes the calendar cap, the window cap and the export cap", async () => {
  const s = sandbox();
  const c = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
  try {
    await c.init();
    const st = await c.call("license_status", {});
    assert.match(st.text, /"tier": "pro"/);

    for (const name of ["work", "family", "third", "fourth"]) {
      const r = await c.call("ics_import", { path: name === "work" ? s.fixture : s.second, name });
      assert.equal(r.isError, false, r.text);
      assert.ok(!r.text.includes("Pro feature"), `${name} was refused: ${r.text}`);
    }
    const cals = await c.call("calendars_list", {});
    assert.match(cals.text, /4 calendar\(s\)/);

    // a six-month window is allowed and the weekly series is still expanded correctly
    const wide = await c.call("events_list", { from: "2026-01-01", to: "2026-06-30", zone: "UTC" });
    assert.equal(wide.isError, false, wide.text);
    assert.ok(!wide.text.includes("Pro feature"), wide.text);
    assert.equal((wide.text.match(/Standup/g) ?? []).length, 3);

    // conflicts across two calendars: the school run clashes with the kickoff
    const cf = await c.call("conflicts", { from: "2026-03-09", to: "2026-03-09" });
    assert.match(cf.text, /School run/);

    // a URL import reaches the fetch guard rather than the licence gate
    const local = await c.call("ics_import", { url: "http://127.0.0.1:1/cal.ics", name: "feed" });
    assert.equal(local.isError, true, local.text);
    assert.match(local.text, /loopback address|refusing to fetch/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("empty state and bad input answer with instructions, never a stack trace", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const empty = await c.call("calendars_list", {});
    assert.match(empty.text, /No calendars imported yet/);
    const list = await c.call("events_list", { from: "2026-03-01", to: "2026-03-05" });
    assert.match(list.text, /No calendars imported yet/);

    const bad = await c.call("ics_import", { path: join(s.dir, "nope.ics"), name: "x" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /no file at/);

    const notCal = await c.call("ics_import", { text: "just some words", name: "x" });
    assert.equal(notCal.isError, true);
    assert.match(notCal.text, /not look like a calendar file/);

    const both = await c.call("ics_import", { path: s.fixture, text: FIXTURE, name: "x" });
    assert.equal(both.isError, true);
    assert.match(both.text, /exactly one of path, text or url/);

    await c.call("ics_import", { path: s.fixture, name: "work" });
    const backwards = await c.call("events_list", { from: "2026-03-10", to: "2026-03-01" });
    assert.equal(backwards.isError, true);
    assert.match(backwards.text, /is before/);

    const badDate = await c.call("events_list", { from: "2026-02-30", to: "2026-03-01" });
    assert.equal(badDate.isError, true);

    const badId = await c.call("event_to_time_entry", { event_id: "nonsense", project: "Acme" });
    assert.equal(badId.isError, true);
    assert.match(badId.text, /is not an event id/);

    const allDayId = (await c.call("events_list", { from: "2026-03-11", to: "2026-03-11", zone: "UTC" })).text.match(/id (\S+)/)[1];
    const allDay = await c.call("event_to_time_entry", { event_id: allDayId, project: "Acme" });
    assert.equal(allDay.isError, true);
    assert.match(allDay.text, /whole-day event/);

    const noArgs = await c.call("event_export", { out_path: join(s.dir, "x.ics") });
    assert.equal(noArgs.isError, true);
    assert.match(noArgs.text, /either ids, or from and to/);
  } finally {
    c.close(); s.cleanup();
  }
});
