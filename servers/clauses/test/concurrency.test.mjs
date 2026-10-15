// Two server processes on one data dir adding and updating clauses at the same time.
// data.json is a single file holding the whole library, so an unlocked read-modify-write
// loses whichever write landed second. withFileLock is what makes every clause survive.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");
const N = 12;

function client(dataHome, key) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dataHome, "cfg"), MCP_LICENSE_KEY: key },
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
    send,
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "conc", version: "0.0.0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: (name, args) => send("tools/call", { name, arguments: args ?? {} }),
    close() { child.kill(); },
  };
}

test("two processes, one data dir: every clause and every update survives", async () => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "clauses"], { encoding: "utf8" }).trim();
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-clauses-conc-"));
  const dataHome = join(sandbox, "data");
  const a = client(dataHome, key);
  const b = client(dataHome, key);
  try {
    await Promise.all([a.init(), b.init()]);

    const work = [];
    for (let i = 0; i < N; i++) {
      work.push(a.call("clause_add", { title: `A clause ${i}`, body: `From A ${i} for {{client}}.`, category: "general" }));
      work.push(b.call("clause_add", { title: `B clause ${i}`, body: `From B ${i} for {{client}}.`, category: "payment" }));
    }
    const results = await Promise.all(work);
    for (const r of results) assert.ok(r.result && !r.result.isError, JSON.stringify(r.result ?? r.error));

    const db = JSON.parse(readFileSync(join(dataHome, "mcp-servers", "clauses", "data.json"), "utf8"));
    const own = db.clauses.filter((c) => !c.starter);
    assert.equal(own.length, 2 * N, `expected ${2 * N} own clauses, found ${own.length}`);
    assert.equal(new Set(db.clauses.map((c) => c.id)).size, db.clauses.length, "duplicate ids");
    assert.equal(db.clauses.length, 25 + 2 * N, "the starter set was re-seeded or lost");
    for (let i = 0; i < N; i++) {
      assert.ok(own.some((c) => c.title === `A clause ${i}`), `lost A clause ${i}`);
      assert.ok(own.some((c) => c.title === `B clause ${i}`), `lost B clause ${i}`);
    }

    // Interleaved updates on the same clause: both must be recorded, last one wins the body.
    const updates = [];
    for (let i = 0; i < N; i++) {
      updates.push(a.call("clause_update", { id: `a-clause-${i}`, body: `A rewritten ${i} for {{client}}.` }));
      updates.push(b.call("clause_update", { id: `b-clause-${i}`, tags: ["reviewed"] }));
    }
    for (const r of await Promise.all(updates)) assert.ok(r.result && !r.result.isError, JSON.stringify(r.result ?? r.error));

    const after = JSON.parse(readFileSync(join(dataHome, "mcp-servers", "clauses", "data.json"), "utf8"));
    assert.equal(after.clauses.length, 25 + 2 * N, "an update dropped a clause");
    for (let i = 0; i < N; i++) {
      const ca = after.clauses.find((c) => c.id === `a-clause-${i}`);
      assert.equal(ca.body, `A rewritten ${i} for {{client}}.`);
      assert.equal(ca.history.length, 1, "Pro must keep one prior version");
      assert.deepEqual(after.clauses.find((c) => c.id === `b-clause-${i}`).tags, ["reviewed"]);
    }
  } finally {
    a.close(); b.close();
  }
});
