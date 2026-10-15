// A damaged data dir must never be reported as "no calendars": the next import would
// then overwrite an index that is still on disk.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

const FIXTURE = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
  "BEGIN:VEVENT", "UID:a@fixture", "DTSTART:20260310T090000Z", "DTEND:20260310T100000Z", "SUMMARY:One", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n") + "\r\n";

function client(env) {
  const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MCP_LICENSE_KEY: "", ...env } });
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
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "corrupt", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
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
  const dir = mkdtempSync(join(tmpdir(), "mcp-cal-corrupt-"));
  const dataHome = join(dir, "data");
  const prod = join(dataHome, "mcp-servers", "calendar");
  mkdirSync(prod, { recursive: true });
  const fixture = join(dir, "work.ics");
  writeFileSync(fixture, FIXTURE, "utf8");
  return {
    dir, prod, fixture,
    env: { XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dir, "cfg") },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a data.json that is not JSON is quarantined, not overwritten", async () => {
  const s = sandbox();
  const db = join(s.prod, "data.json");
  const original = '{"version":1,"calendars":{"work":{"name":"work"'; // truncated mid-write
  writeFileSync(db, original, "utf8");
  const c = client(s.env);
  try {
    await c.init();
    const list = await c.call("calendars_list", {});
    assert.equal(list.isError, true, list.text);
    assert.match(list.text, /corrupt/);
    assert.match(list.text, /nothing was written/);

    // the bytes are still on disk under the quarantine name
    const moved = readdirSync(s.prod).filter(f => /^data\.json\.corrupt-/.test(f));
    assert.equal(moved.length, 1, readdirSync(s.prod).join(", "));
    assert.equal(readFileSync(join(s.prod, moved[0]), "utf8"), original);
    assert.ok(existsSync(join(s.prod, "data.json.corrupt")), "a marker must block later calls");

    // and a later write still refuses rather than starting a fresh index over the top
    const imp = await c.call("ics_import", { path: s.fixture, name: "work" });
    assert.equal(imp.isError, true, imp.text);
    assert.match(imp.text, /corrupt/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("an index row whose .ics file was deleted says how to fix it", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    await c.call("ics_import", { path: s.fixture, name: "work" });
    rmSync(join(s.prod, "cal-work.ics"), { force: true });
    const list = await c.call("calendars_list", {});
    assert.equal(list.isError, false, list.text);       // the index itself is fine
    const ev = await c.call("events_list", { from: "2026-03-01", to: "2026-03-31", zone: "UTC" });
    assert.equal(ev.isError, true, ev.text);
    assert.match(ev.text, /missing or unreadable/);
    assert.match(ev.text, /ics_forget/);
    // and the fix works
    const forget = await c.call("ics_forget", { name: "work" });
    assert.equal(forget.isError, false, forget.text);
  } finally {
    c.close(); s.cleanup();
  }
});

test("a truncated .ics is read as far as it goes rather than hanging or throwing", async () => {
  const s = sandbox();
  const truncated = join(s.dir, "cut.ics");
  writeFileSync(truncated, [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "BEGIN:VEVENT", "UID:ok@fixture", "DTSTART:20260310T090000Z", "DTEND:20260310T100000Z", "SUMMARY:Kept", "END:VEVENT",
    "BEGIN:VEVENT", "UID:cut@fixture", "DTSTART:20260311T09",     // the file stops here
  ].join("\r\n"), "utf8");
  const c = client(s.env);
  try {
    await c.init();
    const imp = await c.call("ics_import", { path: truncated, name: "cut" });
    assert.equal(imp.isError, false, imp.text);
    assert.match(imp.text, /1 event definition\(s\)/);
    const ev = await c.call("events_list", { from: "2026-03-01", to: "2026-03-31", zone: "UTC" });
    assert.match(ev.text, /Kept/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("an index holding a row of the wrong shape is ignored, not fatal", async () => {
  const s = sandbox();
  writeFileSync(join(s.prod, "data.json"), JSON.stringify({ version: 1, calendars: { junk: 7, other: { name: "x" } } }), "utf8");
  const c = client(s.env);
  try {
    await c.init();
    const list = await c.call("calendars_list", {});
    assert.equal(list.isError, false, list.text);
    assert.match(list.text, /No calendars imported yet/);
    const imp = await c.call("ics_import", { path: s.fixture, name: "work" });
    assert.equal(imp.isError, false, imp.text);
  } finally {
    c.close(); s.cleanup();
  }
});

test("a stray cal-*.ics with no index row is reported, not read", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    await c.call("ics_import", { path: s.fixture, name: "work" });
    writeFileSync(join(s.prod, "cal-ghost.ics"), FIXTURE, "utf8");
    const list = await c.call("calendars_list", {});
    assert.match(list.text, /cal-ghost\.ics/);
    assert.match(list.text, /no calendar row/);
  } finally {
    c.close(); s.cleanup();
  }
});
