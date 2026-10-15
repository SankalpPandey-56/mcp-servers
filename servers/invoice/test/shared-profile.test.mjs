// D-R31: ONE business profile for the whole suite. The profile is set through invoice and
// then read back by docx, expense-tracker and recurring, each in its OWN process, sharing
// only XDG_DATA_HOME - exactly the way the office-suite bundle runs them.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SERVERS = join(here, "..", "..");

function client(server, home) {
  const child = spawn(process.execPath, [join(SERVERS, server, "dist", "index.js")], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), MCP_LICENSE_KEY: "" },
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
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    const to = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method} (${server})`)); } }, 20000);
    to.unref();
  });
  return {
    async init() {
      await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `${server} ${name}: ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

async function withServer(server, home, fn) {
  const c = client(server, home);
  try { await c.init(); return await fn(c); } finally { c.close(); }
}

test("D-R31: a profile set through invoice is read by docx, expense-tracker and recurring in separate processes", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-shared-profile-"));

  await withServer("invoice", home, async (c) => {
    const r = await c.call("business_set", {
      name: "Lucky Strike Software", address: "Warsaw, Poland", vat_id: "PL1234567890",
      default_currency: "EUR", default_tax_rate: 23, payment_terms_days: 14,
      timezone: "Europe/Warsaw",
    });
    assert.ok(!r.isError, r.text);
  });

  // The shared file itself: one profile, in one place, for the whole suite.
  const shared = join(home, "data", "mcp-servers", "profile", "business.json");
  assert.ok(existsSync(shared), `shared profile not written to ${shared}`);
  const p = JSON.parse(readFileSync(shared, "utf8"));
  assert.equal(p.name, "Lucky Strike Software");
  assert.equal(p.default_tax_rate, 23);
  assert.equal(p.default_currency, "EUR");
  assert.equal(p.timezone, "Europe/Warsaw");
  assert.equal(p.email, undefined, "no email was given, so none may be stored (D-R40)");

  // docx: the letterhead is there without a second business_set, so proposal_create runs.
  await withServer("docx", home, async (c) => {
    const out = join(home, "proposal.docx");
    const r = await c.call("proposal_create", {
      client: "Nova Labs", project_title: "API redesign", summary: "Redesign the public API.",
      scope: ["Audit"], deliverables: ["OpenAPI spec"], timeline: [{ phase: "Audit", duration: "2 weeks" }],
      price: { amount: 6000, currency: "EUR", terms: "50% on signature" }, out_path: out,
    });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /PROP-\d{4}-0001/, r.text);
    assert.match(r.text, /\[add: email\]/, "a missing email must be reported, not invented (D-R40)");
  });

  // expense-tracker: the 23% stated once at onboarding splits a receipt with no vat_rate.
  await withServer("expense-tracker", home, async (c) => {
    const r = await c.call("expense_add", { amount: 61.5, currency: "EUR", merchant: "Adobe" });
    assert.ok(!r.isError, r.text);
    assert.match(r.text, /Net EUR 50\.00, VAT EUR 11\.50 at 23%/, r.text);
    assert.match(r.text, /business profile/, "the response must name the source of the rate (D-R34)");
  });

  // recurring: the issuer and the tax default come from the same profile.
  await withServer("recurring", home, async (c) => {
    const r = await c.call("schedule_create", {
      client: "Nova Labs", items: [{ description: "Retainer", quantity: 20, unit_price: 90 }],
      every: "monthly", start_date: "2026-10-01",
      tax_note: "Reverse charge: VAT accounted for by the recipient.",
    });
    assert.ok(!r.isError, r.text);
    assert.doesNotMatch(r.text, /No business profile yet/, r.text);
    assert.match(r.text, /"currency": "EUR"/, r.text);
  });
});
