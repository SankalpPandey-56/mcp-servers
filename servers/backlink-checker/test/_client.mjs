// Shared stdio JSON-RPC client for the mcp-backlink-checker suites.
// This server is stateless — no data dir is written — but the same client shape
// is kept so the contract suite reads like every other suite in the estate.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey(product = "backlink-checker") {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), product], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-backlink-checker-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

export function client({ dataHome, key } = {}) {
  const env = { ...process.env };
  if (dataHome) env.XDG_DATA_HOME = dataHome;
  if (key) env.MCP_LICENSE_KEY = key; else delete env.MCP_LICENSE_KEY;
  const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { continue; }
      const r = pending.get(m.id);
      if (r) { pending.delete(m.id); r(m); }
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
      const r = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
      return r.result;
    },
    async tools() { return (await send("tools/list", {})).result.tools; },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      if (!r.result) return { text: JSON.stringify(r.error), isError: true };
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: r.result.isError === true };
    },
    close() { child.kill(); },
  };
}

export function cleanup(dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }

// Local fixture pages, so no contract test touches the network.
import { createServer } from "node:http";
export function linkPages() {
  const PAGES = {
    "/dofollow": `<!doctype html><html><head><title>Ref A</title></head><body>
      <p>See <a href="https://target.example">best widgets</a> for more.</p></body></html>`,
    "/nofollow": `<!doctype html><html><head><title>Ref B</title></head><body>
      <a href="https://target.example" rel="nofollow sponsored">sponsored widgets</a></body></html>`,
    "/noindex": `<!doctype html><html><head><meta name="robots" content="noindex, follow"></head><body>
      <a href="https://target.example">widgets</a></body></html>`,
    "/nolink": `<!doctype html><html><head><title>Ref D</title></head><body><p>nothing here</p></body></html>`,
  };
  const srv = createServer((req, res) => {
    const body = PAGES[req.url];
    if (!body) { res.writeHead(404, { "content-type": "text/html" }); res.end("<h1>404</h1>"); return; }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(body);
  });
  return new Promise((resolve) => srv.listen(0, "127.0.0.1", () => resolve({
    base: `http://127.0.0.1:${srv.address().port}`,
    close: () => srv.close(),
  })));
}
