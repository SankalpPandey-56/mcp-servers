// A damaged data dir must never be reported as "no transactions": the next import would
// then overwrite a year of statements that is still on disk.
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

const CSV = [
  "Date,Description,Amount,Currency,Balance",
  "2026-03-01,Coffee,-3.50,EUR,996.50",
  "2026-03-02,Client payment,500.00,EUR,1496.50",
].join("\n") + "\n";

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
  const dir = mkdtempSync(join(tmpdir(), "mcp-bank-corrupt-"));
  const dataHome = join(dir, "data");
  const prod = join(dataHome, "mcp-servers", "bank-statement");
  mkdirSync(prod, { recursive: true });
  const csv = join(dir, "statement.csv");
  writeFileSync(csv, CSV, "utf8");
  return {
    dir, prod, csv,
    env: { XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dir, "cfg") },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test("a data.json that is not JSON is quarantined, not overwritten", async () => {
  const s = sandbox();
  const db = join(s.prod, "data.json");
  const original = '{"version":1,"transactions":[{"id":"a1","date":"2026-01-01"'; // truncated mid-write
  writeFileSync(db, original, "utf8");
  const c = client(s.env);
  try {
    await c.init();
    const list = await c.call("accounts_list", {});
    assert.equal(list.isError, true, list.text);
    assert.match(list.text, /corrupt/);
    assert.match(list.text, /nothing was written/);

    // the bytes are still on disk under the quarantine name
    const moved = readdirSync(s.prod).filter((f) => /^data\.json\.corrupt-/.test(f));
    assert.equal(moved.length, 1, readdirSync(s.prod).join(", "));
    assert.equal(readFileSync(join(s.prod, moved[0]), "utf8"), original);
    assert.ok(existsSync(join(s.prod, "data.json.corrupt")), "a marker must block later calls");

    // and a later write still refuses rather than starting a fresh ledger over the top
    const imp = await c.call("statement_import", { path: s.csv, account: "business" });
    assert.equal(imp.isError, true, imp.text);
    assert.match(imp.text, /corrupt/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("a transaction row of the wrong shape is dropped, not fatal", async () => {
  const s = sandbox();
  writeFileSync(join(s.prod, "data.json"), JSON.stringify({
    version: 1,
    accounts: [{ name: "business", created: "2026-01-01T00:00:00.000Z" }, 7],
    transactions: [
      { id: "good", account: "business", date: "2026-02-01", description: "Kept", amount_minor: -100, currency: "EUR", bank: "generic", dedupe: "x#0", imported: "2026-02-01T00:00:00.000Z" },
      { id: "bad", account: "business", date: "2026-02-02", amount_minor: "not a number", currency: "EUR" },
      null,
    ],
    rules: [{ match: "kept", category: "ok" }, { nonsense: true }],
  }), "utf8");
  const c = client(s.env);
  try {
    await c.init();
    const list = await c.call("transactions_list", { from: "2026-01-01", to: "2026-12-31" });
    assert.equal(list.isError, false, list.text);
    const j = JSON.parse(list.text);
    assert.equal(j.count, 1, "the malformed rows are dropped, the good one survives");
    assert.equal(j.transactions[0].description, "Kept");
    const rules = JSON.parse((await c.call("category_rules", {})).text);
    assert.equal(rules.count, 1);
    // and a write still works on top of the cleaned ledger
    const imp = await c.call("statement_import", { path: s.csv, account: "business" });
    assert.equal(imp.isError, false, imp.text);
  } finally {
    c.close(); s.cleanup();
  }
});

test("an empty ledger is empty, and a missing file is not a corruption", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const accs = await c.call("accounts_list", {});
    assert.equal(accs.isError, false, accs.text);
    assert.equal(JSON.parse(accs.text).count, 0);
    assert.ok(!existsSync(join(s.prod, "data.json.corrupt")));
  } finally {
    c.close(); s.cleanup();
  }
});

test("a CSV that is not a bank export is refused with a reason, and nothing is stored", async () => {
  const s = sandbox();
  const junk = join(s.dir, "junk.csv");
  writeFileSync(junk, "hello,world\n1,2\n", "utf8");
  const c = client(s.env);
  try {
    await c.init();
    const imp = await c.call("statement_import", { path: junk, account: "junk" });
    assert.equal(imp.isError, true, imp.text);
    assert.match(imp.text, /no header row was found/);
    const accs = JSON.parse((await c.call("accounts_list", {})).text);
    assert.equal(accs.count, 0, "a refused import must not create the account");

    const missing = await c.call("statement_import", { path: join(s.dir, "nowhere.csv") });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /no file at/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("a CSV with an unterminated quote is refused rather than swallowing the file into one cell", async () => {
  const s = sandbox();
  const broken = join(s.dir, "broken.csv");
  writeFileSync(broken, 'Date,Description,Amount,Currency\n2026-03-01,"Coffee,-3.50,EUR\n2026-03-02,Tea,-2.00,EUR\n', "utf8");
  const c = client(s.env);
  try {
    await c.init();
    const imp = await c.call("statement_import", { path: broken, account: "broken" });
    assert.equal(imp.isError, true, imp.text);
    assert.match(imp.text, /quoted field/);
  } finally {
    c.close(); s.cleanup();
  }
});
