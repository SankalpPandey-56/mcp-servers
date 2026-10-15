// Everything about a CALLER-SUPPLIED output path.
//
// The livelock this suite exists for: mkdirSync(recursive) never returns on a
// pseudo-filesystem. Measured on Linux in a node:22-alpine container, mkdir("/proc/nope")
// answers ENOENT in 0 ms, Node reads that as a missing parent and retries forever, and the
// call had not returned after 25 seconds. Seven servers in this repo shipped that bug. This
// one uses the bounded ancestor walk instead, and the /proc case is exercised HERE rather
// than assumed, on any machine that has a /proc.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { client, sandbox, writeProfile, cleanup, seed, proKey } from "./_client.mjs";

function open(t) {
  const box = sandbox();
  writeProfile(box.dataHome);
  const c = client({ dataHome: box.dataHome, key: proKey() });
  t.after(() => { c.close(); cleanup(box.dir); });
  return { box, c };
}

test("a pseudo-filesystem path fails fast instead of hanging the server", async (t) => {
  const { c } = open(t);
  await c.init();
  const { run } = await seed(c);

  // The case this whole file is about. It only exists on Linux, so it is SKIPPED where
  // there is no /proc rather than replaced by a path that merely looks equivalent. The
  // 30-second client timeout in _client.mjs is the livelock detector: before the bounded
  // walk, this call never came back and the suite reported "timeout on tools/call".
  if (existsSync("/proc")) {
    const started = Date.now();
    const r = await c.call("run_report", { run, out_path: "/proc/nope/report.txt" });
    assert.ok(r.isError, r.text);
    assert.ok(Date.now() - started < 10000, `the call took ${Date.now() - started} ms; the bounded walk is not being used`);
    assert.equal(existsSync("/proc/nope/report.txt"), false);
    assert.equal(existsSync("/proc/nope"), false);
  }
  if (existsSync("/sys")) assert.ok((await c.call("run_report", { run, out_path: "/sys/nope/report.txt" })).isError);
  if (existsSync("/dev")) assert.ok((await c.call("run_report", { run, out_path: "/dev/nope/report.txt" })).isError);

  // A path made unwritable in a way that behaves the same on every platform this ships to:
  // a regular file used as a directory, which is ENOTDIR immediately everywhere.
  const boxDir = mkdtempSync(join(tmpdir(), "cl-unwritable-"));
  const blocker = join(boxDir, "not-a-directory");
  writeFileSync(blocker, "x");
  const target = join(blocker, "report.txt");
  const r = await c.call("run_report", { run, out_path: target });
  assert.ok(r.isError, r.text);
  assert.equal(existsSync(target), false);
  cleanup(boxDir);
});

test("a normal nested path that does not exist yet is created, all levels of it", async (t) => {
  const { box, c } = open(t);
  await c.init();
  const { run } = await seed(c);
  const deep = join(box.dir, "a", "b", "c", "d", "report.txt");
  const w = await c.json("run_report", { run, out_path: deep });
  assert.equal(w.written, true);
  assert.equal(w.path, deep);
  assert.match(readFileSync(deep, "utf8"), /CHECKLIST {2}RUN-/);
  assert.equal(w.bytes, Buffer.byteLength(readFileSync(deep, "utf8")));
});

test("a URL is refused by name and the refusal does not leak the cwd", async (t) => {
  const { c } = open(t);
  await c.init();
  const { run } = await seed(c);
  for (const u of ["https://example.com/r.txt", "file:///tmp/r.txt", "s3://bucket/r.txt"]) {
    const r = await c.call("run_report", { run, out_path: u });
    assert.ok(r.isError, r.text);
    assert.match(r.text, /is a URL, not a file path/);
    assert.equal(r.text.includes(process.cwd()), false, `the refusal leaked the cwd: ${r.text}`);
  }
});

test("an existing file is refused, and overwrite replaces it", async (t) => {
  const { box, c } = open(t);
  await c.init();
  const { run } = await seed(c);
  const p = join(box.dir, "report.txt");
  writeFileSync(p, "OLD");
  const refused = await c.call("run_report", { run, out_path: p });
  assert.ok(refused.isError, refused.text);
  assert.match(refused.text, /already exists and nothing was written/);
  assert.equal(readFileSync(p, "utf8"), "OLD");
  const forced = await c.json("run_report", { run, out_path: p, overwrite: true });
  assert.equal(forced.written, true);
  assert.match(readFileSync(p, "utf8"), /CHECKLIST {2}RUN-/);
});

test("the extension is added when it is missing and not doubled when it is there", async (t) => {
  const { box, c } = open(t);
  await c.init();
  const { run } = await seed(c);
  assert.equal((await c.json("run_report", { run, out_path: join(box.dir, "one") })).path, join(box.dir, "one.txt"));
  assert.equal((await c.json("run_report", { run, out_path: join(box.dir, "two.txt") })).path, join(box.dir, "two.txt"));
  assert.equal((await c.json("run_report", { run, out_path: join(box.dir, "three.TXT") })).path, join(box.dir, "three.TXT"));
});

test("a tilde path expands to the home directory rather than being taken literally", async (t) => {
  const { c } = open(t);
  await c.init();
  const { run } = await seed(c);
  const { homedir } = await import("node:os");
  const rel = `mcp-purchase-requisition-test-${process.pid}`;
  const r = await c.json("run_report", { run, out_path: `~/${rel}/report.txt` });
  assert.equal(r.path, join(homedir(), rel, "report.txt"));
  assert.ok(existsSync(r.path));
  cleanup(join(homedir(), rel));
});
