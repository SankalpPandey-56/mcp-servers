import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "dist", "index.js");

// Local fixture pages, so no network is touched.
const PAGES = {
  "/dofollow": `<!doctype html><html><head><title>Ref A</title></head><body>
    <p>See <a href="https://target.example">best widgets</a> for more.</p></body></html>`,
  "/nofollow": `<!doctype html><html><head><title>Ref B</title></head><body>
    <a href="https://target.example" rel="nofollow sponsored">sponsored widgets</a></body></html>`,
  "/noindex": `<!doctype html><html><head><meta name="robots" content="noindex, follow"></head><body>
    <a href="https://target.example">widgets</a></body></html>`,
  "/nolink": `<!doctype html><html><head><title>Ref D</title></head><body><p>nothing here</p></body></html>`,
  "/subdomain": `<!doctype html><html><body><a href="https://www.target.example/page">www link</a></body></html>`,
};

function startPages() {
  const srv = createServer((req, res) => {
    const body = PAGES[req.url];
    if (!body) { res.writeHead(404, { "content-type": "text/html" }); res.end("<h1>404</h1>"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

function rpc(proc, id, method, params) {
  return new Promise((resolve, reject) => {
    const onData = (d) => {
      for (const line of d.toString().split("\n")) {
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === id) { proc.stdout.off("data", onData); return resolve(msg.result); }
      }
    };
    proc.stdout.on("data", onData);
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    setTimeout(() => { proc.stdout.off("data", onData); reject(new Error(`rpc timeout ${method}`)); }, 15000);
  });
}

test("tools/list exposes link_check, link_audit, robots_guard_check with annotations", async () => {
  const { srv, base } = await startPages();
  const proc = spawn(process.execPath, [entry], {
    env: { ...process.env, XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "blc-")) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await rpc(proc, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const { tools } = await rpc(proc, 2, "tools/list", {});
    const names = tools.map((t) => t.name);
    for (const n of ["link_check", "link_audit", "robots_guard_check", "license_status"]) assert.ok(names.includes(n), `missing ${n}`);
    for (const t of tools) {
      if (t.name.startsWith("license_")) continue; // gate-injected, managed by @theluckystrike/mcp-license
      assert.ok(t.title, `${t.name} missing title annotation`);
      assert.ok(typeof t.annotations?.readOnlyHint === "boolean", `${t.name} missing readOnlyHint`);
    }
  } finally { proc.kill(); srv.close(); }
});

test("link_check: dofollow vs nofollow, anchor text, noindex guard", async () => {
  const { srv, base } = await startPages();
  const proc = spawn(process.execPath, [entry], {
    env: { ...process.env, XDG_DATA_HOME: mkdtempSync(join(tmpdir(), "blc-")) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    await rpc(proc, 1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

    const good = await rpc(proc, 3, "tools/call", { name: "link_check", arguments: { page_url: `${base}/dofollow`, target_domain: "target.example" } });
    const g = good.content[0].text;
    assert.match(g, /Status: 200/);
    assert.match(g, /DOFOLLOW/);
    assert.match(g, /best widgets/);

    const bad = await rpc(proc, 4, "tools/call", { name: "link_check", arguments: { page_url: `${base}/nofollow`, target_domain: "target.example" } });
    assert.match(bad.content[0].text, /nofollow/);
    assert.doesNotMatch(bad.content[0].text, /DOFOLLOW/);
    assert.match(bad.content[0].text, /sponsored widgets/);

    const guard = await rpc(proc, 5, "tools/call", { name: "link_check", arguments: { page_url: `${base}/noindex`, target_domain: "target.example" } });
    assert.match(guard.content[0].text, /NOINDEX/);

    const none = await rpc(proc, 6, "tools/call", { name: "link_check", arguments: { page_url: `${base}/nolink`, target_domain: "target.example" } });
    assert.match(none.content[0].text, /does not link/);

    const sub = await rpc(proc, 7, "tools/call", { name: "link_check", arguments: { page_url: `${base}/subdomain`, target_domain: "target.example" } });
    assert.match(sub.content[0].text, /DOFOLLOW/);
    assert.match(sub.content[0].text, /www link/);
  } finally { proc.kill(); srv.close(); }
});
