// Adversarial probes: hostile arguments, hostile file paths, hostile content, and the
// invariants a clause library must not lose (the not-legal-advice note, JSON-RPC-only
// stdout, no network). Every assertion reads the artefact back, never the answer alone.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const SRC = join(here, "..", "src");
const REPO = join(here, "..", "..", "..");

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-clauses-adv-"));
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
      if (msg.id !== undefined && pending.has(msg.id)) { pending.get(msg.id).resolve(msg); pending.delete(msg.id); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const my = ++id;
    pending.set(my, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(my)) { pending.delete(my); reject(new Error(`timeout on ${method}`)); } }, 30000);
    t.unref();
  });
  return {
    home, bad, send,
    notify: (m, p) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n"),
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (r.error) return { text: `RPC ${r.error.message}`, isError: true };
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

async function init(c) {
  const r = await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "adv", version: "0" } });
  assert.ok(r.result?.serverInfo);
  c.notify("notifications/initialized", {});
}

const xml = (docx) => execFileSync("unzip", ["-p", docx, "word/document.xml"], { encoding: "utf8", maxBuffer: 1 << 28 });

test("hostile arguments are refused by the schema, not by a crash", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  assert.match((await c.call("clause_add", {})).text, /Required at title/);
  assert.match((await c.call("clause_add", { title: "X", body: 12, category: "payment" })).text, /Expected string, received number/);
  assert.match((await c.call("contract_assemble", { title: "T" })).text, /pass clause_ids or categories/);
  assert.match((await c.call("contract_assemble", { title: "T", clause_ids: ["nope-xyz"] })).text, /no clause matches "nope-xyz"/);
  assert.match((await c.call("variables_list", { clause_ids: ["nope-xyz"] })).text, /no clause matches/);
  // D-R80: this probe used to assert the vague "already exists", which was the defect
  // asserted - "Payment Terms" is a STARTER clause, and saying so is the whole answer.
  assert.match((await c.call("clause_add", { title: "Payment Terms", body: "dup", category: "payment" })).text, /STARTER clause \(payment-terms\)/);
  assert.equal(c.bad.length, 0, `non-JSON on stdout: ${c.bad.join(" | ")}`);
});

test("a 10 000 character category is capped, a 1 MB body still assembles", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  const cat = JSON.parse((await c.call("clause_add", { title: "Cat10k", body: "b {{a}}", category: "c".repeat(10000) })).text);
  assert.ok(cat.added.category.length <= 40, `category kept ${cat.added.category.length} characters`);
  const big = await c.call("clause_add", { title: "Big One", body: "lorem ipsum ".repeat(90000) + " {{fee}}", category: "scope" });
  assert.equal(big.isError, false, big.text);
  const out = join(c.home, "big.docx");
  const r = JSON.parse((await c.call("contract_assemble", { title: "Big Doc", clause_ids: ["big-one"], values: { fee: "1" }, out_path: out })).text);
  assert.equal(r.path, out);
  assert.ok(existsSync(out));
});

test("HTML and script in a clause body reach the .docx as character data", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("clause_add", { title: "Script Clause", body: "<script>alert(1)</script> & <b onerror=x>{{client}}</b> ]]>", category: "general" });
  const out = join(c.home, "script.docx");
  await c.call("contract_assemble", { title: "Script Doc", clause_ids: ["script-clause"], client: "Acme <script>", out_path: out });
  const doc = xml(out);
  assert.equal(doc.includes("<script"), false, "raw <script survived into document.xml");
  assert.match(doc, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  const md = join(c.home, "script.md");
  await c.call("contract_assemble", { title: "Script Doc", clause_ids: ["script-clause"], format: "markdown", out_path: md });
  assert.match(readFileSync(md, "utf8"), /<script>alert\(1\)<\/script>/); // a .md file keeps its text verbatim
});

test("variables with regex metacharacters and nested braces fill without corrupting the text", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("clause_add", { title: "Meta Vars", body: "A {{a.b-c}} B {{{nested}}} C $1 ^(x)$ [z] D {{ spaced }}", category: "general" });
  const out = join(c.home, "meta.docx");
  const r = JSON.parse((await c.call("contract_assemble", { title: "Meta Doc", clause_ids: ["meta-vars"], values: { "a.b-c": "$1 & <x>", nested: "NV", spaced: "SP" }, out_path: out })).text);
  assert.deepEqual(r.filled.sort(), ["a.b-c", "nested", "spaced"]);
  assert.deepEqual(r.unfilled, []);
  const doc = xml(out);
  assert.ok(doc.includes("$1 &amp; &lt;x&gt;"), "the literal $1 replacement was eaten by the replacer");
  assert.equal(doc.includes("{{"), false, "an unfilled placeholder survived into the document");
});

test("an existing out_path is never overwritten without overwrite: true", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  const out = join(c.home, "keep.docx");
  await c.call("contract_assemble", { title: "First", clause_ids: ["scope-of-work"], out_path: out });
  const first = readFileSync(out);
  const refused = await c.call("contract_assemble", { title: "Second", clause_ids: ["late-fees"], out_path: out });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /already exists and nothing was written.*overwrite: true/s);
  assert.deepEqual(readFileSync(out), first, "the first document was destroyed");
  const forced = await c.call("contract_assemble", { title: "Second", clause_ids: ["late-fees"], out_path: out, overwrite: true });
  assert.equal(forced.isError, false, forced.text);
  assert.notDeepEqual(readFileSync(out), first);
});

test("clause_export refuses an existing destination and imports report a missing file", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  const dest = join(c.home, "lib.md");
  writeFileSync(dest, "ORIGINAL KEEP\n");
  const refused = await c.call("clause_export", { path: dest, format: "markdown" });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /already exists and nothing was written/);
  assert.equal(readFileSync(dest, "utf8"), "ORIGINAL KEEP\n");
  const forced = await c.call("clause_export", { path: dest, format: "markdown", overwrite: true });
  assert.equal(forced.isError, false, forced.text);
  assert.match(readFileSync(dest, "utf8"), /^# Clause library/);
  // A path that does not exist is reported as such, not as a Pro upsell.
  assert.match((await c.call("clause_import", { path: join(c.home, "gone.json") })).text, /no such file/);
  writeFileSync(join(c.home, "bad.md"), "no headings here at all\n");
  assert.match((await c.call("clause_import", { path: join(c.home, "bad.md") })).text, /no clauses found/);
});

test("a JSON import carrying prototype keys pollutes nothing", async (t) => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "clauses"], { encoding: "utf8" }).trim();
  const c = client({ MCP_LICENSE_KEY: key });
  t.after(() => c.close());
  await init(c);
  const f = join(c.home, "proto.json");
  writeFileSync(f, JSON.stringify([
    { title: "Proto", body: "b {{x}}", __proto__: { polluted: "yes" }, category: "general" },
    { title: "Proto2", body: "c", constructor: { prototype: { p2: "y" } }, category: "__proto__" },
  ]));
  const r = JSON.parse((await c.call("clause_import", { path: f })).text);
  assert.equal(r.added, 2);
  assert.equal({}.polluted, undefined);
  assert.equal({}.p2, undefined);
  assert.match((await c.call("clause_import", { path: join(c.home, "gone.json") })).text, /no such file/);
});

test("500 clauses stay listable, searchable and assemblable", async (t) => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "clauses"], { encoding: "utf8" }).trim();
  const c = client({ MCP_LICENSE_KEY: key });
  t.after(() => c.close());
  await init(c);
  for (let i = 0; i < 500; i++) {
    const r = await c.call("clause_add", { title: `Bulk clause ${i}`, body: `Bulk ${i} for {{client}} at {{fee}}.`, category: "general" });
    assert.equal(r.isError, false, `clause ${i}: ${r.text}`);
  }
  const list = JSON.parse((await c.call("clause_list", {})).text);
  assert.equal(list.count, 525);
  assert.equal(new Set(list.clauses.map((x) => x.id)).size, 525, "duplicate ids at 525 clauses");
  const hits = JSON.parse((await c.call("clause_search", { query: "payment late" })).text);
  assert.equal(hits.results[0].id, "late-fees");
  const out = join(c.home, "mega.docx");
  const mega = await c.call("contract_assemble", {
    title: "Mega", clause_ids: Array.from({ length: 60 }, (_, i) => `bulk-clause-${i}`),
    values: { client: "C", fee: "1" }, out_path: out,
  });
  assert.equal(mega.isError, false, mega.text);
  assert.equal(xml(out).includes("{{"), false);
});

test("starter set: 25 clauses, every one carries the not-legal-advice note", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  const list = JSON.parse((await c.call("clause_list", {})).text);
  assert.equal(list.count, 25);
  assert.equal(list.own, 0);
  let withVariables = 0;
  for (const s of list.clauses) {
    const full = JSON.parse((await c.call("clause_get", { id: s.id })).text);
    assert.equal(full.note, "generic template, not legal advice", `${s.id} has no note`);
    assert.ok(full.starter);
    if (full.variables.length) withVariables++;
  }
  // Only the two pure boilerplate clauses (entire agreement, severability) carry no variable.
  assert.equal(withVariables, 23);
  assert.equal(c.bad.length, 0);
});

test("stdout is JSON-RPC only and the server makes no network call", () => {
  let hits = "";
  try {
    hits = execFileSync("grep", ["-rlE", "fetch\\(|https?://|node:http|node:net|node:dns", SRC], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (e) {
    if (e.status !== 1) throw e;            // grep exits 1 on no match, which is the pass
  }
  const grep = hits.split("\n").filter(Boolean);
  assert.deepEqual(grep, [], `network-shaped references in src: ${grep.join(", ")}`);
});
