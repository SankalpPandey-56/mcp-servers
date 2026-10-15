// Two server processes on one data dir must not lose documents or repeat a reference.
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

test("two processes, one data dir: 20 concurrent documents all persist with unique references", async () => {
  const key = execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "docx"], { encoding: "utf8" }).trim();
  const sandbox = mkdtempSync(join(tmpdir(), "mcp-docx-conc-"));
  const dataHome = join(sandbox, "data");
  const a = client(dataHome, key);
  const b = client(dataHome, key);
  try {
    await Promise.all([a.init(), b.init()]);
    await a.call("business_set", { name: "Acme Consulting", default_currency: "EUR" });

    const proposal = (c, tag, n) => c.call("proposal_create", {
      client: `Client ${tag}${n}`, project_title: `Job ${tag}${n}`, summary: "Summary.",
      scope: ["a"], deliverables: ["b"], timeline: [{ phase: "Build", duration: "1 week" }],
      price: { amount: 1000 + n, currency: "EUR", terms: "on delivery" },
    });

    const jobs = [];
    for (let i = 1; i <= N; i++) { jobs.push(proposal(a, "A", i)); jobs.push(proposal(b, "B", i)); }
    const results = await Promise.all(jobs);
    for (const r of results) {
      assert.ok(r.result, `call failed: ${JSON.stringify(r.error)}`);
      assert.ok(!r.result.isError, r.result.content[0].text);
    }

    const docs = JSON.parse(readFileSync(join(dataHome, "mcp-servers", "docx", "documents.json"), "utf8"));
    assert.equal(docs.length, 2 * N, `expected ${2 * N} stored documents, got ${docs.length}`);
    const numbers = docs.map((d) => d.number);
    assert.equal(new Set(numbers).size, numbers.length, `duplicate reference numbers: ${numbers.join(", ")}`);
    const year = new Date().toISOString().slice(0, 4);
    const expected = Array.from({ length: 2 * N }, (_, i) => `PROP-${year}-${String(i + 1).padStart(4, "0")}`);
    assert.deepEqual([...numbers].sort(), expected.sort(), "the counter must allocate a contiguous run with no gaps");
    for (const d of docs) assert.ok(existsSync(d.path), `${d.path} was recorded but not written`);

    const counters = JSON.parse(readFileSync(join(dataHome, "mcp-servers", "docx", "counter.json"), "utf8"));
    assert.equal(counters[`PROP-${year}`], 2 * N);

    // The recent-documents resource still parses and reports every write.
    const recent = JSON.parse((await a.send("resources/read", { uri: "docs://recent" })).result.contents[0].text);
    assert.equal(recent.length, 20);
    assert.equal(new Set(recent.map((d) => d.id)).size, 20);
  } finally {
    a.close(); b.close();
  }
});
