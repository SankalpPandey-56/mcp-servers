// Two server processes on one data dir must not lose contact writes.
// Without the advisory lock the load-mutate-save cycles interleave and each process
// saves a contacts map that is missing the other's rows.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const N = 20;

function client(dataHome, tag) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dataHome, "cfg"), MCP_LICENSE_KEY: process.env.CONC_KEY ?? "" },
  });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 30000);
    t.unref();
  });
  return {
    tag, send,
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "conc", version: "0.0.0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: (name, args) => send("tools/call", { name, arguments: args ?? {} }),
    close() { child.kill(); },
  };
}

test("two processes, one data dir: 40 concurrent contacts_set all persist", async () => {
  const { execFileSync } = await import("node:child_process");
  const REPO = join(here, "..", "..", "..");
  // Pro, so the free 5-contact cap is not what is being measured here.
  process.env.CONC_KEY = execFileSync(process.execPath,
    [join(REPO, "scripts", "sign-license.mjs"), "timezone"], { encoding: "utf8" }).trim();

  const sandbox = mkdtempSync(join(tmpdir(), "mcp-tz-conc-"));
  const dataHome = join(sandbox, "data");
  const a = client(dataHome, "a");
  const b = client(dataHome, "b");
  try {
    await Promise.all([a.init(), b.init()]);
    const zones = ["Warsaw", "New York", "Bangalore", "Tokyo", "Lisbon"];
    const jobs = [];
    for (let i = 0; i < N; i++) {
      jobs.push(a.call("contacts_set", { name: `a${i}`, zone: zones[i % zones.length] }));
      jobs.push(b.call("contacts_set", { name: `b${i}`, zone: zones[(i + 2) % zones.length] }));
    }
    const results = await Promise.all(jobs);
    for (const r of results) {
      assert.ok(r.result, `call failed: ${JSON.stringify(r.error)}`);
      assert.equal(r.result.isError, undefined, r.result.content?.[0]?.text);
    }

    const file = join(dataHome, "mcp-servers", "timezone", "data.json");
    const db = JSON.parse(readFileSync(file, "utf8"));
    const names = Object.keys(db.contacts).sort();
    assert.equal(names.length, 2 * N, `expected ${2 * N} contacts on disk, found ${names.length}`);
    for (let i = 0; i < N; i++) {
      assert.ok(db.contacts[`a${i}`], `lost a${i}`);
      assert.ok(db.contacts[`b${i}`], `lost b${i}`);
    }

    // both processes agree with the file
    const listA = await a.call("contacts_list", {});
    assert.match(listA.result.content[0].text, new RegExp(`${2 * N} contact\\(s\\)`));
  } finally {
    a.close(); b.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("two processes writing ics counters do not lose a count", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-tz-conc2-"));
  const dataHome = join(sandbox, "data");
  const a = client(dataHome, "a");
  const b = client(dataHome, "b");
  try {
    await Promise.all([a.init(), b.init()]);
    const jobs = [];
    for (let i = 0; i < 5; i++) {
      jobs.push(a.call("ics_create", { title: `A${i}`, start: "2026-09-10 15:00", zone: "Warsaw", duration_minutes: 30, out_path: join(sandbox, `a${i}.ics`) }));
      jobs.push(b.call("ics_create", { title: `B${i}`, start: "2026-09-10 16:00", zone: "Warsaw", duration_minutes: 30, out_path: join(sandbox, `b${i}.ics`) }));
    }
    await Promise.all(jobs);
    const file = join(dataHome, "mcp-servers", "timezone", "data.json");
    const db = JSON.parse(readFileSync(file, "utf8"));
    const total = Object.values(db.ics).reduce((s, n) => s + n, 0);
    assert.equal(total, 10, `expected 10 counted writes, found ${total}`);
  } finally {
    a.close(); b.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
});
