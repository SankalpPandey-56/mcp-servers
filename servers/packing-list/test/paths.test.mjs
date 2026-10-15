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
  const id = await seed(c);

  // The case this whole file is about. It only exists on Linux, so it is SKIPPED where
  // there is no /proc rather than replaced by a path that merely looks equivalent. The
  // 30-second client timeout in _client.mjs is the livelock detector: before the bounded
  // walk, this call never came back and the suite reported "timeout on tools/call".
  if (existsSync("/proc")) {
    const started = Date.now();
    const r = await c.call("packing_slip", { packing_list: id, out_path: "/proc/nope/slip.txt" });
    assert.ok(r.isError, r.text);
    assert.ok(Date.now() - started < 10000, `the call took ${Date.now() - started} ms; the bounded walk is not being used`);
    assert.equal(existsSync("/proc/nope/slip.txt"), false);
    assert.equal(existsSync("/proc/nope"), false);
  }
  if (existsSync("/sys")) {
    const r = await c.call("packing_slip", { packing_list: id, out_path: "/sys/nope/slip.txt" });
    assert.ok(r.isError, r.text);
  }
  if (existsSync("/dev")) {
    const r = await c.call("packing_slip", { packing_list: id, out_path: "/dev/nope/slip.txt" });
    assert.ok(r.isError, r.text);
  }

  // A path made unwritable in a way that behaves the same on every platform this ships to:
  // a regular file used as a directory, which is ENOTDIR immediately everywhere.
  const boxDir = mkdtempSync(join(tmpdir(), "pl-unwritable-"));
  const blocker = join(boxDir, "not-a-directory");
  writeFileSync(blocker, "x");
  const target = join(blocker, "slip.txt");
  const r = await c.call("packing_slip", { packing_list: id, out_path: target });
  assert.ok(r.isError, r.text);
  assert.equal(existsSync(target), false);
  cleanup(boxDir);
});

test("a normal nested path that does not exist yet is created, all levels of it", async (t) => {
  const { box, c } = open(t);
  await c.init();
  const id = await seed(c);
  const deep = join(box.dir, "a", "b", "c", "d", "slip.txt");
  const w = await c.json("packing_slip", { packing_list: id, out_path: deep });
  assert.equal(w.written, true);
  assert.equal(w.path, deep);
  assert.match(readFileSync(deep, "utf8"), /PACKING SLIP/);
  assert.equal(w.bytes, Buffer.byteLength(readFileSync(deep, "utf8")));
});

test("a URL is refused by name and the refusal does not leak the cwd", async (t) => {
  const { c } = open(t);
  await c.init();
  const id = await seed(c);
  for (const u of ["https://example.com/slip.txt", "file:///tmp/slip.txt", "s3://bucket/slip.txt"]) {
    const r = await c.call("packing_slip", { packing_list: id, out_path: u });
    assert.ok(r.isError, r.text);
    assert.match(r.text, /is a URL, not a file path/);
    assert.equal(r.text.includes(process.cwd()), false, `the refusal leaked the cwd: ${r.text}`);
  }
});

test("an existing file is refused, and overwrite replaces it", async (t) => {
  const { box, c } = open(t);
  await c.init();
  const id = await seed(c);
  const p = join(box.dir, "slip.txt");
  writeFileSync(p, "OLD");
  const refused = await c.call("packing_slip", { packing_list: id, out_path: p });
  assert.ok(refused.isError, refused.text);
  assert.match(refused.text, /already exists and nothing was written/);
  assert.equal(readFileSync(p, "utf8"), "OLD");
  const forced = await c.json("packing_slip", { packing_list: id, out_path: p, overwrite: true });
  assert.equal(forced.written, true);
  assert.match(readFileSync(p, "utf8"), /PACKING SLIP/);
});

test("the extension is added when it is missing and not doubled when it is there", async (t) => {
  const { box, c } = open(t);
  await c.init();
  const id = await seed(c);
  const a = await c.json("packing_slip", { packing_list: id, out_path: join(box.dir, "one") });
  assert.equal(a.path, join(box.dir, "one.txt"));
  const b = await c.json("packing_slip", { packing_list: id, out_path: join(box.dir, "two.txt") });
  assert.equal(b.path, join(box.dir, "two.txt"));
  const cUp = await c.json("packing_slip", { packing_list: id, out_path: join(box.dir, "three.TXT") });
  assert.equal(cUp.path, join(box.dir, "three.TXT"), "an upper-case extension must not be doubled");
});

test("a tilde path expands to the home directory rather than being taken literally", async (t) => {
  const { c } = open(t);
  await c.init();
  const id = await seed(c);
  const { homedir } = await import("node:os");
  // Written into a directory that certainly does not exist under home, then checked and
  // removed, so the test never leaves a file in a real home directory it did not make.
  const rel = `mcp-packing-list-test-${process.pid}`;
  const r = await c.json("packing_slip", { packing_list: id, out_path: `~/${rel}/slip.txt` });
  assert.equal(r.path, join(homedir(), rel, "slip.txt"));
  assert.ok(existsSync(r.path));
  cleanup(join(homedir(), rel));
});
