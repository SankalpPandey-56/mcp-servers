/**
 * Round 15, docs/USER_VALUE_R15.md.
 * D-R78: every amount this server printed was gross - line items plus the shared profile's
 * default_tax_rate - and never said so, while /mcp/invoice broke the same number into
 * subtotal + tax. D-R79: schedule_upcoming totalled every occurrence FOUND while listing
 * only the free-tier slice, so the total could not be added up from the rows on screen.
 */
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function client(profile) {
  const home = mkdtempSync(join(tmpdir(), "mcp-r15-"));
  const data = join(home, "data");
  if (profile) {
    mkdirSync(join(data, "mcp-servers", "profile"), { recursive: true });
    writeFileSync(join(data, "mcp-servers", "profile", "business.json"), JSON.stringify(profile));
  }
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: data, XDG_CONFIG_HOME: join(home, "cfg"), MCP_LICENSE_KEY: "" },
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
    const to = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method}`)); } }, 25000);
    to.unref();
  });
  return {
    home, data, send,
    notify: (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n"),
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (!r.result) return { text: JSON.stringify(r.error), isError: true };
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}
async function init(c) {
  await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r15", version: "0" } });
  c.notify("notifications/initialized", {});
  return c;
}
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString().slice(0, 10);


const PROFILE = { name: "Nova Studio", default_currency: "EUR", default_tax_rate: 23, payment_terms_days: 14, timezone: "Europe/Warsaw" };

async function withRetainer(t) {
  const c = await init(client(PROFILE)); t.after(() => c.close());
  await c.call("schedule_create", {
    client: "Beta Corp", every: "monthly", start_date: iso(-3), currency: "EUR",
    items: [{ description: "Platform retainer", quantity: 1, unit_price: 1500 }],
  });
  return c;
}

test("D-R78: a schedule reports subtotal and tax, not a bare gross total", async (t) => {
  const c = await withRetainer(t);
  const r = await c.call("schedule_list", {});
  // The gross is still there and still right...
  assert.match(r.text, /EUR 1845\.00/);
  // ...and now the two numbers that make it legible are beside it.
  assert.match(r.text, /"subtotal": "EUR 1500\.00"/);
  assert.match(r.text, /23% on EUR 1500\.00 = EUR 345\.00/);
  assert.match(r.text, /"amount_includes_tax": true/);
});

test("D-R78: a schedule with no tax says the amount includes none", async (t) => {
  const c = await init(client({ name: "Nova Studio", default_currency: "EUR", default_tax_rate: 0 }));
  t.after(() => c.close());
  await c.call("schedule_create", {
    client: "Gamma", every: "monthly", start_date: iso(-3), currency: "EUR",
    items: [{ description: "Retainer", quantity: 1, unit_price: 1500 }],
  });
  const r = await c.call("schedule_list", {});
  assert.match(r.text, /"amount": "EUR 1500\.00"/);
  assert.match(r.text, /"subtotal": "EUR 1500\.00"/);
  assert.match(r.text, /"amount_includes_tax": false/);
});

test("D-R79: the upcoming total says which set of occurrences it covers", async (t) => {
  const c = await withRetainer(t);
  const r = await c.call("schedule_upcoming", { days: 183 });
  const out = JSON.parse(r.text);
  assert.ok(out.occurrences_found_in_horizon > out.count, "the free cap must actually bite for this probe to mean anything");
  // The grand total is over everything found, which is MORE than the rows returned...
  assert.ok(out.totals_per_currency.length > 0);
  assert.match(out.totals_cover, /MORE than the \d+ listed above/);
  // ...and the sum of the rows the caller can actually see is given as its own figure.
  assert.ok(Array.isArray(out.totals_per_currency_listed_rows));
  const shownSum = out.occurrences.reduce((n, o) => n + Number(String(o.amount).replace(/[^0-9.]/g, "")), 0);
  assert.equal(out.totals_per_currency_listed_rows[0], `EUR ${shownSum.toFixed(2)}`);
  assert.notEqual(out.totals_per_currency[0], out.totals_per_currency_listed_rows[0]);
});

test("D-R79: when nothing is withheld the total says so and no second figure is invented", async (t) => {
  const c = await withRetainer(t);
  const r = await c.call("schedule_upcoming", { days: 45 });
  const out = JSON.parse(r.text);
  assert.equal(out.count, out.occurrences_found_in_horizon);
  assert.match(out.totals_cover, /every one of them listed above/);
  assert.equal(out.totals_per_currency_listed_rows, undefined);
});

test("D-R79: the internal per-occurrence minor value never leaks into the payload", async (t) => {
  const c = await withRetainer(t);
  const r = await c.call("schedule_upcoming", { days: 183 });
  assert.doesNotMatch(r.text, /_minor/);
});
