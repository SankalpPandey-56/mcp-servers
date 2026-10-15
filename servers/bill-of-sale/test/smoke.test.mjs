// The server over real stdio JSON-RPC: initialize, tools/list, and a full sale lifecycle --
// create, get, update, render (draft watermark), finalize, render (signing copy), the
// refusal of edits after finalize, summary, delete -- then the free-tier caps on drafts and
// finalized documents, and the same calls passing in Pro.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-bill-of-sale-"));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), MCP_LICENSE_KEY: "", ...env },
  });
  child.stderr.resume();
  let buf = "";
  const bad = [];
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { bad.push(line); continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { const r = pending.get(msg.id); pending.delete(msg.id); r.resolve(msg); }
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
    home, bad, send,
    notify: (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n"),
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => { child.kill(); try { rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ } },
  };
}

async function init(c) {
  const r = await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  assert.ok(r.result?.serverInfo, "initialize failed");
  assert.equal(r.result.serverInfo.name, "mcp-bill-of-sale");
  c.notify("notifications/initialized", {});
}

const VEHICLE = {
  buyer_name: "Jane Kowalska",
  buyer_address: "ul. Piękna 12, 00-549 Warszawa",
  seller_name: "Mike Errington",
  item_description: "2019 Honda Civic 1.5 petrol, grey",
  item_category: "vehicle",
  vin: "SHHFC1340KU203456",
  condition: "used, good working order",
  price_minor: 6850000,
  currency: "PLN",
  date: "2026-09-01",
  notes: "Two keys and the service book included.",
};

test("stdio: initialize, tools/list, and the full sale lifecycle", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);

  const tools = (await c.send("tools/list", {})).result.tools.map((x) => x.name).sort();
  for (const name of ["license_activate", "license_status", "sale_create", "sale_delete",
    "sale_finalize", "sale_get", "sale_list", "sale_render", "sale_summary", "sale_update"]) {
    assert.ok(tools.includes(name), `tools/list is missing ${name}: ${tools.join(", ")}`);
  }

  // Record the sale.
  let r = await c.call("sale_create", VEHICLE);
  assert.equal(r.isError, false, r.text);
  const created = JSON.parse(r.text);
  assert.match(created.recorded.id, /^BOS-2026-\d{4}$/);
  assert.equal(created.recorded.status, "draft");
  assert.equal(created.recorded.price, "68,500.00 PLN");
  assert.equal(created.recorded.as_is, true);
  const id = created.recorded.id;

  // A byte-identical repeat is refused, and allowed with duplicate_ok.
  r = await c.call("sale_create", VEHICLE);
  assert.equal(r.isError, true);
  assert.match(r.text, /is already this sale/);
  assert.match(r.text, new RegExp(id));

  // Read it back, then change the price and add a warranty.
  r = await c.call("sale_get", { sale: id });
  assert.equal(JSON.parse(r.text).buyer.name, "Jane Kowalska");
  r = await c.call("sale_update", { sale: id, price_minor: 6600000, warranty: "The seller warrants the engine for 30 days from the sale date." });
  assert.equal(r.isError, false, r.text);
  assert.equal(JSON.parse(r.text).updated.price, "66,000.00 PLN");

  // Render the draft: files on disk, signature lines, DRAFT watermark.
  r = await c.call("sale_render", { sale: id, format: "both", out_path: join(c.home, "doc", "sale") });
  assert.equal(r.isError, false, r.text);
  const rendered = JSON.parse(r.text);
  assert.equal(rendered.files.length, 2);
  const mdPath = rendered.files.find((f) => f.format === "markdown").path;
  const htmlPath = rendered.files.find((f) => f.format === "html").path;
  assert.ok(existsSync(mdPath), mdPath);
  assert.ok(existsSync(htmlPath), htmlPath);
  const md = readFileSync(mdPath, "utf8");
  assert.match(md, /DRAFT -- NOT FINALIZED/);
  assert.match(md, /SHHFC1340KU203456/);
  assert.match(md, /66,000\.00 PLN/);
  assert.match(md, /Signature \| _+/);
  const html = readFileSync(htmlPath, "utf8");
  assert.match(html, /class="watermark">DRAFT</);
  assert.match(html, /warrants the engine for 30 days/);
  assert.match(html, /Jane Kowalska/);
  assert.ok(!html.includes("http://") && !html.includes("https://") || html.includes("w3.org"), "the HTML must be self-contained");

  // Finalize, and the document freezes: no edit, no second finalize, no watermark.
  r = await c.call("sale_finalize", { sale: id });
  assert.equal(r.isError, false, r.text);
  assert.equal(JSON.parse(r.text).finalized.status, "final");
  r = await c.call("sale_update", { sale: id, price_minor: 1 });
  assert.equal(r.isError, true);
  assert.match(r.text, /is finalized and cannot be edited/);
  r = await c.call("sale_finalize", { sale: id });
  assert.equal(r.isError, true);
  assert.match(r.text, /was already finalized/);
  r = await c.call("sale_render", { sale: id, format: "html" });
  const signing = JSON.parse(r.text);
  assert.ok(!signing.html.includes("watermark"), "the signing copy must not carry the watermark");
  assert.match(signing.html, /66,000\.00 PLN/);

  // List and summary agree.
  r = await c.call("sale_list", {});
  const list = JSON.parse(r.text);
  assert.equal(list.total, 1);
  assert.equal(list.finalized, 1);
  assert.equal(list.sales[0].id, id);
  r = await c.call("sale_summary", {});
  const sum = JSON.parse(r.text);
  assert.equal(sum.finalized, 1);
  assert.equal(sum.totals[0].currency, "PLN");
  assert.equal(sum.totals[0].finalized_total, "66,000.00 PLN");

  // A finalized document is guarded on delete; with the confirm it goes.
  r = await c.call("sale_delete", { sale: id });
  assert.equal(r.isError, true);
  assert.match(r.text, /confirm_finalized true/);
  r = await c.call("sale_delete", { sale: id, confirm_finalized: true });
  assert.equal(r.isError, false, r.text);
  assert.equal(JSON.parse((await c.call("sale_list", {})).text).total, 0);
  r = await c.call("sale_get", { sale: id });
  assert.equal(r.isError, true);
  assert.match(r.text, /no bill of sale has the id/);

  assert.deepEqual(c.bad, [], `non-JSON on stdout: ${c.bad.join(" | ")}`);
});

test("free tier: the 11th draft and the 6th finalized document are refused, Pro takes both", async (t) => {
  const free = client();
  t.after(() => free.close());
  await init(free);

  for (let i = 1; i <= 10; i++) {
    const r = await free.call("sale_create", {
      buyer_name: `Buyer ${i}`, seller_name: "Seller", item_description: `Lot ${i}: used office chair`,
      price_minor: 5000 + i, currency: "USD", date: "2026-09-02",
    });
    assert.equal(r.isError, false, r.text);
  }
  let r = await free.call("sale_create", {
    buyer_name: "Buyer 11", seller_name: "Seller", item_description: "Lot 11: used office chair",
    price_minor: 5011, currency: "USD", date: "2026-09-02",
  });
  assert.equal(r.isError, true);
  assert.match(r.text, /free tier holds 10 drafts/);
  assert.match(r.text, /mcp\.zovo\.one\/buy\/bill-of-sale/);

  // Five finalize, the sixth is refused, and rendering a draft is still free.
  const list = JSON.parse((await free.call("sale_list", {})).text);
  for (const row of list.sales.slice(0, 5)) {
    r = await free.call("sale_finalize", { sale: row.id });
    assert.equal(r.isError, false, r.text);
  }
  r = await free.call("sale_finalize", { sale: list.sales[5].id });
  assert.equal(r.isError, true);
  assert.match(r.text, /free tier finalizes 5 documents/);
  assert.match(r.text, /mcp\.zovo\.one\/buy\/bill-of-sale/);
  r = await free.call("sale_render", { sale: list.sales[5].id, format: "markdown" });
  assert.equal(r.isError, false, "rendering a draft stays free");

  // license_status explains the tier; a bad key is refused unsaved.
  r = await free.call("license_status", {});
  assert.match(r.text, /"tier": "free"/);
  r = await free.call("license_activate", { key: "MCPL1.not.a.key" });
  assert.equal(r.isError, true);

  // Pro removes both caps.
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "bill-of-sale"], { encoding: "utf8" }).trim();
  assert.match(key, /^MCPL1\./);
  const pro = client({ MCP_LICENSE_KEY: key });
  t.after(() => pro.close());
  await init(pro);
  assert.match((await pro.call("license_status", {})).text, /"tier": "pro"/);
  for (let i = 1; i <= 12; i++) {
    const r2 = await pro.call("sale_create", {
      buyer_name: `Buyer ${i}`, seller_name: "Seller", item_description: `Lot ${i}: used office chair`,
      price_minor: 5000 + i, currency: "USD", date: "2026-09-02",
    });
    assert.equal(r2.isError, false, `pro draft ${i} was blocked: ${r2.text}`);
  }
  const proList = JSON.parse((await pro.call("sale_list", {})).text);
  assert.equal(proList.total, 12);
  for (const row of proList.sales) {
    const r3 = await pro.call("sale_finalize", { sale: row.id });
    assert.equal(r3.isError, false, `pro finalize ${row.id} was blocked: ${r3.text}`);
  }
  const sum = JSON.parse((await pro.call("sale_summary", {})).text);
  assert.equal(sum.tier, "pro");
  assert.equal(sum.finalized, 12);
  assert.equal(sum.totals[0].finalized_total_minor, proList.sales.reduce((x, s) => x + s.price_minor, 0));
});
