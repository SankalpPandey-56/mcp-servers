// The server over real stdio JSON-RPC: initialize, tools/list, and one pass of the
// whole application flow. The generated .docx is read back with the docx server's own
// engine (@theluckystrike/mcp-docx/lib), so "it wrote a file" is never the assertion.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readDocx, blockText } from "@theluckystrike/mcp-docx/lib";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-resume-"));
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
      if (msg.id !== undefined && pending.has(msg.id)) { const { resolve } = pending.get(msg.id); pending.delete(msg.id); resolve(msg); }
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
  assert.equal(r.result.serverInfo.name, "mcp-resume");
  c.notify("notifications/initialized", {});
}

const PROFILE = {
  name: "Ada Rowe", email: "ada@example.com", phone: "+48 500 100 200", location: "Warsaw, Poland",
  summary: "Backend engineer working on payment systems.",
  skills: ["TypeScript", "Node.js", "PostgreSQL", "Kubernetes"],
  experience: [
    { company: "Acme Pay", title: "Senior Engineer", start: "2021",
      bullets: ["Rebuilt the settlement pipeline in Node.js, cutting reconciliation time from 6 hours to 20 minutes",
        "Owned the PostgreSQL schema for ledger entries", "Migrated batch jobs to Kubernetes"] },
    { company: "Beta Corp", title: "Engineer", start: "2018", end: "2021", bullets: ["Built internal reporting in TypeScript"] },
  ],
  education: [{ school: "University of Warsaw", degree: "BSc Computer Science", start: "2014", end: "2018" }],
};

const pathOf = (text) => {
  const m = /(\/[^\s"]+\.(?:docx|html))/.exec(text);
  assert.ok(m, `no output path in: ${text}`);
  return m[1];
};

test("stdio: initialize, tools/list, profile, resume, cover letter, tailoring", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);

  const tools = (await c.send("tools/list", {})).result.tools.map((x) => x.name).sort();
  for (const name of ["cover_letter_create", "license_activate", "license_status", "profile_get", "profile_set",
    "resume_create", "resume_read", "resume_to_html", "resume_to_markdown", "tailor_to_job"]) {
    assert.ok(tools.includes(name), `tools/list is missing ${name}: ${tools.join(", ")}`);
  }
  const res = (await c.send("resources/list", {})).result.resources.map((r) => r.uri);
  assert.deepEqual(res, ["resume://profile"]);
  const prompts = (await c.send("prompts/list", {})).result.prompts.map((p) => p.name);
  assert.deepEqual(prompts, ["apply_to_job"]);

  let r = await c.call("profile_set", PROFILE);
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /2 roles, 4 bullets/);

  r = await c.call("profile_get", {});
  assert.match(r.text, /"name": "Ada Rowe"/);

  const resource = (await c.send("resources/read", { uri: "resume://profile" })).result.contents[0].text;
  assert.match(resource, /Acme Pay/);

  // resume_create, then read the .docx back with the docx engine.
  r = await c.call("resume_create", { style: "modern", target_role: "Staff Engineer", keywords: ["Kubernetes", "Rust"], max_pages: 1 });
  assert.equal(r.isError, false, r.text);
  const out = JSON.parse(r.text);
  assert.deepEqual(out.keywords_matched, ["Kubernetes"]);
  assert.deepEqual(out.keywords_missing, ["Rust"]);
  assert.ok(out.estimated_pages <= 1, `estimated ${out.estimated_pages} pages for max_pages 1`);
  assert.ok(existsSync(out.path));
  assert.ok(statSync(out.path).size > 2000);

  const text = readDocx(readFileSync(out.path)).map(blockText).join("\n");
  assert.match(text, /Ada Rowe/, "the resume does not contain the name");
  assert.match(text, /Acme Pay/, "the resume does not contain the company");
  assert.match(text, /University of Warsaw/);
  assert.doesNotMatch(text, /Rust/, "a missing keyword reached the document");

  r = await c.call("resume_to_markdown", {});
  assert.match(r.text, /# Ada Rowe/);
  assert.match(r.text, /Acme Pay/);

  r = await c.call("resume_to_html", {});
  assert.equal(r.isError, false, r.text);
  const html = readFileSync(pathOf(r.text), "utf8");
  assert.match(html, /<h1>Ada Rowe<\/h1>/);
  assert.match(html, /@media print/);

  // resume_read round trip through a real .docx.
  r = await c.call("resume_read", { path: out.path });
  assert.equal(r.isError, false, r.text);
  const back = JSON.parse(r.text);
  assert.equal(back.saved, false);
  assert.equal(back.profile.name, "Ada Rowe");
  assert.equal(back.profile.email, "ada@example.com");
  assert.ok(back.profile.experience.length >= 1, `no roles read back: ${JSON.stringify(back.profile.experience)}`);
  assert.ok(back.profile.experience.some((e) => /Acme Pay/.test(`${e.company} ${e.title}`)), JSON.stringify(back.profile.experience));

  // cover_letter_create: the letter must name the company and quote a profile bullet verbatim.
  r = await c.call("cover_letter_create", {
    company: "Zeta Systems", role: "Staff Engineer", tone: "formal",
    job_description: "Backend engineer, payments platform. PostgreSQL and Kubernetes. Payments platform experience.",
  });
  assert.equal(r.isError, false, r.text);
  const letter = JSON.parse(r.text);
  assert.match(letter.free_tier, /1 of 3 free letters/);
  const lt = readDocx(readFileSync(letter.path)).map(blockText).join("\n");
  assert.match(lt, /Zeta Systems/);
  assert.match(lt, /Acme Pay/);
  assert.match(lt, /Owned the PostgreSQL schema for ledger entries/);
  for (const n of lt.match(/\d[\d.,%/-]*/g) ?? []) {
    const bare = n.replace(/[.,%/-]+$/, "");
    assert.ok(JSON.stringify(PROFILE).includes(bare) || "Zeta Systems Staff Engineer".includes(bare),
      `the letter states ${bare}, which is in neither the profile nor the arguments`);
  }

  // tailor_to_job
  r = await c.call("tailor_to_job", { job_description: "Backend engineer, payments. We use Rust and PostgreSQL. Rust in production." });
  assert.equal(r.isError, false, r.text);
  const gap = JSON.parse(r.text);
  assert.ok(gap.matched.includes("postgresql"), JSON.stringify(gap.matched));
  assert.ok(gap.missing.includes("rust"), JSON.stringify(gap.missing));
  assert.equal(gap.matched.length + gap.missing.length, gap.keywords.length);

  assert.deepEqual(c.bad, [], `non-JSON on stdout: ${c.bad.join(" | ")}`);
});

test("profile_set stores experience newest-first regardless of the order the caller sent it in", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);

  const oldestFirst = {
    name: "Ada Rowe", email: "ada@example.com",
    experience: [
      { company: "Alpha", title: "Junior Dev", start: "2015", end: "2018", bullets: ["old"] },
      { company: "Beta Corp", title: "Engineer", start: "2018", end: "2021", bullets: ["mid"] },
      { company: "Acme Pay", title: "Senior Engineer", start: "2021", bullets: ["current, no end date"] },
    ],
    education: [],
  };
  let r = await c.call("profile_set", oldestFirst);
  assert.equal(r.isError, false, r.text);

  r = await c.call("profile_get", {});
  const stored = JSON.parse(r.text);
  assert.deepEqual(stored.profile.experience.map((e) => e.company), ["Acme Pay", "Beta Corp", "Alpha"],
    "profile_set must reorder oldest-first input to newest-first on storage");

  assert.deepEqual(c.bad, [], `non-JSON on stdout: ${c.bad.join(" | ")}`);
});

test("free tier: modern only, 3 letters a month, 2000-character postings; Pro lifts all three", async (t) => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "resume"], { encoding: "utf8" }).trim();
  assert.match(key, /^MCPL1\./);

  const free = client();
  t.after(() => free.close());
  await init(free);
  await free.call("profile_set", PROFILE);

  let r = await free.call("resume_create", { style: "classic" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Pro feature/);

  r = await free.call("profile_set", { ...PROFILE, variant: "backend" });
  assert.equal(r.isError, true);
  assert.match(r.text, /Pro feature/);

  r = await free.call("tailor_to_job", { job_description: "x".repeat(2001) });
  assert.equal(r.isError, true);
  assert.match(r.text, /2,?000|2000/);

  for (let i = 1; i <= 3; i++) {
    r = await free.call("cover_letter_create", { company: `Company ${i}`, role: "Engineer", tone: "direct" });
    assert.equal(r.isError, false, `letter ${i} was refused: ${r.text}`);
  }
  r = await free.call("cover_letter_create", { company: "Fourth Co", role: "Engineer", tone: "direct" });
  assert.equal(r.isError, true, "the fourth free letter was allowed");
  assert.match(r.text, /already written 3 cover letters/);

  // Same data dir, Pro key: the fourth letter goes through and so do the other three limits.
  const pro = client({ MCP_LICENSE_KEY: key, XDG_DATA_HOME: join(free.home, "data"), XDG_CONFIG_HOME: join(free.home, "config") });
  t.after(() => pro.close());
  await init(pro);
  r = await pro.call("cover_letter_create", { company: "Fourth Co", role: "Engineer", tone: "direct" });
  assert.equal(r.isError, false, `Pro refused the fourth letter: ${r.text}`);
  r = await pro.call("resume_create", { style: "classic" });
  assert.equal(r.isError, false, r.text);
  r = await pro.call("tailor_to_job", { job_description: "PostgreSQL. " + "x ".repeat(1200) });
  assert.equal(r.isError, false, r.text);
  r = await pro.call("profile_set", { ...PROFILE, variant: "backend" });
  assert.equal(r.isError, false, r.text);

  assert.deepEqual(pro.bad, [], `non-JSON on stdout: ${pro.bad.join(" | ")}`);
});

// Profile-first sweep (docs/PROFILE_FIRST_RESULT.md), the D-R64 species: your own name and
// phone are business identity held once behind the token, and profile_set made name required.
test("profile_set falls back to the shared business profile for name and phone", async (t) => {
  const c = client();
  t.after(() => c.close());
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = join(c.home, "data", "mcp-servers", "profile");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "business.json"), JSON.stringify({
    name: "Ada Rowe", phone: "+48 500 100 200", email: "ada@example.com",
  }));
  await init(c);

  const r = await c.call("profile_set", { experience: PROFILE.experience, education: PROFILE.education });
  assert.equal(r.isError, false, r.text);
  assert.match(r.text, /shared business profile/);
  const g = await c.call("profile_get", {});
  assert.equal(g.isError, false, g.text);
  assert.match(g.text, /Ada Rowe/);
  assert.match(g.text, /\+48 500 100 200/);

  // An explicit name wins over the profile and is not annotated as profile-sourced.
  const r2 = await c.call("profile_set", { name: "Kenji Ito", phone: "+81 3 0000 0000", merge: true, experience: [], education: [] });
  assert.equal(r2.isError, false, r2.text);
  assert.doesNotMatch(r2.text, /Taken from the shared business profile: name/);
  const g2 = await c.call("profile_get", {});
  assert.match(g2.text, /Kenji Ito/);
});

test("profile_set with no name anywhere names business_set rather than asking", async (t) => {
  const c = client();
  t.after(() => c.close());
  await init(c);
  const r = await c.call("profile_set", { experience: PROFILE.experience, education: PROFILE.education });
  assert.equal(r.isError, true, r.text);
  assert.match(r.text, /business_set/);
  assert.match(r.text, /Nothing was stored/);
});
