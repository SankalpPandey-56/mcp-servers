// Two server processes on one data dir must not lose an imported calendar. Without the
// advisory lock the load-mutate-save cycles interleave and each process saves an index
// that is missing the other's rows.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");
const N = 12;

const FIXTURE = (n) => [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN",
  "BEGIN:VEVENT", `UID:e${n}@fixture`, "DTSTART:20260310T090000Z", "DTEND:20260310T100000Z", `SUMMARY:Event ${n}`, "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n") + "\r\n";

function client(env) {
  const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
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
    const to = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method}`)); } }, 30000);
    to.unref();
  });
  return {
    send,
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "conc", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: (name, args) => send("tools/call", { name, arguments: args ?? {} }),
    close() { child.kill(); },
  };
}

test(`two processes, one data dir: ${2 * N} concurrent imports all persist`, async () => {
  // Pro, so the free two-calendar cap is not what is being measured here.
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "calendar"], { encoding: "utf8" }).trim();
  const dir = mkdtempSync(join(tmpdir(), "mcp-cal-conc-"));
  const dataHome = join(dir, "data");
  const env = { XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dir, "cfg"), MCP_LICENSE_KEY: key };
  const files = [];
  for (let i = 0; i < N; i++) {
    for (const tag of ["a", "b"]) {
      const p = join(dir, `${tag}${i}.ics`);
      writeFileSync(p, FIXTURE(`${tag}${i}`), "utf8");
      files.push(p);
    }
  }
  const a = client(env);
  const b = client(env);
  try {
    await Promise.all([a.init(), b.init()]);
    const jobs = [];
    for (let i = 0; i < N; i++) {
      jobs.push(a.call("ics_import", { path: join(dir, `a${i}.ics`), name: `a${i}` }));
      jobs.push(b.call("ics_import", { path: join(dir, `b${i}.ics`), name: `b${i}` }));
    }
    const results = await Promise.all(jobs);
    for (const r of results) {
      assert.ok(r.result, `call failed: ${JSON.stringify(r.error)}`);
      assert.equal(r.result.isError, undefined, r.result.content?.[0]?.text);
    }

    const file = join(dataHome, "mcp-servers", "calendar", "data.json");
    const db = JSON.parse(readFileSync(file, "utf8"));
    const names = Object.keys(db.calendars).sort();
    assert.equal(names.length, 2 * N, `expected ${2 * N} calendars on disk, found ${names.length}: ${names.join(", ")}`);
    for (let i = 0; i < N; i++) {
      assert.ok(db.calendars[`a${i}`], `lost a${i}`);
      assert.ok(db.calendars[`b${i}`], `lost b${i}`);
      // every row's stored .ics has to exist, or the index is lying
      assert.ok(existsSync(db.calendars[`a${i}`].file), `missing file for a${i}`);
    }

    // both processes agree with the file
    const list = await a.call("calendars_list", {});
    assert.match(list.result.content[0].text, new RegExp(`${2 * N} calendar\\(s\\)`));
  } finally {
    a.close(); b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent forget and import do not corrupt the index", async () => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "calendar"], { encoding: "utf8" }).trim();
  const dir = mkdtempSync(join(tmpdir(), "mcp-cal-conc2-"));
  const dataHome = join(dir, "data");
  const env = { XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dir, "cfg"), MCP_LICENSE_KEY: key };
  for (let i = 0; i < 6; i++) writeFileSync(join(dir, `c${i}.ics`), FIXTURE(`c${i}`), "utf8");
  const a = client(env);
  const b = client(env);
  try {
    await Promise.all([a.init(), b.init()]);
    for (let i = 0; i < 6; i++) await a.call("ics_import", { path: join(dir, `c${i}.ics`), name: `c${i}` });
    const jobs = [];
    for (let i = 0; i < 3; i++) jobs.push(a.call("ics_forget", { name: `c${i}` }));
    for (let i = 3; i < 6; i++) jobs.push(b.call("ics_import", { path: join(dir, `c${i}.ics`), name: `d${i}` }));
    await Promise.all(jobs);
    const db = JSON.parse(readFileSync(join(dataHome, "mcp-servers", "calendar", "data.json"), "utf8"));
    const names = Object.keys(db.calendars).sort();
    assert.deepEqual(names, ["c3", "c4", "c5", "d3", "d4", "d5"], names.join(", "));
  } finally {
    a.close(); b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
