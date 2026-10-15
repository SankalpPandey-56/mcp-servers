// Two server processes on one data dir writing profile variants at the same time.
// profiles.json is a single file holding every variant, so an unlocked read-modify-write
// loses whichever write landed second.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");
const N = 10;

function client(dataHome, key) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dataHome, "cfg"), MCP_LICENSE_KEY: key },
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
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 30000);
    t.unref();
  });
  return {
    send,
    async init() {
      await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "conc", version: "0.0.0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    },
    call: (name, args) => send("tools/call", { name, arguments: args ?? {} }),
    close() { child.kill(); },
  };
}

test("two processes, one data dir: every variant and every cover letter survives", async () => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "resume"], { encoding: "utf8" }).trim();
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-resume-conc-"));
  const dataHome = join(sandbox, "data");
  const a = client(dataHome, key);
  const b = client(dataHome, key);
  try {
    await Promise.all([a.init(), b.init()]);

    const setVariant = (c, tag, n) => c.call("profile_set", {
      variant: `${tag}${n}`,
      name: `Person ${tag}${n}`, email: `${tag}${n}@example.com`,
      skills: ["TypeScript"],
      experience: [{ company: `Company ${tag}${n}`, title: "Engineer", start: "2020", bullets: ["Shipped a thing"] }],
      education: [{ school: "University", degree: "BSc" }],
    });

    const jobs = [];
    for (let i = 1; i <= N; i++) { jobs.push(setVariant(a, "a", i)); jobs.push(setVariant(b, "b", i)); }
    const results = await Promise.all(jobs);
    for (const r of results) {
      assert.ok(r.result, `call failed: ${JSON.stringify(r.error)}`);
      assert.ok(!r.result.isError, r.result.content[0].text);
    }

    const file = join(dataHome, "mcp-servers", "resume", "profiles.json");
    assert.ok(existsSync(file), "profiles.json was never written");
    const stored = JSON.parse(readFileSync(file, "utf8"));
    const names = Object.keys(stored).sort();
    assert.equal(names.length, 2 * N, `expected ${2 * N} variants, got ${names.length}: ${names.join(", ")}`);
    for (let i = 1; i <= N; i++) {
      for (const tag of ["a", "b"]) {
        assert.ok(stored[`${tag}${i}`], `variant ${tag}${i} was lost`);
        assert.equal(stored[`${tag}${i}`].name, `Person ${tag}${i}`, `variant ${tag}${i} holds another variant's data`);
      }
    }

    // Cover letters read the default profile and append to a second shared file.
    const seed = await a.call("profile_set", {
      name: "Ada Rowe", email: "ada@example.com", skills: ["TypeScript"],
      experience: [{ company: "Acme Pay", title: "Engineer", start: "2020", bullets: ["Owned the ledger schema"] }],
      education: [{ school: "University", degree: "BSc" }],
    });
    assert.ok(seed.result && !seed.result.isError, JSON.stringify(seed.result ?? seed.error));

    const letters = [];
    for (let i = 1; i <= N; i++) {
      letters.push(a.call("cover_letter_create", { company: `Alpha ${i}`, role: "Engineer", tone: "direct" }));
      letters.push(b.call("cover_letter_create", { company: `Bravo ${i}`, role: "Engineer", tone: "direct" }));
    }
    for (const r of await Promise.all(letters)) {
      assert.ok(r.result && !r.result.isError, JSON.stringify(r.result ?? r.error));
    }
    const recorded = JSON.parse(readFileSync(join(dataHome, "mcp-servers", "resume", "letters.json"), "utf8"));
    assert.equal(recorded.length, 2 * N, `expected ${2 * N} letters, got ${recorded.length}`);
    const paths = new Set(recorded.map((l) => l.path));
    assert.equal(paths.size, 2 * N, "two letters were written to the same path");
    for (const p of paths) assert.ok(existsSync(p), `${p} was recorded but is not on disk`);
  } finally {
    a.close();
    b.close();
  }
});
