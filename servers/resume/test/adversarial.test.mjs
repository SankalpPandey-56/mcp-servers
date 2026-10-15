// Adversarial probes for mcp-resume, run over real stdio JSON-RPC where the defect is a
// protocol-level one and in-process where it is a pure function. Every generated .docx is
// read back with the docx engine, so "a file appeared" is never the assertion.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readDocx, buildDocx } from "@theluckystrike/mcp-docx/lib";
import { unsourcedNumbers, numbersIn } from "../dist/letter.js";
import { extractKeywords, analyseGap, SHORT_SKILLS } from "../dist/tailor.js";
import { keywordReport } from "../dist/render.js";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

function client(env = {}) {
  const home = mkdtempSync(join(tmpdir(), "mcp-resume-adv-"));
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "cfg"), MCP_LICENSE_KEY: "", ...env },
  });
  child.stderr.resume();
  let buf = ""; const bad = []; const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { bad.push(line); continue; }
      const r = pending.get(msg.id); if (r) { pending.delete(msg.id); r(msg); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((res) => {
    const n = ++id; pending.set(n, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
  return {
    home, bad,
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "adv", version: "1" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args });
      return { text: (r.result?.content ?? []).map((c) => c.text).join("\n"), isError: !!r.result?.isError, rpcError: r.error ?? null };
    },
    close() { child.stdin.end(); child.kill(); },
  };
}

const PROFILE = {
  name: "Ada Rowe", email: "ada@example.com", location: "Warsaw",
  summary: "Backend engineer building payment systems.",
  skills: ["Go", "Kubernetes", "Postgres", "Terraform", "gRPC"],
  experience: [{
    company: "Acme Pay", title: "Senior Backend Engineer", start: "2021",
    bullets: ["Cut checkout latency by 37 percent", "Ran a fleet of 12 services"],
  }],
  education: [{ school: "University of Warsaw", degree: "BSc Computer Science" }],
};

function docxText(path) {
  return readDocx(readFileSync(path))
    .map((b) => (b.type === "bullets" ? b.items.join("\n") : (b.text ?? ""))).join("\n");
}

test("a job description is not a source of numbers about the candidate", () => {
  // The profile holds exactly three numbers. Nothing from the posting may join them.
  const profileSource = JSON.stringify(PROFILE);
  assert.deepEqual(numbersIn(profileSource).sort(), ["12", "2021", "37"]);
  const letter = "I grew revenue to 48 million with a team of 23.";
  assert.deepEqual(unsourcedNumbers(letter, [profileSource, "Northwind", "Staff Engineer"]), ["48", "23"]);
  // A word-token comparison, not substring containment: "2012" must not license "12".
  assert.deepEqual(unsourcedNumbers("I ran 12 services.", ['{"start":"2012"}']), ["12"]);
  assert.deepEqual(unsourcedNumbers("I ran 12 services.", [profileSource]), []);
});

test("ten cover letters against ten numeric postings leak no posting figure", async () => {
  const c = client();
  await c.init();
  const dir = mkdtempSync(join(tmpdir(), "mcp-resume-letters-"));
  assert.equal((await c.call("profile_set", PROFILE)).isError, false);
  const allowed = new Set(numbersIn(JSON.stringify(PROFILE)));
  const postings = [
    ["Northwind", "We grew revenue to 48 million. The platform team is 23 engineers. Go and Kubernetes, 9400 requests per second."],
    ["Vertex", "Vertex processes 1.2 billion events a day across 64 clusters. A team of 17 needs a Postgres expert."],
    ["Halcyon", "Halcyon closed a 92 million Series C. 41 engineers. Terraform, gRPC, 8 years of distributed systems."],
  ];
  for (let i = 0; i < postings.length; i++) {
    const [company, jd] = postings[i];
    const out = join(dir, `l${i}.docx`);
    const r = await c.call("cover_letter_create", { company, role: "Backend Engineer", job_description: jd, tone: "direct", out_path: out });
    assert.equal(r.isError, false, r.text);
    const stated = numbersIn(docxText(out));
    const leaked = stated.filter((n) => !allowed.has(n));
    assert.deepEqual(leaked, [], `letter ${i} stated ${leaked.join(",")} which the profile does not`);
  }
  assert.deepEqual(c.bad, []);
  c.close();
});

test("short skill names survive keyword extraction", () => {
  const jd = "Senior Go engineer with Kubernetes and Postgres experience";
  assert.ok(extractKeywords(jd, 30).includes("go"), "the posting's only real skill word was dropped");
  const g = analyseGap(PROFILE, jd, 30);
  assert.ok(g.keywords.includes("go"));
  assert.ok(g.matched.includes("go"));
  assert.ok(g.matched_in_skills.includes("go"));
  // Two-character skills from the allowlist and from the user's own skills list.
  assert.deepEqual(extractKeywords("We need C# and R and SQL and iOS work", 30).sort(), ["c#", "ios", "r", "sql"]);
  for (const s of ["go", "c", "r", "c#", "k8s", "ui"]) assert.ok(SHORT_SKILLS.has(s));
  const withOwn = analyseGap({ ...PROFILE, skills: ["Nx"] }, "We use Nx and Kubernetes here", 30);
  assert.ok(withOwn.keywords.includes("nx"), "a short skill the user actually lists was dropped");
  // The length filter must not turn every one-letter noise word into a keyword.
  assert.ok(!extractKeywords("a b d e f of to in", 30).includes("d"));
});

test("keywords carrying regex metacharacters neither crash nor match everything", () => {
  const corpus = "Cut checkout latency by 37 percent using Go and Postgres";
  const r = keywordReport(corpus, ["C++", ".*", "(a|b)", "[Go]", "a{2,3}", "$^", "\\d+", "Go", "37"]);
  assert.deepEqual(r.matched, ["Go", "37"]);
  assert.deepEqual(r.missing, ["C++", ".*", "(a|b)", "[Go]", "a{2,3}", "$^", "\\d+"]);
});

test("HTML and script in bullets reach the document as character data", async () => {
  const c = client();
  await c.init();
  const dir = mkdtempSync(join(tmpdir(), "mcp-resume-xss-"));
  await c.call("profile_set", {
    ...PROFILE,
    experience: [{
      company: "Acme <b>Pay</b>", title: "Engineer", start: "2021",
      bullets: ["<script>alert(1)</script> built the thing", "<img src=x onerror=alert(2)> shipped it", "Used A & B < C > D"],
    }],
  });
  const docx = join(dir, "xss.docx");
  const html = join(dir, "xss.html");
  assert.equal((await c.call("resume_create", { out_path: docx })).isError, false);
  assert.equal((await c.call("resume_to_html", { out_path: html })).isError, false);
  const text = docxText(docx);
  assert.match(text, /<script>alert\(1\)<\/script> built the thing/);
  const page = readFileSync(html, "utf8");
  assert.doesNotMatch(page, /<script/i);
  assert.doesNotMatch(page, /<img/i);
  assert.match(page, /&lt;img src=x onerror=alert\(2\)&gt;/);
  c.close();
});

test("unicode names and 300 bullets survive; the trim stays inside its budget", async () => {
  const c = client();
  await c.init();
  const dir = mkdtempSync(join(tmpdir(), "mcp-resume-big-"));
  const name = "Zoe Sliwinska-ОБрайен 田中";
  const bullets = Array.from({ length: 300 }, (_, i) => `Shipped feature ${i} improving throughput`);
  await c.call("profile_set", { ...PROFILE, name, experience: [{ company: "Acme Pay", title: "Engineer", start: "2021", bullets }] });
  const out = join(dir, "big.docx");
  const r = await c.call("resume_create", { out_path: out, max_pages: 1 });
  assert.equal(r.isError, false, r.text);
  const j = JSON.parse(r.text);
  assert.ok(j.bullets_kept > 0 && j.bullets_dropped.length > 0, "nothing was trimmed at one page with 300 bullets");
  assert.equal(j.bullets_kept + j.bullets_dropped.length, 300);
  assert.ok(j.words_used - (j.max_pages * 450 - j.word_budget) <= j.word_budget, "bullets overshot the word budget");
  assert.match(docxText(out), new RegExp(name.slice(0, 4)));
  c.close();
});

test("out_path: an existing file is never clobbered without overwrite", async () => {
  const c = client();
  await c.init();
  const dir = mkdtempSync(join(tmpdir(), "mcp-resume-out-"));
  const keep = join(dir, "keep.docx");
  writeFileSync(keep, "ORIGINAL");
  await c.call("profile_set", PROFILE);
  const refused = await c.call("resume_create", { out_path: keep });
  assert.equal(refused.isError, true);
  assert.match(refused.text, /already exists and nothing was written/);
  assert.equal(readFileSync(keep, "utf8"), "ORIGINAL");
  const forced = await c.call("resume_create", { out_path: keep, overwrite: true });
  assert.equal(forced.isError, false);
  assert.match(docxText(keep), /Ada Rowe/);
  // A relative traversal resolves against cwd; it does not escape to an arbitrary root.
  const rel = await c.call("resume_create", { out_path: "../../../../etc/passwd" });
  assert.equal(rel.isError, true);
  c.close();
});

test("resume_read refuses what is not a Word document and survives a 50 MB one", async (ctx) => {
  const c = client();
  await c.init();
  const dir = mkdtempSync(join(tmpdir(), "mcp-resume-read-"));
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  const txt = join(dir, "cv.txt");
  writeFileSync(txt, "hello");
  const a = await c.call("resume_read", { path: txt });
  assert.equal(a.isError, true);
  assert.match(a.text, /is not a \.docx file/);
  // A real .docx with a 50 MB part: the media is inflated but never parsed.
  const buf = await buildDocx({
    title: "Ada Rowe", business: { name: "Ada Rowe" },
    blocks: [{ type: "para", text: "Ada Rowe" }, { type: "heading", level: 2, text: "Skills" }, { type: "para", text: "Go - Postgres" }],
    media: undefined,
  });
  const big = join(dir, "big.docx");
  writeFileSync(big, buf);
  const { execFileSync } = await import("node:child_process");
  writeFileSync(join(dir, "pad.bin"), Buffer.alloc(50 * 1024 * 1024));
  execFileSync("zip", ["-q", "-0", big, "pad.bin"], { cwd: dir });
  assert.ok(statSync(big).size > 50 * 1024 * 1024);
  const t0 = Date.now();
  const b = await c.call("resume_read", { path: big });
  assert.equal(b.isError, false, b.text);
  assert.ok(Date.now() - t0 < 10000, "reading a 50 MB docx took too long");
  assert.match(JSON.parse(b.text).profile.name, /Ada Rowe/);
  c.close();
});

test("a profile with no experience, and a cover letter from an empty profile", async () => {
  const c = client();
  await c.init();
  const dir = mkdtempSync(join(tmpdir(), "mcp-resume-thin-"));
  await c.call("profile_set", { name: "Nia Blank", email: "nia@example.com", experience: [], education: [] });
  const resume = await c.call("resume_create", { out_path: join(dir, "thin.docx") });
  assert.equal(resume.isError, false, resume.text);
  assert.equal(JSON.parse(resume.text).bullets_kept, 0);
  const letterPath = join(dir, "thin-letter.docx");
  const letter = await c.call("cover_letter_create", { company: "Acme", role: "Engineer", out_path: letterPath });
  assert.equal(letter.isError, false, letter.text);
  const j = JSON.parse(letter.text);
  assert.ok(j.fills_required.length >= 3, `an empty profile produced only ${j.fills_required.length} prompts`);
  const text = docxText(letterPath);
  // Everything the letter cannot know is bracketed, and nothing numeric was invented.
  for (const p of j.fills_required) assert.ok(text.includes(p), `prompt missing from the document: ${p}`);
  assert.deepEqual(numbersIn(text).filter((n) => !["Nia Blank"].join().includes(n)), []);
  c.close();
});

test("a corrupt profile store is quarantined byte-for-byte and every tool refuses", async () => {
  const home = mkdtempSync(join(tmpdir(), "mcp-resume-corrupt-"));
  const dir = join(home, "data", "mcp-servers", "resume");
  mkdirSync(dir, { recursive: true });
  const junk = '{"default": {"name": "Ada"';
  writeFileSync(join(dir, "profiles.json"), junk);
  const sha = createHash("sha256").update(junk).digest("hex");
  const c = client({ XDG_DATA_HOME: join(home, "data") });
  await c.init();
  for (const [tool, args] of [["profile_get", {}], ["resume_to_markdown", {}], ["profile_set", { name: "New", email: "n@e.com" }]]) {
    const r = await c.call(tool, args);
    assert.equal(r.isError, true, `${tool} did not refuse on a corrupt store`);
    assert.match(r.text, /^Error: /, `${tool} threw across the transport instead of answering`);
    assert.match(r.text, /corrupt/);
  }
  const files = readdirSync(dir);
  const moved = files.find((f) => f.startsWith("profiles.json.corrupt-"));
  assert.ok(moved, "the corrupt file was not quarantined");
  assert.equal(createHash("sha256").update(readFileSync(join(dir, moved))).digest("hex"), sha, "the quarantined copy is not byte-identical");
  assert.ok(files.includes("profiles.json.corrupt"), "no marker was written");
  assert.ok(!files.includes("profiles.json"), "the corrupt file was left in place");
  assert.deepEqual(c.bad, []);
  c.close();
});

test("two processes racing one out_path: exactly one wins, nothing is clobbered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-resume-race-"));
  const home = mkdtempSync(join(tmpdir(), "mcp-resume-race-home-"));
  const a = client({ XDG_DATA_HOME: join(home, "data") });
  const b = client({ XDG_DATA_HOME: join(home, "data") });
  await Promise.all([a.init(), b.init()]);
  await a.call("profile_set", PROFILE);
  const target = join(dir, "shared.docx");
  const [ra, rb] = await Promise.all([
    a.call("resume_create", { out_path: target }),
    b.call("resume_create", { out_path: target }),
  ]);
  const winners = [ra, rb].filter((r) => !r.isError);
  assert.equal(winners.length, 1, "both processes claimed the same out_path");
  const loser = [ra, rb].find((r) => r.isError);
  assert.match(loser.text, /already exists and nothing was written/);
  assert.match(docxText(target), /Ada Rowe/);
  assert.deepEqual([...a.bad, ...b.bad], []);
  a.close(); b.close();
});

test("the server opens no socket and stdout carries only JSON-RPC", async () => {
  const src = readdirSync(join(here, "..", "src")).map((f) => readFileSync(join(here, "..", "src", f), "utf8")).join("\n");
  assert.doesNotMatch(src, /\bfetch\s*\(|node:https?|node:net|node:dns|XMLHttpRequest/);
  const c = client();
  await c.init();
  await c.call("profile_set", PROFILE);
  await c.call("profile_get", {});
  await c.call("resume_to_markdown", {});
  assert.deepEqual(c.bad, []);
  c.close();
});

test("proof bullets are printed under the role they belong to, never under the wrong employer", async () => {
  const c = client();
  await c.init();
  const dir = mkdtempSync(join(tmpdir(), "mcp-resume-attr-"));
  const two = {
    ...PROFILE,
    experience: [
      { company: "Acme Pay", title: "Senior Backend Engineer", start: "2021", bullets: ["Own the settlement service", "Cut checkout latency by 37 percent"] },
      { company: "Norstad Systems", title: "Backend Engineer", start: "2017", end: "2021", bullets: ["Wrote the ledger reconciliation jobs"] },
    ],
  };
  await c.call("profile_set", two);
  const out = join(dir, "letter.docx");
  const r = await c.call("cover_letter_create", { company: "Northwind", role: "Senior Backend Engineer", tone: "direct", out_path: out });
  assert.equal(r.isError, false, r.text);
  const text = docxText(out);
  const acme = text.indexOf("Acme Pay");
  const norstad = text.indexOf("Norstad Systems");
  const ledger = text.indexOf("ledger reconciliation");
  assert.ok(acme >= 0 && norstad >= 0, "one of the two employers was never named");
  assert.ok(ledger > norstad, "a Norstad bullet was printed under the Acme Pay heading");
  assert.ok(text.indexOf("settlement service") > acme && text.indexOf("settlement service") < norstad);
  c.close();
});

test("a skill name outranks a long noise word of the same frequency", () => {
  const jd = "Northwind Labs is hiring a Senior Backend Engineer for our payments platform. " +
    "You will work on services written in Go, deployed on Kubernetes, backed by Postgres, " +
    "with Kafka as the event backbone. Rust and Cassandra are used elsewhere. Terraform everywhere. gRPC is expected.";
  const top = extractKeywords(jd, 6, ["go", "postgres", "kubernetes", "terraform", "grpc", "kafka"]);
  for (const k of ["go", "kafka", "grpc", "postgres", "kubernetes", "terraform"]) {
    assert.ok(top.includes(k), `${k} lost its place to a noise word: ${top.join(", ")}`);
  }
  assert.ok(!top.includes("everywhere") && !top.includes("backbone"));
});
