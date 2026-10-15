// Shared stdio JSON-RPC client and image fixture builders for the mcp-image tests.
// Every fixture is generated here with jimp; nothing binary is committed.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Jimp } from "jimp";

const here = dirname(fileURLToPath(import.meta.url));
export const ENTRY = join(here, "..", "dist", "index.js");
export const REPO = join(here, "..", "..", "..");

export function proKey() {
  return execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "image"], { encoding: "utf8" }).trim();
}

export function sandbox(prefix = "mcp-image-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dataHome: join(dir, "data") };
}

export function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
    const t = setTimeout(() => { if (pending.has(mid)) { pending.delete(mid); rej(new Error(`timeout on ${method}`)); } }, 60000);
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

/** A deterministic noisy image: noise is what makes a JPEG quality change visible in bytes. */
export function noisy(width, height, seed = 1) {
  const img = new Jimp({ width, height, color: 0x000000ff });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const r = (x * 37 + y * 91 + seed * 13) % 256;
      const g = (x * 13 + y * 7 + seed * 29) % 256;
      const b = (x * 5 + y * 53 + seed * 61) % 256;
      img.setPixelColor((((r << 24) | (g << 16) | (b << 8) | 0xff) >>> 0), x, y);
    }
  }
  return img;
}

export async function makePng(path, width = 120, height = 80, seed = 1) {
  writeFileSync(path, await noisy(width, height, seed).getBuffer("image/png"));
  return path;
}

/** A PNG with a real alpha channel: the left half is transparent. */
export async function makeAlphaPng(path, width = 60, height = 40) {
  const img = noisy(width, height, 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width / 2; x++) img.setPixelColor(0x00000000, x, y);
  writeFileSync(path, await img.getBuffer("image/png"));
  return path;
}

export async function makeJpeg(path, width = 200, height = 150, quality = 100, seed = 2) {
  writeFileSync(path, await noisy(width, height, seed).getBuffer("image/jpeg", { quality }));
  return path;
}

/**
 * A JPEG carrying an APP1 EXIF block, built by splicing the segment in after SOI, which
 * is exactly where a camera writes it. jimp's encoder never emits one, so this is the
 * only way to have something for image_strip_metadata to remove.
 */
export async function makeJpegWithExif(path, width = 120, height = 90) {
  const base = await noisy(width, height, 7).getBuffer("image/jpeg", { quality: 90 });
  const payload = Buffer.concat([
    Buffer.from("Exif\0\0", "latin1"),
    Buffer.from("MM\0*\0\0\0\x08\0\x01\x01\x0e\0\x02\0\0\0\x14SECRET-GPS-PLACE\0\0\0\0\0\0", "latin1"),
  ]);
  const len = payload.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]), payload]);
  writeFileSync(path, Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]));
  return path;
}

/**
 * A decompression bomb: a small, otherwise valid PNG whose IHDR declares 20000x20000,
 * which is 1.6 GB of RGBA if anything decodes it.
 */
export async function makeBombPng(path, declared = 20000) {
  const b = Buffer.from(await noisy(8, 8, 5).getBuffer("image/png"));
  b.writeUInt32BE(declared, 16);
  b.writeUInt32BE(declared, 20);
  writeFileSync(path, b);
  return path;
}

export async function dimensions(path) {
  const img = await Jimp.read(readFileSync(path));
  return { width: img.width, height: img.height };
}

export async function readImage(path) {
  return Jimp.read(readFileSync(path));
}
