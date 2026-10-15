// Two processes, one data dir. The risk is the id counter, not the quote list: a lost
// row shows up in a count, a REISSUED id (two different quotes both called Q-2026-0007,
// one of them already emailed to a client) does not.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, REPO } from "./harness.mjs";

const PRO = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "quotes"], { encoding: "utf8" }).trim();

test("40 quotes created by two processes leave 40 quotes and 40 unique ids", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "mcp-quotes-conc-"));
  const a = client({ MCP_LICENSE_KEY: PRO }, home);
  const b = client({ MCP_LICENSE_KEY: PRO }, home);
  t.after(() => { a.kill(); b.close(); });
  await Promise.all([a.init(), b.init()]);

  const make = (c, i) => c.json("quote_create", {
    client: `Client ${i}`, currency: "EUR",
    items: [{ description: "Work", quantity: 1, unit_price_minor: 10000 + i }],
    issue_date: "2026-03-01",
  });
  const jobs = [];
  for (let i = 0; i < 20; i++) { jobs.push(make(a, i)); jobs.push(make(b, 100 + i)); }
  const made = await Promise.all(jobs);

  const stored = JSON.parse(readFileSync(join(home, "data", "mcp-servers", "quotes", "quotes.json"), "utf8"));
  assert.equal(stored.length, 40, "a lost write means the lock did not hold");
  const ids = new Set(stored.map((q) => q.id));
  assert.equal(ids.size, 40, "a reissued id is a quote a client has already seen");
  assert.deepEqual([...ids].sort(), made.map((r) => r.created.id).sort());
  const counter = JSON.parse(readFileSync(join(home, "data", "mcp-servers", "quotes", "counter.json"), "utf8"));
  assert.equal(counter["Q-2026"], 40);
});
