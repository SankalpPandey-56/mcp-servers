import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");

const D0 = new Date().toISOString().slice(0, 10);
const DAILY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01"><Cube><Cube time='${D0}'>
<Cube currency='USD' rate='1.0812'/><Cube currency='PLN' rate='4.2650'/></Cube></Cube></gesmes:Envelope>`;

let hits = 0;
/** Answers slowly, so every process is inside the refresh window at the same time. */
function slowEcb() {
  const srv = createServer((req, res) => {
    hits++;
    setTimeout(() => { res.writeHead(200, { "content-type": "text/xml" }); res.end(DAILY_XML); }, 250);
  });
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
    const to = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error(`timeout on ${method}`)); } }, 30000);
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
  const r = await c.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "conc", version: "0" } });
  assert.ok(r.result?.serverInfo);
}

test("four processes refreshing the same cache at once leave exactly one valid file", async (t) => {
  const { srv, url } = await slowEcb();
  const home = mkdtempSync(join(tmpdir(), "mcp-currency-conc-"));
  const dataHome = join(home, "data");
  const env = { XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(home, "cfg"), ECB_BASE_URL: url };

  const clients = [client(env), client(env), client(env), client(env)];
  t.after(() => { for (const c of clients) c.close(); srv.close(); });
  await Promise.all(clients.map(init));

  // The cache refresh is the only write this server does; fire all four at the same instant.
  const results = await Promise.all(clients.map((c) => c.call("convert", { amount: 100, from: "USD", to: "PLN" })));
  for (const r of results) {
    assert.equal(r.isError, false, r.text);
    const j = JSON.parse(r.text);
    assert.equal(j.result, "PLN 394.47", "every process returns the same number off the same rate date");
    assert.equal(j.rate_date, D0);
  }

  assert.equal(hits, 1, "the lock collapsed four concurrent refreshes into one download");

  const dir = join(dataHome, "mcp-servers", "currency");
  const files = readdirSync(dir);
  assert.deepEqual(files.filter((f) => f.endsWith(".tmp")), [], "no half-written temp file survives");
  assert.deepEqual(files.filter((f) => f.includes(".corrupt")), [], "nothing was quarantined");
  assert.deepEqual(files.filter((f) => f === "daily.json"), ["daily.json"]);

  const cache = JSON.parse(readFileSync(join(dir, "daily.json"), "utf8"));
  assert.equal(cache.version, 1);
  assert.equal(cache.date, D0);
  assert.equal(cache.rates.USD, 1.0812);
});
