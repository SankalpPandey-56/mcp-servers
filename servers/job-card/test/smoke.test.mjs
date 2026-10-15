// End to end over stdio JSON-RPC, the way a client drives it: open a job card, log the
// labor and the materials, walk the status flow, read the running totals, print the
// card both ways, summarize the week, delete what is empty, and hit the free-tier cap.
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
 * The worked card, EUR. Every figure below is recomputed by hand:
 *   L1  2026-03-02  Anna   7.50 h @ 4500  = 33750
 *   L2  2026-03-03  Ben    3.25 h @ 4500  = 14625
 *   L3  2026-03-04  Anna   2.50 h @ 4999  = 12497.5 -> 12498  (half-up)
 *   M1  2026-03-02  Copper pipe 15mm, qty 2    @ 1299 = 2598
 *   M2  2026-03-03  Junction box,      qty 0.5 @  399 = 199.5 -> 200  (half-up)
 * Labor 60873, materials 2798, grand 63671; hours 13.25 (Anna 10.0, Ben 3.25).
 * The dates are a past week on purpose: 2026-03-02 is a Monday, so the week window is
 * 2026-03-02 to 2026-03-08 and the future-date guard cannot make the suite depend on
 * the day it runs.
 */
const CARD = { client: "Kowalski bathroom refit", site: "14 Nowa Street, flat 3", description: "Rewire the bathroom and certify", currency: "EUR", scheduled_date: "2026-03-02" };
const LABOR = [
  { worker: "Anna", date: "2026-03-02", hours: 7.5, rate_cents: 4500, value: 33750, note: "Strip out and first fix" },
  { worker: "Ben", date: "2026-03-03", hours: 3.25, rate_cents: 4500, value: 14625, note: "Cable runs" },
  { worker: "Anna", date: "2026-03-04", hours: 2.5, rate_cents: 4999, value: 12498, note: "Second fix and test" },
];
const MATERIALS = [
  { item: "Copper pipe 15mm", date: "2026-03-02", qty: 2, unit_cost_cents: 1299, value: 2598 },
  { item: "Junction box", date: "2026-03-03", qty: 0.5, unit_cost_cents: 399, value: 200 },
];
const LABOR_TOTAL = 60873;
const MATERIALS_TOTAL = 2798;
const GRAND_TOTAL = 63671;
// A second card, GBP, worked inside the same week, so the summary must keep the two
// currencies apart: L4 is 1 h @ 6000 = 6000 on 2026-03-05.
const CARD2 = { client: "Acme Ltd office", site: "2 Mill Lane", description: "PAT test the office", currency: "GBP" };
const L4 = { worker: "Anna", date: "2026-03-05", hours: 1, rate_cents: 6000, value: 6000 };

/* --------------------------------------------------------------------- client */

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-job-card-"));
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

const proKey = () => execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "job-card"], { encoding: "utf8" }).trim();

/** Card 1 with the full worked week on it, plus card 2 with the GBP line. */
async function seed(c) {
  const one = await c.json("job_card_create", CARD);
  const id1 = one.created.id;
  for (const l of LABOR) await c.json("job_card_log_labor", { card: id1, ...l });
  for (const m of MATERIALS) await c.json("job_card_log_material", { card: id1, ...m });
  const two = await c.json("job_card_create", CARD2);
  const id2 = two.created.id;
  await c.json("job_card_log_labor", { card: id2, ...L4 });
  return { id1, id2 };
}

/* ---------------------------------------------------------------------- tests */

test("initialize, tools/list and the whole free-tier flow", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    const init = await c.init();
    assert.equal(init.result.serverInfo.name, "mcp-job-card");

    const list = await c.send("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    for (const want of ["job_card_create", "job_card_delete", "job_card_get", "job_card_list",
      "job_card_log_labor", "job_card_log_material", "job_card_print", "job_card_summary",
      "job_card_update_status", "license_activate", "license_status"]) {
      assert.ok(names.includes(want), `missing tool ${want}; got ${names.join(", ")}`);
    }

    const { id1, id2 } = await seed(c);
    assert.match(id1, /^JC-\d{4}-0001$/);

    // get: the running totals, as integer cents, recomputed by hand above
    const got = await c.json("job_card_get", { card: id1 });
    assert.equal(got.labor_total_cents, LABOR_TOTAL);
    assert.equal(got.materials_total_cents, MATERIALS_TOTAL);
    assert.equal(got.grand_total_cents, GRAND_TOTAL);
    assert.equal(got.grand_total, "EUR 636.71");
    assert.equal(got.hours, 13.25);
    assert.equal(got.labor.length, 3);
    assert.equal(got.labor[2].value_cents, 12498, "2.5 h at 4999 rounds half-up to 12498");
    assert.equal(got.materials[1].value_cents, 200, "0.5 at 399 rounds half-up to 200");
    assert.deepEqual(got.hours_by_worker, [{ worker: "Anna", hours: 10 }, { worker: "Ben", hours: 3.25 }]);

    // list: newest first, filtered by status and client, totals per currency
    const all = await c.json("job_card_list", {});
    assert.equal(all.count, 2);
    assert.equal(all.active, 2);
    assert.equal(all.cards[0].id, id2, "newest card first");
    const openOnly = await c.json("job_card_list", { status: "open" });
    assert.equal(openOnly.count, 2);
    const kowalski = await c.json("job_card_list", { client: "kowalski" });
    assert.equal(kowalski.count, 1);
    assert.equal(kowalski.cards[0].id, id1, "client filter is case-insensitive");
    const byCur = Object.fromEntries(all.totals.map((t) => [t.currency, t]));
    assert.equal(byCur.EUR.total_cents, GRAND_TOTAL);
    assert.equal(byCur.GBP.total_cents, 6000, "GBP stays its own total, never added to EUR");
  } finally {
    c.close(); s.cleanup();
  }
});

test("the status flow moves one step at a time, stamped, and closes the card to entries", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const { id1 } = await seed(c);

    // a skipped step is refused, nothing written
    const skip = await c.call("job_card_update_status", { card: id1, status: "done" });
    assert.equal(skip.isError, true);
    assert.match(skip.text, /one step at a time/);
    assert.match(skip.text, /Nothing was written/);

    // buyer spelling in-progress is the same step
    const started = await c.json("job_card_update_status", { card: id1, status: "in-progress", date: "2026-03-02" });
    assert.equal(started.card.status, "in_progress");
    assert.equal(started.history[0].date, "2026-03-02");

    // a backwards step is refused
    await c.json("job_card_update_status", { card: id1, status: "done", date: "2026-03-04" });
    const back = await c.call("job_card_update_status", { card: id1, status: "open", date: "2026-03-05" });
    assert.equal(back.isError, true);
    assert.match(back.text, /only step from here is invoiced/);

    // a step dated before the step before it is refused
    await c.json("job_card_update_status", { card: id1, status: "invoiced", date: "2026-03-06" });
    const backdated = await c.call("job_card_update_status", { card: id1, status: "archived", date: "2026-03-05" });
    assert.equal(backdated.isError, true);
    assert.match(backdated.text, /cannot be dated before the step before it/);

    // done and invoiced cards are closed to entries
    const doneCard = (await c.json("job_card_create", { client: "Done job", site: "1 High St", description: "Small repair", currency: "EUR" })).created.id;
    await c.json("job_card_log_labor", { card: doneCard, worker: "Ben", date: "2026-03-02", hours: 1, rate_cents: 4000 });
    await c.json("job_card_update_status", { card: doneCard, status: "in_progress", date: "2026-03-02" });
    await c.json("job_card_update_status", { card: doneCard, status: "done", date: "2026-03-03" });
    const late = await c.call("job_card_log_labor", { card: doneCard, worker: "Ben", date: "2026-03-04", hours: 1, rate_cents: 4000 });
    assert.equal(late.isError, true);
    assert.match(late.text, /no longer on the board/);
    const lateMat = await c.call("job_card_log_material", { card: doneCard, item: "Screws", date: "2026-03-04", qty: 1, unit_cost_cents: 100 });
    assert.equal(lateMat.isError, true);

    // archiving frees the slot and keeps the record
    const archived = await c.json("job_card_update_status", { card: id1, status: "archived", date: "2026-03-06" });
    assert.equal(archived.card.status, "archived");
    const list = await c.json("job_card_list", {});
    assert.equal(list.active, 2, "the archived card no longer counts as active");
    const kept = await c.json("job_card_get", { card: id1 });
    assert.equal(kept.grand_total_cents, GRAND_TOTAL, "archiving keeps the record");
  } finally {
    c.close(); s.cleanup();
  }
});

test("print renders markdown and self-contained HTML, both with the signature line", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const { id1 } = await seed(c);

    const md = await c.call("job_card_print", { card: id1 });
    assert.equal(md.isError, false);
    assert.match(md.text, /# Job card JC-/);
    assert.match(md.text, /\| 2026-03-02 \| Anna \| 7\.5 \| EUR 45\.00 \| EUR 337\.50 \|/);
    assert.match(md.text, /Total due: EUR 636\.71/);
    assert.match(md.text, /Client signature: _+/);

    const html = await c.call("job_card_print", { card: id1, format: "html" });
    assert.equal(html.isError, false);
    assert.match(html.text, /<!DOCTYPE html>/);
    assert.match(html.text, /<style>/, "self-contained: styling is inline");
    assert.ok(!/src=|href=|@import|url\(/i.test(html.text), "self-contained: nothing external is referenced");
    assert.match(html.text, /Client signature/);
    assert.match(html.text, /Total due: EUR 636\.71/);
    assert.match(html.text, /Kowalski bathroom refit/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("the summary answers a day and a week, per worker and per currency", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    await seed(c);

    // one day: only what is dated on it
    const day = await c.json("job_card_summary", { date: "2026-03-02", span: "day" });
    assert.equal(day.from, "2026-03-02");
    assert.equal(day.to, "2026-03-02");
    assert.equal(day.cards_touched, 1);
    assert.equal(day.hours_total, 7.5);
    assert.deepEqual(day.hours_by_worker, [{ worker: "Anna", hours: 7.5 }]);
    assert.equal(day.by_currency.length, 1);
    assert.equal(day.by_currency[0].labor_cents, 33750);
    assert.equal(day.by_currency[0].materials_cents, 2598);
    assert.equal(day.by_currency[0].total_cents, 36348);

    // the week runs Monday to Sunday around any date in it
    const week = await c.json("job_card_summary", { date: "2026-03-04", span: "week" });
    assert.equal(week.from, "2026-03-02", "2026-03-04 falls in the week starting Monday 2026-03-02");
    assert.equal(week.to, "2026-03-08");
    assert.equal(week.cards_touched, 2);
    assert.equal(week.hours_total, 14.25);
    assert.deepEqual(week.hours_by_worker, [{ worker: "Anna", hours: 11 }, { worker: "Ben", hours: 3.25 }]);
    const byCur = Object.fromEntries(week.by_currency.map((t) => [t.currency, t]));
    assert.equal(byCur.EUR.total_cents, GRAND_TOTAL);
    assert.equal(byCur.GBP.total_cents, 6000, "the GBP card is its own line, never added to EUR");

    // a window with nothing in it says so, it does not fail
    const empty = await c.json("job_card_summary", { date: "2026-03-09", span: "day" });
    assert.equal(empty.cards_touched, 0);
    assert.equal(empty.hours_total, 0);
    assert.equal(empty.by_currency.length, 0);
  } finally {
    c.close(); s.cleanup();
  }
});

test("guards: future dates, bad hours, ambiguous refs, and delete keeps worked cards", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const { id1 } = await seed(c);

    // work cannot have been done tomorrow
    const future = await c.call("job_card_log_labor", { card: id1, worker: "Anna", date: "2099-01-01", hours: 1, rate_cents: 4500 });
    assert.equal(future.isError, true);
    assert.match(future.text, /after today/);
    const futureMat = await c.call("job_card_log_material", { card: id1, item: "Pipe", date: "2099-01-01", qty: 1, unit_cost_cents: 100 });
    assert.equal(futureMat.isError, true);

    // hours must be to the hundredth, within a day
    const badHours = await c.call("job_card_log_labor", { card: id1, worker: "Anna", date: "2026-03-02", hours: 1.234, rate_cents: 4500 });
    assert.equal(badHours.isError, true);
    assert.match(badHours.text, /to the hundredth/);
    const tooLong = await c.call("job_card_log_labor", { card: id1, worker: "Anna", date: "2026-03-02", hours: 25, rate_cents: 4500 });
    assert.equal(tooLong.isError, true);

    // a date that is not a date
    const badDate = await c.call("job_card_log_labor", { card: id1, worker: "Anna", date: "2026-02-30", hours: 1, rate_cents: 4500 });
    assert.equal(badDate.isError, true);
    assert.match(badDate.text, /not a real date/);

    // a partial client name that matches two cards is refused with the candidates
    const amb = await c.call("job_card_get", { card: "o" });
    assert.equal(amb.isError, true);
    assert.match(amb.text, /matches more than one job card/);

    // delete refuses a card that holds work, naming what it holds
    const del = await c.call("job_card_delete", { card: id1 });
    assert.equal(del.isError, true);
    assert.match(del.text, /3 labor entries and 2 material entries/);
    assert.match(del.text, /EUR 636\.71/);

    // delete takes an empty card and never reissues the number
    const emptyCard = (await c.json("job_card_create", { client: "Mistake", site: "Nowhere", description: "Typed twice", currency: "EUR" })).created.id;
    const gone = await c.json("job_card_delete", { card: emptyCard });
    assert.equal(gone.deleted.id, emptyCard);
    const after = await c.json("job_card_list", {});
    assert.equal(after.count, 2);
    const next = (await c.json("job_card_create", { client: "Next job", site: "3 Low St", description: "Gutter", currency: "EUR" })).created.id;
    assert.notEqual(next, emptyCard, "a deleted number is burned, not reissued");
  } finally {
    c.close(); s.cleanup();
  }
});

test("free tier: the eleventh active card is refused, archiving frees the slot, Pro lifts the cap", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    let first = "";
    for (let i = 1; i <= 10; i++) {
      const r = await c.json("job_card_create", { client: `Client ${i}`, site: `${i} Street`, description: `Job ${i}`, currency: "EUR" });
      assert.ok(r.created.id, `card ${i} should open`);
      if (!first) first = r.created.id;
    }
    const eleventh = await c.call("job_card_create", { client: "Client 11", site: "11 Street", description: "Job 11", currency: "EUR" });
    assert.equal(eleventh.isError, true);
    assert.match(eleventh.text, /10 active job cards/);
    assert.match(eleventh.text, /Nothing was written/);
    assert.match(eleventh.text, /Pro/);

    // archiving one frees its slot, no key needed
    await c.json("job_card_update_status", { card: first, status: "in_progress", date: "2026-03-01" });
    await c.json("job_card_update_status", { card: first, status: "done", date: "2026-03-02" });
    await c.json("job_card_update_status", { card: first, status: "invoiced", date: "2026-03-03" });
    await c.json("job_card_update_status", { card: first, status: "archived", date: "2026-03-04" });
    const freed = await c.json("job_card_create", { client: "Client 11", site: "11 Street", description: "Job 11", currency: "EUR" });
    assert.ok(freed.created.id, "archiving a finished job frees the slot on the free tier");
    c.close();

    // Pro takes the cap off entirely
    const pro = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
    try {
      await pro.init();
      const status = await pro.json("license_status", {});
      assert.equal(status.tier, "pro");
      for (let i = 12; i <= 13; i++) {
        const r = await pro.json("job_card_create", { client: `Client ${i}`, site: `${i} Street`, description: `Job ${i}`, currency: "EUR" });
        assert.ok(r.created.id, `Pro card ${i} should open over the free cap`);
      }
      const list = await pro.json("job_card_list", {});
      assert.equal(list.active, 12);
    } finally { pro.close(); }
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
    assert.equal(r.product, "job-card");
    assert.match(r.upgradeUrl, /mcp\.zovo\.one\/buy\/job-card/);
    const bad = await c.call("license_activate", { key: "MCPL1.nope.nope" });
    assert.equal(bad.isError, true);
  } finally {
    c.close(); s.cleanup();
  }
});
