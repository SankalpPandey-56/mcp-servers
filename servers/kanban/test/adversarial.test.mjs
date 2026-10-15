import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveProject } from "../dist/board.js";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

/** Minimal stdio client that also records any stdout line that is not JSON-RPC. */
function client(env) {
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-kb-adv-"));
  const child = spawn(process.execPath, [ENTRY], {
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
  const nonJson = [];
  child.stdout.on("data", chunk => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { nonJson.push(line.slice(0, 120)); continue; }
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 20000);
    t.unref();
  });
  return {
    nonJson, sandbox,
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "adv", version: "0.0.0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (r.error) return { text: r.error.message, isError: true, schema: true };
      return { text: r.result.content.map(c => c.text).join("\n"), isError: r.result.isError === true, schema: false };
    },
    close() { child.stdin.end(); child.kill(); try { rmSync(sandbox, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

test("oversized and out-of-range arguments are refused at the schema", async () => {
  const c = client();
  try {
    await c.init();
    await c.call("task_add", { project: "Nova", title: "seed" });

    const big = await c.call("task_add", { project: "Nova", title: "x".repeat(1048576) });
    assert.equal(big.isError, true);
    assert.match(big.text, /300 characters or fewer/);

    const notes = await c.call("task_add", { project: "Nova", title: "n", notes: "y".repeat(1048576) });
    assert.match(notes.text, /5000 characters or fewer/);

    const proj = await c.call("task_add", { project: "z".repeat(5000), title: "p" });
    assert.match(proj.text, /100 characters or fewer/);

    const tags = await c.call("task_add", { project: "Nova", title: "t", tags: Array.from({ length: 1000 }, () => "t") });
    assert.match(tags.text, /at most 30 element/);

    const neg = await c.call("task_add", { project: "Nova", title: "e", estimate_minutes: -5 });
    assert.match(neg.text, /at least 0/);

    const huge = await c.call("task_add", { project: "Nova", title: "e", estimate_minutes: 1e9 });
    assert.match(huge.text, /100000 minutes/);

    const logHuge = await c.call("task_log_time", { id: "NOVA-1", minutes: 1e9 });
    assert.match(logHuge.text, /100000 minutes/);

    for (const p of ["urgent!", "HIGH", "1"]) {
      const r = await c.call("task_add", { project: "Nova", title: "p", priority: p });
      assert.equal(r.isError, true, `priority ${p} should be refused`);
      assert.match(r.text, /Invalid enum value/);
    }
    assert.deepEqual(c.nonJson, []);
  } finally { c.close(); }
});

test("a blank project name never becomes a board that swallows every later project", async () => {
  // The unit rule first: an empty stored name is a prefix of every input.
  assert.deepEqual(resolveProject([""], "Nova"), { kind: "use", project: "Nova" });

  const c = client();
  try {
    await c.init();
    const blank = await c.call("task_add", { project: "   ", title: "pe" });
    assert.equal(blank.isError, true);
    assert.match(blank.text, /project is blank/);

    await c.call("task_add", { project: "Nova", title: "seed" });
    const list = await c.call("project_list");
    assert.match(list.text, /Nova/);
    assert.equal(list.text.split("\n").filter(l => l.trim() && !l.startsWith("-") && !l.startsWith("project") && !l.startsWith("Free")).length, 1);
  } finally { c.close(); }
});

test("due dates: 2026-13-45 refused, weekdays and relative days accepted", async () => {
  const c = client();
  try {
    await c.init();
    const bad = await c.call("task_add", { project: "Nova", title: "bad", due: "2026-13-45" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /not a valid date: 2026-13-45/);

    const nonsense = await c.call("task_add", { project: "Nova", title: "junk", due: "sometime soon" });
    assert.equal(nonsense.isError, true);
    assert.match(nonsense.text, /Use YYYY-MM-DD/);

    for (const due of ["today", "tomorrow", "+3d", "friday", "next Monday", "2026-09-10"]) {
      const r = await c.call("task_add", { project: "Nova", title: `due ${due}`, due });
      assert.equal(r.isError, false, `${due}: ${r.text}`);
      assert.match(r.text, /Due \d{4}-\d{2}-\d{2}\./, `${due} did not resolve to a day: ${r.text}`);
    }

    // "next <weekday>" is strictly after today; the bare weekday may be today itself.
    const l = await c.call("task_list", { project: "Nova" });
    const dayOf = title => {
      const row = l.text.split("\n").find(r => r.includes(title));
      return /(\d{4}-\d{2}-\d{2})/.exec(row)[1];
    };
    assert.ok(dayOf("due next Monday") > dayOf("due today"), l.text);
    assert.ok(dayOf("due friday") >= dayOf("due today"), l.text);

    const asOf = await c.call("overdue", { as_of: "next Monday" });
    assert.equal(asOf.isError, false, asOf.text);
  } finally { c.close(); }
});

test("columns: unknown target refused, and blanks cannot collapse a board to one column", async () => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "kanban"], { encoding: "utf8" }).trim();
  const c = client({ MCP_LICENSE_KEY: key });
  try {
    await c.init();
    await c.call("task_add", { project: "Alpha", title: "alpha seed" });

    for (const column of ["nope", "  To Do  ", "дела", "   "]) {
      const r = await c.call("task_move", { id: "ALPH-1", column });
      assert.equal(r.isError, true, `column ${JSON.stringify(column)} should be refused`);
    }

    // D-K4: min(2) ran before the blanks were filtered, leaving one column that is also
    // doneColumn(), so every task on the board silently read as done.
    const collapse = await c.call("columns_set", { project: "Alpha", columns: ["only", "   "] });
    assert.equal(collapse.isError, true, collapse.text);
    assert.match(collapse.text, /at least 2 named columns/);
    const open = await c.call("task_list", { project: "Alpha" });
    assert.match(open.text, /ALPH-1/, "the task must still be open after the refused change");

    const many = await c.call("columns_set", { project: "Alpha", columns: Array.from({ length: 500 }, (_, i) => `c${i}`) });
    assert.match(many.text, /at most 12 element/);
    const long = await c.call("columns_set", { project: "Alpha", columns: ["a", "b".repeat(1048576)] });
    assert.match(long.text, /40 characters or fewer/);

    // spaces and non-ASCII are legal column names once they survive normalisation
    const okCols = await c.call("columns_set", { project: "Alpha", columns: ["To Do", "В работе", "Done"] });
    assert.equal(okCols.isError, false, okCols.text);
    assert.match(okCols.text, /to do -> в работе -> done/);
    const mv = await c.call("task_move", { id: "ALPH-1", column: "В РАБОТЕ" });
    assert.equal(mv.isError, false, mv.text);
  } finally { c.close(); }
});

test("deleting a task with logged time says what was lost and does not touch the time tracker", async () => {
  const c = client();
  try {
    await c.init();
    await c.call("task_add", { project: "Nova", title: "has time" });
    await c.call("task_log_time", { id: "NOVA-1", minutes: 90 });
    const d = await c.call("task_delete", { id: "NOVA-1" });
    assert.equal(d.isError, false, d.text);
    assert.match(d.text, /1h 30m of logged time/);
    assert.match(d.text, /time-tracker entries .* were not touched/);
    const gone = await c.call("task_log_time", { id: "NOVA-1", minutes: 5 });
    assert.equal(gone.isError, true);
  } finally { c.close(); }
});

test("5,000 tasks: list, board and search stay bounded in time and in output size", async () => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "kanban"], { encoding: "utf8" }).trim();
  const c = client({ MCP_LICENSE_KEY: key });
  try {
    await c.init();
    const t0 = Date.now();
    for (let i = 0; i < 5000; i++) {
      const r = await c.call("task_add", {
        project: i % 2 ? "Nova" : "Alpha",
        title: `task ${i}`,
        due: `2026-09-${String(1 + (i % 28)).padStart(2, "0")}`,
        estimate_minutes: 30,
      });
      if (r.isError) assert.fail(`task_add ${i}: ${r.text}`);
    }
    const addMs = Date.now() - t0;

    const timed = async (name, args) => {
      const t = Date.now();
      const r = await c.call(name, args);
      return { r, ms: Date.now() - t };
    };
    const list = await timed("task_list", {});
    const board = await timed("board", { project: "Nova" });
    const search = await timed("task_search", { query: "task" });
    for (const [n, x] of [["task_list", list], ["board", board], ["task_search", search]]) {
      assert.equal(x.r.isError, false, `${n}: ${x.r.text}`);
      assert.ok(x.ms < 3000, `${n} took ${x.ms} ms on 5000 tasks`);
      assert.ok(x.r.text.length < 60000, `${n} returned ${x.r.text.length} chars`);
    }
    assert.match(list.r.text, /5000 task\(s\)/);
    assert.match(list.r.text, /Showing the first 200 of 5000/);
    const wide = await c.call("task_list", { limit: 2000 });
    assert.match(wide.text, /Showing the first 2000 of 5000/);
    process.stderr.write(`5000 adds ${addMs} ms; task_list ${list.ms} ms ${list.r.text.length} chars\n`);
    assert.deepEqual(c.nonJson, []);
  } finally { c.close(); }
});

test("weekly_review for a week with nothing in it answers instead of failing", async () => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "kanban"], { encoding: "utf8" }).trim();
  const c = client({ MCP_LICENSE_KEY: key });
  try {
    await c.init();
    const empty = await c.call("weekly_review", { week: "2019-W03" });
    assert.equal(empty.isError, false, empty.text);
    assert.match(empty.text, /Nothing planned and nothing completed/);
    const bad = await c.call("weekly_review", { week: "banana" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /2026-W36/);
  } finally { c.close(); }
});

test("task_start_timer warns when the time tracker would file the timer under another project", async () => {
  const c = client();
  try {
    await c.init();
    await c.call("task_add", { project: "Nova", title: "API design" });
    const clean = await c.call("task_start_timer", { id: "NOVA-1" });
    assert.equal(clean.isError, false, clean.text);
    assert.doesNotMatch(clean.text, /Warning:/, "no sibling store yet, so nothing to warn about");

    // Write a time-tracker store next to this server's, holding a colliding project name.
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const ttDir = join(c.sandbox, "data", "mcp-servers", "time-tracker");
    mkdirSync(ttDir, { recursive: true });
    writeFileSync(join(ttDir, "data.json"), JSON.stringify({
      version: 1, entries: [{ id: "a", project: "Nova App", task: "y", seconds: 600 }], projects: {},
    }));
    const warned = await c.call("task_start_timer", { id: "NOVA-1" });
    assert.match(warned.text, /"project": "Nova"/);
    assert.match(warned.text, /it does have "Nova App"/);
  } finally { c.close(); }
});
