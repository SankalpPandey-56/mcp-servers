// D-B4 follow-up (docs/BANK_AUDIT.md): expense_summary and expense_export answer from the
// hand-logged receipts alone, and a caller asking "what did I spend" gets a confident answer
// from one seeded receipt while an imported bank ledger with dozens of rows sits unread in
// the same session. This tests the sibling-store line added to close that gap: present when
// bank-statement has transactions in the requested period, absent when it does not exist,
// is corrupt, or holds nothing in range.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function bankDataFile(xdgDataHome) {
  return join(xdgDataHome, "mcp-servers", "bank-statement", "data.json");
}

function writeBankDb(xdgDataHome, transactions) {
  const file = bankDataFile(xdgDataHome);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ version: 1, accounts: [], rules: [], transactions }, null, 2));
}

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-expense-banksib-"));
  const dataHome = join(home, "data");
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(home, "config"), MCP_LICENSE_KEY: "", ...env },
  });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
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
    home, dataHome, child, send,
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      return { text: r.result?.content?.[0]?.text ?? "", isError: !!r.result?.isError };
    },
    close: () => child.kill(),
  };
}

async function started(t, env) {
  const c = client(env);
  t.after(() => c.close());
  await c.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  return c;
}

// The free tier reads a window of the last FREE_WINDOW_DAYS days measured from TODAY, so
// hard-coded August dates in this fixture silently fell out of range once the calendar moved
// past them and the count dropped from 2 to 1. Every date here is relative to today.
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test("expense_summary names the bank tool when bank-statement holds transactions in range", async (t) => {
  const c = await started(t);
  const d3 = daysAgo(3), d5 = daysAgo(5);
  writeBankDb(c.dataHome, [
    { id: "1", account: "Revolut", date: d5, description: "Spotify", amount_minor: -999, currency: "EUR", bank: "revolut", dedupe: "a", imported: `${d5}T00:00:00.000Z` },
    { id: "2", account: "Revolut", date: d3, description: "Adobe", amount_minor: -6150, currency: "EUR", bank: "revolut", dedupe: "b", imported: `${d3}T00:00:00.000Z` },
  ]);
  await c.call("expense_add", { amount: 61.50, currency: "EUR", category: "software", merchant: "Adobe", date: d3 });
  const r = JSON.parse((await c.call("expense_summary", { from: daysAgo(10), to: daysAgo(0), group_by: "category" })).text);
  assert.match(r.bank_ledger, /2 transactions/);
  assert.match(r.bank_ledger, /statement_summary/);
});

test("expense_summary is unchanged when there is no bank-statement store", async (t) => {
  const c = await started(t);
  await c.call("expense_add", { amount: 61.50, currency: "EUR", category: "software", merchant: "Adobe", date: "2026-08-07" });
  const r = JSON.parse((await c.call("expense_summary", { from: "2026-08-01", to: "2026-08-31", group_by: "category" })).text);
  assert.equal(r.bank_ledger, undefined);
});

test("expense_summary is unchanged when the bank store has nothing in the requested period", async (t) => {
  const c = await started(t);
  writeBankDb(c.dataHome, [
    { id: "1", account: "Revolut", date: "2026-01-05", description: "Spotify", amount_minor: -999, currency: "EUR", bank: "revolut", dedupe: "a", imported: "2026-01-05T00:00:00.000Z" },
  ]);
  const r = JSON.parse((await c.call("expense_summary", { from: "2026-08-01", to: "2026-08-31", group_by: "category" })).text);
  assert.equal(r.bank_ledger, undefined);
});

test("expense_summary stays silent when the bank store is unreadable", async (t) => {
  const c = await started(t);
  const file = bankDataFile(c.dataHome);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, "{not json");
  const r = JSON.parse((await c.call("expense_summary", { from: "2026-08-01", to: "2026-08-31", group_by: "category" })).text);
  assert.equal(r.bank_ledger, undefined);
});

test("expense_export names the bank tool when bank-statement holds transactions in range", async (t) => {
  const c = await started(t);
  // Relative dates: the free window is measured from TODAY, so a hard-coded fixture
  // silently falls out of range once the calendar moves past it (same time-bomb the
  // summary test above fixed).
  const d1 = daysAgo(4), d30 = daysAgo(1);
  writeBankDb(c.dataHome, [
    { id: "1", account: "Revolut", date: d30, description: "Spotify", amount_minor: -999, currency: "EUR", bank: "revolut", dedupe: "a", imported: `${d30}T00:00:00.000Z` },
  ]);
  await c.call("expense_add", { amount: 3.60, currency: "EUR", category: "meals", merchant: "Costa", date: d30 });
  const out = join(c.home, "sept.csv");
  const r = await c.call("expense_export", { from: d1, to: d30, format: "csv", path: out });
  assert.match(r.text, /1 transaction/);
  assert.match(r.text, /statement_export/);
});

test("expense_export is unchanged with no bank-statement store", async (t) => {
  const c = await started(t);
  await c.call("expense_add", { amount: 3.60, currency: "EUR", category: "meals", merchant: "Costa", date: "2026-09-01" });
  const out = join(c.home, "sept2.csv");
  const r = await c.call("expense_export", { from: "2026-09-01", to: "2026-09-30", format: "csv", path: out });
  assert.doesNotMatch(r.text, /bank-statement/);
});

test("tool descriptions say receipts only and name bank-statement, under 220 chars", async (t) => {
  const c = await started(t);
  const list = await c.send("tools/list", {});
  const tools = list.result.tools;
  for (const name of ["expense_summary", "expense_export"]) {
    const tool = tools.find((x) => x.name === name);
    assert.ok(tool, `${name} not found`);
    assert.ok(tool.description.length <= 220, `${name} description is ${tool.description.length} chars`);
    assert.match(tool.description, /bank-statement/);
  }
});

// Profile-first sweep (docs/PROFILE_FIRST_RESULT.md), the D-R64 species: expense_add
// assumed EUR for a caller whose shared business profile already said PLN. Chain: the call,
// then expense_settings, then the shared profile, then EUR.
test("expense_add takes its currency from the shared business profile", async (t) => {
  const c = await started(t);
  const { mkdirSync, writeFileSync: wf } = await import("node:fs");
  const dir = join(c.dataHome, "mcp-servers", "profile");
  mkdirSync(dir, { recursive: true });
  wf(join(dir, "business.json"), JSON.stringify({ name: "Nova Studio", default_currency: "PLN" }));

  const r = await c.call("expense_add", { amount: 100, merchant: "Adobe" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /PLN/);
  assert.match(r.text, /shared business profile \(default_currency\)/);

  // An explicit currency still wins and is not annotated as profile-sourced.
  const r2 = await c.call("expense_add", { amount: 100, currency: "GBP", merchant: "Adobe" });
  assert.equal(r2.isError, false, r2.text);
  assert.match(r2.text, /GBP/);
  assert.doesNotMatch(r2.text, /shared business profile \(default_currency\)/);
});

test("expense_add with no profile currency still falls back to EUR, unannotated", async (t) => {
  const c = await started(t);
  const r = await c.call("expense_add", { amount: 100, merchant: "Adobe" });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /EUR/);
  assert.doesNotMatch(r.text, /shared business profile \(default_currency\)/);
});
