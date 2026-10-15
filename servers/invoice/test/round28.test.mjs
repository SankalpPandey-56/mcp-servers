// Round 28, docs/DIST_R19_RESULT.md finding 3.
//
// D-R97: client_add accepted a byte-identical record as often as it was called and no
// tool could remove one, so the only way back from a wrong or duplicated record was a
// Pro key. client_add now refuses an exact match by id, and client_delete removes a
// client nothing references. A client that IS referenced is refused with the document
// named, so an issued invoice can never lose the party it bills.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function client(home, env = {}) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), MCP_LICENSE_KEY: "", ...env },
  });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const r = pending.get(m.id);
      if (r) { pending.delete(m.id); r(m); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 15000);
    t.unref();
  });
  return {
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r28", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
    },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (!r.result) return { text: JSON.stringify(r.error), isError: true };
      return { text: r.result.content.map((x) => x.text).join("\n"), isError: r.result.isError === true };
    },
    close() { child.kill(); },
  };
}

const ACME = {
  name: "Acme GmbH", address: "Hauptstr. 5\nBerlin", email: "ap@acme.example", vat_id: "DE999999999",
};

test("D-R97: client_add refuses an identical record, names the stored id and the tool that removes it", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-invoice-r28a-"));
  try {
    const c = client(home);
    await c.init();
    try {
      const first = await c.call("client_add", ACME);
      assert.ok(!first.isError, first.text);
      const id = first.text.match(/\(([0-9a-f]{8})\)/)[1];

      // Byte-identical.
      const again = await c.call("client_add", ACME);
      assert.equal(again.isError, true, `a second identical client_add must be refused: ${again.text}`);
      assert.match(again.text, new RegExp(id), `the refusal must name the existing client id: ${again.text}`);
      assert.match(again.text, /Nothing was written/i, again.text);
      assert.match(again.text, /client_delete/, `the refusal must name the tool that removes it: ${again.text}`);

      // Same record, spelled differently: padding, case and tax-id punctuation only.
      const sloppy = await c.call("client_add", {
        name: "  acme  gmbh ", address: "hauptstr. 5\n  Berlin  ", email: "AP@Acme.Example", vat_id: "DE 999-999.999",
      });
      assert.equal(sloppy.isError, true, `a normalised-identical record must be refused too: ${sloppy.text}`);
      assert.match(sloppy.text, new RegExp(id), sloppy.text);

      // Nothing was stored twice.
      const list = await c.call("client_list", {});
      const clients = JSON.parse(list.text);
      assert.equal(clients.length, 1, `exactly one client must exist: ${list.text}`);

      // A field that differs is still an update, not a refusal.
      const upd = await c.call("client_add", { ...ACME, email: "billing@acme.example" });
      assert.ok(!upd.isError, upd.text);
      assert.match(upd.text, /Updated client Acme GmbH/, upd.text);
      assert.equal(JSON.parse((await c.call("client_list", {})).text).length, 1);
    } finally { c.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("D-R97: client_delete removes an unused client and frees the record for reuse", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-invoice-r28b-"));
  try {
    const c = client(home);
    await c.init();
    try {
      const first = await c.call("client_add", ACME);
      const id = first.text.match(/\(([0-9a-f]{8})\)/)[1];

      const del = await c.call("client_delete", { client: id });
      assert.ok(!del.isError, del.text);
      assert.match(del.text, new RegExp(`Deleted client Acme GmbH \\(${id}\\)`), del.text);
      assert.match(del.text, /0 clients left/, del.text);

      const list = await c.call("client_list", {});
      assert.match(list.text, /No clients yet/, list.text);

      // The slot is genuinely free: the same record can be stored again, with a new id,
      // and it is no longer refused as a duplicate.
      const again = await c.call("client_add", ACME);
      assert.ok(!again.isError, `after client_delete the same record must be storable again: ${again.text}`);
      assert.match(again.text, /Added client Acme GmbH/, again.text);
      const newId = again.text.match(/\(([0-9a-f]{8})\)/)[1];
      assert.notEqual(newId, id, "a re-added client gets a fresh id");
      assert.equal(JSON.parse((await c.call("client_list", {})).text).length, 1);

      // Deleting a name that was never stored says so and deletes nothing.
      const missing = await c.call("client_delete", { client: "Nobody Ltd" });
      assert.equal(missing.isError, true, missing.text);
      assert.match(missing.text, /no client matches "Nobody Ltd"/, missing.text);
      assert.equal(JSON.parse((await c.call("client_list", {})).text).length, 1);
    } finally { c.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("D-R97: client_delete refuses a client with dependents and names the invoice", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-invoice-r28c-"));
  try {
    const c = client(home);
    await c.init();
    let number;
    try {
      await c.call("business_set", { name: "Lucky Strike Software", default_currency: "EUR" });
      await c.call("client_add", { name: "Nova Labs", address: "ul. Testowa 1\nWarsaw" });
      const created = await c.call("invoice_create", {
        client: "Nova Labs",
        items: [{ description: "Consulting", quantity: 1, unit_price: 900, tax_rate: 0 }],
        issue_date: "2026-03-02",
      });
      assert.ok(!created.isError, created.text);
      number = created.text.match(/(INV-\d{4}-\d{4})/)[1];

      const del = await c.call("client_delete", { client: "Nova Labs" });
      assert.equal(del.isError, true, `a client with an invoice must not be deletable: ${del.text}`);
      assert.match(del.text, new RegExp(`invoice ${number}`), `the refusal must name the dependent invoice: ${del.text}`);
      assert.match(del.text, /Nothing was deleted/, del.text);

      // The client is still there, and so is the invoice.
      assert.equal(JSON.parse((await c.call("client_list", {})).text).length, 1);
      const still = await c.call("invoice_get", { number });
      assert.ok(!still.isError, still.text);
    } finally { c.close(); }

    // A quote in the quotes server's own store is a dependent too, even though this
    // server never writes that file.
    const quotesDir = join(home, "data", "mcp-servers", "quotes");
    mkdirSync(quotesDir, { recursive: true });
    writeFileSync(join(quotesDir, "quotes.json"), JSON.stringify([{
      id: "Q-2026-0007", client: { name: "Orion Media" }, issue_date: "2026-03-02",
      valid_until: "2026-04-01", validity_days: 30, currency: "EUR", decimals: 2, lines: [],
      subtotal_minor: 0, discount_percent: 0, discount_minor: 0, net_minor: 0,
      tax_lines: [], tax_minor: 0, total_minor: 0, status: "sent",
      created: new Date().toISOString(), branded: true,
    }]));

    const c2 = client(home);
    await c2.init();
    try {
      const add = await c2.call("client_add", { name: "Orion Media" });
      assert.ok(!add.isError, add.text);
      const del = await c2.call("client_delete", { client: "Orion Media" });
      assert.equal(del.isError, true, `a client with a quote must not be deletable: ${del.text}`);
      assert.match(del.text, /quote Q-2026-0007/, del.text);
    } finally { c2.close(); }
  } finally { rmSync(home, { recursive: true, force: true }); }
});
