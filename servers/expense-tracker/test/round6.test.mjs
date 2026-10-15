// Round-6 fixes (docs/USER_VALUE_R6.md): D-R20 an empty rebill set asserts nothing about
// lines it does not have, D-R21 billable defaults to true when a project is given, D-R23
// the .corrupt marker is self-describing JSON.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const today = localDay();

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-expense-r6-"));
  mkdirSync(join(home, "data"), { recursive: true });
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), MCP_LICENSE_KEY: "", ...env },
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
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    const to = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method}`)); } }, 10000);
    to.unref();
  });
  return {
    send,
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (r.error) return { text: r.error.message, isError: true };
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

async function started(t, env) {
  const c = client(env);
  t.after(() => c.close());
  await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r6", version: "0" } });
  return c;
}

test("D-R21: billable defaults to true when a project is given, false without one, and the response says so", async (t) => {
  const c = await started(t);

  const withProject = await c.call("expense_add", { amount: 45, currency: "EUR", merchant: "Amazon", project: "Nova" });
  assert.equal(withProject.isError, false, withProject.text);
  assert.match(withProject.text, /Billable: yes \(default for an expense with a project/);
  assert.match(withProject.text, /will appear in expense_to_invoice/);

  const noProject = await c.call("expense_add", { amount: 9, currency: "EUR", merchant: "Coffee" });
  assert.match(noProject.text, /Billable: no \(default with no project\)/);
  assert.match(noProject.text, /will NOT appear in expense_to_invoice/);

  const explicit = await c.call("expense_add", { amount: 20, currency: "EUR", merchant: "Gift", project: "Nova", billable: false });
  assert.match(explicit.text, /Billable: no - it will NOT appear in expense_to_invoice/);
  assert.doesNotMatch(explicit.text, /\(default/);
  assert.doesNotMatch(explicit.text, /split\.\. /);   // no doubled sentence terminator

  // the default reaches the rebill chain the tool recommends: 45 EUR at 1.08 = USD 48.60
  const inv = await c.call("expense_to_invoice", { project: "Nova", from: today, to: today, target_currency: "USD", fx_rates: { EUR: 1.08 } });
  const j = JSON.parse(inv.text);
  assert.equal(j.count, 1);
  assert.equal(j.line_items_per_currency[0].items[0].unit_price, 48.6);
  assert.equal(j.line_items_per_currency[0].total_net, "USD 48.60");
});

test("D-R20: an empty rebill set returns count 0, a plain reason and NO fx_note", async (t) => {
  const c = await started(t);
  await c.call("expense_add", { amount: 45, currency: "EUR", merchant: "Amazon", project: "Nova", billable: false });

  const inv = await c.call("expense_to_invoice", { project: "Nova", from: today, to: today, target_currency: "USD", fx_rates: { EUR: 1.08 } });
  assert.equal(inv.isError, false, inv.text);
  const j = JSON.parse(inv.text);
  assert.equal(j.count, 0);
  assert.equal("fx_note" in j, false, `fx_note must be absent on an empty set, got ${JSON.stringify(j.fx_note)}`);
  assert.equal("vat_note" in j, false);
  assert.deepEqual(j.line_items_per_currency, []);
  assert.deepEqual(j.source_currencies, []);
  assert.equal(j.converted_lines, 0);
  assert.match(j.note, /no matching billable, un-rebilled expenses in this range/);
  assert.match(j.next_step, /not marked billable/);
  assert.match(j.next_step, /already rebilled/);
});

test("D-R23: the .corrupt marker holds self-describing one-line JSON", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mcp-expense-r6c-"));
  const dir = join(home, "data", "mcp-servers", "expense-tracker");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "data.json"), '{"expenses":[{"id":"a","amount');

  const c = await started(t, { XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config") });
  const r = await c.call("expense_add", { amount: 1, currency: "EUR", merchant: "X" });
  assert.equal(r.isError, true, r.text);

  const raw = readFileSync(join(dir, "data.json.corrupt"), "utf8");
  assert.equal(raw.trim().split("\n").length, 1, `marker must be one line, got ${JSON.stringify(raw)}`);
  const m = JSON.parse(raw);
  assert.deepEqual(Object.keys(m).sort(), ["at", "hint", "quarantined"]);
  assert.match(m.quarantined, /data\.json\.corrupt-/);
  assert.ok(!Number.isNaN(Date.parse(m.at)));
  assert.equal(m.hint, "the original data file failed to parse; it was moved, nothing was overwritten; restore it manually or delete this marker to start fresh");
});
