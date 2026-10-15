// Contract: the version a server announces in the MCP handshake (serverInfo.version)
// must equal the version in its own package.json. Before v0.6.1 these were independent
// string literals in src/index.ts and drifted up to five releases behind.
import "./_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SERVERS = readdirSync(join(ROOT, "servers")).sort()
  .filter((n) => existsSync(join(ROOT, "servers", n, "package.json")));

/** initialize one stdio server and return its serverInfo. */
function serverInfo(entry) {
  return new Promise((resolve, reject) => {
    const sandbox = mkdtempSync(join(tmpdir(), "mcp-ver-"));
    const child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, XDG_DATA_HOME: join(sandbox, "data"), XDG_CONFIG_HOME: join(sandbox, "config"), MCP_LICENSE_KEY: "" },
    });
    child.stderr.resume();
    const done = (fn, v) => { clearTimeout(timer); try { child.kill("SIGKILL"); } catch {} rmSync(sandbox, { recursive: true, force: true }); fn(v); };
    const timer = setTimeout(() => done(reject, new Error(`timeout: ${entry}`)), 30000);
    let buf = "";
    child.stdout.on("data", (c) => {
      buf += c.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) return done(resolve, msg.result?.serverInfo ?? {});
      }
    });
    child.on("error", (e) => done(reject, e));
    child.stdin.write(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "version-contract", version: "1.0.0" } },
    }) + "\n");
  });
}

for (const name of SERVERS) {
  const dir = join(ROOT, "servers", name);
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));

  test(`${name}: src/version.ts matches package.json`, (t) => {
    if (!existsSync(join(dir, "src", "index.ts"))) return t.skip("no src yet");
    const src = readFileSync(join(dir, "src", "version.ts"), "utf8");
    const m = /export const VERSION = "([^"]+)";/.exec(src);
    assert.ok(m, `servers/${name}/src/version.ts has no VERSION export`);
    assert.equal(m[1], pkg.version);
  });

  test(`${name}: src/index.ts announces no version literal`, (t) => {
    if (!existsSync(join(dir, "src", "index.ts"))) return t.skip("no src yet");
    const src = readFileSync(join(dir, "src", "index.ts"), "utf8");
    assert.ok(/version: VERSION/.test(src), `servers/${name}/src/index.ts does not pass VERSION to McpServer`);
  });

  test(`${name}: serverInfo.version equals package.json version`, { concurrency: 1 }, async (t) => {
    const entry = join(dir, "dist", "index.js");
    if (!existsSync(entry)) return t.skip("not built");
    const info = await serverInfo(entry);
    assert.equal(info.version, pkg.version, `${name} handshake says ${info.version}, package.json says ${pkg.version}`);
  });
}
