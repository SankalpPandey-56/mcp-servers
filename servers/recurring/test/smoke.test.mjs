import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const INVOICE_ENTRY = join(here, "..", "..", "invoice", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

function rpc(entry, env) {
  const child = spawn(process.execPath, [entry], { stdio: ["pipe", "pipe", "pipe"], env });
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
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method}`)); } }, 30000);
    t.unref();
  });
  return {
    child, send,
    notify: (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n"),
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

function sandbox() {
  const home = mkdtempSync(join(tmpdir(), "mcp-recurring-"));
  return { home, data: join(home, "data"), config: join(home, "config") };
}

function client(box, extra = {}) {
  const c = rpc(ENTRY, {
    ...process.env, XDG_DATA_HOME: box.data, XDG_CONFIG_HOME: box.config,
    MCP_LICENSE_KEY: "", ...extra,
  });
  c.home = box.home;
  return c;
}

async function init(c, name = "mcp-recurring") {
  const r = await c.send("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" },
  });
  assert.ok(r.result?.serverInfo, "initialize failed");
  assert.equal(r.result.serverInfo.name, name);
  c.notify("notifications/initialized", {});
  return r.result;
}

const pad = (n) => String(n).padStart(2, "0");
function monthsAgoFirst(n) {
  const now = new Date();
  const total = now.getFullYear() * 12 + now.getMonth() - n;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${pad((total % 12) + 1)}-01`;
}
const invoiceStore = (box, file) => join(box.data, "mcp-servers", "invoice", file);

test("schedule_get refuses an ambiguous partial client match with the candidate list; an exact match still wins", async (t) => {
  const box = sandbox();
  const c = client(box);
  t.after(() => c.close());
  await init(c);

  const start = monthsAgoFirst(1);
  const mk = (client_) => c.call("schedule_create", {
    client: client_,
    items: [{ description: "Retainer hours", quantity: 1, unit_price: 100, tax_rate: 0 }],
    currency: "EUR", every: "monthly", start_date: start, due_days: 14,
  });
  let r = await mk("Acme Inc (Consulting)");
  assert.equal(r.isError, false, r.text);
  r = await mk("Acme Inc (Retail)");
  assert.equal(r.isError, false, r.text);
  r = await mk("Acme Inc");
  assert.equal(r.isError, false, r.text);

  // "Acme Inc (" is a substring of two client names and an exact match of neither.
  r = await c.call("schedule_get", { id: "Acme Inc (" });
  assert.equal(r.isError, true, "an ambiguous partial client reference must be refused, not silently resolved");
  assert.match(r.text, /matches more than one schedule/);
  assert.match(r.text, /Acme Inc \(Consulting\)/);
  assert.match(r.text, /Acme Inc \(Retail\)/);

  // The exact client name still resolves outright, with no ambiguity check.
  r = await c.call("schedule_get", { id: "Acme Inc" });
  assert.equal(r.isError, false, r.text);
  assert.equal(JSON.parse(r.text).client, "Acme Inc");
});

test("stdio: initialize, tools/list, monthly schedule, generate due, idempotent second run", async (t) => {
  const box = sandbox();
  const c = client(box);
  t.after(() => c.close());
  await init(c);

  const tools = (await c.send("tools/list", {})).result.tools.map((x) => x.name).sort();
  for (const name of [
    "schedule_create", "schedule_list", "schedule_get", "schedule_update", "schedule_pause",
    "schedule_resume", "schedule_delete", "schedule_upcoming", "invoice_generate_due",
    "schedule_history", "forecast", "license_status", "license_activate",
  ]) assert.ok(tools.includes(name), `missing tool ${name} (have ${tools.join(", ")})`);

  // The issuer profile belongs to the invoice server; this one deliberately has no
  // business_set, and a missing profile must not block generation.
  assert.ok(!tools.includes("business_set"), "business_set must not be defined here");

  const start = monthsAgoFirst(3);
  const created = await c.call("schedule_create", {
    client: "Acme Retainer",
    items: [{ description: "Retainer hours", quantity: 12, unit_price: 90, tax_rate: 0 }],
    currency: "EUR", every: "monthly", start_date: start, due_days: 14,
  });
  assert.equal(created.isError, false, created.text);
  assert.match(created.text, /Created schedule [0-9a-f]{8}/);
  assert.match(created.text, /placeholder issuer/, "must warn that no business profile exists");
  const id = /Created schedule ([0-9a-f]{8})/.exec(created.text)[1];

  const dry = await c.call("invoice_generate_due", { dry_run: true });
  const dryJson = JSON.parse(dry.text);
  assert.equal(dryJson.would_create.length, 4, `4 monthly periods are due from ${start}`);
  assert.ok(!existsSync(invoiceStore(box, "invoices.json")), "dry_run must not write an invoice");

  const gen = await c.call("invoice_generate_due", {});
  assert.equal(gen.isError, false, gen.text);
  assert.match(gen.text, /created 4 invoices, skipped 0/);
  const numbers = [...gen.text.matchAll(/^(INV-\d{4}-\d{4})\s/gm)].map((m) => m[1]);
  assert.equal(numbers.length, 4, gen.text);
  assert.equal(new Set(numbers).size, 4, "invoice numbers must be unique");
  assert.match(gen.text, /EUR 1080\.00/);

  // PDFs exist and are real PDF bytes.
  for (const n of numbers) {
    const p = join(box.data, "mcp-servers", "invoice", "pdf", `${n}.pdf`);
    assert.ok(existsSync(p), `missing PDF ${p}`);
    assert.ok(statSync(p).size > 800, `PDF too small: ${p}`);
    assert.equal(readFileSync(p).subarray(0, 5).toString(), "%PDF-");
  }

  // The invoice server's own store holds them, and its own process lists them.
  const stored = JSON.parse(readFileSync(invoiceStore(box, "invoices.json"), "utf8"));
  assert.equal(stored.length, 4);
  assert.deepEqual(stored.map((i) => i.number).sort(), [...numbers].sort());
  assert.equal(stored[0].total_minor, 108000);

  const inv = rpc(INVOICE_ENTRY, { ...process.env, XDG_DATA_HOME: box.data, XDG_CONFIG_HOME: box.config, MCP_LICENSE_KEY: "" });
  t.after(() => inv.close());
  await init(inv, "mcp-invoice");
  const listed = JSON.parse((await inv.call("invoice_list", {})).text);
  assert.equal(listed.count, 4, "invoice_list in the invoice server must show them");
  assert.deepEqual(listed.invoices.map((i) => i.number).sort(), [...numbers].sort());
  assert.equal(listed.invoices[0].client, "Acme Retainer");

  // Idempotent: the second run creates nothing and skips every period.
  const again = await c.call("invoice_generate_due", {});
  assert.match(again.text, /created 0 invoices, skipped 4/);
  assert.equal(JSON.parse(readFileSync(invoiceStore(box, "invoices.json"), "utf8")).length, 4,
    "a second run must not add an invoice");

  // Upcoming, forecast and the resource all answer.
  const up = JSON.parse((await c.call("schedule_upcoming", {})).text);
  assert.equal(up.horizon_days, 30);
  const fc = JSON.parse((await c.call("forecast", { months: 12 })).text);
  assert.equal(fc.months, 3, "free tier forecasts 3 months");
  assert.match(fc.note, /Free tier forecasts 3 months/);
  const res = await c.send("resources/read", { uri: "recurring://upcoming" });
  assert.ok(JSON.parse(res.result.contents[0].text).occurrences, "recurring://upcoming must return JSON");

  // Pause stops generation of the next period; history is Pro-gated on free.
  await c.call("schedule_pause", { id });
  const paused = await c.call("invoice_generate_due", { as_of: "2099-01-01" });
  assert.match(paused.text, /created 0 invoices/);
  const hist = await c.call("schedule_history", { id });
  assert.match(hist.text, /Pro feature/);
});

test("free tier stops at 3 active schedules; Pro allows the 4th", async (t) => {
  const key = execFileSync(process.execPath,
    [join(REPO, "scripts", "sign-license.mjs"), "recurring"], { encoding: "utf8" }).trim();
  assert.match(key, /^MCPL1\./);

  const box = sandbox();
  const free = client(box);
  t.after(() => free.close());
  await init(free);

  const mk = (c, n) => c.call("schedule_create", {
    client: `Client ${n}`,
    items: [{ description: "Retainer", quantity: 1, unit_price: 500 }],
    currency: "EUR", every: "monthly", start_date: "2026-01-10",
  });
  for (let i = 1; i <= 3; i++) {
    const r = await mk(free, i);
    assert.match(r.text, /Created schedule/, `schedule ${i} was blocked: ${r.text}`);
  }
  const fourth = await mk(free, 4);
  assert.match(fourth.text, /free tier allows 3/i);
  assert.doesNotMatch(fourth.text, /Created schedule/);
  assert.equal(JSON.parse((await free.call("schedule_list", {})).text).count, 3);

  const pro = client(box, { MCP_LICENSE_KEY: key });
  t.after(() => pro.close());
  await init(pro);
  assert.match((await pro.call("license_status", {})).text, /"tier": "pro"/);
  const proFourth = await mk(pro, 4);
  assert.match(proFourth.text, /Created schedule/, `pro 4th schedule blocked: ${proFourth.text}`);
  assert.equal(JSON.parse((await pro.call("schedule_list", {})).text).count, 4);

  // Pro also unlocks the audit log, the anchor-day rule and the longer forecast.
  const anchored = await pro.call("schedule_create", {
    client: "Anchored", items: [{ description: "Hosting", quantity: 1, unit_price: 100 }],
    currency: "EUR", every: "monthly", start_date: "2026-01-05", anchor_day: 31,
  });
  assert.match(anchored.text, /Created schedule/);
  assert.doesNotMatch(anchored.text, /Pro rules/);
  assert.match(anchored.text, /2026-01-31/, `anchor_day 31 must bill on the month end: ${anchored.text}`);
  const fc = JSON.parse((await pro.call("forecast", { months: 12 })).text);
  assert.equal(fc.months, 12);
  const gen = await pro.call("invoice_generate_due", { as_of: "2026-03-31" });
  assert.match(gen.text, /created \d+ invoices/);
  const anchoredId = /Created schedule ([0-9a-f]{8})/.exec(anchored.text)[1];
  const hist = JSON.parse((await pro.call("schedule_history", { id: anchoredId })).text);
  assert.deepEqual(hist.generated.map((g) => g.period), ["2026-01-31", "2026-02-28", "2026-03-31"]);
  assert.ok(hist.generated.every((g) => g.pdf && existsSync(g.pdf)), "history must carry a real PDF path");
});
