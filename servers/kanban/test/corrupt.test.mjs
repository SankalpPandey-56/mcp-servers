// A damaged data.json must never be reported as "no tasks": the next task_add would
// then overwrite a board that is still on disk.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function client(env) {
  const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MCP_LICENSE_KEY: "", ...env } });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", d => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const to = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 15000);
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
      return { text: r.result.content?.map(c => c.text).join("\n") ?? "", isError: r.result.isError === true };
    },
    close() { child.kill(); },
  };
}

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-kb-corrupt-"));
  const dataHome = join(dir, "data");
  const prod = join(dataHome, "mcp-servers", "kanban");
  mkdirSync(prod, { recursive: true });
  return {
    dir, prod,
    env: { XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dir, "cfg") },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a data.json that is not JSON is quarantined, not overwritten", async () => {
  const s = sandbox();
  const db = join(s.prod, "data.json");
  const original = '{"version":1,"boards":{"nova site":{"name":"Nova Site","slug":"NS"';   // truncated mid-write
  writeFileSync(db, original, "utf8");
  const c = client(s.env);
  try {
    await c.init();
    const list = await c.call("task_list", {});
    assert.equal(list.isError, true, list.text);
    assert.match(list.text, /corrupt/);
    assert.match(list.text, /nothing was written/);

    // the bytes are still on disk under the quarantine name
    const moved = readdirSync(s.prod).filter(f => /^data\.json\.corrupt-/.test(f));
    assert.equal(moved.length, 1, readdirSync(s.prod).join(", "));
    assert.equal(readFileSync(join(s.prod, moved[0]), "utf8"), original);
    assert.ok(existsSync(join(s.prod, "data.json.corrupt")), "a marker must block later calls");

    // and a later write still refuses rather than starting a fresh board over the top
    const add = await c.call("task_add", { project: "Nova Site", title: "would clobber" });
    assert.equal(add.isError, true, add.text);
    assert.match(add.text, /corrupt/);
    assert.equal(readdirSync(s.prod).filter(f => f === "data.json").length, 0, "no fresh data.json may appear");
  } finally {
    c.close(); s.cleanup();
  }
});

test("a board row of the wrong shape is ignored, not fatal", async () => {
  const s = sandbox();
  writeFileSync(join(s.prod, "data.json"), JSON.stringify({
    version: 1,
    boards: { junk: 7, nova: { name: "Nova", slug: "NOVA", columns: ["backlog", "done"], counter: 4 } },
    tasks: [{ id: "NOVA-4", project: "Nova", title: "kept", tags: [], priority: "normal", column: "backlog", created: "2026-01-01T00:00:00.000Z", updated: "2026-01-01T00:00:00.000Z" }],
  }), "utf8");
  const c = client(s.env);
  try {
    await c.init();
    const list = await c.call("task_list", {});
    assert.equal(list.isError, false, list.text);
    assert.match(list.text, /NOVA-4/);
    const projects = await c.call("project_list", {});
    assert.match(projects.text, /Nova/);
    assert.doesNotMatch(projects.text, /junk/);
    // the counter carries on from the file, so an id is never reissued
    const add = await c.call("task_add", { project: "Nova", title: "next" });
    assert.match(add.text, /^NOVA-5/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("a marker with no quarantine file still blocks and says how to clear it", async () => {
  const s = sandbox();
  writeFileSync(join(s.prod, "data.json.corrupt"), "/some/where/data.json.corrupt-2026", "utf8");
  const c = client(s.env);
  try {
    await c.init();
    const r = await c.call("board", {});
    assert.equal(r.isError, true, r.text);
    assert.match(r.text, /delete .*data\.json\.corrupt to continue/);
  } finally {
    c.close(); s.cleanup();
  }
});
