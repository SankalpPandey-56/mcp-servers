// End to end over stdio JSON-RPC, the way a client drives it: initialize, tools/list,
// write an agreement, render it (the party names must be in the render), walk the
// status flow, run the checklist, hit the clause and HTML gates, and the free-tier cap.
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
 * The worked agreement, EUR. Anna Nowak designs and builds a five-page site for
 * Brightleaf Studio: 8,500 cents an hour, Net 14, 14 days' notice, capped at 850,000
 * cents, England and Wales. Dates in the past so the suite cannot depend on the day
 * it runs.
 */
const AGREEMENT = {
  freelancer: "Anna Nowak",
  client: "Brightleaf Studio",
  scope: "Design and build of a five-page marketing site, with two weeks of post-launch fixes",
  deliverables: ["Five-page site deployed to the client's host", "Handover document"],
  rate_cents: 8500,
  rate_unit: "hour",
  currency: "EUR",
  payment_terms: "Net 14 from invoice date",
  start_date: "2026-10-01",
  end_date: "2026-12-31",
  termination_notice_days: 14,
  liability_cap_cents: 850000,
  jurisdiction: "England and Wales",
};

/* --------------------------------------------------------------------- client */

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-service-agreement-"));
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

const proKey = () => execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "service-agreement"], { encoding: "utf8" }).trim();

/* ---------------------------------------------------------------------- tests */

test("initialize, tools/list, agreement_create then agreement_render carries the party names", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    const init = await c.init();
    assert.equal(init.result.serverInfo.name, "mcp-service-agreement");

    const list = await c.send("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    for (const want of ["agreement_checklist", "agreement_create", "agreement_get", "agreement_list",
      "agreement_render", "agreement_update_status", "clause_library", "license_activate", "license_status"]) {
      assert.ok(names.includes(want), `missing tool ${want}; got ${names.join(", ")}`);
    }

    const created = await c.json("agreement_create", AGREEMENT);
    assert.match(created.created.id, /^SA-\d{4}-0001$/);
    assert.equal(created.created.status, "draft");
    assert.equal(created.created.rate, "EUR 85.00 per hour");
    assert.match(created.markdown, /# Service Agreement/);
    assert.match(created.markdown, /Anna Nowak/, "the Markdown render names the freelancer");
    assert.match(created.markdown, /Brightleaf Studio/, "the Markdown render names the client");
    assert.match(created.markdown, /template, not legal advice/);

    const md = await c.call("agreement_render", { agreement: created.created.id });
    assert.equal(md.isError, false);
    assert.match(md.text, /Anna Nowak/, "rendered text contains the freelancer name");
    assert.match(md.text, /Brightleaf Studio/, "rendered text contains the client name");
    assert.match(md.text, /EUR 85\.00 per hour/);
    assert.match(md.text, /Net 14 from invoice date/);
    assert.match(md.text, /14 days' written notice/);
    assert.match(md.text, /capped at EUR 8500\.00/);
    assert.match(md.text, /England and Wales/);
    assert.match(md.text, /Signature: _+/);
    assert.match(md.text, /template, not legal advice/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("the status flow moves one step at a time, stamped, and expiring frees the slot", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const id = (await c.json("agreement_create", AGREEMENT)).created.id;

    // a skipped step is refused, nothing written
    const skip = await c.call("agreement_update_status", { agreement: id, status: "signed" });
    assert.equal(skip.isError, true);
    assert.match(skip.text, /one step at a time/);
    assert.match(skip.text, /Nothing was written/);

    const sent = await c.json("agreement_update_status", { agreement: id, status: "sent", date: "2026-09-20" });
    assert.equal(sent.agreement.status, "sent");
    assert.equal(sent.history[0].date, "2026-09-20");

    // a backwards step is refused
    const back = await c.call("agreement_update_status", { agreement: id, status: "draft" });
    assert.equal(back.isError, true);
    assert.match(back.text, /only step from here is signed/);

    // a step dated before the step before it is refused
    const backdated = await c.call("agreement_update_status", { agreement: id, status: "signed", date: "2026-09-19" });
    assert.equal(backdated.isError, true);
    assert.match(backdated.text, /cannot be dated before the step before it/);

    await c.json("agreement_update_status", { agreement: id, status: "signed", date: "2026-09-25" });
    const expired = await c.json("agreement_update_status", { agreement: id, status: "expired", date: "2026-12-31" });
    assert.equal(expired.agreement.status, "expired");
    const list = await c.json("agreement_list", {});
    assert.equal(list.active, 0, "an expired agreement no longer counts as active");

    // expired is the end of the flow
    const beyond = await c.call("agreement_update_status", { agreement: id, status: "draft" });
    assert.equal(beyond.isError, true);
    assert.match(beyond.text, /the end of the flow/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("the checklist flags missing fields and one-sided gaps neutrally", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();

    // a bare agreement: no dates, no notice, no cap, no jurisdiction
    const bare = (await c.json("agreement_create", {
      freelancer: "Anna Nowak", client: "Bare Minimum Co",
      scope: "Ongoing design work", deliverables: ["Monthly design batch"],
      rate_cents: 6000, rate_unit: "day", currency: "EUR", payment_terms: "Net 30",
    })).created.id;
    const check = await c.json("agreement_checklist", { agreement: bare });
    assert.equal(check.ready, false);
    const byItem = Object.fromEntries(check.items.map((i) => [i.item, i]));
    assert.equal(byItem["End date set"].ok, false);
    assert.match(byItem["End date set"].detail, /open-ended/);
    assert.equal(byItem["Termination notice set"].ok, false);
    assert.match(byItem["Termination notice set"].detail, /No termination clause/);
    assert.equal(byItem["Liability cap set"].ok, false);
    assert.match(byItem["Liability cap set"].detail, /unlimited/);
    assert.equal(byItem["Jurisdiction set"].ok, false);
    assert.equal(byItem["Client named"].ok, true);
    assert.match(check.disclaimer, /template, not legal advice/);

    // the full agreement passes every item
    const full = (await c.json("agreement_create", AGREEMENT)).created.id;
    const ready = await c.json("agreement_checklist", { agreement: full });
    assert.equal(ready.ready, true);
    assert.equal(ready.missing_count, 0);

    // get and list read the store back
    const got = await c.json("agreement_get", { agreement: full });
    assert.equal(got.freelancer, "Anna Nowak");
    assert.equal(got.liability_cap, "EUR 8500.00");
    const drafts = await c.json("agreement_list", { status: "draft" });
    assert.equal(drafts.count, 2);
    const brightleaf = await c.json("agreement_list", { client: "brightleaf" });
    assert.equal(brightleaf.count, 1, "client filter is case-insensitive");
  } finally {
    c.close(); s.cleanup();
  }
});

test("clause library and HTML are Pro-gated; Markdown stays free", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const id = (await c.json("agreement_create", AGREEMENT)).created.id;

    // free tier: titles and summaries, no bodies
    const freeLib = await c.json("clause_library", {});
    assert.equal(freeLib.pro, false);
    assert.equal(freeLib.clauses.length, 5);
    for (const want of ["ip_assignment", "confidentiality", "late_payment", "kill_fee", "revision_rounds"]) {
      assert.ok(freeLib.clauses.some((x) => x.id === want), `missing clause ${want}`);
    }
    assert.equal(freeLib.clauses[0].body, undefined, "free tier lists no bodies");
    assert.match(freeLib.upgrade, /mcp\.zovo\.one\/buy\/service-agreement/);

    // free tier: clauses on create are refused
    const withClause = await c.call("agreement_create", { ...AGREEMENT, client: "Clause Co", clauses: ["ip_assignment"] });
    assert.equal(withClause.isError, true);
    assert.match(withClause.text, /clause library is a Pro feature/);
    assert.match(withClause.text, /Nothing was written/);

    // free tier: HTML is refused, Markdown is not
    const htmlFree = await c.call("agreement_render", { agreement: id, format: "html" });
    assert.equal(htmlFree.isError, true);
    assert.match(htmlFree.text, /HTML rendering is a Pro feature/);
    const mdFree = await c.call("agreement_render", { agreement: id, format: "markdown" });
    assert.equal(mdFree.isError, false);

    c.close();

    // Pro: bodies come back with the agreement's variables filled in
    const pro = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
    try {
      await pro.init();
      const status = await pro.json("license_status", {});
      assert.equal(status.tier, "pro");

      const lib = await pro.json("clause_library", { agreement: id });
      assert.equal(lib.pro, true);
      const ip = lib.clauses.find((x) => x.id === "ip_assignment");
      assert.match(ip.body, /Anna Nowak assigns to Brightleaf Studio/, "variables are substituted");
      assert.ok(!/\{\{/.test(ip.body), "no tokens are left in a filled body");
      const conf = lib.clauses.find((x) => x.id === "confidentiality");
      assert.match(conf.body, /England and Wales/);

      // Pro: clauses attach at create and render into the document
      const withClauses = await pro.json("agreement_create", { ...AGREEMENT, client: "Clause Co", clauses: ["ip_assignment", "kill_fee"] });
      assert.match(withClauses.markdown, /### Intellectual property assignment/);
      assert.match(withClauses.markdown, /### Kill fee/);
      assert.match(withClauses.markdown, /Anna Nowak assigns to Clause Co/);

      // Pro: HTML renders self-contained, with the disclaimer
      const html = await pro.call("agreement_render", { agreement: id, format: "html" });
      assert.equal(html.isError, false);
      assert.match(html.text, /<!DOCTYPE html>/);
      assert.match(html.text, /<style>/, "self-contained: styling is inline");
      assert.ok(!/src=|href=|@import|url\(/i.test(html.text), "self-contained: nothing external is referenced");
      assert.match(html.text, /@media print/, "print CSS is present");
      assert.match(html.text, /Anna Nowak/);
      assert.match(html.text, /Brightleaf Studio/);
      assert.match(html.text, /template, not legal advice/);
    } finally { pro.close(); }
  } finally {
    s.cleanup();
  }
});

test("free tier: the fourth active agreement is refused, expiring frees the slot, Pro lifts the cap", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    let first = "";
    for (let i = 1; i <= 3; i++) {
      const r = await c.json("agreement_create", {
        freelancer: "Anna Nowak", client: `Client ${i}`,
        scope: `Work package ${i}`, deliverables: [`Deliverable ${i}`],
        rate_cents: 5000, rate_unit: "hour", currency: "EUR", payment_terms: "Net 14",
      });
      assert.ok(r.created.id, `agreement ${i} should be written`);
      if (!first) first = r.created.id;
    }
    const fourth = await c.call("agreement_create", {
      freelancer: "Anna Nowak", client: "Client 4",
      scope: "Work package 4", deliverables: ["Deliverable 4"],
      rate_cents: 5000, rate_unit: "hour", currency: "EUR", payment_terms: "Net 14",
    });
    assert.equal(fourth.isError, true);
    assert.match(fourth.text, /3 active agreements/);
    assert.match(fourth.text, /Nothing was written/);
    assert.match(fourth.text, /Pro/);

    // expiring one frees its slot, no key needed
    await c.json("agreement_update_status", { agreement: first, status: "sent", date: "2026-09-01" });
    await c.json("agreement_update_status", { agreement: first, status: "signed", date: "2026-09-02" });
    await c.json("agreement_update_status", { agreement: first, status: "expired", date: "2026-09-03" });
    const freed = await c.json("agreement_create", {
      freelancer: "Anna Nowak", client: "Client 4",
      scope: "Work package 4", deliverables: ["Deliverable 4"],
      rate_cents: 5000, rate_unit: "hour", currency: "EUR", payment_terms: "Net 14",
    });
    assert.ok(freed.created.id, "expiring a finished engagement frees the slot on the free tier");
    c.close();

    // Pro takes the cap off entirely
    const pro = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
    try {
      await pro.init();
      for (let i = 5; i <= 6; i++) {
        const r = await pro.json("agreement_create", {
          freelancer: "Anna Nowak", client: `Client ${i}`,
          scope: `Work package ${i}`, deliverables: [`Deliverable ${i}`],
          rate_cents: 5000, rate_unit: "hour", currency: "EUR", payment_terms: "Net 14",
        });
        assert.ok(r.created.id, `Pro agreement ${i} should be written over the free cap`);
      }
      const list = await pro.json("agreement_list", {});
      assert.equal(list.active, 5);
    } finally { pro.close(); }
  } finally {
    s.cleanup();
  }
});

test("license_status on the free tier names the tier and the checkout", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const r = await c.json("license_status", {});
    assert.equal(r.tier, "free");
    assert.equal(r.product, "service-agreement");
    assert.match(r.upgradeUrl, /mcp\.zovo\.one\/buy\/service-agreement/);
    const bad = await c.call("license_activate", { key: "MCPL1.nope.nope" });
    assert.equal(bad.isError, true);
  } finally {
    c.close(); s.cleanup();
  }
});
