import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");
const TT_ENTRY = join(REPO, "servers", "time-tracker", "dist", "index.js");

/** Minimal stdio JSON-RPC client for one server process. */
function client(entry, env) {
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-kb-"));
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_DATA_HOME: join(sandbox, "data"),
      XDG_CONFIG_HOME: join(sandbox, "config"),
      MCP_LICENSE_KEY: "",
      ...env,
    },
  });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", chunk => {
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
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 15000);
    t.unref();
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return {
    send, notify, sandbox,
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned no result: ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map(c => c.text).join("\n"), isError: r.result.isError === true };
    },
    async init(expectedName) {
      const r = await send("initialize", {
        protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.0" },
      });
      assert.equal(r.result.serverInfo.name, expectedName);
      notify("notifications/initialized");
      return r.result;
    },
    close() { child.kill(); try { rmSync(sandbox, { recursive: true, force: true }); } catch {} },
  };
}

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const shiftDay = (n) => {
  const [y, m, d] = localDay().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};

test("free tier: initialize, tools/list, add, move, board, overdue, timer handoff, project limit", async () => {
  const c = client(ENTRY, {});
  try {
    await c.init("mcp-kanban");

    const tools = (await c.send("tools/list", {})).result.tools.map(t => t.name).sort();
    for (const n of ["board", "columns_set", "license_activate", "license_status", "overdue", "project_list",
      "task_add", "task_delete", "task_done", "task_list", "task_log_time", "task_move",
      "task_search", "task_start_timer", "task_update", "weekly_review"]) {
      assert.ok(tools.includes(n), `tools/list is missing ${n}: ${tools.join(", ")}`);
    }

    // five tasks across two projects
    const added = [];
    for (const [project, title, extra] of [
      ["Nova Site", "Write the launch email", { estimate_minutes: 90, due: shiftDay(0) }],
      ["Nova Site", "Fix the pricing table", { estimate_minutes: 30, due: shiftDay(-2), priority: "high", tags: ["bug"] }],
      ["Nova Site", "Record the demo", { estimate_minutes: 60 }],
      ["Acme App", "Ship v2", { estimate_minutes: 120, due: shiftDay(3) }],
      ["Acme App", "Answer support backlog", { tags: ["support"] }],
    ]) {
      const r = await c.call("task_add", { project, title, ...extra });
      assert.equal(r.isError, false, r.text);
      added.push(r.text.split(/\s+/)[0]);
    }
    assert.match(added[0], /^NS-1$/);           // slug from initials, base36 counter
    assert.match(added[3], /^AA-1$/);           // second board gets its own counter
    assert.equal(new Set(added).size, 5);

    // move
    const mv = await c.call("task_move", { id: added[0], column: "doing" });
    assert.equal(mv.isError, false, mv.text);
    assert.match(mv.text, /backlog -> doing/);
    const badCol = await c.call("task_move", { id: added[0], column: "nowhere" });
    assert.equal(badCol.isError, true);
    assert.match(badCol.text, /is not a column/);

    // board summary: counts and estimate totals per column
    const b = await c.call("board", { project: "nova" });      // prefix resolution
    assert.equal(b.isError, false, b.text);
    assert.match(b.text, /column\s+tasks\s+estimate/);
    assert.match(b.text, /doing\s+1\s+1h 30m/);
    assert.match(b.text, /backlog\s+2\s+1h 30m/);
    assert.match(b.text, /3 task\(s\), 3 open, estimate 3h remaining/);

    // overdue: only the task whose due day is already past
    const od = await c.call("overdue", {});
    assert.equal(od.isError, false, od.text);
    assert.match(od.text, /Fix the pricing table/);
    assert.doesNotMatch(od.text, /Write the launch email/);   // due today is not overdue
    assert.match(od.text, /1 overdue as of/);

    // task_list filters
    const byTag = await c.call("task_list", { tag: "bug" });
    assert.match(byTag.text, /1 task\(s\)/);
    const search = await c.call("task_search", { query: "demo" });
    assert.match(search.text, /Record the demo/);

    // the timer handoff must name exactly the arguments time-tracker's timer_start takes
    const hand = await c.call("task_start_timer", { id: added[0] });
    assert.equal(hand.isError, false, hand.text);
    const args = JSON.parse(hand.text.slice(hand.text.indexOf("{"), hand.text.lastIndexOf("}") + 1));
    assert.deepEqual(Object.keys(args).sort(), ["project", "task"]);
    assert.equal(args.project, "Nova Site");
    assert.equal(args.task, "Write the launch email");
    const tt = client(TT_ENTRY, {});
    try {
      await tt.init("mcp-time-tracker");
      const schema = (await tt.send("tools/list", {})).result.tools.find(t => t.name === "timer_start");
      assert.ok(schema, "time-tracker has no timer_start");
      const accepted = Object.keys(schema.inputSchema.properties);
      for (const k of Object.keys(args)) assert.ok(accepted.includes(k), `timer_start does not accept ${k}: ${accepted.join(", ")}`);
      for (const k of schema.inputSchema.required ?? []) assert.ok(k in args, `timer_start requires ${k}, which the handoff omits`);
      const started = await tt.call("timer_start", args);
      assert.equal(started.isError, false, started.text);
      assert.match(started.text, /Started timer for "Nova Site" - Write the launch email/);
    } finally { tt.close(); }

    // actuals and completion
    await c.call("task_log_time", { id: added[0], minutes: 120 });
    const done = await c.call("task_done", { id: added[0] });
    assert.match(done.text, /estimate 1h 30m, actual 2h/);

    // free tier: a 4th project board is refused, with the checkout URL
    const p4 = await c.call("task_add", { project: "Zephyr", title: "third board is fine" });
    assert.equal(p4.isError, false, p4.text);       // 3rd board allowed
    const p5 = await c.call("task_add", { project: "Delta Co", title: "fourth board" });
    assert.equal(p5.isError, false, p5.text);
    assert.match(p5.text, /free tier keeps 3 project boards/);
    assert.match(p5.text, /https:\/\/mcp\.zovo\.one\/buy\/kanban/);
    const projects = await c.call("project_list", {});
    assert.doesNotMatch(projects.text, /Delta Co/);

    // custom columns are Pro
    const cols = await c.call("columns_set", { project: "Nova Site", columns: ["inbox", "next", "shipped"] });
    assert.match(cols.text, /Pro feature/);
    assert.match(cols.text, /https:\/\/mcp\.zovo\.one\/buy\/kanban/);

    // a past week's review is Pro; this week is free
    const past = await c.call("weekly_review", { week: "2020-W02" });
    assert.match(past.text, /Pro feature/);
    const nowWeek = await c.call("weekly_review", {});
    assert.equal(nowWeek.isError, false, nowWeek.text);
    assert.match(nowWeek.text, /Week \d{4}-W\d{2}/);

    // resource and prompt
    const res = await c.send("resources/read", { uri: "kanban://today" });
    assert.match(res.result.contents[0].text, /DUE TODAY/);
    assert.match(res.result.contents[0].text, /OVERDUE/);
    assert.match(res.result.contents[0].text, /Fix the pricing table/);
    const pr = await c.send("prompts/get", { name: "plan_week", arguments: { hours: "20" } });
    assert.match(pr.result.messages[0].content.text, /Capacity: 20 hours/);
  } finally {
    c.close();
  }
});

test("pro tier: a signed key unlocks more projects, custom columns and past weeks", async () => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "kanban"], { encoding: "utf8" }).trim();
  assert.match(key, /^MCPL1\./);
  const c = client(ENTRY, { MCP_LICENSE_KEY: key });
  try {
    await c.init("mcp-kanban");
    const status = await c.call("license_status");
    assert.match(status.text, /"tier": "pro"/);

    for (const p of ["One", "Two", "Three", "Four", "Five"]) {
      const r = await c.call("task_add", { project: p, title: `task for ${p}` });
      assert.equal(r.isError, false, r.text);
      assert.doesNotMatch(r.text, /Pro feature|free tier keeps/, `project ${p} should be allowed on pro`);
    }

    const cols = await c.call("columns_set", { project: "One", columns: ["inbox", "next", "shipped"] });
    assert.equal(cols.isError, false, cols.text);
    assert.match(cols.text, /inbox -> next -> shipped/);
    assert.match(cols.text, /Removed backlog, todo, doing, review, done; 1 task\(s\) moved to inbox/);

    // the renamed last column now closes a task
    const b = await c.call("board", { project: "One" });
    assert.match(b.text, /shipped/);
    const list = await c.call("task_list", { project: "One" });
    const id = list.text.split("\n")[2].split(/\s+/)[0];
    const mv = await c.call("task_move", { id, column: "shipped" });
    assert.equal(mv.isError, false, mv.text);
    const open = await c.call("task_list", { project: "One" });
    assert.match(open.text, /No tasks match/);

    const past = await c.call("weekly_review", { week: "2020-W02" });
    assert.equal(past.isError, false, past.text);
    assert.match(past.text, /Week 2020-W02 \(2020-01-06 to 2020-01-12\)/);
  } finally {
    c.close();
  }
});
