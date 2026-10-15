// The server over real stdio JSON-RPC: initialize, tools/list, search, and a full assembly
// whose .docx is read back with the docx server's own engine, so "it wrote a file" is never
// the assertion. Then the free own-clause cap, and the same call passing in Pro.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readDocx, blockText } from "@theluckystrike/mcp-docx/lib";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-clauses-"));
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
    close: () => child.kill(),
  };
}

async function init(c) {
  const r = await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
  assert.ok(r.result?.serverInfo, "initialize failed");
  assert.equal(r.result.serverInfo.name, "mcp-clauses");
  c.notify("notifications/initialized", {});
}

const FIVE = ["scope-of-work", "payment-terms", "late-fees", "ip-assignment", "termination"];

test("clause_get refuses an ambiguous partial title with the candidate list; an exact match still wins", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);

  let r = await c.call("clause_add", {
    title: "Payment Terms (Retainer)", body: "Retainer text.", category: "payment",
  });
  assert.equal(r.isError, false, r.text);
  r = await c.call("clause_add", {
    title: "Payment Terms (Hourly)", body: "Hourly text.", category: "payment",
  });
  assert.equal(r.isError, false, r.text);

  // "Payment Terms (" is a substring of both new titles and an exact match of neither.
  r = await c.call("clause_get", { title: "Payment Terms (" });
  assert.equal(r.isError, true, "an ambiguous partial title must be refused, not silently resolved");
  assert.match(r.text, /matches more than one clause/);
  assert.match(r.text, /Payment Terms \(Retainer\)/);
  assert.match(r.text, /Payment Terms \(Hourly\)/);

  // The exact starter title still resolves outright, with no ambiguity check.
  r = await c.call("clause_get", { title: "Payment Terms" });
  assert.equal(r.isError, false, r.text);
  assert.equal(JSON.parse(r.text).id, "payment-terms");

  assert.deepEqual(c.bad, [], `non-JSON on stdout: ${c.bad.join(" | ")}`);
});

test("stdio: initialize, tools/list, search, assemble five clauses into a .docx", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);

  const tools = (await c.send("tools/list", {})).result.tools.map((x) => x.name).sort();
  for (const name of ["clause_add", "clause_delete", "clause_export", "clause_get", "clause_import",
    "clause_list", "clause_search", "clause_update", "contract_assemble", "license_activate",
    "license_status", "variables_list"]) {
    assert.ok(tools.includes(name), `tools/list is missing ${name}: ${tools.join(", ")}`);
  }
  const res = (await c.send("resources/list", {})).result.resources.map((r) => r.uri);
  assert.deepEqual(res, ["clauses://categories"]);
  const prompts = (await c.send("prompts/list", {})).result.prompts.map((p) => p.name);
  assert.deepEqual(prompts, ["draft_contract"]);

  // The starter set is there on the first call, with the not-legal-advice note.
  let r = await c.call("clause_list", {});
  let list = JSON.parse(r.text);
  assert.equal(list.count, 25);
  assert.equal(list.own, 0);

  r = await c.call("clause_get", { id: "late-fees" });
  const one = JSON.parse(r.text);
  assert.equal(one.note, "generic template, not legal advice");
  assert.ok(one.variables.includes("late_fee_percent"));

  // Ranked search.
  r = await c.call("clause_search", { query: "payment" });
  const hits = JSON.parse(r.text);
  assert.ok(hits.count >= 3, r.text);
  assert.equal(hits.results[0].id, "payment-terms", r.text);
  assert.ok(hits.results[0].score > hits.results[hits.results.length - 1].score);

  r = await c.call("variables_list", { clause_ids: FIVE });
  const vars = JSON.parse(r.text);
  for (const v of ["client", "fee", "late_fee_percent"]) assert.ok(vars.variables.includes(v), r.text);

  const categories = JSON.parse((await c.send("resources/read", { uri: "clauses://categories" })).result.contents[0].text);
  assert.equal(categories.total, 25);
  assert.equal(categories.categories[0].category, "scope", JSON.stringify(categories.categories));

  // Assemble five clauses into a .docx and read it back with the docx engine.
  r = await c.call("contract_assemble", {
    title: "Service Agreement",
    clause_ids: FIVE,
    client: "Beta Corp",
    values: { contractor: "Solo Dev", fee: "4500", currency: "EUR", payment_days: "14", project: "Checkout rebuild" },
  });
  assert.equal(r.isError, false, r.text);
  const out = JSON.parse(r.text);
  assert.ok(existsSync(out.path), out.path);
  assert.ok(out.path.endsWith(".docx"));
  assert.ok(statSync(out.path).size > 2000);
  assert.ok(out.unfilled.includes("late_fee_percent"), r.text);
  assert.ok(out.unfilled_prompts.includes("[late fee percent]"));

  const text = readDocx(readFileSync(out.path)).map(blockText).join("\n");
  assert.match(text, /Beta Corp/, "the client name is not in the document");
  assert.match(text, /not legal advice/i, "the disclaimer is not in the document");
  assert.match(text, /1\. Scope of Work/);
  assert.match(text, /5\. Termination/);
  assert.match(text, /4500 EUR/);
  assert.match(text, /\[late fee percent\]/, "an unfilled variable was not left as a bracketed prompt");
  assert.ok(!text.includes("{{"), "raw {{...}} survived into the document");

  // Markdown assembly is free too.
  const md = JSON.parse((await c.call("contract_assemble", { title: "Short form", clause_ids: ["notices"], format: "markdown" })).text);
  assert.ok(md.path.endsWith(".md"));
  assert.match(readFileSync(md.path, "utf8"), /not legal advice/i);

  assert.deepEqual(c.bad, [], "non-JSON on stdout");
});

test("free tier: the 11th own clause is refused, Pro takes it", async (t) => {
  const free = client();
  t.after(() => free.close());
  await init(free);

  for (let i = 1; i <= 10; i++) {
    const r = await free.call("clause_add", { title: `House rule ${i}`, body: `Rule ${i} for {{client}}.`, category: "general" });
    assert.equal(r.isError, false, r.text);
    assert.equal(JSON.parse(r.text).own_clauses, i);
  }
  const blocked = await free.call("clause_add", { title: "House rule 11", body: "One too many for {{client}}.", category: "general" });
  assert.equal(blocked.isError, false, "a gate must not be an error result");
  assert.match(blocked.text, /free tier holds 10 of your own clauses/i);
  assert.match(blocked.text, /mcp\.zovo\.one\/buy\/clauses/);
  assert.equal(JSON.parse((await free.call("clause_list", {})).text).own, 10);

  // Free tools stay free after the gate closes.
  const still = await free.call("clause_search", { query: "termination" });
  assert.equal(still.isError, false, still.text);
  // Pro-only surfaces refuse politely in the free tier.
  assert.match((await free.call("clause_search", { query: "fee", tags: ["payment"] })).text, /Pro feature/);
  assert.match((await free.call("clause_export", { path: join(free.home, "x.json"), format: "json" })).text, /Pro feature/);
  const mdOut = await free.call("clause_export", { path: join(free.home, "lib.md"), format: "markdown" });
  assert.match(mdOut.text, /Exported 35 clauses/, mdOut.text);

  // Free assembly stops at 8 clauses.
  const nine = ["scope-of-work", "payment-terms", "late-fees", "ip-assignment", "confidentiality",
    "termination", "liability-cap", "revisions", "expenses"];
  const capped = await free.call("contract_assemble", { title: "Long form", clause_ids: nine, format: "markdown" });
  assert.equal(capped.isError, false);
  assert.match(capped.text, /free tier assembles up to 8 clauses/i);

  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "clauses"], { encoding: "utf8" }).trim();
  assert.match(key, /^MCPL1\./);
  const pro = client({ MCP_LICENSE_KEY: key });
  t.after(() => pro.close());
  await init(pro);
  assert.match((await pro.call("license_status", {})).text, /"tier": "pro"/);

  for (let i = 1; i <= 11; i++) {
    const r = await pro.call("clause_add", { title: `House rule ${i}`, body: `Rule ${i} for {{client}}.`, category: "general" });
    assert.equal(r.isError, false, `pro clause ${i} was blocked: ${r.text}`);
    assert.equal(JSON.parse(r.text).own_clauses, i);
  }
  const long = await pro.call("contract_assemble", { title: "Long form", clause_ids: nine, format: "markdown" });
  assert.equal(long.isError, false, long.text);
  assert.equal(JSON.parse(long.text).clauses.length, 9);

  // Pro keeps versions, and filters work.
  await pro.call("clause_update", { id: "House rule 1", body: "Rewritten for {{client}}." });
  assert.equal(JSON.parse((await pro.call("clause_get", { id: "house-rule-1" })).text).versions, 1);
  const filtered = JSON.parse((await pro.call("clause_search", { query: "fee", tags: ["payment"] })).text);
  assert.ok(filtered.results.every((h) => h.tags.includes("payment")), JSON.stringify(filtered));
});

test("import round trip through the server, markdown free and json in Pro", async (t) => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "clauses"], { encoding: "utf8" }).trim();
  const c = client({ MCP_LICENSE_KEY: key });
  t.after(() => c.close());
  await init(c);

  const md = join(c.home, "in.md");
  writeFileSync(md, ["## Retainer", "category: payment", "tags: retainer", "", "The client pays {{monthly_fee}} monthly.", ""].join("\n"));
  let r = await c.call("clause_import", { path: md });
  assert.equal(JSON.parse(r.text).added, 1, r.text);
  assert.deepEqual(JSON.parse((await c.call("clause_get", { id: "retainer" })).text).variables, ["monthly_fee"]);
  // A second import without overwrite skips.
  assert.equal(JSON.parse((await c.call("clause_import", { path: md })).text).skipped, 1);

  const jsonOut = join(c.home, "out.json");
  assert.match((await c.call("clause_export", { path: jsonOut, format: "json" })).text, /Exported 26 clauses/);
  const round = client({ MCP_LICENSE_KEY: key });
  t.after(() => round.close());
  await init(round);
  r = await round.call("clause_import", { path: jsonOut, overwrite: true });
  const imported = JSON.parse(r.text);
  assert.equal(imported.replaced + imported.added, 26, r.text);
  assert.equal(JSON.parse((await round.call("clause_get", { title: "Retainer" })).text).body, "The client pays {{monthly_fee}} monthly.");
});
