// Two server processes on one data dir must not lose an imported statement. Without the
// advisory lock the load-mutate-save cycles interleave and each process saves a ledger
// that is missing the other's transactions.
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
const N = 10;
const ROWS = 4;

const FIXTURE = (tag) => [
  "Date,Description,Amount,Currency,Balance",
  ...Array.from({ length: ROWS }, (_, i) =>
    `2026-03-${String(i + 1).padStart(2, "0")},Payment ${tag} ${i},-${10 + i}.00,EUR,${1000 - i}.00`),
].join("\n") + "\n";

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

function proEnv(dir) {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "bank-statement"], { encoding: "utf8" }).trim();
  return { XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "cfg"), MCP_LICENSE_KEY: key };
}

test(`two processes, one data dir: ${2 * N} concurrent imports all persist`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-bank-conc-"));
  const env = proEnv(dir);   // Pro, so the free two-account cap is not what is being measured
  for (let i = 0; i < N; i++) {
    for (const tag of ["a", "b"]) writeFileSync(join(dir, `${tag}${i}.csv`), FIXTURE(`${tag}${i}`), "utf8");
  }
  const a = client(env);
  const b = client(env);
  try {
    await Promise.all([a.init(), b.init()]);
    const jobs = [];
    for (let i = 0; i < N; i++) {
      jobs.push(a.call("statement_import", { path: join(dir, `a${i}.csv`), account: `a${i}` }));
      jobs.push(b.call("statement_import", { path: join(dir, `b${i}.csv`), account: `b${i}` }));
    }
    const results = await Promise.all(jobs);
    for (const r of results) {
      assert.ok(r.result, `call failed: ${JSON.stringify(r.error)}`);
      assert.equal(r.result.isError, undefined, r.result.content?.[0]?.text);
    }

    const file = join(dir, "data", "mcp-servers", "bank-statement", "data.json");
    const db = JSON.parse(readFileSync(file, "utf8"));
    const names = db.accounts.map((x) => x.name).sort();
    assert.equal(names.length, 2 * N, `expected ${2 * N} accounts on disk, found ${names.length}: ${names.join(", ")}`);
    assert.equal(db.transactions.length, 2 * N * ROWS, "every transaction of every import has to survive");
    for (let i = 0; i < N; i++) {
      assert.equal(db.transactions.filter((t) => t.account === `a${i}`).length, ROWS, `lost rows of a${i}`);
      assert.equal(db.transactions.filter((t) => t.account === `b${i}`).length, ROWS, `lost rows of b${i}`);
    }

    // both processes agree with the file
    const list = JSON.parse((await a.call("accounts_list", {})).result.content[0].text);
    assert.equal(list.count, 2 * N);
  } finally {
    a.close(); b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent imports of the SAME export into one account still deduplicate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-bank-conc2-"));
  const env = proEnv(dir);
  const csv = join(dir, "same.csv");
  writeFileSync(csv, FIXTURE("same"), "utf8");
  const a = client(env);
  const b = client(env);
  try {
    await Promise.all([a.init(), b.init()]);
    const jobs = [];
    for (let i = 0; i < 4; i++) {
      jobs.push(a.call("statement_import", { path: csv, account: "shared" }));
      jobs.push(b.call("statement_import", { path: csv, account: "shared" }));
    }
    await Promise.all(jobs);
    const db = JSON.parse(readFileSync(join(dir, "data", "mcp-servers", "bank-statement", "data.json"), "utf8"));
    assert.equal(db.transactions.length, ROWS,
      `eight concurrent imports of one file must leave ${ROWS} transactions, found ${db.transactions.length}`);
    assert.equal(db.accounts.length, 1);
  } finally {
    a.close(); b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("concurrent rule writes and categorisation do not lose the ledger", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-bank-conc3-"));
  const env = proEnv(dir);
  const csv = join(dir, "s.csv");
  writeFileSync(csv, FIXTURE("x"), "utf8");
  const a = client(env);
  const b = client(env);
  try {
    await Promise.all([a.init(), b.init()]);
    await a.call("statement_import", { path: csv, account: "one" });
    const jobs = [];
    for (let i = 0; i < 6; i++) {
      jobs.push(a.call("category_rules", { rules: [{ match: `payment x ${i}`, category: `c${i}` }] }));
      jobs.push(b.call("statement_import", { path: csv, account: `extra${i}` }));
    }
    await Promise.all(jobs);
    const db = JSON.parse(readFileSync(join(dir, "data", "mcp-servers", "bank-statement", "data.json"), "utf8"));
    assert.equal(db.accounts.length, 7, db.accounts.map((x) => x.name).join(", "));
    assert.equal(db.transactions.length, 7 * ROWS);
    assert.equal(db.rules.length, 1, "the last rule set written wins; none of them corrupts the file");
  } finally {
    a.close(); b.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
