// Run-scoped temp root for every test process in this repo. Not a test file itself.
//
// Importing this module (once per process; ESM caches it) creates one directory
// `mcp-test-run-<pid>-XXXXXX` under the current tmpdir, points process.env.TMPDIR at it
// so every later os.tmpdir()/mkdtemp call in the test - and every server child it spawns
// with { ...process.env } - lands inside it, and removes the whole tree when the process
// exits (normal exit, process.exit, SIGINT, SIGTERM, SIGHUP). Fixtures of 50-200 MB that
// the adversarial suites write therefore never outlive the test file that made them.
//
// A run killed with SIGKILL cannot clean up after itself, so the next import also removes
// `mcp-test-run-<pid>-*` directories whose owning pid is no longer alive.
import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PREFIX = "mcp-test-run-";
const base = tmpdir();

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

// Tests chmod directories read-only to provoke write errors; restore owner rwx so the
// tree can be removed.
function unlock(p) {
  let st;
  try { st = lstatSync(p); } catch { return; }
  if (!st.isDirectory()) return;
  try { chmodSync(p, 0o700); } catch { /* not ours to change */ }
  let names = [];
  try { names = readdirSync(p); } catch { return; }
  for (const n of names) unlock(join(p, n));
}

export function removeTree(p) {
  try { rmSync(p, { recursive: true, force: true, maxRetries: 3 }); return; } catch { /* fall through */ }
  unlock(p);
  try { rmSync(p, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort */ }
}

// Sweep scopes left behind by runs that were killed before their exit hook ran.
try {
  for (const name of readdirSync(base)) {
    const m = /^mcp-test-run-(\d+)-/.exec(name);
    if (m && Number(m[1]) !== process.pid && !alive(Number(m[1]))) removeTree(join(base, name));
  }
} catch { /* tmpdir unreadable: nothing to sweep */ }

export const TEST_TMP_ROOT = mkdtempSync(join(base, `${PREFIX}${process.pid}-`));
process.env.TMPDIR = TEST_TMP_ROOT;

let done = false;
function cleanup() {
  if (done) return;
  done = true;
  removeTree(TEST_TMP_ROOT);
}
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  const onSignal = () => {
    cleanup();
    process.removeListener(sig, onSignal);
    process.kill(process.pid, sig);
  };
  process.on(sig, onSignal);
}
