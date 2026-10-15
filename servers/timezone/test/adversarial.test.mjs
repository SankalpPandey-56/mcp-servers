/**
 * Adversarial probes, docs/TIMEZONE_AUDIT.md. Every test here is a probe that either
 * failed before the audit or guards a bound that a caller can otherwise blow past.
 */
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const tz = await import(join(here, "..", "dist", "tz.js"));

function client() {
  const home = mkdtempSync(join(tmpdir(), "mcp-tz-adv-"));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "cfg"), MCP_LICENSE_KEY: "" },
  });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  const nonJson = [];
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { nonJson.push(line); continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
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
    home, nonJson, send,
    notify: (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n"),
    raw: (name, args) => send("tools/call", { name, arguments: args ?? {} }),
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (!r.result) return { text: JSON.stringify(r.error), isError: true, rpcError: true };
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}
async function init(c) {
  await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "adv", version: "0" } });
  c.notify("notifications/initialized", {});
}

const MB = "a".repeat(1_000_000);

test("a 1 MB argument is refused at the schema, not echoed back", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  const zone = await c.call("now", { zones: [MB] });
  assert.ok(zone.isError);
  assert.ok(zone.text.length < 2000, `error was ${zone.text.length} characters`);
  assert.match(zone.text, /100 characters or fewer/);

  const title = await c.call("ics_create", { title: MB, start: "2026-09-10 15:00", zone: "Warsaw", duration_minutes: 60 });
  assert.ok(title.isError);
  assert.ok(title.text.length < 2000);
});

test("unknown and near-miss place names", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  const good = await c.call("now", { zones: ["New york", "warsaw", "PST", "CET", "GMT+2", "Europe/warsaw", "poland"] });
  assert.ok(!good.isError, good.text);
  assert.match(good.text, /America\/New_York/);
  assert.match(good.text, /Europe\/Warsaw/);
  // V4-6: a fixed abbreviation is an offset, not a place, and the answer says so
  assert.match(good.text, /PST -> Etc\/GMT\+8/);
  assert.match(good.text, /CET -> Etc\/GMT-1/);
  assert.match(good.text, /Etc\/GMT-2/);
  assert.match(good.text, /Note: PST is a fixed offset \(UTC-08:00\)/);
  assert.ok(!/PST -> America\/Los_Angeles/.test(good.text), good.text);

  const bad = await c.call("now", { zones: ["Xanadu"] });
  assert.ok(bad.isError);
  assert.match(bad.text, /unknown time zone or place/);

  // a fixed offset with minutes is not an IANA zone; say so instead of suggesting UTC
  const half = await c.call("now", { zones: ["UTC+5:30"] });
  assert.ok(half.isError);
  assert.match(half.text, /fixed offset with minutes/);
});

test("bounds: days, duration, participants, work_start after work_end", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  const p = [{ name: "a", zone: "Warsaw" }];
  assert.ok((await c.call("find_meeting_slots", { participants: p, days: 0 })).isError);
  assert.ok((await c.call("find_meeting_slots", { participants: p, days: 10000 })).isError);
  assert.ok((await c.call("find_meeting_slots", { participants: p, duration_minutes: 0 })).isError);
  assert.ok((await c.call("find_meeting_slots", { participants: p, duration_minutes: 100000 })).isError);
  const many = Array.from({ length: 200 }, (_, i) => ({ name: `p${i}`, zone: "Warsaw" }));
  assert.ok((await c.call("find_meeting_slots", { participants: many })).isError);
  const bad = await c.call("overlap", { zones: ["Warsaw", "Denver"], work_start: "17:00", work_end: "09:00" });
  assert.ok(bad.isError);
  assert.match(bad.text, /must be after work_start/);
});

test("business_days refuses a span it cannot walk instead of reporting a short count", () => {
  const r = tz.businessDays("2026-09-01", "2026-09-30", "Europe/Warsaw", []);
  assert.equal(r.days.length, 22);
  assert.equal(r.total, 30);
  assert.throws(() => tz.businessDays("1900-01-01", "2100-01-01", "Europe/Warsaw", []), /calendar days; this tool counts at most/);
});

test("a second contact with the same name says what it replaced", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  await c.call("contacts_set", { name: "Sara", zone: "Sydney" });
  const again = await c.call("contacts_set", { name: " sara ", zone: "Austin" });
  assert.match(again.text, /Replaced the saved Sara \(was Australia\/Sydney/);
  const list = await c.call("contacts_list", {});
  assert.equal((list.text.match(/America\/Chicago/g) ?? []).length, 1);
});

test("ics escapes commas, semicolons and newlines, and DTSTART is UTC", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  const out = join(c.home, "esc.ics");
  const r = await c.call("ics_create", {
    title: "Nova, kickoff; second line", start: "2026-09-10 15:00", zone: "Warsaw",
    duration_minutes: 60, attendees: ["sara@example.com", "Tom"],
    organizer_email: "me@example.com", out_path: out,
  });
  assert.ok(!r.isError, r.text);
  const ics = readFileSync(out, "utf8");
  assert.ok(ics.includes("SUMMARY:Nova\\, kickoff\\; second line\r\n"), ics);
  assert.match(ics, /DTSTART:20260910T130000Z/);
  // V4-9: CN is a quoted PARAMETER value, not TEXT-escaped
  assert.match(ics, /ATTENDEE;CN="sara";RSVP=TRUE:mailto:sara@example.com/);
  // D-R27: a name with no email is listed in the description, never written as a fake address
  assert.ok(!/invalid:nomail/.test(ics), ics);
  const unfolded = ics.replace(/\r\n /g, "");   // RFC 5545 folding puts long lines on continuations
  assert.match(unfolded, /DESCRIPTION:Also attending \(no email address was given[^\r\n]*\): Tom/);
  assert.match(ics, /ORGANIZER;CN="me":mailto:me@example.com/);
  assert.match(r.text, /listed in the description/);
  assert.ok(ics.split("\r\n").every((l) => Buffer.byteLength(l, "utf8") <= 75));

  // V4-9: a line break in any field is refused, not escaped away
  const inj = await c.call("ics_create", {
    title: "ok", start: "2026-09-10 15:00", zone: "Warsaw", duration_minutes: 60,
    attendees: ["a@example.com\r\nORGANIZER:mailto:x@example.com"], out_path: join(c.home, "inj.ics"),
  });
  assert.ok(inj.isError, inj.text);
  assert.match(inj.text, /line break/);
  assert.ok(!existsSync(join(c.home, "inj.ics")));
  const nlTitle = await c.call("ics_create", {
    title: "one\ntwo", start: "2026-09-10 15:00", zone: "Warsaw", duration_minutes: 60,
    out_path: join(c.home, "nl.ics"),
  });
  assert.ok(nlTitle.isError, nlTitle.text);
  // no organizer_email -> the answer says the ORGANIZER line is missing
  const noOrg = await c.call("ics_create", {
    title: "solo", start: "2026-09-10 15:00", zone: "Warsaw", duration_minutes: 60,
    out_path: join(c.home, "solo.ics"),
  });
  assert.ok(!noOrg.isError, noOrg.text);
  assert.match(noOrg.text, /No ORGANIZER line/);
  assert.ok(!/ORGANIZER/.test(readFileSync(join(c.home, "solo.ics"), "utf8")));
});

test("an unwritable out_path fails cleanly and writes nothing", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  // The path used to be a hardcoded "/proc/nope/x.ics". That is unwritable on macOS,
  // where there is no /proc at all, and behaved differently on the Linux runner once the
  // mirrors gained CI: the call did not fail, it hung, and the suite reported "timeout on
  // tools/call" on a public repository's badge. A path is made unwritable here instead of
  // assumed to be: a regular file is created and then used as a directory, which fails
  // with ENOTDIR immediately on every platform this ships to.
  const box = mkdtempSync(join(tmpdir(), "tz-unwritable-"));
  const blocker = join(box, "not-a-directory");
  writeFileSync(blocker, "x");
  const target = join(blocker, "x.ics");
  const r = await c.call("ics_create", { title: "x", start: "2026-09-10 15:00", zone: "Warsaw", duration_minutes: 60, out_path: target });
  assert.ok(r.isError, r.text);
  assert.ok(!existsSync(target));

  // The pseudo-filesystem case, which is where this test started. It ran only on Linux
  // and it did not fail there, it HUNG: mkdirSync(recursive) retries forever when mkdir
  // answers ENOENT in 0 ms, so the server never returned. Skipped where /proc does not
  // exist rather than replaced by a path that only looks equivalent.
  if (existsSync("/proc")) {
    const proc = await c.call("ics_create", { title: "x", start: "2026-09-10 15:00", zone: "Warsaw", duration_minutes: 60, out_path: "/proc/nope/x.ics" });
    assert.ok(proc.isError, proc.text);
    assert.ok(!existsSync("/proc/nope/x.ics"));
  }
});

test("DST gap and fold, and far dates", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  // V4-5: a time in the spring-forward gap is REFUSED, with both valid neighbours named
  const gap = await c.call("convert_time", { time: "2026-03-29 02:30", from_zone: "Europe/Warsaw", to_zones: ["UTC"] });
  assert.ok(gap.isError, gap.text);
  assert.match(gap.text, /does not exist in Europe\/Warsaw/);
  assert.match(gap.text, /2026-03-29 01:30 and 2026-03-29 03:30/);
  assert.match(gap.text, /gap:"backward".*gap:"forward"/);
  const fwd = await c.call("convert_time", { time: "2026-03-29 02:30", from_zone: "Europe/Warsaw", to_zones: ["UTC"], gap: "forward" });
  assert.ok(!fwd.isError, fwd.text);
  assert.match(fwd.text, /UTC instant: 2026-03-29T01:30/);
  assert.match(fwd.text, /moved it to 2026-03-29 03:30/);
  const back = await c.call("convert_time", { time: "2026-03-29 02:30", from_zone: "Europe/Warsaw", to_zones: ["UTC"], gap: "backward" });
  assert.match(back.text, /UTC instant: 2026-03-29T00:30/);
  // V4-5: the fold returns the FIRST occurrence by default and says which one it used
  const fold = await c.call("convert_time", { time: "2026-10-25 02:30", from_zone: "Europe/Warsaw", to_zones: ["UTC"] });
  assert.ok(!fold.isError, fold.text);
  assert.match(fold.text, /UTC instant: 2026-10-25T00:30/);
  assert.match(fold.text, /used the first occurrence/);
  const second = await c.call("convert_time", { time: "2026-10-25 02:30", from_zone: "Europe/Warsaw", to_zones: ["UTC"], fold: "second" });
  assert.match(second.text, /UTC instant: 2026-10-25T01:30/);
  assert.match(second.text, /used the second occurrence/);
  const old = await c.call("convert_time", { time: "1900-06-15 12:00", from_zone: "Europe/Warsaw", to_zones: ["America/New_York"] });
  assert.ok(!old.isError, old.text);
  const far = await c.call("convert_time", { time: "2100-06-15 12:00", from_zone: "Europe/Warsaw", to_zones: ["America/New_York"] });
  assert.ok(!far.isError, far.text);
});

test("V4-4/V4-10: a date that does not exist is refused, never rolled forward", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  const conv = await c.call("convert_time", { time: "2026-02-30 09:00", from_zone: "Europe/Warsaw", to_zones: ["UTC"] });
  assert.ok(conv.isError, conv.text);
  assert.match(conv.text, /not a real calendar date/);
  assert.ok(!/03-02/.test(conv.text), conv.text);
  const bd = await c.call("business_days", { from: "2026-02-30", to: "2026-02-30", zone: "UTC" });
  assert.ok(bd.isError, bd.text);
  assert.match(bd.text, /not a real calendar date/);
  const hol = await c.call("business_days", { from: "2026-09-01", to: "2026-09-30", zone: "UTC", holidays: ["2026-09-31"] });
  assert.ok(hol.isError, hol.text);
  assert.match(hol.text, /a holiday/);
  const good = await c.call("business_days", { from: "2026-02-28", to: "2026-02-28", zone: "UTC" });
  assert.ok(!good.isError, good.text);
});

test("V4-6: EST is a fixed offset in July, not EDT", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  const r = await c.call("convert_time", { time: "2026-07-01 09:00", from_zone: "EST", to_zones: ["UTC"] });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /UTC instant: 2026-07-01T14:00/);
  assert.match(r.text, /Etc\/GMT\+5/);
  assert.match(r.text, /Note: EST is a fixed offset \(UTC-05:00\)/);
});

test("V4-7: overlap boundaries come from the requested LOCAL date in each zone", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  const r = await c.call("overlap", { zones: ["Europe/Warsaw", "America/New_York"], date: "2026-09-10" });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /2026-09-10T13:00:00.000Z - 2026-09-10T15:00:00.000Z/);
  assert.ok(!/2026-09-09/.test(r.text), r.text);
});

test("D-R30: a search past the free cap is shortened, not refused", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  const r = await c.call("find_meeting_slots", {
    participants: [{ name: "A", zone: "Europe/Warsaw" }, { name: "B", zone: "Europe/London" }],
    duration_minutes: 60, days: 30, earliest_date: "2026-09-07",
  });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /slot\(s\) fit all 2 participants/);
  assert.match(r.text, /Searched 5 of the 30 days/);
  assert.match(r.text, /mcp\.zovo\.one\/buy\/timezone/);
});

test("D-R30: no overlap returns the least-bad near misses, not only a refusal", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  const r = await c.call("find_meeting_slots", {
    participants: [{ name: "Ana", zone: "America/Los_Angeles" }, { name: "Kenji", zone: "Asia/Tokyo" }],
    duration_minutes: 60, days: 3, earliest_date: "2026-09-07",
  });
  assert.ok(!r.isError, r.text);
  assert.match(r.text, /No slot fits everyone/);
  assert.match(r.text, /Closest times, all OUTSIDE someone's hours/);
  assert.match(r.text, /min outside; needs \d\d:\d\d-\d\d:\d\d/);
  assert.match(r.text, /To make the first one fit, set: /);
});

test("missing and wrong-typed arguments are refused, and stdout stays JSON-RPC", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  const missing = await c.call("convert_time", {});
  assert.ok(missing.isError, missing.text);
  assert.match(missing.text, /Required at time/);
  const typed = await c.call("convert_time", { time: 123, from_zone: "Warsaw", to_zones: ["UTC"] });
  assert.ok(typed.isError);
  assert.match(typed.text, /Expected string, received number/);
  await c.call("now", {});
  assert.deepEqual(c.nonJson, []);
});

test("business_days says whether a holiday list was used (D-T1)", async (t) => {
  const c = client(); t.after(() => c.close()); await init(c);
  const bare = await c.call("business_days", { from: "2026-09-01", to: "2026-09-30", zone: "Poland" });
  assert.match(bare.text, /22 business day\(s\) of 30 calendar day\(s\)/);
  assert.match(bare.text, /no national holiday calendar/);
  const withHol = await c.call("business_days", { from: "2026-11-01", to: "2026-11-30", zone: "Poland", holidays: ["2026-11-01", "2026-11-11"] });
  assert.match(withHol.text, /Excluded as holidays: 2026-11-01, 2026-11-11/);
});
