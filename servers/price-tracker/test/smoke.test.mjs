import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "dist", "index.js");
const signer = join(here, "..", "..", "..", "scripts", "sign-license.mjs");

const FIXTURE = (price) => `<!doctype html><html><head><meta charset="utf-8">
<title>Test Gadget - Local Shop</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Test Gadget",
"offers":{"@type":"Offer","price":"${price}","priceCurrency":"USD"}}</script>
</head><body><h1>Test Gadget</h1><div class="product-price">$${price}</div></body></html>`;

function startShop() {
  let price = "199.00";
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/blocked")) { res.writeHead(403, { "content-type": "text/html" }); res.end("<h1>Access Denied</h1>"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE(price));
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => resolve({
      srv,
      url: `http://127.0.0.1:${srv.address().port}/product/1`,
      blockedUrl: `http://127.0.0.1:${srv.address().port}/blocked`,
      setPrice: (p) => { price = p; },
      close: () => new Promise((r) => srv.close(r)),
    }));
  });
}

/** A shop whose product URL 302s to a generic category listing (D-2). */
function startRedirectingShop() {
  const CATEGORY = `<!doctype html><html><head><meta charset="utf-8"><title>Products</title></head>
<body><h1>Products</h1><ul><li>Cheap thing 10.00 USD</li><li>Other thing 250.00 USD</li></ul></body></html>`;
  const NO_TITLE = `<!doctype html><html><head><meta charset="utf-8"></head><body><div>Some page 42.00 USD</div></body></html>`;
  const srv = createServer((req, res) => {
    if (req.url.startsWith("/p/gone")) {
      res.writeHead(302, { location: "/cat/products-products/" });
      res.end();
      return;
    }
    if (req.url.startsWith("/cat/")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(CATEGORY);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(NO_TITLE);
  });
  return new Promise((resolve) => {
    srv.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${srv.address().port}`;
      resolve({
        goneUrl: `${base}/p/gone/billy-bookcase`,
        untitledUrl: `${base}/p/untitled/thing`,
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

function client(env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pt-"));
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "config"), MCP_LICENSE_KEY: "", ...env },
  });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const rid = ++id;
    const t = setTimeout(() => reject(new Error(`timeout on ${method}`)), 20000);
    pending.set(rid, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
  });
  const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  return { child, send, notify, dir, stop: () => child.kill() };
}

async function init(c) {
  const r = await c.send("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" },
  });
  c.notify("notifications/initialized", {});
  return r;
}

const textOf = (r) => (r.result?.content ?? []).map((x) => x.text).join("\n");

test("stdio server: initialize, tools/list, manual price, watch, refresh, history, resource", async (t) => {
  const shop = await startShop();
  const c = client();
  t.after(async () => { c.stop(); await shop.close(); });

  const initRes = await init(c);
  assert.equal(initRes.result.serverInfo.name, "mcp-price-tracker");

  const list = await c.send("tools/list", {});
  const names = list.result.tools.map((x) => x.name).sort();
  for (const n of ["alerts_pending", "license_activate", "license_status", "price_add_manual", "price_check",
                   "price_history", "watch_add", "watch_list", "watch_refresh", "watch_remove"]) {
    assert.ok(names.includes(n), `missing tool ${n}`);
  }

  const manual = await c.send("tools/call", {
    name: "price_add_manual",
    arguments: { url: "https://blocked.example.com/tv", price: "1.299,00", currency: "EUR", label: "TV" },
  });
  assert.equal(manual.result.isError, undefined);
  assert.match(textOf(manual), /1299\.00 EUR/);

  const add = await c.send("tools/call", { name: "watch_add", arguments: { url: shop.url, target_price: "150", label: "Gadget" } });
  assert.equal(add.result.isError, undefined);
  assert.match(textOf(add), /199\.00 USD/);

  const check = await c.send("tools/call", { name: "price_check", arguments: { url: shop.url } });
  assert.match(textOf(check), /Price: 199\.00 USD/);

  shop.setPrice("149.00");
  const wid = textOf(add).match(/as ([0-9a-f]{8})\./)[1];
  const refresh = await c.send("tools/call", { name: "watch_refresh", arguments: { id: wid } });
  const rt = textOf(refresh);
  assert.match(rt, /"current": "149\.00 USD"/);
  assert.match(rt, /"previous": "199\.00 USD"/);
  // D-R70: min and max print at the currency's own scale, like every other price here
  assert.match(rt, /"min": "149\.00"/);
  assert.match(rt, /"max": "199\.00"/);
  assert.match(rt, /"change_pct": "-25\.13%"/);
  assert.match(rt, /"target_hit": true/);
  assert.match(rt, /Target hit: /);

  const hist = await c.send("tools/call", { name: "price_history", arguments: { id: wid } });
  const ht = textOf(hist);
  assert.match(ht, /2 of 2 observation/);
  assert.match(ht, /"price": "199\.00"/);
  assert.match(ht, /"price": "149\.00"/);

  const listRes = await c.send("tools/call", { name: "watch_list", arguments: {} });
  assert.match(textOf(listRes), /2\/3 watches used/);

  const resources = await c.send("resources/read", { uri: "prices://watches" });
  const parsed = JSON.parse(resources.result.contents[0].text);
  assert.equal(parsed.tier, "free");
  assert.equal(parsed.watches.length, 2);

  const rm = await c.send("tools/call", { name: "watch_remove", arguments: { id: wid } });
  assert.match(textOf(rm), /Removed /);
});

test("blocked page yields a friendly manual-entry suggestion", async (t) => {
  const shop = await startShop();
  const c = client();
  t.after(async () => { c.stop(); await shop.close(); });
  await init(c);
  const r = await c.send("tools/call", { name: "price_check", arguments: { url: shop.blockedUrl } });
  assert.equal(r.result.isError, true);
  assert.match(textOf(r), /HTTP 403/);
  assert.match(textOf(r), /price_add_manual/);
});

test("free tier caps watches at 3 and gates pro tools without isError", async (t) => {
  const shop = await startShop();
  const c = client();
  t.after(async () => { c.stop(); await shop.close(); });
  await init(c);

  for (let i = 1; i <= 3; i++) {
    const r = await c.send("tools/call", { name: "price_add_manual", arguments: { url: `https://example.com/p${i}`, price: "10.00", currency: "USD" } });
    assert.equal(r.result.isError, undefined);
  }
  const fourth = await c.send("tools/call", { name: "price_add_manual", arguments: { url: "https://example.com/p4", price: "10.00" } });
  assert.equal(fourth.result.isError, undefined);
  assert.match(textOf(fourth), /free tier tracks 3 items/);
  assert.match(textOf(fourth), /mcp\.zovo\.one\/buy\/price-tracker/);

  const alerts = await c.send("tools/call", { name: "alerts_pending", arguments: {} });
  assert.equal(alerts.result.isError, undefined);
  assert.doesNotMatch(textOf(alerts), /Pro feature/);
  assert.doesNotMatch(textOf(alerts), /mcp\.zovo\.one/);
  assert.match(textOf(alerts), /No pending alerts across 3 watch\(es\)/);

  const refreshAll = await c.send("tools/call", { name: "watch_refresh", arguments: { all: true } });
  assert.equal(refreshAll.result.isError, undefined);
  assert.match(textOf(refreshAll), /Pro feature/);
});

test("pro license unlocks unlimited watches, refresh all and alerts_pending", async (t) => {
  const key = execFileSync(process.execPath, [signer, "price-tracker"], { encoding: "utf8" }).trim();
  assert.match(key, /^MCPL1\./);
  const shop = await startShop();
  const c = client({ MCP_LICENSE_KEY: key });
  t.after(async () => { c.stop(); await shop.close(); });
  await init(c);

  const status = await c.send("tools/call", { name: "license_status", arguments: {} });
  assert.match(textOf(status), /"tier": "pro"/);

  for (let i = 1; i <= 5; i++) {
    const r = await c.send("tools/call", { name: "price_add_manual", arguments: { url: `https://example.com/pro${i}`, price: "100.00", currency: "USD" } });
    assert.equal(r.result.isError, undefined);
    assert.doesNotMatch(textOf(r), /Pro feature/);
  }

  await c.send("tools/call", { name: "watch_add", arguments: { url: shop.url, target_price: "150" } });
  shop.setPrice("120.00");
  const refreshAll = await c.send("tools/call", { name: "watch_refresh", arguments: { all: true } });
  assert.equal(refreshAll.result.isError, undefined);
  assert.match(textOf(refreshAll), /"current": "120\.00 USD"/);

  const alerts = await c.send("tools/call", { name: "alerts_pending", arguments: {} });
  assert.equal(alerts.result.isError, undefined);
  assert.match(textOf(alerts), /target hit/);

  const listRes = await c.send("tools/call", { name: "watch_list", arguments: {} });
  assert.match(textOf(listRes), /Tier: pro/);
});

test("pro history is not truncated at 10 observations", async (t) => {
  const key = execFileSync(process.execPath, [signer, "price-tracker"], { encoding: "utf8" }).trim();
  const c = client({ MCP_LICENSE_KEY: key });
  t.after(() => c.stop());
  await init(c);
  for (let i = 0; i < 34; i++) {
    await c.send("tools/call", { name: "price_add_manual", arguments: { url: "https://example.com/many", price: String(100 + i), currency: "USD" } });
  }
  const hist = await c.send("tools/call", { name: "price_history", arguments: { url: "https://example.com/many" } });
  assert.match(textOf(hist), /34 of 34 observation/);
});

test("D-2: a redirect to a category page fails instead of returning a price", async (t) => {
  const shop = await startRedirectingShop();
  const c = client();
  t.after(async () => { c.stop(); await shop.close(); });
  await init(c);

  const check = await c.send("tools/call", { name: "price_check", arguments: { url: shop.goneUrl } });
  assert.equal(check.result.isError, true);
  const ct = textOf(check);
  assert.match(ct, /the shop redirected to http:\/\/127\.0\.0\.1:\d+\/cat\/products-products\//);
  assert.match(ct, /which is not a product page/);
  assert.doesNotMatch(ct, /Price: /);

  const add = await c.send("tools/call", { name: "watch_add", arguments: { url: shop.goneUrl } });
  assert.equal(add.result.isError, true);
  assert.match(textOf(add), /which is not a product page/);

  const list = await c.send("tools/call", { name: "watch_list", arguments: {} });
  assert.match(textOf(list), /No watches yet/);
});

test("D-2: a low-confidence price on an untitled page is reported but never stored", async (t) => {
  const shop = await startRedirectingShop();
  const c = client();
  t.after(async () => { c.stop(); await shop.close(); });
  await init(c);

  const check = await c.send("tools/call", { name: "price_check", arguments: { url: shop.untitledUrl } });
  assert.equal(check.result.isError, undefined);
  const ct = textOf(check);
  assert.match(ct, /Confidence: low \(source regex-fallback\)/);
  assert.match(ct, /Warning: refusing to store a price/);

  const add = await c.send("tools/call", { name: "watch_add", arguments: { url: shop.untitledUrl } });
  assert.equal(add.result.isError, true);
  assert.match(textOf(add), /refusing to store a price/);

  const list = await c.send("tools/call", { name: "watch_list", arguments: {} });
  assert.match(textOf(list), /No watches yet/);
});

test("confidence and source are exposed in price_check, watch_add and watch_list", async (t) => {
  const shop = await startShop();
  const c = client();
  t.after(async () => { c.stop(); await shop.close(); });
  await init(c);

  const check = await c.send("tools/call", { name: "price_check", arguments: { url: shop.url } });
  assert.match(textOf(check), /Confidence: high \(source json-ld\)/);

  const add = await c.send("tools/call", { name: "watch_add", arguments: { url: shop.url } });
  assert.match(textOf(add), /Confidence: high \(source json-ld\)/);
  assert.match(textOf(add), /no background job/);
  assert.match(textOf(add), /refresh my watches/);

  const list = await c.send("tools/call", { name: "watch_list", arguments: {} });
  const lt = textOf(list);
  assert.match(lt, /"confidence": "high"/);
  assert.match(lt, /"source": "json-ld"/);
});

test("D-5: alerts_pending is free and the check_prices prompt exists", async (t) => {
  const shop = await startShop();
  const c = client();
  t.after(async () => { c.stop(); await shop.close(); });
  await init(c);

  await c.send("tools/call", { name: "watch_add", arguments: { url: shop.url, target_price: "150", label: "Gadget" } });
  shop.setPrice("120.00");
  const wid = (await c.send("tools/call", { name: "watch_list", arguments: {} })).result.content[0].text.match(/"id": "([0-9a-f]{8})"/)[1];
  await c.send("tools/call", { name: "watch_refresh", arguments: { id: wid } });

  const alerts = await c.send("tools/call", { name: "alerts_pending", arguments: {} });
  assert.equal(alerts.result.isError, undefined);
  const at = textOf(alerts);
  assert.doesNotMatch(at, /Pro feature/);
  assert.match(at, /target hit/);
  assert.match(at, /"confidence": "high"/);

  const prompts = await c.send("prompts/list", {});
  assert.ok(prompts.result.prompts.some((p) => p.name === "check_prices"), "check_prices prompt missing");
  const got = await c.send("prompts/get", { name: "check_prices", arguments: {} });
  const pt = got.result.messages.map((m) => m.content.text).join("\n");
  assert.match(pt, /watch_refresh/);
  assert.match(pt, /alerts_pending/);
});

test("free history keeps the last 30 observations", async (t) => {
  const c = client();
  t.after(() => c.stop());
  await init(c);
  for (let i = 0; i < 34; i++) {
    await c.send("tools/call", { name: "price_add_manual", arguments: { url: "https://example.com/many", price: String(100 + i), currency: "USD" } });
  }
  const hist = await c.send("tools/call", { name: "price_history", arguments: { url: "https://example.com/many" } });
  const ht = textOf(hist);
  assert.match(ht, /30 of 34 observation/);
  assert.match(ht, /Free shows the last 30 observations/);
});

// D-R19: in round 6 the model answered "what is the price here: <url>" with curl and a
// question back to the user; price_check was never called. The first sentence of both
// URL-taking tools is now an imperative aimed at the client.
test("D-R19: price_check and watch_add lead with the client-directed claim", async (t) => {
  const c = client();
  t.after(() => c.stop());
  await init(c);
  const list = await c.send("tools/list", {});
  const byName = new Map(list.result.tools.map((x) => [x.name, x]));
  const CLAIM = "Call this tool for any product URL; fetching the page with a generic web tool returns raw HTML without the price.";
  for (const n of ["price_check", "watch_add"]) {
    assert.ok(byName.has(n), `${n} missing`);
    const d = byName.get(n).description;
    assert.ok(d.startsWith(CLAIM), `${n} does not lead with the claim: ${d.slice(0, 90)}`);
    assert.ok(d.length < 220, `${n} description is ${d.length} chars, must stay under 220`);
  }
});
