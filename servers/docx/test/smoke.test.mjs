import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-docx-"));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      XDG_DATA_HOME: join(home, "data"),
      XDG_CONFIG_HOME: join(home, "config"),
      MCP_LICENSE_KEY: "",
      ...env,
    },
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
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
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
    home, child, send,
    notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

async function init(c) {
  const r = await c.send("initialize", {
    protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" },
  });
  assert.ok(r.result?.serverInfo, "initialize failed");
  assert.equal(r.result.serverInfo.name, "mcp-docx");
  c.notify("notifications/initialized", {});
  return r.result;
}

const pathOf = (text) => {
  const m = /(\/[^\s]+\.(?:docx|html))/.exec(text);
  assert.ok(m, `no output path in: ${text}`);
  return m[1];
};

test("stdio: initialize, tools/list, business_set, proposal, doc_read, html", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);

  const tools = (await c.send("tools/list", {})).result.tools.map((x) => x.name).sort();
  for (const name of ["business_set", "contract_create", "doc_create", "doc_fill_template",
    "doc_from_markdown", "doc_read", "doc_to_html", "license_activate", "license_status", "proposal_create"]) {
    assert.ok(tools.includes(name), `tools/list is missing ${name}: ${tools.join(", ")}`);
  }
  // doc_to_pdf is deliberately absent: no native dependency, no headless browser.
  assert.ok(!tools.includes("doc_to_pdf"));

  const res = (await c.send("resources/list", {})).result.resources.map((r) => r.uri);
  assert.deepEqual(res, ["docs://recent"]);
  const prompts = (await c.send("prompts/list", {})).result.prompts.map((p) => p.name);
  assert.deepEqual(prompts, ["write_proposal_from_hours"]);

  let r = await c.call("business_set", {
    name: "Acme Consulting", address: "1 Road, Warsaw", email: "hi@acme.example",
    vat_id: "PL1234567890", default_currency: "EUR", payment_terms_days: 14,
  });
  assert.equal(r.isError, false);
  assert.match(r.text, /"default_currency": "EUR"/);

  r = await c.call("proposal_create", {
    client: "Beta Corp",
    project_title: "Checkout rebuild",
    summary: "Beta Corp loses orders at checkout. This project rebuilds it.",
    scope: ["Audit the current funnel", "Rebuild the checkout", "Ship and measure"],
    deliverables: ["New checkout in production", "A one-page handover"],
    timeline: [
      { phase: "Discovery", duration: "1 week" },
      { phase: "Build", duration: "3 weeks" },
      { phase: "Launch", duration: "1 week" },
    ],
    price: { amount: 4500, currency: "EUR", terms: "50% on signature, 50% on delivery" },
    valid_until: "2026-12-31",
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /"total": "EUR 4,500\.00"/);
  assert.match(r.text, /"phases": 3/);
  assert.match(r.text, /PROP-\d{4}-0001/);
  const docxPath = pathOf(r.text);
  assert.ok(existsSync(docxPath), `${docxPath} was not written`);
  assert.ok(statSync(docxPath).size > 2000);

  // The generated document must actually contain the client and the total.
  r = await c.call("doc_read", { path: docxPath });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /Beta Corp/);
  assert.match(r.text, /EUR 4,500\.00/);
  assert.match(r.text, /Checkout rebuild/);
  assert.match(r.text, /Timeline/);

  r = await c.call("doc_to_html", { path: docxPath });
  assert.equal(r.isError, false, r.text);
  const htmlPath = pathOf(r.text);
  assert.ok(existsSync(htmlPath));
  assert.match(r.text, /Print > Save as PDF/);

  // markdown -> docx -> text
  r = await c.call("doc_from_markdown", {
    markdown: "# Notes\n\nOne **bold** line.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n",
    out_path: join(c.home, "notes.docx"),
  });
  assert.equal(r.isError, false, r.text);
  r = await c.call("doc_read", { path: join(c.home, "notes.docx"), format: "json" });
  const blocks = JSON.parse(r.text).blocks;
  assert.ok(blocks.some((b) => b.type === "table"), r.text);

  // doc_create is free and unlimited
  r = await c.call("doc_create", {
    title: "Meeting letter", style: "letter", recipient: "Beta Corp\n2 Street",
    sections: [{ heading: "Agenda", bullets: ["Scope", "Budget"] }],
    out_path: join(c.home, "letter.docx"),
  });
  assert.equal(r.isError, false, r.text);
  assert.ok(existsSync(join(c.home, "letter.docx")));

  const recent = (await c.send("resources/read", { uri: "docs://recent" })).result.contents[0].text;
  const list = JSON.parse(recent);
  assert.equal(list.length, 4, `expected proposal, html, markdown and letter records: ${recent}`);
  assert.equal(list[0].kind, "document");
  assert.equal(list[list.length - 1].kind, "proposal");
});

test("contract_create says it is a template and not legal advice", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  await c.call("business_set", { name: "Acme Consulting", default_currency: "EUR" });
  const r = await c.call("contract_create", {
    client: "Beta Corp", services: "Frontend development on the checkout.",
    start_date: "2026-10-01", fee: { amount: 3000, currency: "EUR", schedule: "monthly in arrears" },
    governing_law: "the laws of Poland",
  });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /not legal advice/i);
  assert.match(r.text, /AGR-2026-0001/);
  const read = await c.call("doc_read", { path: pathOf(r.text) });
  assert.match(read.text, /TEMPLATE - NOT LEGAL ADVICE/);
  assert.match(read.text, /EUR 3,000\.00/);
  assert.match(read.text, /the laws of Poland/);
});

test("free tier: 3 proposals or contracts a month, the 4th is refused; Pro allows it", async (t) => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "docx"], { encoding: "utf8" }).trim();
  assert.match(key, /^MCPL1\./);

  const free = client();
  t.after(() => free.close());
  await init(free);
  await free.call("business_set", { name: "Solo Dev", default_currency: "EUR" });

  const mk = (c, n) => c.call("proposal_create", {
    client: `Client ${n}`, project_title: `Job ${n}`, summary: "A summary.",
    scope: ["a"], deliverables: ["b"], timeline: [{ phase: "Build", duration: "1 week" }],
    price: { amount: 4500, currency: "EUR", terms: "50/50" },
  });

  for (let i = 1; i <= 3; i++) {
    const r = await mk(free, i);
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /Created proposal PROP-\d{4}-000\d/);
  }
  const blocked = await mk(free, 4);
  assert.equal(blocked.isError, false, "a gate must not be an error result");
  assert.match(blocked.text, /free tier allows 3 proposals or contracts per calendar month/i);
  assert.match(blocked.text, /mcp\.zovo\.one\/buy\/docx/);
  // Free tools stay free after the gate closes.
  const still = await free.call("doc_create", { title: "Still free", sections: [{ paragraphs: ["yes"] }] });
  assert.equal(still.isError, false, still.text);

  const pro = client({ MCP_LICENSE_KEY: key });
  t.after(() => pro.close());
  await init(pro);
  const st = await pro.call("license_status", {});
  assert.match(st.text, /"tier": "pro"/);
  await pro.call("business_set", { name: "Solo Dev", default_currency: "EUR" });
  for (let i = 1; i <= 4; i++) {
    const r = await mk(pro, i);
    assert.equal(r.isError, false);
    assert.match(r.text, /Created proposal PROP-\d{4}-000\d/, `pro proposal ${i} was blocked: ${r.text}`);
  }
  const recent = JSON.parse((await pro.send("resources/read", { uri: "docs://recent" })).result.contents[0].text);
  assert.equal(recent.filter((d) => d.kind === "proposal").length, 4);
  const numbers = recent.map((d) => d.number).filter(Boolean);
  assert.equal(new Set(numbers).size, numbers.length, "reference numbers must never repeat");
});
