// Round-10 fix (docs/USER_VALUE_R10.md):
// D-R47 - proposal_create's summary, scope, deliverables and timeline are all optional.
// A missing (or empty) section is OMITTED from the document, never invented, and the
// response lists which sections were left out.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DIST = join(here, "..", "dist");
const ENTRY = join(DIST, "index.js");
const { readDocx } = await import(join(DIST, "wordxml.js"));

function client(home) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "cfg"), MCP_LICENSE_KEY: "" },
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
      const r = pending.get(msg.id);
      if (r) { pending.delete(msg.id); r(msg); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: mid, method, params }) + "\n");
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); reject(new Error(`timeout on ${method}`)); } }, 20000);
    t.unref();
  });
  return {
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "r10", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, JSON.stringify(r.error));
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

test("D-R47: a two-paragraph proposal with no scope/deliverables/timeline omits those sections, not inventing them", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-docx-r47-"));
  const c = client(home);
  try {
    await c.init();
    await c.call("business_set", { name: "Acme Consulting", default_currency: "EUR" });
    const r = await c.call("proposal_create", {
      client: "Nova", project_title: "Nova phase 2",
      summary: "Paragraph one.\n\nParagraph two.",
      price: { amount: 6000, currency: "EUR" },
    });
    assert.equal(r.isError, false, r.text);
    const body = JSON.parse(r.text.split("\n\n")[1]);
    assert.deepEqual(body.omitted_sections, ["scope", "deliverables", "timeline"]);
    assert.equal(body.phases, 0);
    assert.match(r.text, /Omitted from the document, not invented: scope, deliverables, timeline/);

    const blocks = readDocx(readFileSync(body.file));
    const headings = blocks.filter((b) => b.type === "heading").map((b) => b.text);
    assert.ok(headings.includes("Summary"));
    assert.equal(headings.includes("Scope of work"), false, "no invented scope heading");
    assert.equal(headings.includes("Deliverables"), false, "no invented deliverables heading");
    assert.equal(headings.includes("Timeline"), false, "no invented timeline heading");
  } finally { c.close(); }
});

test("D-R47: an empty scope array is also omitted, same as a missing one", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-docx-r47b-"));
  const c = client(home);
  try {
    await c.init();
    await c.call("business_set", { name: "Acme Consulting", default_currency: "EUR" });
    const r = await c.call("proposal_create", {
      client: "Nova", project_title: "Nova phase 3",
      scope: [], deliverables: ["Report"],
      price: { amount: 500, currency: "EUR" },
    });
    assert.equal(r.isError, false, r.text);
    const body = JSON.parse(r.text.split("\n\n")[1]);
    assert.deepEqual(body.omitted_sections, ["summary", "scope", "timeline"]);
    const blocks = readDocx(readFileSync(body.file));
    const headings = blocks.filter((b) => b.type === "heading").map((b) => b.text);
    assert.equal(headings.includes("Scope of work"), false);
    assert.ok(headings.includes("Deliverables"));
  } finally { c.close(); }
});

test("D-R47: all four sections present still renders normally with nothing omitted", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-docx-r47c-"));
  const c = client(home);
  try {
    await c.init();
    await c.call("business_set", { name: "Acme Consulting", default_currency: "EUR" });
    const r = await c.call("proposal_create", {
      client: "Nova", project_title: "Nova phase 4", summary: "Summary.",
      scope: ["a"], deliverables: ["b"], timeline: [{ phase: "Build", duration: "1 week" }],
      price: { amount: 500, currency: "EUR" },
    });
    assert.equal(r.isError, false, r.text);
    const body = JSON.parse(r.text.split("\n\n")[1]);
    assert.deepEqual(body.omitted_sections, []);
    assert.equal(body.phases, 1);
    assert.equal(/Omitted from the document/.test(r.text), false, r.text);
    const headings = readDocx(readFileSync(body.file)).filter((b) => b.type === "heading").map((b) => b.text);
    assert.deepEqual(
      headings.filter((h) => h !== "Nova phase 4"),
      ["Summary", "Scope of work", "Deliverables", "Timeline", "Investment", "Acceptance"],
    );
  } finally { c.close(); }
});
