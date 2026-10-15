import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = (f) => join(here, "..", "dist", f);
const ENTRY = join(here, "..", "dist", "index.js");

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 86_400_000));

const HEAD = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01"><Cube>`;
const TAIL = `</Cube></gesmes:Envelope>`;
const day = (t, usd, pln) => `<Cube time='${t}'><Cube currency='USD' rate='${usd}'/><Cube currency='PLN' rate='${pln}'/></Cube>`;

function listen(handler) {
  const srv = createServer(handler);
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

/* ------------------------------------------------- 2. the deadline covers the body */

test("the fetch deadline covers the body, not just the headers", async (t) => {
  const { fetchText } = await import(dist("ecb.js"));
  // Headers go out immediately, then the body stalls forever: the failure a header-only
  // timer cannot see, and the one that used to hold the refresh lock open past its lease.
  const open = [];
  const { srv, url } = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/xml" });
    res.write(HEAD);
    open.push(res);
  });
  t.after(() => { for (const r of open) r.destroy(); srv.close(); });

  const t0 = Date.now();
  await assert.rejects(
    () => fetchText(`${url}/eurofxref-hist.xml`, 700),
    /did not finish sending .* within 1s/,
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 5000, `aborted the stalled body in ${elapsed} ms rather than hanging`);
});

test("the lock lease outlasts the longest body deadline", async () => {
  const { LOCK_TIMEOUT_MS, HISTORY_TIMEOUT_MS, TIMEOUT_MS } = await import(dist("ecb.js"));
  assert.ok(HISTORY_TIMEOUT_MS >= TIMEOUT_MS);
  assert.ok(
    LOCK_TIMEOUT_MS >= HISTORY_TIMEOUT_MS,
    `the lock is held for the whole download: ${LOCK_TIMEOUT_MS} ms lease must cover a ${HISTORY_TIMEOUT_MS} ms body`,
  );
});

/* ------------------------------------- 2. a stale response cannot overwrite a newer cache */

test("a history download that goes backwards is refused and the newer cache is kept", async (t) => {
  const D0 = daysAgo(0), D1 = daysAgo(1), D2 = daysAgo(2), D3 = daysAgo(3);
  // Same number of days, older newest day: the shrink guard alone cannot see this one.
  const FRESH = HEAD + day(D0, "1.0812", "4.2650") + day(D1, "1.0790", "4.2710") + day(D2, "1.0755", "4.2800") + TAIL;
  const STALE = HEAD + day(D1, "1.0790", "4.2710") + day(D2, "1.0755", "4.2800") + day(D3, "1.0731", "4.2890") + TAIL;
  let body = FRESH;
  const { srv, url } = await listen((req, res) => { res.writeHead(200, { "content-type": "text/xml" }); res.end(body); });
  const home = mkdtempSync(join(tmpdir(), "mcp-currency-stale-"));
  t.after(() => srv.close());

  process.env.XDG_DATA_HOME = join(home, "data");
  process.env.ECB_BASE_URL = url;
  const { getHistory } = await import(dist("ecb.js") + "?stale");
  const { historyPath } = await import(dist("store.js") + "?stale");

  const first = await getHistory();
  assert.equal(first.refreshed, true);
  assert.equal(Object.keys(first.data.days).sort().pop(), D0);

  // Age the cache so the next call refreshes, then serve the stale body.
  const onDisk = JSON.parse(readFileSync(historyPath(), "utf8"));
  onDisk.fetched_at = new Date(Date.now() - 48 * 3_600_000).toISOString();
  writeFileSync(historyPath(), JSON.stringify(onDisk));
  body = STALE;

  const second = await getHistory();
  assert.equal(second.refreshed, false, "the stale download was refused");
  assert.match(second.offline_note ?? "", /stale response/);
  assert.match(second.offline_note ?? "", new RegExp(`already reaches ${D0}`));
  assert.equal(Object.keys(second.data.days).sort().pop(), D0, "the cache still reaches the newer day");
  assert.equal(Object.keys(JSON.parse(readFileSync(historyPath(), "utf8")).days).sort().pop(), D0);
});

/* -------------------------------------------- 3. a cache miss is labelled for what it is */

function client(env) {
  const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MCP_LICENSE_KEY: "", ...env } });
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
    init: () => send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "guards", version: "0" } }),
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

test("a date past the end of the cache is not called a weekend", async (t) => {
  const D0 = daysAgo(0), D2 = daysAgo(2), D3 = daysAgo(3), D4 = daysAgo(4), D5 = daysAgo(5);
  // The cache reaches D2 and has a hole at D3. D0 is after the end of it.
  const HIST = HEAD + day(D2, "1.0755", "4.2800") + day(D4, "1.0741", "4.2860") + day(D5, "1.0731", "4.2890") + TAIL;
  const DAILY = HEAD + day(D2, "1.0755", "4.2800") + TAIL;
  const { srv, url } = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/xml" });
    res.end(req.url.includes("hist") ? HIST : DAILY);
  });
  const home = mkdtempSync(join(tmpdir(), "mcp-currency-miss-"));
  const c = client({ XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "cfg"), ECB_BASE_URL: url });
  t.after(() => { c.close(); srv.close(); });
  await c.init();

  const after = await c.call("rate_on", { from: "EUR", to: "PLN", date: D0 });
  assert.equal(after.isError, false, after.text);
  const a = JSON.parse(after.text);
  assert.equal(a.rate_date, D2);
  assert.match(a.note, new RegExp(`No rate published yet in the cache for ${D0} \\(latest ${D2}\\)`));
  assert.match(a.note, /The history was refreshed from the ECB on this call/, "the caller is told a refresh was attempted");
  assert.ok(!/weekend or TARGET holiday\), so/.test(a.note), "a missing tail is never reported as a non-publication day");

  const inside = await c.call("rate_on", { from: "EUR", to: "PLN", date: D3 });
  assert.equal(inside.isError, false, inside.text);
  const i = JSON.parse(inside.text);
  assert.equal(i.rate_date, D4);
  assert.match(i.note, new RegExp(`No ECB rate was published on ${D3} \\(weekend or TARGET holiday\\)`));

  // Second call for the same out-of-range date: the cache is fresh, so no refresh is attempted,
  // and the answer says that instead of implying the ECB was asked again.
  const again = await c.call("rate_on", { from: "EUR", to: "PLN", date: D0 });
  assert.match(JSON.parse(again.text).note, /No refresh was attempted: the cached history is less than 24 hours old/);
});


/* ------------------------------- D-R71: one date beyond the free window is shortened */

test("a date older than the free window is shortened, not refused (D-R71)", async (t) => {
  // rate_history has shortened a too-wide window since D-R55 and says which window it
  // really covered. rate_on refused: it looked nothing up and answered a question about a
  // rate with a price. Round 14 measured it hosted - "What was the EUR/USD rate 91 days
  // ago?" came back as an upgrade pitch and cost the user a second turn.
  const D91 = daysAgo(91), D89 = daysAgo(89), D95 = daysAgo(95);
  const days = [];
  for (let i = 0; i <= 120; i++) days.push(day(daysAgo(i), (1.08 + i / 10000).toFixed(4), (4.25 + i / 10000).toFixed(4)));
  const HIST = HEAD + days.join("") + TAIL;
  const DAILY = HEAD + day(daysAgo(0), "1.0800", "4.2500") + TAIL;
  const { srv, url } = await listen((req, res) => {
    res.writeHead(200, { "content-type": "text/xml" });
    res.end(req.url.includes("hist") ? HIST : DAILY);
  });
  const home = mkdtempSync(join(tmpdir(), "mcp-currency-clamp-"));
  const c = client({ XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "cfg"), ECB_BASE_URL: url });
  t.after(() => { c.close(); srv.close(); });
  await c.init();

  const r = await c.call("rate_on", { from: "EUR", to: "USD", date: D95 });
  assert.equal(r.isError, false, r.text);
  const j = JSON.parse(r.text);
  // A real rate came back, for a date inside the free window, and every field that could
  // be mistaken for the requested date says otherwise.
  assert.ok(Number(j.rate) > 0, `no rate in ${r.text}`);
  assert.equal(j.requested_date, D95);
  assert.equal(j.shortened_from, D95);
  assert.ok(j.rate_date > D95, `${j.rate_date} must be newer than the date asked for`);
  assert.match(j.note, new RegExp(`NOT ${D95}`), `the note must name the date that was NOT read:\n${j.note}`);
  assert.match(j.rate_date_is_not_requested_date, new RegExp(D95));

  // Inside the window nothing changes: no clamp note, no shortened_from.
  const inside = await c.call("rate_on", { from: "EUR", to: "USD", date: D89 });
  const i = JSON.parse(inside.text);
  assert.equal(i.shortened_from, undefined, `a date inside the window must not be clamped: ${inside.text}`);
  assert.ok(!/NOT /.test(i.note), i.note);

  // convert shares ratesForDate, so it shortens the same way instead of refusing.
  const conv = await c.call("convert", { amount: 100, from: "EUR", to: "USD", date: D95 });
  assert.equal(conv.isError, false, conv.text);
  const cj = JSON.parse(conv.text);
  assert.equal(cj.shortened_from, D95);
  assert.ok(Number(cj.result_number) > 0, conv.text);

  // Non-vacuity: the boundary itself is not clamped, so the test cannot pass by clamping
  // everything.
  const edge = await c.call("rate_on", { from: "EUR", to: "USD", date: D91 });
  const e = JSON.parse(edge.text);
  assert.ok(e.rate_date <= D91 || e.shortened_from === undefined || e.shortened_from === D91,
    `unexpected clamp at the boundary: ${edge.text}`);
});
