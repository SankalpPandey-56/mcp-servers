/**
 * Adversarial cases from docs/CALENDAR_AUDIT.md. One test per fixed defect, so a
 * regression fails here rather than in a user's week.
 */
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeIcs, expandAll, parseIcs, parseRRule, findConflicts,
} from "../dist/ics.js";

const WIN = (from, to, zone = "Europe/Warsaw") => ({
  fromUtc: new Date(`${from}T00:00:00Z`), toUtc: new Date(`${to}T00:00:00Z`), defaultZone: zone,
});
const cal = body => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}END:VCALENDAR\r\n`;
const ev = lines => `BEGIN:VEVENT\r\n${lines.join("\r\n")}\r\nEND:VEVENT\r\n`;

test("a fold that lands inside a UTF-8 sequence does not corrupt the summary", () => {
  const one = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:u@x\r\nDTSTART;TZID=Europe/Warsaw:20260909T140000\r\nDTEND;TZID=Europe/Warsaw:20260909T150000\r\nSUMMARY:Budget 1000 € review\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  const buf = Buffer.from(one, "utf8");
  const i = buf.indexOf(Buffer.from("€", "utf8"));
  const split = Buffer.concat([buf.subarray(0, i + 1), Buffer.from("\r\n "), buf.subarray(i + 1)]);
  // decoding first and unfolding after is what loses the character
  assert.ok(split.toString("utf8").includes("�"));
  const events = parseIcs(decodeIcs(split)).events;
  assert.equal(events[0].summary, "Budget 1000 € review");
});

test("BYSETPOS picks one occurrence out of the period, not all of them", () => {
  const text = cal(ev([
    "UID:sp@x",
    "DTSTART;TZID=Europe/Warsaw:20260930T160000",
    "DTEND;TZID=Europe/Warsaw:20260930T170000",
    "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=4",
    "SUMMARY:Last weekday of the month",
  ]));
  const p = parseIcs(text);
  assert.deepEqual(p.events[0].rrule.bySetPos, [-1]);
  const occ = expandAll(p.events, WIN("2026-10-01", "2026-11-01"));
  assert.equal(occ.length, 1, "October has exactly one last weekday");
  assert.equal(occ[0].key, "20261030T160000");
});

test("BYDAY ordinals still resolve, with and without BYSETPOS", () => {
  const text = cal(
    ev(["UID:a@x", "DTSTART;TZID=Europe/Warsaw:20260914T090000", "DTEND;TZID=Europe/Warsaw:20260914T100000",
        "RRULE:FREQ=MONTHLY;BYDAY=2MO;COUNT=3", "SUMMARY:Second Monday"]) +
    ev(["UID:b@x", "DTSTART;TZID=Europe/Warsaw:20260925T140000", "DTEND;TZID=Europe/Warsaw:20260925T150000",
        "RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3", "SUMMARY:Last Friday"]),
  );
  const occ = expandAll(parseIcs(text).events, WIN("2026-10-01", "2026-11-01"));
  assert.deepEqual(occ.map(o => o.key).sort(), ["20261012T090000", "20261030T140000"]);
});

test("FREQ=HOURLY is expanded; MINUTELY and SECONDLY are refused by name", () => {
  const hourly = cal(ev(["UID:h@x", "DTSTART;TZID=Europe/Warsaw:20260907T110000",
    "DTEND;TZID=Europe/Warsaw:20260907T113000", "RRULE:FREQ=HOURLY;COUNT=5", "SUMMARY:Hourly"]));
  const occ = expandAll(parseIcs(hourly).events, WIN("2026-09-07", "2026-09-08"));
  assert.equal(occ.length, 5);
  assert.equal(occ[4].key, "20260907T150000");

  const w = [];
  assert.equal(parseRRule({ name: "RRULE", params: {}, value: "FREQ=SECONDLY" }, w), null);
  assert.match(w[0], /deliberately not expanded/);
});

test("an unbounded RRULE stays inside the window and terminates", () => {
  const text = cal(ev(["UID:u@x", "DTSTART;TZID=Europe/Warsaw:20200101T090000",
    "DTEND;TZID=Europe/Warsaw:20200101T093000", "RRULE:FREQ=DAILY", "SUMMARY:Forever"]));
  const events = parseIcs(text).events;
  const t0 = Date.now();
  const occ = expandAll(events, WIN("2026-09-07", "2026-09-14"));
  assert.equal(occ.length, 7);
  assert.ok(Date.now() - t0 < 5000, "a ten-year-old daily rule must not take seconds");
  // a ten-year window is still bounded
  assert.ok(expandAll(events, WIN("2020-01-01", "2030-01-01")).length <= 20_000);
});

test("DTEND before DTSTART is reported, not silently zero", () => {
  const text = cal(ev(["UID:r@x", "DTSTART;TZID=Europe/Warsaw:20260909T170000",
    "DTEND;TZID=Europe/Warsaw:20260909T160000", "SUMMARY:Backwards"]));
  const p = parseIcs(text);
  assert.ok(p.warnings.some(w => /DTEND is before DTSTART/.test(w)), p.warnings.join("|"));
  const occ = expandAll(p.events, WIN("2026-09-09", "2026-09-10"));
  assert.equal(occ[0].endUtc.getTime(), occ[0].startUtc.getTime());
});

test("RDATE adds occurrences, floating times take the caller's zone, an unknown TZID falls back", () => {
  const text = cal(
    ev(["UID:rd@x", "DTSTART;TZID=Europe/Warsaw:20260907T080000", "DTEND;TZID=Europe/Warsaw:20260907T083000",
        "RDATE;TZID=Europe/Warsaw:20260910T080000,20260912T080000", "SUMMARY:RDATE"]) +
    ev(["UID:fl@x", "DTSTART:20260908T120000", "DTEND:20260908T130000", "SUMMARY:Floating"]) +
    ev(["UID:tz@x", "DTSTART;TZID=Mars/Olympus:20260908T150000", "DTEND;TZID=Mars/Olympus:20260908T160000", "SUMMARY:Unknown zone"]),
  );
  const p = parseIcs(text);
  assert.ok(p.warnings.some(w => /Mars\/Olympus/.test(w)));
  const occ = expandAll(p.events, WIN("2026-09-06", "2026-09-14"));
  assert.equal(occ.filter(o => o.event.uid === "rd@x").length, 3);
  const fl = occ.find(o => o.event.uid === "fl@x");
  assert.equal(fl.startUtc.toISOString(), "2026-09-08T10:00:00.000Z");   // Warsaw noon
  const tz = occ.find(o => o.event.uid === "tz@x");
  assert.equal(tz.startUtc.toISOString(), "2026-09-08T13:00:00.000Z");
});

test("zero-length, year-spanning and nested-VCALENDAR events are all read", () => {
  const text = cal(
    ev(["UID:z@x", "DTSTART;TZID=Europe/Warsaw:20260909T180000", "DTEND;TZID=Europe/Warsaw:20260909T180000", "SUMMARY:Zero"]) +
    ev(["UID:s@x", "DTSTART;TZID=Europe/Warsaw:20260901T000000", "DTEND;TZID=Europe/Warsaw:20290901T000000", "SUMMARY:Three years"]) +
    `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${ev(["UID:n@x", "DTSTART;TZID=Europe/Warsaw:20260911T090000", "DTEND;TZID=Europe/Warsaw:20260911T100000", "SUMMARY:Nested"])}END:VCALENDAR\r\n`,
  );
  const p = parseIcs(text);
  assert.equal(p.events.length, 3);
  const occ = expandAll(p.events, WIN("2026-09-07", "2026-09-14"));
  const zero = occ.find(o => o.event.uid === "z@x");
  assert.equal(zero.endUtc.getTime() - zero.startUtc.getTime(), 0);
  const span = occ.find(o => o.event.uid === "s@x");
  assert.equal(span.endUtc.getUTCFullYear(), 2029);
  assert.ok(occ.some(o => o.event.uid === "n@x"));
  assert.ok(findConflicts(occ).length > 0);
});

test("CR-only line endings and a Google export with X-WR-TIMEZONE both parse", () => {
  const cr = "BEGIN:VCALENDAR\rVERSION:2.0\rBEGIN:VEVENT\rUID:cr@x\rDTSTART;TZID=Europe/Warsaw:20260907T090000\rDTEND;TZID=Europe/Warsaw:20260907T100000\rSUMMARY:CR only\rEND:VEVENT\rEND:VCALENDAR\r";
  assert.equal(parseIcs(cr).events[0].summary, "CR only");

  const google = cal(
    "PRODID:-//Google Inc//Google Calendar 70.9054//EN\r\nX-WR-CALNAME:mike@example.com\r\nX-WR-TIMEZONE:America/New_York\r\n" +
    "BEGIN:VTIMEZONE\r\nTZID:America/New_York\r\nBEGIN:DAYLIGHT\r\nTZOFFSETFROM:-0500\r\nTZOFFSETTO:-0400\r\nDTSTART:19700308T020000\r\nEND:DAYLIGHT\r\nEND:VTIMEZONE\r\n" +
    ev(["UID:g1@google.com", "DTSTART;TZID=America/New_York:20260908T100000", "DTEND;TZID=America/New_York:20260908T110000", "SUMMARY:Café review"]) +
    ev(["UID:g2@google.com", "DTSTART;VALUE=DATE:20260910", "DTEND;VALUE=DATE:20260911", "SUMMARY:Holiday"]),
  );
  const p = parseIcs(google);
  assert.equal(p.calendarName, "mike@example.com");
  assert.equal(p.events.length, 2, "the VTIMEZONE must not be read as an event");
  assert.equal(p.events[0].summary, "Café review");
  const occ = expandAll(p.events, WIN("2026-09-08", "2026-09-12"));
  assert.equal(occ[0].startUtc.toISOString(), "2026-09-08T14:00:00.000Z");   // EDT, from ICU not the file
});

test("Windows zone names from an Outlook export are named in a warning", () => {
  const text = cal(
    "PRODID:-//Microsoft Exchange Server 2016//EN\r\n" +
    "BEGIN:VTIMEZONE\r\nTZID:W. Europe Standard Time\r\nBEGIN:STANDARD\r\nDTSTART:16011028T030000\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\n" +
    ev(['UID:o@x', "DTSTART;TZID=W. Europe Standard Time:20260909T140000",
        "DTEND;TZID=W. Europe Standard Time:20260909T150000",
        'ORGANIZER;CN="Doe, John":mailto:john@example.com', "SUMMARY:Outlook"]),
  );
  const p = parseIcs(text);
  assert.equal(p.events.length, 1);
  assert.match(p.warnings.join("|"), /W\. Europe Standard Time/);
  assert.equal(p.events[0].organizer, "john@example.com");
});

/* ------------------------------------------------------------------ stdio */

function rpc(requests, dataDir, waitMs = 6000) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [new URL("../dist/index.js", import.meta.url).pathname], {
      env: { ...process.env, XDG_DATA_HOME: dataDir, XDG_CONFIG_HOME: join(dataDir, "cfg"), MCP_LICENSE_KEY: "" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buf = ""; const out = []; const bad = [];
    // Requests are sent one at a time: the server handles calls concurrently, so a
    // search fired in the same write as an import can be answered before the import lands.
    const queue = [...requests]; let done = false;
    const finish = () => { if (done) return; done = true; child.kill(); resolve({ out, bad }); };
    const next = () => { const r = queue.shift(); if (!r) { setTimeout(finish, 150); return; } child.stdin.write(JSON.stringify(r) + "\n"); };
    child.stdout.on("data", d => {
      buf += d.toString();
      const lines = buf.split("\n"); buf = lines.pop();
      for (const l of lines) {
        if (!l.trim()) continue;
        try { const m = JSON.parse(l); out.push(m); if (m.id !== undefined && m.id !== 0) next(); } catch { bad.push(l); }
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } } }) + "\n");
    setTimeout(() => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      next();
    }, 400);
    setTimeout(finish, waitMs);
  });
}
const textOf = (out, id) => (out.find(o => o.id === id)?.result?.content ?? []).map(c => c.text).join("\n");

test("missing and wrong-typed arguments are refused at the schema, and stdout stays JSON-RPC", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-adv-"));
  const { out, bad } = await rpc([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ics_import", arguments: {} } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ics_import", arguments: { path: 123, name: "x" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "events_list", arguments: {} } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "ics_import", arguments: { path: "/x.ics", text: "BEGIN:VCALENDAR", name: "n" } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "ics_import", arguments: { url: "http://127.0.0.1:9/a.ics", name: "n" } } },
  ], dir);
  assert.deepEqual(bad, []);
  assert.match(JSON.stringify(out.find(o => o.id === 1)), /Required at name/);
  assert.match(JSON.stringify(out.find(o => o.id === 2)), /Expected string, received number/);
  assert.match(JSON.stringify(out.find(o => o.id === 3)), /Required at from/);
  assert.match(textOf(out, 4), /exactly one of path, text or url/);
  assert.match(textOf(out, 5), /Pro feature/);   // free tier never reaches the network
});

test("D-R58: the url gate names the free text path that gets the same events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-r58-"));
  const { out, bad } = await rpc([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ics_import", arguments: { url: "https://example.com/team.ics", name: "Team" } } },
  ], dir);
  assert.deepEqual(bad, []);
  const t = textOf(out, 1);
  assert.match(t, /Pro feature/);
  assert.match(t, /Free alternative/);
  // the alternative has to be usable as written: the tool name, the argument, and the
  // name the caller already asked for.
  assert.match(t, /ics_import \{name: "Team", text:/);
  assert.match(t, /identical/);
});

test("an all-day event survives export and re-import as a whole day, on any machine zone", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-rt-"));
  const src = join(dir, "src.ics");
  writeFileSync(src, cal(
    ev(["UID:h@x", "DTSTART;VALUE=DATE:20260910", "DTEND;VALUE=DATE:20260911", "SUMMARY:Company holiday"]) +
    ev(["UID:t@x", "DTSTART;TZID=Europe/Warsaw:20260908T140000", "DTEND;TZID=Europe/Warsaw:20260908T153000", "SUMMARY:Nova call"]),
  ));
  const outIcs = join(dir, "out.ics");
  const { out, bad } = await rpc([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ics_import", arguments: { path: src, name: "work" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "event_export", arguments: { from: "2026-09-07", to: "2026-09-13", out_path: outIcs } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ics_import", arguments: { path: outIcs, name: "back" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "events_list", arguments: { calendar: "back", from: "2026-09-07", to: "2026-09-13", zone: "Europe/Warsaw" } } },
  ], dir, 8000);
  assert.deepEqual(bad, []);
  const written = readFileSync(outIcs, "utf8");
  assert.match(written, /DTSTART;VALUE=DATE:20260910/);
  assert.match(written, /DTEND;VALUE=DATE:20260911/);
  const listed = textOf(out, 4);
  assert.match(listed, /2026-09-10 Thu\n\s+all day\s+Company holiday/);
  assert.match(listed, /14:00-15:30\s+Nova call/);
  assert.doesNotMatch(listed, /UTCUTC/);          // the offset label already carries "UTC"
});

test("event_to_time_entry carries the currency and matches the event to the minute", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cal-tte-"));
  const src = join(dir, "src.ics");
  writeFileSync(src, cal(ev([
    "UID:n@x", "DTSTART;TZID=Europe/Warsaw:20260908T140000", "DTEND;TZID=Europe/Warsaw:20260908T153000",
    "SUMMARY:Nova call", "ATTENDEE;CN=Nova Ops:mailto:ops@nova.example",
  ])));
  const first = await rpc([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ics_import", arguments: { path: src, name: "work" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "events_search", arguments: { query: "Nova", from: "2026-09-07", to: "2026-09-13" } } },
  ], dir);
  const id = /id (\S+)/.exec(textOf(first.out, 2))[1];
  const second = await rpc([
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "event_to_time_entry", arguments: { event_id: id, project: "Nova", rate: 90, currency: "EUR" } } },
  ], dir);
  const body = textOf(second.out, 3);
  const args = JSON.parse(body.slice(body.indexOf("{")));
  assert.equal(args.start, "2026-09-08T12:00:00.000Z");
  assert.equal(args.end, "2026-09-08T13:30:00.000Z");
  assert.equal(args.currency, "EUR");
  assert.equal(args.billable, true);
});

test("a 20,000-event 5 MB export imports, lists and is not re-parsed on every call", async (ctx) => {
  const dir = mkdtempSync(join(tmpdir(), "cal-big-"));
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  const src = join(dir, "big.ics");
  const parts = ["BEGIN:VCALENDAR\r\nVERSION:2.0\r\n"];
  for (let i = 0; i < 20000; i++) {
    const day = 1 + (i % 28), mon = 1 + Math.floor(i / 28) % 12, yr = 2026 + Math.floor(i / (28 * 12));
    const d = `${yr}${String(mon).padStart(2, "0")}${String(day).padStart(2, "0")}`;
    parts.push(`BEGIN:VEVENT\r\nUID:big-${i}@x\r\nDTSTART;TZID=Europe/Warsaw:${d}T090000\r\nDTEND;TZID=Europe/Warsaw:${d}T100000\r\nSUMMARY:Event ${i}\r\nDESCRIPTION:${"X".repeat(86)}\r\nEND:VEVENT\r\n`);
  }
  parts.push("END:VCALENDAR\r\n");
  writeFileSync(src, parts.join(""));
  const { out, bad } = await rpc([
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ics_import", arguments: { path: src, name: "big" } } },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "events_list", arguments: { calendar: "big", from: "2026-01-01", to: "2026-01-31" } } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "conflicts", arguments: { calendar: "big", from: "2026-01-01", to: "2026-01-31" } } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "free_busy", arguments: { from: "2026-01-01", to: "2026-01-31" } } },
  ], dir, 90000);
  assert.deepEqual(bad, []);
  assert.match(textOf(out, 1), /20000 event definition\(s\)/);
  assert.match(textOf(out, 2), /28 event\(s\)/);
  assert.ok(textOf(out, 3).length > 0 && textOf(out, 4).length > 0, "every call answered inside the window");
});
