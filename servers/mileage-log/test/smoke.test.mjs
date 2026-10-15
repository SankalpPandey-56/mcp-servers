// End to end over stdio JSON-RPC, the way a client drives it: set the rates, log the
// trips, read the summary, export the CSV, and hit every free-tier gate.
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
 * The worked rates and trips, every figure recomputed by hand. The rate label says
 * EXAMPLE because these are fixtures, not law:
 *   R1  business    0.70  USD/mile  from 2026-01-01
 *   R2  business    0.655 USD/mile  from 2025-01-01   (Pro: the year-over-year series)
 *   R3  medical     0.21  USD/mile  from 2025-01-01
 *   T1  2026-03-02  12.5 mi  business @ 0.70  =  875   (exact)
 *   T2  2026-03-04   7.5 mi  medical  @ 0.21  =  157.5 -> 158  (half-up)
 *   T3  2025-06-15 100.0 mi  business @ 0.655 = 6550   (the earlier rate, on its day)
 *   T4  2026-03-05  10.0 km  business @ 0.70 USD/mile: 10 km = 6213.7119... ->
 *       6214 thousandths of a mile; 6214 x 700 = 4,349,800; /10000 = 434.98 -> 435
 * All fixture dates are in the past, so the future-date guard cannot make the suite
 * depend on the day it runs.
 */
const JURIS = "US federal (EXAMPLE)";
const R1 = { jurisdiction: JURIS, category: "business", rate: 0.70, unit: "miles", currency: "USD", effective_from: "2026-01-01" };
const R2 = { jurisdiction: JURIS, category: "business", rate: 0.655, unit: "miles", currency: "USD", effective_from: "2025-01-01" };
const R3 = { jurisdiction: JURIS, category: "medical", rate: 0.21, unit: "miles", currency: "USD", effective_from: "2025-01-01" };
const T1 = { date: "2026-03-02", from: "Home office", to: "Client site, 2 Mill Lane", distance: 12.5, unit: "miles", purpose: "Site visit", category: "business" };
const T2 = { date: "2026-03-04", from: "Home office", to: "Clinic", distance: 7.5, unit: "miles", purpose: "Appointment", category: "medical" };
const T3 = { date: "2025-06-15", from: "Home office", to: "Warehouse", distance: 100, unit: "miles", purpose: "Stock run", category: "business" };
const T4 = { date: "2026-03-05", from: "Home office", to: "Airport", distance: 10, unit: "km", purpose: "Client pickup", category: "business" };

/* --------------------------------------------------------------------- client */

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-mileage-log-"));
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

const proKey = () => execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "mileage-log"], { encoding: "utf8" }).trim();

/* ---------------------------------------------------------------------- tests */

test("initialize, tools/list, and the priced flow: rate_set, trip_add, mileage_summary", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    const init = await c.init();
    assert.equal(init.result.serverInfo.name, "mcp-mileage-log");

    const list = await c.send("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    for (const want of ["trip_add", "trip_list", "trip_remove", "rate_set", "rate_list",
      "mileage_summary", "mileage_export", "license_activate", "license_status"]) {
      assert.ok(names.includes(want), `missing tool ${want}; got ${names.join(", ")}`);
    }

    // rates on file
    const r1 = await c.json("rate_set", R1);
    assert.equal(r1.rate.rate, "USD 0.700/mile");
    const r3 = await c.json("rate_set", R3);
    assert.ok(r3.rate);
    const book = await c.json("rate_list", {});
    assert.equal(book.count, 2);

    // trips: T1 exact, T2 the half-up case, T4 the km-to-miles conversion
    const t1 = await c.json("trip_add", T1);
    assert.match(t1.logged.id, /^TR-2026-0001$/);
    assert.equal(t1.logged.jurisdiction, JURIS, "the one covering jurisdiction is pinned at log time");
    await c.json("trip_add", T2);
    const t4 = await c.json("trip_add", T4);

    const sum = await c.json("mileage_summary", { from_date: "2026-01-01", to_date: "2026-12-31" });
    assert.equal(sum.trips_in_window, 3);
    assert.equal(sum.trips_priced, 3);
    const biz = sum.categories.find((x) => x.category === "business");
    const med = sum.categories.find((x) => x.category === "medical");
    assert.equal(biz.totals[0].amount_cents, 1310, "875 + 435");
    assert.equal(med.totals[0].amount_cents, 158, "7.5 miles at 0.21 rounds half-up to 158, never 157.49999");
    assert.equal(sum.totals[0].amount_cents, 1468);
    assert.equal(sum.totals[0].amount, "USD 14.68");

    // distance kept per unit, never added together
    const miles = biz.distance.find((d) => d.unit === "miles");
    const km = biz.distance.find((d) => d.unit === "km");
    assert.equal(miles.distance, 12.5);
    assert.equal(km.distance, 10);

    // every line carries the rate in force on its own day
    const l1 = biz.lines.find((l) => l.date === "2026-03-02");
    const l4 = biz.lines.find((l) => l.date === "2026-03-05");
    assert.equal(l1.rate, "USD 0.700/mile");
    assert.equal(l1.amount_cents, 875);
    assert.equal(l4.amount_cents, 435, "10 km converts to 6214 thousandths of a mile, then prices");
    assert.equal(l4.rate_effective_from, "2026-01-01");
    assert.equal(t4.logged.unit, "km");
  } finally {
    c.close(); s.cleanup();
  }
});

test("the effective-dated series prices each trip at the rate in force on its day (Pro)", async () => {
  const s = sandbox();
  const c = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
  try {
    await c.init();
    await c.json("rate_set", R1);
    await c.json("rate_set", R2); // the earlier year, second rate in the series
    await c.json("trip_add", T1); // 2026-03-02 -> 0.70
    await c.json("trip_add", T3); // 2025-06-15 -> 0.655

    const sum = await c.json("mileage_summary", { from_date: "2025-01-01", to_date: "2026-12-31", category: "business" });
    const biz = sum.categories[0];
    const old = biz.lines.find((l) => l.date === "2025-06-15");
    const newr = biz.lines.find((l) => l.date === "2026-03-02");
    assert.equal(old.rate, "USD 0.655/mile");
    assert.equal(old.rate_effective_from, "2025-01-01");
    assert.equal(old.amount_cents, 6550);
    assert.equal(newr.amount_cents, 875);
    assert.equal(biz.totals[0].amount_cents, 7425);
  } finally {
    c.close(); s.cleanup();
  }
});

test("unpriced trips are listed with the reason, personal ones apart, never silently dropped", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    // a trip logged before any rate exists keeps jurisdiction null
    const early = await c.json("trip_add", { ...T1, date: "2024-05-10", purpose: "Old trip" });
    assert.equal(early.logged.jurisdiction, null);
    assert.match(early.notes.join(" "), /No rate prices this trip yet/);
    await c.json("trip_add", { ...T2, category: "personal", date: "2024-05-11", purpose: "Weekend drive" });
    await c.json("rate_set", R1);

    const sum = await c.json("mileage_summary", { from_date: "2024-01-01", to_date: "2024-12-31" });
    assert.equal(sum.trips_in_window, 2);
    assert.equal(sum.trips_priced, 0);
    assert.equal(sum.unpriced.length, 1);
    assert.equal(sum.unpriced[0].category, "business");
    assert.match(sum.unpriced[0].reason, /earliest business rate takes effect 2026-01-01/);
    assert.equal(sum.personal_unpriced.length, 1, "personal mileage is not priced and that is expected, not a defect");
    assert.equal(sum.totals.length, 0);
  } finally {
    c.close(); s.cleanup();
  }
});

test("two jurisdictions covering one category make an unpinned trip ambiguous, stated plainly", async () => {
  const s = sandbox();
  const c = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
  try {
    await c.init();
    await c.json("trip_add", { ...T1, date: "2026-02-10" }); // before any rate: unpinned
    await c.json("rate_set", R1);
    await c.json("rate_set", { ...R1, jurisdiction: "State program (EXAMPLE)", rate: 0.30 });

    // trip_add is refused without a jurisdiction once two cover the category
    const amb = await c.call("trip_add", { ...T1, date: "2026-02-11" });
    assert.equal(amb.isError, true);
    assert.match(amb.text, /more than one jurisdiction has a business rate/);
    assert.match(amb.text, /Nothing was written/);
    const pinned = await c.json("trip_add", { ...T1, date: "2026-02-11", jurisdiction: "State program (EXAMPLE)" });
    assert.equal(pinned.logged.jurisdiction, "State program (EXAMPLE)");

    // and the unpinned trip is listed unpriced in the summary, with the reason
    const sum = await c.json("mileage_summary", { from_date: "2026-01-01", to_date: "2026-12-31" });
    assert.equal(sum.unpriced.length, 1);
    assert.match(sum.unpriced[0].reason, /more than one jurisdiction has a business rate/);
    const biz = sum.categories[0];
    assert.equal(biz.totals[0].amount_cents, 375, "12.5 miles at the state 0.30 rate");
  } finally {
    c.close(); s.cleanup();
  }
});

test("mileage_export is Pro-gated, then pure CSV: quoted cells, bare amounts, no silent gaps", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    await c.json("rate_set", R1);
    await c.json("rate_set", R3);
    await c.json("trip_add", T1);
    await c.json("trip_add", T2);

    // free tier: refused with the checkout
    const gated = await c.call("mileage_export", {});
    assert.equal(gated.isError, true);
    assert.match(gated.text, /CSV export.*Pro feature/);
    assert.match(gated.text, /mcp\.zovo\.one\/buy\/mileage-log/);
    c.close();

    const pro = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
    try {
      await pro.init();
      const csv = await pro.call("mileage_export", { from_date: "2026-01-01", to_date: "2026-12-31" });
      assert.equal(csv.isError, false);
      const lines = csv.text.trim().split("\n");
      assert.equal(lines[0], "date,from,to,distance,unit,category,rate,rate_unit,currency,amount,purpose,jurisdiction,effective_from,id");
      assert.equal(lines.length, 3, "header plus two trips");
      assert.equal(
        lines[1],
        `2026-03-02,Home office,"Client site, 2 Mill Lane",12.5,miles,business,0.7,miles,USD,8.75,Site visit,${JURIS},2026-01-01,TR-2026-0001`,
      );
      assert.match(lines[2], /^2026-03-04,Home office,Clinic,7\.5,miles,medical,0\.21,miles,USD,1\.58,/);
      // no comment rows, no totals row: every line after the header is a trip
      for (const l of lines.slice(1)) assert.match(l, /^\d{4}-\d{2}-\d{2},/);

      // a window holding an unpriced non-personal trip refuses the whole export
      await pro.json("trip_add", { ...T1, date: "2024-05-10", purpose: "Old trip" });
      const gaps = await pro.call("mileage_export", { from_date: "2024-01-01", to_date: "2026-12-31" });
      assert.equal(gaps.isError, true);
      assert.match(gaps.text, /no applicable rate/);
      assert.match(gaps.text, /nothing was exported/);
    } finally { pro.close(); }
  } finally {
    c.close(); s.cleanup();
  }
});

test("free tier: the 21st trip in a calendar month is refused; another month still logs", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    await c.json("rate_set", R1);
    for (let i = 1; i <= 20; i++) {
      const day = String(Math.min(i, 28)).padStart(2, "0");
      const r = await c.json("trip_add", { ...T1, date: `2026-04-${day}`, purpose: `Drive ${i}` });
      assert.ok(r.logged.id, `trip ${i} should log`);
    }
    const blocked = await c.call("trip_add", { ...T1, date: "2026-04-28", purpose: "Drive 21" });
    assert.equal(blocked.isError, true);
    assert.match(blocked.text, /20 trips per calendar month/);
    assert.match(blocked.text, /Nothing was written/);
    assert.match(blocked.text, /Pro/);

    // the cap counts the month of the trip date, so May still logs on the free tier
    const may = await c.json("trip_add", { ...T1, date: "2026-05-01", purpose: "May drive" });
    assert.ok(may.logged.id);

    // Pro lifts the cap
    c.close();
    const pro = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
    try {
      await pro.init();
      const more = await pro.json("trip_add", { ...T1, date: "2026-04-28", purpose: "Drive 21" });
      assert.ok(more.logged.id, "Pro logs over the free cap");
    } finally { pro.close(); }
  } finally {
    c.close(); s.cleanup();
  }
});

test("free tier: one rate per jurisdiction and category; overwriting stays free; the series is Pro", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    await c.json("rate_set", R1);

    // a second effective-dated rate for the same jurisdiction and category is Pro
    const second = await c.call("rate_set", R2);
    assert.equal(second.isError, true);
    assert.match(second.text, /multi-rate support/);
    assert.match(second.text, /mcp\.zovo\.one\/buy\/mileage-log/);
    assert.match(second.text, /Nothing was written/);

    // overwriting the one rate on file stays free and says what it replaced
    const over = await c.json("rate_set", { ...R1, rate: 0.72 });
    assert.equal(over.replaced.rate_per_unit, 0.7);
    assert.equal(over.rate.rate, "USD 0.720/mile");
    const book = await c.json("rate_list", {});
    assert.equal(book.count, 1, "overwrite, not a second rate");

    // a rate for a different category is a different pair and stays free
    const med = await c.json("rate_set", R3);
    assert.ok(med.rate);

    // Pro takes the gate off
    c.close();
    const pro = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
    try {
      await pro.init();
      const ok2 = await pro.json("rate_set", R2);
      assert.equal(ok2.replaced, null);
      const book2 = await pro.json("rate_list", {});
      assert.equal(book2.count, 3);
    } finally { pro.close(); }
  } finally {
    c.close(); s.cleanup();
  }
});

test("guards: future dates, bad distances and rates, and trip_remove keeps the series honest", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    await c.json("rate_set", R1);
    const t1 = await c.json("trip_add", T1);

    // a trip cannot have been driven tomorrow
    const future = await c.call("trip_add", { ...T1, date: "2099-01-01" });
    assert.equal(future.isError, true);
    assert.match(future.text, /after today/);

    // distance must be to the thousandth, within one drive
    const badDist = await c.call("trip_add", { ...T1, distance: 12.3456 });
    assert.equal(badDist.isError, true);
    assert.match(badDist.text, /to the thousandth/);
    const tooFar = await c.call("trip_add", { ...T1, distance: 10001 });
    assert.equal(tooFar.isError, true);

    // a date that is not a date
    const badDate = await c.call("trip_add", { ...T1, date: "2026-02-30" });
    assert.equal(badDate.isError, true);
    assert.match(badDate.text, /not a real date/);

    // rates: to the thousandth of a currency unit, and a future effective date is fine
    const badRate = await c.call("rate_set", { ...R3, rate: 0.1234 });
    assert.equal(badRate.isError, true);
    assert.match(badRate.text, /to the thousandth/);
    const announced = await c.json("rate_set", { jurisdiction: JURIS, category: "charitable", rate: 0.14, unit: "miles", currency: "USD", effective_from: "2027-01-01" });
    assert.ok(announced.rate, "next year's announced rate can be set ahead of time");

    // trip_remove by exact id; the number is burned, not reissued
    const gone = await c.json("trip_remove", { id: t1.logged.id });
    assert.equal(gone.removed.id, t1.logged.id);
    const again = await c.call("trip_remove", { id: t1.logged.id });
    assert.equal(again.isError, true);
    assert.match(again.text, /no trip has the id/);
    const next = await c.json("trip_add", T1);
    assert.notEqual(next.logged.id, t1.logged.id, "a removed id is not reissued");

    // list filters
    const only2026 = await c.json("trip_list", { from_date: "2026-01-01", to_date: "2026-12-31" });
    assert.equal(only2026.count, 1);
    const business = await c.json("trip_list", { category: "business" });
    assert.equal(business.count, 1);
    const badCat = await c.call("trip_list", { category: "pleasure" });
    assert.equal(badCat.isError, true);
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
    assert.equal(r.product, "mileage-log");
    assert.match(r.upgradeUrl, /mcp\.zovo\.one\/buy\/mileage-log/);
    const bad = await c.call("license_activate", { key: "MCPL1.nope.nope" });
    assert.equal(bad.isError, true);
  } finally {
    c.close(); s.cleanup();
  }
});
