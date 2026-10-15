// Shared stdio JSON-RPC client and PDF fixture builders for the mcp-pdf tests.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey() {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "pdf"], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-pdf-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

export function client({ dataHome, key, cwd } = {}) {
  const env = { ...process.env, XDG_DATA_HOME: dataHome, XDG_CONFIG_HOME: join(dataHome ?? tmpdir(), "cfg") };
  if (key) env.MCP_LICENSE_KEY = key; else delete env.MCP_LICENSE_KEY;
  const child = spawn(process.execPath, [ENTRY], { stdio: ["pipe", "pipe", "pipe"], env, cwd });
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
      let msg;
      try { msg = JSON.parse(line); } catch { throw new Error(`non-JSON on stdout: ${line}`); }
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
      const r = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return r;
    },
    call: (name, args) => send("tools/call", { name, arguments: args ?? {} }),
    async text(name, args) {
      const r = await this.call(name, args);
      if (r.error) throw new Error(`${name} returned a protocol error: ${JSON.stringify(r.error)}`);
      return r.result.content.map((c) => c.text).join("\n");
    },
    close() { child.kill(); },
  };
}

/** A fixture with `pages` pages; page n carries the line "PAGE n <label>" in a standard font. */
export async function makePdf(path, pages, label = "fixture") {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let n = 1; n <= pages; n++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`PAGE ${n} ${label}`, { x: 60, y: 760, size: 18, font, color: rgb(0, 0, 0) });
  }
  doc.setTitle(label);
  writeFileSync(path, await doc.save({ useObjectStreams: false }));
  return path;
}

/** An invoice-shaped fixture whose text pdf_text must be able to read back. */
export async function makeInvoicePdf(path, reference = "INV-2026-0007") {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595.28, 841.89]);
  page.drawText(`Invoice ${reference}`, { x: 60, y: 760, size: 20, font });
  page.drawText("Beta Corp, Warsaw", { x: 60, y: 730, size: 12, font });
  page.drawText("Total EUR 4,500.00", { x: 60, y: 700, size: 12, font });
  writeFileSync(path, await doc.save({ useObjectStreams: false }));
  return path;
}

/**
 * pdf-lib cannot write an encrypted PDF, so the fixture is a valid PDF with an
 * /Encrypt reference added to its trailer - which is exactly the signal a reader uses.
 */
export async function makeEncryptedPdf(path) {
  const doc = await PDFDocument.create();
  doc.addPage([200, 200]);
  const s = Buffer.from(await doc.save({ useObjectStreams: false })).toString("latin1")
    .replace("trailer\n<<\n", "trailer\n<<\n/Encrypt 3 0 R\n");
  writeFileSync(path, Buffer.from(s, "latin1"));
  return path;
}
