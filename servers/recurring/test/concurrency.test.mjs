// Two recurring processes on one data dir must not double-bill.
// invoice_generate_due reads the history, allocates invoice numbers from the invoice
// server's counter and writes both stores; without the recurring -> invoice lock order
// two simultaneous runs produce two invoices for the same period, or two invoices with
// the same number.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function client(dataHome, tag) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dataHome, "cfg"), MCP_LICENSE_KEY: "" },
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
      const msg = JSON.parse(line);
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res, rej) => {
    const mid = ++id;
    pending.set(mid, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 60000);
    t.unref();
  });
  return {
    tag, send,
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "conc", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: (name, args) => send("tools/call", { name, arguments: args ?? {} }),
    close() { child.kill(); },
  };
}

test("two processes generating due invoices at once: no duplicate number, no duplicate period", async () => {
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-rec-conc-"));
  const dataHome = join(sandbox, "data");
  const a = client(dataHome, "A");
  const b = client(dataHome, "B");
  try {
    await Promise.all([a.init(), b.init()]);
    // Three monthly schedules, 12 periods each: 36 invoices are due in total.
    for (const [i, name] of ["Alpha", "Beta", "Gamma"].entries()) {
      const r = await a.call("schedule_create", {
        client: name,
        items: [{ description: "Retainer", quantity: 1, unit_price: 100 * (i + 1) }],
        currency: "EUR", every: "monthly", start_date: "2026-01-15", end_date: "2026-12-15",
      });
      assert.ok(r.result && r.result.isError !== true, JSON.stringify(r));
      assert.match(r.result.content[0].text, /Created schedule/);
    }

    const results = await Promise.all([
      a.call("invoice_generate_due", { as_of: "2026-12-31" }),
      b.call("invoice_generate_due", { as_of: "2026-12-31" }),
    ]);
    for (const r of results) {
      assert.ok(r.result, `tools/call failed: ${JSON.stringify(r.error)}`);
      assert.notEqual(r.result.isError, true, `tool error: ${r.result.content?.[0]?.text}`);
    }
    const createdCounts = results.map((r) => Number(/created (\d+) invoice/.exec(r.result.content[0].text)[1]));
    assert.equal(createdCounts[0] + createdCounts[1], 36,
      `the two runs must create 36 invoices between them, got ${createdCounts.join(" + ")}`);

    const invoices = JSON.parse(readFileSync(join(dataHome, "mcp-servers", "invoice", "invoices.json"), "utf8"));
    assert.equal(invoices.length, 36, `expected 36 invoices, got ${invoices.length}`);
    assert.equal(new Set(invoices.map((i) => i.number)).size, 36, "invoice numbers must be unique");

    const history = JSON.parse(readFileSync(join(dataHome, "mcp-servers", "recurring", "history.json"), "utf8"));
    assert.equal(history.length, 36, `expected 36 history rows, got ${history.length}`);
    const keys = history.map((h) => `${h.schedule_id}|${h.period}`);
    assert.equal(new Set(keys).size, 36, "one invoice per schedule per period");
    assert.equal(new Set(history.map((h) => h.invoice_number)).size, 36, "history invoice numbers must be unique");

    // A third run after both must find nothing left to do.
    const third = await a.call("invoice_generate_due", { as_of: "2026-12-31" });
    assert.match(third.result.content[0].text, /created 0 invoices, skipped 36/);
  } finally {
    a.close(); b.close();
    try { rmSync(sandbox, { recursive: true, force: true }); } catch {}
  }
});
