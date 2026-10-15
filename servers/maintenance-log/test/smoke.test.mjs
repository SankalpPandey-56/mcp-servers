// End to end over stdio JSON-RPC, the way a client drives it: add assets, log the work,
// read the history and the due report, export both ways, remove what is empty, and hit
// the free-tier cap.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

/* ------------------------------------------------------------------- fixtures */

/**
 * The worked register. Every figure below is recomputed by hand:
 *   Lathe (USD): 2020-01-06 oil change 12000, interval 90 -> next due 2020-04-05
 *                2020-04-02 drive belt  4599, next_due 2020-10-02
 *   Total 16599 = USD 165.99. The current schedule is 2020-10-02 (the entry with the
 *   latest work date), which is overdue no matter when the suite runs.
 *   Boiler (GBP): an in-house check at 0 cents, next due today + 10 days, so it lands
 *   in the due-soon window no matter when the suite runs.
 *   Van 2: no log at all, so it is the unscheduled row.
 */
const LATHE = { name: "Lathe", tag: "SN-88-4412", location: "Workshop bay 2", currency: "USD" };
const L1 = { date: "2020-01-06", work: "Oil and filter change", cost_cents: 12000, technician: "Anna", interval_days: 90, next_due: "2020-04-05" };
const L2 = { date: "2020-04-02", work: "Replace drive belt, tension set", cost_cents: 4599, technician: "Ben", next_due: "2020-10-02" };
const LATHE_TOTAL = 16599;
const BOILER = { name: "Combi boiler", tag: "BOIL-14", location: "14 Nowa Street", currency: "GBP" };
const VAN = { name: "Van 2", currency: "USD" };

function todayLocal() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* --------------------------------------------------------------------- client */

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-maintenance-log-"));
  return {
    dir,
    env: { XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "cfg") },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function client(env) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MCP_LICENSE_KEY: "", ...env },
  });
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
      const r = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return r;
    },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `${name} failed: ${JSON.stringify(r.error)}`);
      return { text: r.result.content?.[0]?.text ?? "", isError: r.result.isError === true };
    },
    async json(name, args) {
      const r = await this.call(name, args);
      assert.equal(r.isError, false, r.text);
      try { return JSON.parse(r.text); } catch { assert.fail(`${name} did not return JSON:\n${r.text}`); }
    },
    close() { child.kill(); },
  };
}

const proKey = () => execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "maintenance-log"], { encoding: "utf8" }).trim();

/** The worked register: the lathe with its two entries, the boiler due soon, the van bare. */
async function seed(c) {
  const lathe = (await c.json("asset_add", LATHE)).created.id;
  await c.json("maintenance_log", { asset: lathe, date: L1.date, work: L1.work, cost_cents: L1.cost_cents, technician: L1.technician, interval_days: L1.interval_days });
  await c.json("maintenance_log", { asset: lathe, date: L2.date, work: L2.work, cost_cents: L2.cost_cents, technician: L2.technician, next_due: L2.next_due });
  const boiler = (await c.json("asset_add", BOILER)).created.id;
  const today = todayLocal();
  await c.json("maintenance_log", { asset: boiler, date: addDays(today, -20), work: "Pressure check", technician: "Anna", next_due: addDays(today, 10) });
  const van = (await c.json("asset_add", VAN)).created.id;
  return { lathe, boiler, van };
}

/* ---------------------------------------------------------------------- tests */

test("initialize, tools/list and the free-tier flow: add, log, history, CSV", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    const init = await c.init();
    assert.equal(init.result.serverInfo.name, "mcp-maintenance-log");

    const list = await c.send("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    for (const want of ["asset_add", "maintenance_log", "maintenance_due", "asset_history",
      "maintenance_export", "asset_remove", "license_activate", "license_status"]) {
      assert.ok(names.includes(want), `missing tool ${want}; got ${names.join(", ")}`);
    }

    const { lathe } = await seed(c);
    assert.match(lathe, /^AST-\d{4}-0001$/);

    // history: chronological, the hand-recomputed total, the current schedule
    const h = await c.json("asset_history", { asset: lathe });
    assert.equal(h.id, lathe);
    assert.equal(h.log.length, 2);
    assert.equal(h.log[0].date, "2020-01-06");
    assert.equal(h.log[0].next_due, "2020-04-05", "2020-01-06 + 90 days is 2020-04-05 (2020 is a leap year)");
    assert.equal(h.log[1].next_due, "2020-10-02");
    assert.equal(h.total_spent_cents, LATHE_TOTAL);
    assert.equal(h.total_spent, "USD 165.99");
    assert.equal(h.schedule.next_due, "2020-10-02", "the entry with the latest work date sets the schedule");
    assert.equal(h.last_service, "2020-04-02");
    assert.deepEqual(
      h.spend_by_technician.map((x) => [x.technician, x.total_cents]).sort(),
      [["Anna", 12000], ["Ben", 4599]].sort(),
    );

    // resolving by tag and by exact name lands on the same asset
    assert.equal((await c.json("asset_history", { asset: "sn-88-4412" })).id, lathe, "tag resolves case-insensitively");
    assert.equal((await c.json("asset_history", { asset: "Lathe" })).id, lathe, "exact name resolves");

    // CSV export of the range holding only the lathe's first entry
    const csv = await c.call("maintenance_export", { from: "2020-01-01", to: "2020-01-31" });
    assert.equal(csv.isError, false);
    const lines = csv.text.trim().split("\n");
    assert.equal(lines[0], "asset_id,asset_name,tag,location,date,work,technician,cost_cents,currency,cost,next_due");
    assert.equal(lines.length, 2, "only the 2020-01-06 entry falls inside January");
    assert.match(lines[1], new RegExp(`^${lathe},Lathe,SN-88-4412,"?Workshop bay 2"?,2020-01-06,`));
    assert.match(lines[1], /,12000,USD,USD 120\.00,2020-04-05$/);

    // the comma in the second work string is quoted when it is exported
    const csvAll = await c.call("maintenance_export", { from: "2020-04-01", to: "2020-04-30" });
    assert.match(csvAll.text, /"Replace drive belt, tension set"/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("maintenance_due: free tier is refused with the upgrade text, Pro gets the report", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const { lathe, boiler, van } = await seed(c);

    const blocked = await c.call("maintenance_due", {});
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /Pro feature/);
    assert.match(blocked.text, /mcp\.zovo\.one\/buy\/maintenance-log/);
    c.close();

    const pro = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
    try {
      await pro.init();
      const r = await pro.json("maintenance_due", { within_days: 30 });
      assert.equal(r.today, todayLocal());
      assert.equal(r.overdue_count, 1);
      assert.equal(r.overdue[0].id, lathe, "the lathe is the overdue asset");
      assert.equal(r.overdue[0].next_due, "2020-10-02");
      assert.ok(r.overdue[0].days_overdue > 2000, "overdue since 2020");
      assert.equal(r.due_soon_count, 1);
      assert.equal(r.due_soon[0].id, boiler, "the boiler falls due today + 10, inside the 30-day window");
      assert.equal(r.due_soon[0].days_until_due, 10);
      assert.equal(r.scheduled_later.length, 0);
      assert.equal(r.unscheduled.length, 1);
      assert.equal(r.unscheduled[0].id, van, "the van has no log, so no schedule");

      // a narrower window drops the boiler out of due soon
      const narrow = await pro.json("maintenance_due", { within_days: 5 });
      assert.equal(narrow.due_soon_count, 0);
      assert.equal(narrow.scheduled_later.length, 1);
      assert.equal(narrow.scheduled_later[0].id, boiler);
    } finally { pro.close(); }
  } finally {
    c.close(); s.cleanup();
  }
});

test("maintenance_export markdown: gated on free, one section per asset on Pro", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const { lathe } = await seed(c);

    const blocked = await c.call("maintenance_export", { format: "markdown" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /Pro feature/);
    c.close();

    const pro = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
    try {
      await pro.init();
      const md = await pro.call("maintenance_export", { format: "markdown" });
      assert.equal(md.isError, false);
      assert.match(md.text, /# Maintenance log/);
      assert.match(md.text, /## Lathe \(AST-\d{4}-0001\)/);
      assert.match(md.text, /Serial\/tag: SN-88-4412/);
      assert.match(md.text, /Spend in range: USD 165\.99/);
      assert.match(md.text, /Next due: 2020-10-02/);
      assert.match(md.text, /\| 2020-01-06 \| Oil and filter change \| Anna \| USD 120\.00 \| 2020-04-05 \|/);
      assert.match(md.text, /## Combi boiler \(/);
      assert.ok(!md.text.includes("## Van 2"), "an asset with no entries in range gets no section");

      // the pipe in a note cannot break the table
      await pro.json("maintenance_log", { asset: lathe, date: "2020-04-03", work: "Coolant top-up | flushed", cost_cents: 0 });
      const md2 = await pro.call("maintenance_export", { format: "markdown", from: "2020-04-03", to: "2020-04-03" });
      assert.match(md2.text, /Coolant top-up \\\| flushed/);
    } finally { pro.close(); }
  } finally {
    c.close(); s.cleanup();
  }
});

test("free tier: the fourth asset is refused, Pro lifts the cap, logging stays free", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    await seed(c);
    const fourth = await c.call("asset_add", { name: "Compressor", currency: "USD" });
    assert.equal(fourth.isError, true);
    assert.match(fourth.text, /free tier holds 3 assets/);
    assert.match(fourth.text, /Nothing was written/);
    assert.match(fourth.text, /Pro/);

    // logging on the assets you have is never metered
    const log = await c.call("maintenance_log", { asset: "Van 2", date: "2020-05-01", work: "Tyre rotation", cost_cents: 3000 });
    assert.equal(log.isError, false, "logging stays free at the asset cap");

    // removing one frees its slot, no key needed
    await c.json("asset_remove", { asset: "Van 2", confirm: true });
    const freed = await c.json("asset_add", { name: "Compressor", currency: "USD" });
    assert.ok(freed.created.id, "removing an asset frees the slot on the free tier");
    c.close();

    // Pro takes the cap off entirely
    const pro = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
    try {
      await pro.init();
      const status = await pro.json("license_status", {});
      assert.equal(status.tier, "pro");
      for (const name of ["Welder", "Milling machine"]) {
        const r = await pro.json("asset_add", { name, currency: "USD" });
        assert.ok(r.created.id, `Pro asset ${name} should be added over the free cap`);
      }
      const h = await pro.json("asset_history", { asset: "Welder" });
      assert.equal(h.name, "Welder");
    } finally { pro.close(); }
  } finally {
    c.close(); s.cleanup();
  }
});

test("asset_remove: a logged asset needs confirm, the number is burned, an empty one goes", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const { lathe, van } = await seed(c);

    // without confirm the removal is refused, naming what would be lost
    const refused = await c.call("asset_remove", { asset: lathe });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /2 log entries/);
    assert.match(refused.text, /USD 165\.99/);
    assert.match(refused.text, /confirm: true/);
    assert.match(refused.text, /Nothing was written/);

    // with confirm it goes, log and all
    const gone = await c.json("asset_remove", { asset: lathe, confirm: true });
    assert.equal(gone.removed.id, lathe);
    assert.equal(gone.removed.entries_lost, 2);
    assert.equal(gone.removed.spend_lost_cents, LATHE_TOTAL);
    const lookup = await c.call("asset_history", { asset: lathe });
    assert.equal(lookup.isError, true);
    assert.match(lookup.text, /no asset matches/);

    // the number is not reissued
    const next = (await c.json("asset_add", { name: "Bandsaw", currency: "USD" })).created.id;
    assert.notEqual(next, lathe, "a removed number is burned, not reissued");

    // an empty asset removes without confirm
    assert.equal((await c.json("asset_remove", { asset: van })).removed.id, van);
  } finally {
    c.close(); s.cleanup();
  }
});

test("guards: future work, bad dates, both schedule forms, early next_due, duplicates, ambiguity", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const { lathe } = await seed(c);

    // work cannot have been done tomorrow
    const future = await c.call("maintenance_log", { asset: lathe, date: "2099-01-01", work: "Time travel service" });
    assert.equal(future.isError, true);
    assert.match(future.text, /after today/);

    // a date that is not a date
    const badDate = await c.call("maintenance_log", { asset: lathe, date: "2026-02-30", work: "Ghost service" });
    assert.equal(badDate.isError, true);
    assert.match(badDate.text, /not a real date/);

    // one schedule form or the other, never both
    const both = await c.call("maintenance_log", { asset: lathe, date: "2020-05-01", work: "Service", next_due: "2020-08-01", interval_days: 90 });
    assert.equal(both.isError, true);
    assert.match(both.text, /not both/);
    assert.match(both.text, /Nothing was written/);

    // the next service cannot fall due before the work that sets it
    const early = await c.call("maintenance_log", { asset: lathe, date: "2020-05-01", work: "Service", next_due: "2020-04-15" });
    assert.equal(early.isError, true);
    assert.match(early.text, /before the work date/);

    // a serial identifies one machine (free a slot first, so the 3-asset cap cannot mask the check)
    await c.json("asset_remove", { asset: "Van 2" });
    const dupe = await c.call("asset_add", { name: "Another lathe", tag: "sn-88-4412", currency: "USD" });
    assert.equal(dupe.isError, true);
    assert.match(dupe.text, /already on AST-/);
    assert.match(dupe.text, /Nothing was written/);

    // a partial name that matches two assets is refused with the candidates
    await c.json("asset_add", { name: "Bench grinder", currency: "USD" });
    const amb = await c.call("asset_history", { asset: "b" });
    assert.equal(amb.isError, true);
    assert.match(amb.text, /matches more than one asset/);

    // an inverted export range is refused
    const range = await c.call("maintenance_export", { from: "2020-12-31", to: "2020-01-01" });
    assert.equal(range.isError, true);
    assert.match(range.text, /is after to/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("license_status on the free tier names the tier and the checkout", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const r = await c.json("license_status", {});
    assert.equal(r.tier, "free");
    assert.equal(r.product, "maintenance-log");
    assert.match(r.upgradeUrl, /mcp\.zovo\.one\/buy\/maintenance-log/);
    const bad = await c.call("license_activate", { key: "MCPL1.nope.nope" });
    assert.equal(bad.isError, true);
  } finally {
    c.close(); s.cleanup();
  }
});
