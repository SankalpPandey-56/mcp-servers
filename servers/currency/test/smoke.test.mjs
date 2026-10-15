import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

/* --------------------------------------------------------------- ECB fixtures */
/* Dates are generated relative to today so the free-tier 90-day window is exercised
   against a moving clock rather than a date that ages out of it. */
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86_400_000));
const D0 = daysAgo(0), D1 = daysAgo(1), D2 = daysAgo(2), D5 = daysAgo(5);

const day = (t, usd, jpy, gbp, pln) =>
  `<Cube time='${t}'><Cube currency='USD' rate='${usd}'/><Cube currency='JPY' rate='${jpy}'/>` +
  `<Cube currency='GBP' rate='${gbp}'/><Cube currency='PLN' rate='${pln}'/></Cube>`;

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref"><Cube>`;
const TAIL = `</Cube></gesmes:Envelope>`;

const DAILY_XML = HEAD + day(D0, "1.0812", "172.53", "0.85023", "4.2650") + TAIL;
const HIST_XML = HEAD +
  day(D0, "1.0812", "172.53", "0.85023", "4.2650") +
  day(D1, "1.0790", "172.10", "0.85110", "4.2710") +
  day(D2, "1.0755", "171.88", "0.85240", "4.2800") +
  day(D5, "1.0731", "171.02", "0.85310", "4.2890") +
  TAIL;

let hits = 0;
/* When set, the fixture server truncates the history body mid-stream: valid XML, newest days
   only, no closing tag - exactly what a dropped connection or a truncating proxy delivers. */
let truncateHistory = false;
function ecbServer() {
  const srv = createServer((req, res) => {
    hits++;
    if (req.url.includes("eurofxref-daily.xml")) { res.writeHead(200, { "content-type": "text/xml" }); res.end(DAILY_XML); return; }
    if (req.url.includes("eurofxref-hist.xml")) {
      res.writeHead(200, { "content-type": "text/xml" });
      res.end(truncateHistory ? HEAD + day(D0, "9.9999", "999.99", "9.9999", "9.9999") + "<Cube time='" : HIST_XML);
      return;
    }
    res.writeHead(404); res.end("no");
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

/* ------------------------------------------------------------------- JSON-RPC */

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-currency-"));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config"),
      MCP_LICENSE_KEY: "",
      ...env,
    },
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
    home, child, send,
    notify: (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n"),
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

async function init(c) {
  const r = await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  assert.ok(r.result?.serverInfo, "initialize failed");
  assert.equal(r.result.serverInfo.name, "mcp-currency");
  c.notify("notifications/initialized", {});
  return r.result;
}

test("stdio: initialize, tools/list, convert, fx_rates_for, resource, prompt", async (t) => {
  const { srv, url } = await ecbServer();
  t.after(() => srv.close());
  const c = client({ ECB_BASE_URL: url });
  t.after(() => c.close());

  await init(c);

  const tools = (await c.send("tools/list", {})).result.tools.map((x) => x.name).sort();
  assert.deepEqual(tools, [
    "cache_status", "convert", "convert_many", "currencies_list", "fx_rates_for",
    "license_activate", "license_status", "rate_history", "rate_on", "rates_latest",
  ]);

  // convert 100 USD -> PLN against the fixture: 4.2650/1.0812 = 3.944691, 394.4691 -> 394.47
  const conv = JSON.parse((await c.call("convert", { amount: 100, from: "USD", to: "PLN" })).text);
  assert.equal(conv.rate, 3.944691);
  assert.equal(conv.result, "PLN 394.47");
  assert.equal(conv.result_number, 394.47);
  assert.equal(conv.rate_date, D0, "every answer states the rate date");
  assert.match(conv.note, /16:00 CET on TARGET business days/);

  // JPY rounds to whole units
  const jpy = JSON.parse((await c.call("convert", { amount: 10, from: "EUR", to: "JPY" })).text);
  assert.equal(jpy.result, "JPY 1725");
  assert.match(jpy.rounding, /0 decimal places/);

  // the shape expense_to_invoice takes as fx_rates
  const fx = JSON.parse((await c.call("fx_rates_for", { target: "USD", currencies: ["EUR", "GBP", "USD"] })).text);
  assert.equal(fx.target_currency, "USD");
  assert.deepEqual(Object.keys(fx.fx_rates).sort(), ["EUR", "GBP"], "the target's own currency needs no rate");
  assert.equal(fx.fx_rates.EUR, 1.0812);
  assert.equal(fx.fx_rates.GBP, 1.271656);
  for (const v of Object.values(fx.fx_rates)) assert.equal(typeof v === "number" && v > 0, true, "fx_rates values must be positive numbers");
  assert.equal(fx.rate_date, D0);
  assert.match(fx.next_step, /expense_to_invoice/);

  const many = JSON.parse((await c.call("convert_many", { amount: 50, from: "EUR", to: ["USD", "PLN", "JPY"] })).text);
  assert.equal(many.results.length, 3);
  assert.equal(many.results.find((r) => r.to === "JPY").result, "JPY 8627");

  const list = JSON.parse((await c.call("currencies_list", {})).text);
  assert.equal(list.count, 5);
  assert.equal(list.currencies.find((x) => x.code === "JPY").decimals, 0);

  const status = JSON.parse((await c.call("cache_status", {})).text);
  assert.equal(status.daily.exists, true);
  assert.equal(status.daily.rate_date, D0);
  assert.equal(status.mode, "free");

  const res = await c.send("resources/read", { uri: "fx://latest" });
  const body = JSON.parse(res.result.contents[0].text);
  assert.equal(body.base, "EUR");
  assert.equal(body.date, D0);

  const prompts = (await c.send("prompts/list", {})).result.prompts.map((p) => p.name);
  assert.deepEqual(prompts, ["convert_invoice_lines"]);
  const got = await c.send("prompts/get", { name: "convert_invoice_lines", arguments: { project: "Nova", target_currency: "USD" } });
  assert.match(got.result.messages[0].content.text, /fx_rates_for/);
  assert.match(got.result.messages[0].content.text, /invoice_create/);
});

test("free: a 91-day history window is shortened to 90 days and answered, cap named", async (t) => {
  const { srv, url } = await ecbServer();
  t.after(() => srv.close());
  const c = client({ ECB_BASE_URL: url });
  t.after(() => c.close());
  await init(c);

  // D-R55: a wider window is shortened, not refused. The answer carries the cap.
  const r = await c.call("rate_history", { from: "USD", to: "PLN", days: 91 });
  assert.equal(r.isError, false, "a limit hit is information, not a transport error");
  assert.match(r.text, /Free tier reads 90 days back/);
  assert.match(r.text, /mcp\.zovo\.one/);
  const body = JSON.parse(r.text);
  assert.ok(Array.isArray(body.rates), "the free window is still answered");

  // D-R71: one date beyond the free window is SHORTENED now, not refused with a price.
  // guards.test.mjs drives the shortened answer end to end against a full fixture history;
  // what matters here is that the old refusal - which looked nothing up - is gone.
  const old = await c.call("rate_on", { from: "USD", to: "PLN", date: daysAgo(400) });
  assert.ok(!/Nothing was looked up/.test(old.text), `rate_on still refuses instead of shortening:\n${old.text}`);

  // inside the window the free tier answers normally
  const okr = JSON.parse((await c.call("rate_history", { from: "USD", to: "PLN", days: 30 })).text);
  assert.equal(okr.business_days, 4);
  assert.equal(okr.pair, "USD/PLN");
  assert.equal(typeof okr.avg, "number");
  assert.equal(okr.min.rate <= okr.max.rate, true);
});

test("pro: a 91-day window and an old date are allowed", async (t) => {
  const { srv, url } = await ecbServer();
  t.after(() => srv.close());
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "currency"], { encoding: "utf8" }).trim();
  const c = client({ ECB_BASE_URL: url, MCP_LICENSE_KEY: key });
  t.after(() => c.close());
  await init(c);

  assert.match((await c.call("license_status", {})).text, /"tier": "pro"/);

  const r = JSON.parse((await c.call("rate_history", { from: "USD", to: "PLN", days: 91 })).text);
  assert.equal(r.business_days, 4);
  assert.equal(r.from_date < daysAgo(90), true);

  const on = JSON.parse((await c.call("rate_on", { from: "USD", to: "PLN", date: D5 })).text);
  assert.equal(on.rate_date, D5);
  assert.equal(on.exact, true);
});

test("nearest previous business day is stated in the answer", async (t) => {
  const { srv, url } = await ecbServer();
  t.after(() => srv.close());
  const c = client({ ECB_BASE_URL: url });
  t.after(() => c.close());
  await init(c);

  // D5-1 has no fixture row, so the rule must fall back and say so
  const asked = daysAgo(4);
  const on = JSON.parse((await c.call("rate_on", { from: "USD", to: "PLN", date: asked })).text);
  assert.equal(on.requested_date, asked);
  assert.equal(on.rate_date, D5);
  assert.equal(on.exact, false);
  assert.match(on.note, /No ECB rate was published on/);
  assert.match(on.rule, /nearest previous business day/);
});

test("offline: after one download every answer comes from the cache", async (t) => {
  const { srv, url } = await ecbServer();
  const home = mkdtempSync(join(tmpdir(), "mcp-currency-offline-"));
  const env = { ECB_BASE_URL: url, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config") };

  const warm = client(env);
  await init(warm);
  await warm.call("convert", { amount: 1, from: "EUR", to: "USD" });
  warm.close();
  const afterWarm = hits;
  assert.ok(afterWarm > 0, "the first call went to the ECB");

  // Same data dir, dead URL: the cache is fresh, so nothing is fetched and the answer is identical.
  const cold = client({ ...env, ECB_BASE_URL: "http://127.0.0.1:1/none" });
  t.after(() => { cold.close(); srv.close(); });
  await init(cold);
  const conv = JSON.parse((await cold.call("convert", { amount: 100, from: "USD", to: "PLN" })).text);
  assert.equal(conv.result, "PLN 394.47");
  assert.equal(conv.rate_date, D0);
  assert.equal(hits, afterWarm, "a fresh cache makes no network call at all");
});


test("a truncated history download does not replace a good cache", async (t) => {
  const { srv, url } = await ecbServer();
  const home = mkdtempSync(join(tmpdir(), "mcp-currency-trunc-"));
  const dir = join(home, "data", "mcp-servers", "currency");
  const env = { ECB_BASE_URL: url, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config") };

  const warm = client(env);
  await init(warm);
  const good = JSON.parse((await warm.call("rate_history", { from: "EUR", to: "USD", days: 30 })).text);
  assert.equal(good.business_days, 4);
  warm.close();

  // age the cached history past its 24 h window so the next call refreshes
  const hp = join(dir, "history.json");
  const cached = JSON.parse(readFileSync(hp, "utf8"));
  const beforeDays = Object.keys(cached.days).length;
  cached.fetched_at = new Date(Date.now() - 72 * 3_600_000).toISOString();
  writeFileSync(hp, JSON.stringify(cached));

  truncateHistory = true;
  t.after(() => { truncateHistory = false; srv.close(); });
  const c = client(env);
  t.after(() => c.close());
  await init(c);

  const after = JSON.parse((await c.call("rate_history", { from: "EUR", to: "USD", days: 30 })).text);
  assert.equal(after.business_days, beforeDays, "the cached series survives a truncated download");
  assert.equal(Object.keys(JSON.parse(readFileSync(hp, "utf8")).days).length, beforeDays, "the cache file was not overwritten");
  assert.match(after.note, /truncated in transit|was kept/, "the answer says the refresh failed");
  assert.doesNotMatch(JSON.stringify(after), /9\.9999/, "no rate from the truncated body reached the answer");
});

test("an amount too large to represent is refused, not formatted as Infinity", async (t) => {
  const { srv, url } = await ecbServer();
  t.after(() => srv.close());
  const c = client({ ECB_BASE_URL: url });
  t.after(() => c.close());
  await init(c);

  const big = await c.call("convert", { amount: 1e308, from: "EUR", to: "JPY" });
  assert.equal(big.isError, true);
  assert.match(big.text, /too large to convert exactly/);
  assert.doesNotMatch(big.text, /Infinity/);

  // a string amount is refused by the schema with a message that names the fix
  const str = await c.send("tools/call", { name: "convert", arguments: { amount: "1,250.00", from: "EUR", to: "USD" } });
  const msg = JSON.stringify(str.error ?? str.result);
  assert.match(msg, /must be a JSON number, not a string/);

  // a negative amount is a credit note, not an error
  const neg = JSON.parse((await c.call("convert", { amount: -250.5, from: "EUR", to: "USD" })).text);
  assert.equal(neg.result, "USD -270.84");
});

/* D-C4: "the ECB rate for USD" quoted as USD -> EUR returned 0.8589, the reciprocal of the
   figure the ECB publishes. Both directions are now in the payload and the published
   direction is named, so the reciprocal cannot be relayed as the published rate. */
test("D-C4: rate_on carries both directions and names the ECB's published direction", async (t) => {
  const { srv, url } = await ecbServer();
  t.after(() => srv.close());
  const c = client({ ECB_BASE_URL: url });
  t.after(() => c.close());
  await init(c);

  const rev = JSON.parse((await c.call("rate_on", { from: "USD", to: "EUR", date: D0 })).text);
  assert.equal(rev.pair, "USD/EUR");
  assert.equal(rev.inverse_rate, 1.0812);
  assert.match(rev.inverse_meaning, /^1 EUR = 1\.0812 USD on /);
  assert.match(rev.published_direction, /The ECB publishes this pair the other way round: 1 EUR = 1\.0812 USD/);
  assert.match(rev.published_direction, /reciprocal/);
  assert.match(rev.ecb_quoting_convention, /per 1 EUR/);

  const fwd = JSON.parse((await c.call("rate_on", { from: "EUR", to: "USD", date: D0 })).text);
  assert.equal(fwd.rate, 1.0812);
  assert.match(fwd.published_direction, /ECB's own published direction/);

  const cross = JSON.parse((await c.call("rate_on", { from: "USD", to: "PLN", date: D0 })).text);
  assert.match(cross.published_direction, /Neither side is EUR/);
  assert.match(cross.published_direction, /cross rate/);
});

// Profile-first sweep (docs/PROFILE_FIRST_RESULT.md), the D-R64 species: the currency you
// invoice in is business identity, held once behind the token. convert.to and
// fx_rates_for.target were required, so "convert 100 USD into my currency" had to ask.
test("convert and fx_rates_for fall back to the shared profile's default_currency", async (t) => {
  const { srv, url } = await ecbServer();
  t.after(() => srv.close());
  const c = client({ ECB_BASE_URL: url });
  t.after(() => c.close());

  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = join(c.home, "data", "mcp-servers", "profile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "business.json"), JSON.stringify({ name: "Nova Studio", default_currency: "PLN" }));

  await init(c);

  const r = JSON.parse((await c.call("convert", { amount: 100, from: "USD" })).text);
  assert.equal(r.to, "PLN");
  assert.equal(r.to_source, "the shared business profile's default_currency");

  const f = JSON.parse((await c.call("fx_rates_for", { currencies: ["EUR", "GBP"] })).text);
  assert.equal(f.target_currency, "PLN");
  assert.equal(f.target_source, "the shared business profile's default_currency");

  const b = JSON.parse((await c.call("rates_latest", { quotes: ["EUR"] })).text);
  assert.equal(b.base, "PLN");
  assert.equal(b.base_source, "the shared business profile's default_currency");

  // An explicit target still wins and is not annotated as profile-sourced.
  const r2 = JSON.parse((await c.call("convert", { amount: 100, from: "USD", to: "JPY" })).text);
  assert.equal(r2.to, "JPY");
  assert.equal(r2.to_source, undefined);
});

test("convert with no target anywhere names business_set rather than asking", async (t) => {
  const { srv, url } = await ecbServer();
  t.after(() => srv.close());
  const c = client({ ECB_BASE_URL: url });
  t.after(() => c.close());
  await init(c);
  const r = await c.call("convert", { amount: 100, from: "USD" });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /business_set/);
  assert.match(r.text, /default_currency/);
});
