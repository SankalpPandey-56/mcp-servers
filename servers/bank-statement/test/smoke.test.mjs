// End to end over stdio JSON-RPC, the way a client drives it: import a real-shaped
// 60-row export, list it, categorise it with rules, summarise it per currency, find the
// subscription, reconcile it against a seeded expense ledger, and hit the free-tier caps.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

/* ------------------------------------------------------------------- fixtures */

const pad = (n) => String(n).padStart(2, "0");

/**
 * 60 lines over three months on one account: a monthly subscription, a monthly server
 * bill, three client payments, three PLN lines so the summary has to stay per currency,
 * one debit that a receipt in the expense ledger will match, and filler.
 */
function fixture() {
  const rows = [["Date", "Description", "Amount", "Currency", "Balance"]];
  let balance = 500000;
  const push = (date, desc, minor, cur) => {
    if (cur === "EUR") balance += minor;
    rows.push([date, desc, (minor / 100).toFixed(2), cur, (balance / 100).toFixed(2)]);
  };
  for (const m of [1, 2, 3]) {
    push(`2026-${pad(m)}-05`, `DIRECT DEBIT HETZNER ONLINE GMBH 55${pad(m)}`, -4000, "EUR");
    push(`2026-${pad(m)}-10`, `CARD PAYMENT TO SPOTIFY P${pad(m)}`, -999, "EUR");
    push(`2026-${pad(m)}-15`, `ACME LTD invoice 2026-${pad(m)}`, 250000, "EUR");
  }
  push("2026-03-02", "BIEDRONKA 4021", -12345, "PLN");
  push("2026-03-04", "ORLEN STACJA 118", -25000, "PLN");
  push("2026-03-06", "PRZELEW OD KLIENTA", 500000, "PLN");
  push("2026-03-20", "OFFICE SUPPLIES LTD", -4500, "EUR");
  const merchants = [
    "TESCO EXPRESS", "UBER TRIP", "AWS EMEA", "APPLE STORE", "RYANAIR", "BOOKING COM",
    "DELIVEROO", "SHELL FUEL", "IKEA", "GITHUB INC", "FIGMA INC", "NOTION LABS",
  ];
  let i = 0;
  for (const m of [1, 2, 3]) {
    for (let d = 0; d < 16; d++) {
      const day = pad(((d * 2) % 27) + 1);
      push(`2026-${pad(m)}-${day}`, `${merchants[i % merchants.length]} ${1000 + i}`, -(500 + i * 37), "EUR");
      i++;
    }
  }
  return rows.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n") + "\n";
}

const FIXTURE = fixture();
const FIXTURE_ROWS = FIXTURE.trim().split("\n").length - 1;

/** The expense-tracker ledger, in exactly the shape that server writes it. */
const EXPENSES = {
  version: 1,
  expenses: [
    // settles one day later on the bank: OFFICE SUPPLIES LTD, EUR 45.00
    { id: "e1", date: "2026-03-19", amount_minor: 4500, currency: "EUR", category: "office", merchant: "Office Supplies Ltd", billable: false, created: "2026-03-19T10:00:00.000Z" },
    // paid in cash, so it never reaches the bank at all
    { id: "e2", date: "2026-03-22", amount_minor: 1234, currency: "EUR", category: "travel", merchant: "Taxi", billable: true, created: "2026-03-22T10:00:00.000Z" },
  ],
  rules: [],
  settings: {},
};

/* --------------------------------------------------------------------- client */

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

function sandbox({ withExpenses = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-bank-"));
  const dataHome = join(dir, "data");
  const csv = join(dir, "statement.csv");
  writeFileSync(csv, FIXTURE, "utf8");
  if (withExpenses) {
    const ex = join(dataHome, "mcp-servers", "expense-tracker");
    mkdirSync(ex, { recursive: true });
    writeFileSync(join(ex, "data.json"), JSON.stringify(EXPENSES, null, 2), "utf8");
  }
  return {
    dir, csv, dataHome,
    env: { XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dir, "cfg") },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const proKey = () => execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "bank-statement"], { encoding: "utf8" }).trim();

/* ---------------------------------------------------------------------- tests */

test("initialize, tools/list and the whole free-tier flow", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    const init = await c.init();
    assert.equal(init.result.serverInfo.name, "mcp-bank-statement");

    const list = await c.send("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    for (const want of ["accounts_list", "category_rules", "license_activate", "license_status",
      "recurring_detect", "reconcile_expenses", "statement_export", "statement_import",
      "statement_summary", "transaction_categorize", "transactions_list", "transactions_search"]) {
      assert.ok(names.includes(want), `missing tool ${want}; got ${names.join(", ")}`);
    }

    // import
    const imp = await c.json("statement_import", { path: s.csv, account: "business" });
    assert.equal(imp.imported, FIXTURE_ROWS, JSON.stringify(imp.skipped_lines));
    assert.equal(imp.duplicates_skipped, 0);
    assert.equal(imp.rows_read, FIXTURE_ROWS);
    assert.deepEqual(imp.currencies.sort(), ["EUR", "PLN"]);

    // re-importing the same export adds nothing
    const again = await c.json("statement_import", { path: s.csv, account: "business" });
    assert.equal(again.imported, 0, "a re-import must not double the ledger");
    assert.equal(again.duplicates_skipped, FIXTURE_ROWS);

    // list
    const rows = await c.json("transactions_list", { from: "2026-01-01", to: "2026-03-31", limit: 1000 });
    assert.equal(rows.count, FIXTURE_ROWS);
    const spotify = rows.transactions.filter((t) => t.description.includes("SPOTIFY"));
    assert.equal(spotify.length, 3);
    assert.equal(spotify[0].amount, "EUR -9.99");
    assert.equal(spotify[0].direction, "out");

    // rules categorise what is already stored
    const ruled = await c.json("category_rules", {
      rules: [
        { match: "spotify", category: "software" },
        { match: "hetzner", category: "hosting" },
        { match: "acme", category: "income" },
      ],
    });
    assert.equal(ruled.rules, 3);
    assert.equal(ruled.categorised, 9, "3 subscriptions + 3 server bills + 3 invoices");

    // summary by category, per currency, never mixed
    const sum = await c.json("statement_summary", { from: "2026-01-01", to: "2026-03-31", group_by: "category" });
    assert.ok(sum.by_currency.EUR, JSON.stringify(Object.keys(sum.by_currency)));
    assert.ok(sum.by_currency.PLN, "PLN must be its own group, never added to EUR");
    const software = sum.by_currency.EUR.groups.find((g) => g.group === "software");
    assert.equal(software.money_out, "EUR 29.97");
    assert.equal(software.count, 3);
    assert.equal(sum.by_currency.PLN.money_in, "PLN 5000.00");
    assert.equal(sum.by_currency.PLN.money_out, "PLN 373.45");

    // search
    const found = await c.json("transactions_search", { query: "hetzner" });
    assert.equal(found.matches, 3);

    // categorise by id, and a bad id changes nothing
    const one = rows.transactions.find((t) => t.description.includes("BIEDRONKA"));
    const cat = await c.json("transaction_categorize", { ids: [one.id], category: "groceries" });
    assert.equal(cat.updated, 1);
    const bad = await c.call("transaction_categorize", { ids: [one.id, "nope"], category: "x" });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /nope/);

    // accounts
    const accs = await c.json("accounts_list", {});
    assert.equal(accs.count, 1);
    assert.equal(accs.accounts[0].account, "business");
    assert.equal(accs.accounts[0].transactions, FIXTURE_ROWS);
    assert.equal(accs.free_limit, 2);

    // Export stays Pro and says so rather than half-working.
    const exp = await c.call("statement_export", { from: "2026-01-01", to: "2026-03-31", format: "csv", path: join(s.dir, "out.csv") });
    assert.equal(exp.isError, false, "a limit is information, not a transport error");
    assert.match(exp.text, /Pro feature/);

    // D-R55: the guardrail tools answer on the free tier inside a named cap.
    const rec = await c.json("reconcile_expenses", { from: "2026-01-01", to: "2026-03-31" });
    assert.equal(rec.free_tier_range_days, 31);
    assert.match(rec.free_tier_note, /31 days at a time/);
    assert.equal(rec.from, "2026-03-01");

    const det = await c.json("recurring_detect", { months: 12 });
    assert.equal(det.months, 3, "free tier clamps to 3 months and still answers");
    assert.equal(det.months_asked, 12);
    assert.match(det.free_tier_note, /last 3 months and up to 5 recurring charges/);
    assert.ok(Array.isArray(det.charges));
    assert.ok(det.charges.length <= 5);

    // the resource reads without a tool call
    const res = await c.send("resources/read", { uri: "bank://month" });
    assert.ok(res.result.contents[0].text.includes("by_currency"), res.result.contents[0].text);

    // the prompt exists and names the tools it drives
    const prompt = await c.send("prompts/get", { name: "monthly_review", arguments: { month: "2026-03" } });
    assert.match(prompt.result.messages[0].content.text, /statement_summary/);
    assert.match(prompt.result.messages[0].content.text, /2026-03-01 to 2026-03-31/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("free tier: the third account is refused, Pro accepts it", async () => {
  const s = sandbox();
  const free = client(s.env);
  try {
    await free.init();
    for (const name of ["one", "two"]) {
      const r = await free.json("statement_import", { path: s.csv, account: name });
      assert.equal(r.imported, FIXTURE_ROWS, `${name} should import`);
    }
    const third = await free.call("statement_import", { path: s.csv, account: "three" });
    assert.equal(third.isError, false, "a cap is information, not a transport error");
    assert.match(third.text, /account number 3/);
    assert.match(third.text, /Nothing was imported/);
    free.close();

    const accs = client(s.env);
    await accs.init();
    const before = await accs.json("accounts_list", {});
    assert.equal(before.count, 2, "the refused import must not have created the account");
    accs.close();

    const pro = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
    try {
      await pro.init();
      const r = await pro.json("statement_import", { path: s.csv, account: "three" });
      assert.equal(r.imported, FIXTURE_ROWS);
      const after = await pro.json("accounts_list", {});
      assert.equal(after.count, 3);
      assert.equal(after.free_limit, null);
    } finally { pro.close(); }
  } finally {
    free.close(); s.cleanup();
  }
});

test("Pro: recurring charges, reconciliation against the expense ledger, and export", async () => {
  const s = sandbox({ withExpenses: true });
  const c = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
  try {
    await c.init();
    await c.json("statement_import", { path: s.csv, account: "business" });

    // recurring: the subscription and the server bill come back monthly, the filler does not
    const rec = await c.json("recurring_detect", { months: 12 });
    const names = rec.charges.map((x) => x.counterparty);
    const spot = rec.charges.find((x) => /SPOTIFY/i.test(x.counterparty));
    assert.ok(spot, `no monthly subscription found; saw ${names.join(", ") || "nothing"}`);
    assert.equal(spot.cadence, "monthly");
    assert.equal(spot.occurrences, 3);
    assert.equal(spot.typical_amount, "EUR 9.99");
    assert.equal(spot.annualised, "EUR 119.88");
    assert.equal(spot.last_seen, "2026-03-10");
    assert.ok(rec.charges.some((x) => /HETZNER/i.test(x.counterparty)), names.join(", "));

    // reconcile: one receipt settles a day later, one was paid in cash
    const rec2 = await c.json("reconcile_expenses", { from: "2026-03-01", to: "2026-03-31" });
    assert.equal(rec2.expense_ledger_found, true, rec2.note);
    assert.equal(rec2.matched, 1, JSON.stringify(rec2.matches));
    assert.equal(rec2.matches[0].amount, "EUR -45.00");
    assert.equal(rec2.matches[0].expense.id, "e1");
    assert.equal(rec2.matches[0].days_apart, 1);
    assert.equal(rec2.expenses_without_a_bank_line.length, 1);
    assert.equal(rec2.expenses_without_a_bank_line[0].id, "e2");
    assert.ok(rec2.unmatched_bank.length > 0);

    // export
    const out = join(s.dir, "export.csv");
    const exp = await c.json("statement_export", { from: "2026-01-01", to: "2026-03-31", format: "csv", path: out });
    assert.equal(exp.rows, FIXTURE_ROWS);
    const written = readFileSync(out, "utf8").trim().split("\n");
    assert.equal(written.length, FIXTURE_ROWS + 1, "header plus every row");
    assert.match(written[0], /^id,date,account,description/);
    assert.ok(written.some((l) => l.includes("-9.99")), "an outgoing amount stays negative in the export");

    const outJson = join(s.dir, "export.json");
    await c.json("statement_export", { from: "2026-01-01", to: "2026-03-31", format: "json", path: outJson });
    const parsed = JSON.parse(readFileSync(outJson, "utf8"));
    assert.equal(parsed.length, FIXTURE_ROWS);
    assert.equal(typeof parsed[0].amount_minor, "number");

    // an export to a directory that does not exist fails cleanly
    const bad = await c.call("statement_export", { from: "2026-01-01", to: "2026-03-31", format: "csv", path: join(s.dir, "nope", "x.csv") });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /does not exist/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("reconcile with no expense ledger installed reports that, it does not fail", async () => {
  const s = sandbox();
  const c = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
  try {
    await c.init();
    await c.json("statement_import", { path: s.csv, account: "business" });
    const r = await c.json("reconcile_expenses", { from: "2026-03-01", to: "2026-03-31" });
    assert.equal(r.expense_ledger_found, false);
    assert.match(r.note, /no expense ledger/);
    assert.ok(r.unmatched_bank > 0);
  } finally {
    c.close(); s.cleanup();
  }
});

test("overwrite replaces the account instead of merging into it", async () => {
  const s = sandbox();
  const c = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
  try {
    await c.init();
    await c.json("statement_import", { path: s.csv, account: "business" });
    const corrected = join(s.dir, "corrected.csv");
    writeFileSync(corrected, [
      "Date,Description,Amount,Currency,Balance",
      "2026-03-01,ONLY LINE,-1.00,EUR,100.00",
    ].join("\n"), "utf8");
    const r = await c.json("statement_import", { path: corrected, account: "business", overwrite: true });
    assert.equal(r.imported, 1);
    const accs = await c.json("accounts_list", {});
    assert.equal(accs.accounts[0].transactions, 1);
  } finally {
    c.close(); s.cleanup();
  }
});

test("a rule that could backtrack exponentially is used as a substring, not compiled", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    await c.json("statement_import", { path: s.csv, account: "business" });
    const started = Date.now();
    const r = await c.json("category_rules", { rules: [{ match: "(a+)+$", category: "boom", regex: true }] });
    assert.ok(Date.now() - started < 10000, "an unsafe pattern must not be compiled");
    assert.deepEqual(r.refused_as_regex, ["(a+)+$"]);
    assert.match(r.note, /backtrack/);
  } finally {
    c.close(); s.cleanup();
  }
});

// Profile-first sweep (docs/PROFILE_FIRST_RESULT.md), the D-R64 species: the currency your
// own bank account is denominated in is business identity, held once behind the token.
// statement_import silently assumed EUR for a file that names no currency.
const NO_CURRENCY_CSV = "Date,Description,Amount\n2026-01-05,SPOTIFY,-9.99\n2026-01-06,CLIENT PAYMENT,1200.00\n";

test("statement_import takes the fallback currency from the shared business profile", async () => {
  const s = sandbox();
  writeFileSync(join(s.dir, "plain.csv"), NO_CURRENCY_CSV, "utf8");
  mkdirSync(join(s.dataHome, "mcp-servers", "profile"), { recursive: true });
  writeFileSync(join(s.dataHome, "mcp-servers", "profile", "business.json"),
    JSON.stringify({ name: "Nova Studio", default_currency: "PLN" }), "utf8");
  const c = client(s.env);
  try {
    await c.init();
    const imp = await c.json("statement_import", { path: join(s.dir, "plain.csv"), account: "biz" });
    assert.deepEqual(imp.currencies, ["PLN"]);
    assert.ok(imp.notes.some((n) => /shared business profile/.test(n)), JSON.stringify(imp.notes));

    // An explicit currency still wins and is not annotated as profile-sourced.
    writeFileSync(join(s.dir, "plain2.csv"), NO_CURRENCY_CSV, "utf8");
    const imp2 = await c.json("statement_import", { path: join(s.dir, "plain2.csv"), account: "biz2", currency: "GBP" });
    assert.deepEqual(imp2.currencies, ["GBP"]);
    assert.ok(!imp2.notes.some((n) => /shared business profile/.test(n)), JSON.stringify(imp2.notes));
  } finally { c.close(); s.cleanup(); }
});

test("statement_import with no profile currency still falls back to EUR and says nothing about the profile", async () => {
  const s = sandbox();
  writeFileSync(join(s.dir, "plain.csv"), NO_CURRENCY_CSV, "utf8");
  const c = client(s.env);
  try {
    await c.init();
    const imp = await c.json("statement_import", { path: join(s.dir, "plain.csv"), account: "biz" });
    assert.deepEqual(imp.currencies, ["EUR"]);
    assert.ok(!imp.notes.some((n) => /shared business profile/.test(n)), JSON.stringify(imp.notes));
  } finally { c.close(); s.cleanup(); }
});
