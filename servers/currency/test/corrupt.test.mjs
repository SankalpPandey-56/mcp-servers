import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

const iso = (d) => d.toISOString().slice(0, 10);
const D0 = iso(new Date());
const DAILY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01"><Cube><Cube time='${D0}'>
<Cube currency='USD' rate='1.0812'/><Cube currency='PLN' rate='4.2650'/></Cube></Cube></gesmes:Envelope>`;

function ecbServer() {
  const srv = createServer((req, res) => { res.writeHead(200, { "content-type": "text/xml" }); res.end(DAILY_XML); });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, url: `http://127.0.0.1:${srv.address().port}` })));
}

function client(env) {
  const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MCP_LICENSE_KEY: "", ...env } });
  child.stderr.resume();
  let buf = "";
  const pending = new Map();
  child.stdout.on("data", (d) => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id).resolve(m); pending.delete(m.id); }
    }
  });
  let id = 0;
  const send = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    const to = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method}`)); } }, 20000);
    to.unref();
  });
  return {
    send,
    call: async (name, args) => {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `tools/call ${name} returned ${JSON.stringify(r.error)}`);
      return { text: r.result.content.map((c) => c.text).join("\n"), isError: !!r.result.isError };
    },
    close: () => child.kill(),
  };
}

async function init(c) {
  const r = await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "corrupt", version: "0" } });
  assert.ok(r.result?.serverInfo);
  c.send && c.send;
  return r.result;
}

const GARBAGE = '{"version":1,"rates":{"USD": 1.08,,,   <<< truncated by a full disk';

test("a corrupt rate cache is quarantined byte-for-byte, never overwritten", async (t) => {
  const { srv, url } = await ecbServer();
  const home = mkdtempSync(join(tmpdir(), "mcp-currency-corrupt-"));
  const dataHome = join(home, "data");
  const dir = join(dataHome, "mcp-servers", "currency");
  mkdirSync(dir, { recursive: true });
  const daily = join(dir, "daily.json");
  writeFileSync(daily, GARBAGE);

  const c = client({ XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(home, "config"), ECB_BASE_URL: url });
  t.after(() => { c.close(); srv.close(); });
  await init(c);

  const r = await c.call("convert", { amount: 100, from: "USD", to: "PLN" });
  assert.equal(r.isError, true);
  assert.match(r.text, /cache file is corrupt/);
  assert.match(r.text, /nothing was written/);

  const quarantined = readdirSync(dir).filter((f) => f.startsWith("daily.json.corrupt-"));
  assert.equal(quarantined.length, 1, "exactly one quarantine copy");
  assert.equal(readFileSync(join(dir, quarantined[0]), "utf8"), GARBAGE, "the bad bytes are preserved untouched");
  assert.equal(existsSync(join(dir, "daily.json.corrupt")), true, "a marker blocks every later call");
  assert.equal(existsSync(daily), false, "the corrupt file was moved, not left in place and not replaced by a fresh download");

  // The marker keeps failing until a human resolves it: a second call must not silently re-download.
  const again = await c.call("rates_latest", {});
  assert.equal(again.isError, true);
  assert.match(again.text, /Delete .*daily\.json\.corrupt to let the next call re-download/);
  assert.equal(existsSync(daily), false);

  // The marker explains itself to a model as well as to a human.
  const marker = JSON.parse(readFileSync(join(dir, "daily.json.corrupt"), "utf8"));
  assert.match(marker.quarantined, /daily\.json\.corrupt-/);
  assert.match(marker.hint, /nothing was overwritten/);
});

test("a corrupt history cache does not take the daily rates down with it", async (t) => {
  const { srv, url } = await ecbServer();
  const home = mkdtempSync(join(tmpdir(), "mcp-currency-corrupt2-"));
  const dataHome = join(home, "data");
  const dir = join(dataHome, "mcp-servers", "currency");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "history.json"), GARBAGE);

  const c = client({ XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(home, "config"), ECB_BASE_URL: url });
  t.after(() => { c.close(); srv.close(); });
  await init(c);

  const conv = JSON.parse((await c.call("convert", { amount: 100, from: "USD", to: "PLN" })).text);
  assert.equal(conv.result, "PLN 394.47", "today's conversion still works");

  const hist = await c.call("rate_history", { from: "USD", to: "PLN", days: 30 });
  assert.equal(hist.isError, true);
  assert.match(hist.text, /cache file is corrupt/);

  const st = await c.call("cache_status", {});
  assert.equal(st.isError, false, "cache_status reports on a broken cache instead of dying with it");
});
