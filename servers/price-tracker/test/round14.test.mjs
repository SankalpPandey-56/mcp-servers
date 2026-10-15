/**
 * D-R70. A watch mixes prices from two sources: a page, which supplies the scale the shop
 * printed ("49.00"), and price_add_manual, which stores exactly what the caller typed
 * ("38.5"). Round 14's hosted run put both in one answer:
 *
 *   min 38.50 / max 49 EUR          (price_history)
 *   "current": "38.5 EUR"           (alerts_pending)
 *
 * Same currency, three scales, in a server whose whole job is comparing prices. Nothing
 * was WRONG - every comparison is numeric - which is why a scorecard scored the turn 3 and
 * only re-reading the bytes found it.
 *
 * These tests drive the real stdio server end to end: load a page at 49.00, add 38.5 by
 * hand, then assert that every printed price for that watch carries the same scale, and
 * that a whole-unit price is still printed whole (padding one would be wrong for JPY).
 */
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "dist", "index.js");

const PAGE = (price, cur) => `<!doctype html><html><head><meta charset="utf-8">
<title>Sample Lamp</title>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Sample Lamp",
"offers":{"@type":"Offer","price":"${price}","priceCurrency":"${cur}"}}</script>
</head><body><h1>Sample Lamp</h1></body></html>`;

function startShop(price, cur) {
  const srv = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE(price, cur));
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    url: `http://127.0.0.1:${srv.address().port}/product/lamp`,
    close: () => new Promise((r) => srv.close(r)),
  })));
}

function client() {
  const dir = mkdtempSync(join(tmpdir(), "pt14-"));
  const child = spawn(process.execPath, [entry], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "config"), MCP_LICENSE_KEY: "" },
  });
  child.stderr.resume();
  let buf = ""; const pending = new Map();
  child.stdout.on("data", (c) => {
    buf += c.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const rid = ++id;
    const t = setTimeout(() => reject(new Error(`timeout on ${method}`)), 20000);
    pending.set(rid, (m) => { clearTimeout(t); resolve(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
  });
  return {
    send,
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args });
      return (r.result?.content ?? []).map((x) => x.text).join("\n");
    },
    init: async () => {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r14", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    },
    stop: () => child.kill(),
  };
}

/** Every "<number> EUR" in a block of text, as written. */
const priced = (s) => [...s.matchAll(/(\d+(?:\.\d+)?)\s*EUR/g)].map((m) => m[1]);

test("one watch, two sources, one scale (D-R70)", async (t) => {
  const shop = await startShop("49.00", "EUR");
  const c = client();
  t.after(async () => { c.stop(); await shop.close(); });
  await c.init();

  const added = await c.call("watch_add", { url: shop.url, label: "Lamp", target_price: 40, currency: "EUR" });
  assert.match(added, /49\.00 EUR/, `watch_add lost the page scale:\n${added}`);
  assert.doesNotMatch(added, /\/home\/mcp/, "stdio may name its own directory, but not a hosted one");

  const manual = await c.call("price_add_manual", { url: shop.url, price: "38.5", currency: "EUR" });
  assert.match(manual, /38\.50 EUR/, `a typed 38.5 must print as 38.50:\n${manual}`);

  const hist = await c.call("price_history", { url: shop.url });
  const scales = new Set(priced(hist).map((p) => (p.split(".")[1] ?? "").length));
  assert.deepEqual([...scales], [2], `price_history printed more than one scale: ${priced(hist).join(", ")}`);
  assert.match(hist, /min 38\.50 \/ max 49\.00 EUR/, `min and max must agree on scale:\n${hist}`);

  const alerts = await c.call("alerts_pending", {});
  assert.match(alerts, /"current": "38\.50 EUR"/, `the alert restated the raw string:\n${alerts}`);
  assert.match(alerts, /"previous": "49\.00 EUR"/, alerts);
  const list = await c.call("watch_list", {});
  const listScales = new Set(priced(list).map((p) => (p.split(".")[1] ?? "").length));
  assert.deepEqual([...listScales], [2], `watch_list printed more than one scale: ${priced(list).join(", ")}`);
  // the target was typed as the number 40 and belongs to the same column as the prices
  assert.match(list, /"target": "40\.00 EUR"/, `the target kept its own scale:\n${list}`);
});

test("a whole-unit price is not given decimals it never had", async (t) => {
  const shop = await startShop("2980", "JPY");
  const c = client();
  t.after(async () => { c.stop(); await shop.close(); });
  await c.init();
  const added = await c.call("watch_add", { url: shop.url, label: "Yen thing" });
  assert.match(added, /2980 JPY/, `a JPY price has no minor unit to pad:\n${added}`);
  assert.doesNotMatch(added, /2980\.00/, added);
});

test("non-vacuity: the assertions above fail on the pre-fix behaviour", () => {
  // The old code printed the stored string and formatted min/max through
  // Number.isInteger(n) ? String(n) : n.toFixed(2).
  const oldMoney = (p, cur) => `${p} ${cur}`;
  const oldFmt = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(2));
  assert.notEqual(oldMoney("38.5", "EUR"), "38.50 EUR");
  assert.notEqual(`min ${oldFmt(38.5)} / max ${oldFmt(49)} EUR`, "min 38.50 / max 49.00 EUR");
  assert.notEqual(oldMoney("40", "EUR"), "40.00 EUR");
});
