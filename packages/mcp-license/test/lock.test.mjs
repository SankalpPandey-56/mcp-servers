import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withFileLock, STALE_MS } from "../dist/index.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("two async holders serialize", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-lock-"));
  const lock = join(dir, ".lock");
  const events = [];
  let concurrent = 0, maxConcurrent = 0;
  const hold = async (tag) => withFileLock(lock, async () => {
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    events.push(`${tag}:in`);
    await sleep(40);
    events.push(`${tag}:out`);
    concurrent -= 1;
  });
  await Promise.all([hold("a"), hold("b")]);
  assert.equal(maxConcurrent, 1, "holders overlapped");
  assert.equal(events.length, 4);
  assert.equal(events[1], events[0].replace(":in", ":out"), `interleaved: ${events.join(",")}`);
  assert.equal(existsSync(lock), false, "lock not released");
  rmSync(dir, { recursive: true, force: true });
});

test("lock is released when the body throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-lock-"));
  const lock = join(dir, ".lock");
  await assert.rejects(withFileLock(lock, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(lock), false);
  assert.equal(await withFileLock(lock, () => 7), 7);
  rmSync(dir, { recursive: true, force: true });
});

test("stale lock is recovered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-lock-"));
  const lock = join(dir, ".lock");
  mkdirSync(lock);
  const old = (Date.now() - STALE_MS - 5_000) / 1000;
  utimesSync(lock, old, old);
  const t0 = Date.now();
  assert.equal(await withFileLock(lock, () => "ok", { timeoutMs: 2000 }), "ok");
  assert.ok(Date.now() - t0 < 1500, "stale lock should be reaped promptly");
  assert.equal(existsSync(lock), false);
  rmSync(dir, { recursive: true, force: true });
});

test("a fresh lock held by someone else times out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-lock-"));
  const lock = join(dir, ".lock");
  mkdirSync(lock);
  await assert.rejects(withFileLock(lock, () => "never", { timeoutMs: 120 }), /timed out/);
  assert.equal(existsSync(lock), true, "a foreign fresh lock must not be removed");
  rmSync(dir, { recursive: true, force: true });
});

test("lock creates a missing parent directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-lock-"));
  const lock = join(dir, "nested", "data", ".lock");
  assert.equal(await withFileLock(lock, () => "made"), "made");
  assert.equal(existsSync(lock), false);
  rmSync(dir, { recursive: true, force: true });
});
