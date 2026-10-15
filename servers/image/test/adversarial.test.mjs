// Adversarial probes for mcp-image: the cases from docs/IMAGE_AUDIT.md that turned into
// fixes. Every fixture is generated here; nothing binary is committed.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { client, sandbox, sha256, proKey, makePng, makeJpeg, noisy } from "./_client.mjs";

/** A 2-frame GIF89a, hand-built: jimp cannot write animation, so this is the only source. */
function animatedGif(path) {
  const parts = [Buffer.from("GIF89a", "latin1")];
  const lsd = Buffer.alloc(7);
  lsd.writeUInt16LE(4, 0); lsd.writeUInt16LE(4, 2); lsd[4] = 0x80;
  parts.push(lsd, Buffer.from([0xff, 0x00, 0x00, 0x00, 0x00, 0xff]));
  parts.push(Buffer.from([0x21, 0xff, 0x0b]), Buffer.from("NETSCAPE2.0", "latin1"), Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]));
  const frame = (ci) => {
    const gce = Buffer.from([0x21, 0xf9, 0x04, 0x04, 0x32, 0x00, 0x00, 0x00]);
    const d = Buffer.alloc(10);
    d[0] = 0x2c; d.writeUInt16LE(4, 5); d.writeUInt16LE(4, 7);
    const codes = [4, ...Array(16).fill(ci), 5];
    let acc = 0, n = 0; const out = [];
    for (const c of codes) { acc |= c << n; n += 3; while (n >= 8) { out.push(acc & 0xff); acc >>= 8; n -= 8; } }
    if (n) out.push(acc & 0xff);
    return Buffer.concat([gce, d, Buffer.from([0x02, out.length]), Buffer.from(out), Buffer.from([0x00])]);
  };
  writeFileSync(path, Buffer.concat([...parts, frame(0), frame(1), Buffer.from([0x3b])]));
  return path;
}

/** A JPEG carrying EXIF Orientation 6, so the decoder turns it a quarter and swaps w/h. */
async function orientedJpeg(path, w = 400, h = 200) {
  const base = Buffer.from(await noisy(w, h, 9).getBuffer("image/jpeg", { quality: 90 }));
  const tiff = Buffer.alloc(26);
  tiff.write("MM", 0, "latin1"); tiff.writeUInt16BE(42, 2); tiff.writeUInt32BE(8, 4);
  tiff.writeUInt16BE(1, 8);
  tiff.writeUInt16BE(0x0112, 10); tiff.writeUInt16BE(3, 12); tiff.writeUInt32BE(1, 14); tiff.writeUInt16BE(6, 18);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const len = payload.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]), payload]);
  writeFileSync(path, Buffer.concat([base.subarray(0, 2), app1, base.subarray(2)]));
  return path;
}

/** A PNG whose IDAT bytes are flipped: a valid container with an undecodable payload. */
async function corruptChunkPng(path) {
  const good = Buffer.from(await noisy(120, 80, 1).getBuffer("image/png"));
  const at = good.indexOf(Buffer.from("IDAT", "latin1"));
  for (let k = at + 10; k < at + 40; k++) good[k] ^= 0xff;
  writeFileSync(path, good);
  return path;
}

/** A bomb in each container: 20000x20000 declared in a header that costs nothing to read. */
async function bombs(dir) {
  const out = {};
  const g = Buffer.from(await noisy(8, 8, 6).getBuffer("image/gif"));
  g.writeUInt16LE(20000, 6); g.writeUInt16LE(20000, 8);
  writeFileSync(out.gif = join(dir, "bomb.gif"), g);
  const b = Buffer.from(await noisy(8, 8, 6).getBuffer("image/bmp"));
  b.writeInt32LE(20000, 18); b.writeInt32LE(20000, 22);
  writeFileSync(out.bmp = join(dir, "bomb.bmp"), b);
  const j = Buffer.from(await noisy(8, 8, 6).getBuffer("image/jpeg", { quality: 80 }));
  for (let i = 2; i + 9 < j.length;) {
    if (j[i] !== 0xff) { i++; continue; }
    const m = j[i + 1];
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      j.writeUInt16BE(20000, i + 5); j.writeUInt16BE(20000, i + 7); break;
    }
    i += 2 + j.readUInt16BE(i + 2);
  }
  writeFileSync(out.jpeg = join(dir, "bomb.jpg"), j);
  const t = Buffer.alloc(200);
  t.write("II", 0, "latin1"); t.writeUInt16LE(42, 2); t.writeUInt32LE(8, 4); t.writeUInt16LE(2, 8);
  for (const [off, tag] of [[10, 0x0100], [22, 0x0101]]) {
    t.writeUInt16LE(tag, off); t.writeUInt16LE(4, off + 2); t.writeUInt32LE(1, off + 4); t.writeUInt32LE(20000, off + 8);
  }
  writeFileSync(out.tiff = join(dir, "bomb.tif"), t);
  return out;
}

test("the bomb guard covers JPEG, GIF, BMP and TIFF, not only PNG", async () => {
  const { dir, dataHome } = sandbox("adv-bomb-");
  const b = await bombs(dir);
  const c = client({ dataHome });
  try {
    await c.init();
    for (const [fmt, path] of Object.entries(b)) {
      const t = await c.text("image_resize", { path, width: 50, out_path: join(dir, `${fmt}.out.png`) });
      assert.match(t, /declares 20000x20000/, `${fmt} was not refused on its header`);
      assert.match(t, /Nothing was decoded/);
      assert.equal(existsSync(join(dir, `${fmt}.out.png`)), false);
    }
  } finally { c.close(); }
});

test("a 60 MB file is refused on its size before a byte is decoded", async (ctx) => {
  const { dir, dataHome } = sandbox("adv-big-");
  ctx.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = readFileSync(await makeJpeg(join(dir, "a.jpg"), 200, 150, 90));
  const big = join(dir, "big.jpg");
  writeFileSync(big, Buffer.concat([base, Buffer.alloc(60 * 1024 * 1024 - base.length, 0x20)]));
  const c = client({ dataHome });
  try {
    await c.init();
    const t = await c.text("image_info", { path: big });
    assert.match(t, /is 60\.0 MB; this server refuses inputs over 50\.0 MB/);
  } finally { c.close(); }
});

test("a PNG with a corrupt IDAT is refused with the decoder's reason and writes nothing", async () => {
  const { dir, dataHome } = sandbox("adv-corrupt-");
  const bad = await corruptChunkPng(join(dir, "bad.png"));
  const c = client({ dataHome });
  try {
    await c.init();
    assert.match(await c.text("image_info", { path: bad }), /could not be decoded as PNG/);
    const t = await c.text("image_resize", { path: bad, width: 50, out_path: join(dir, "o.png") });
    assert.match(t, /could not be decoded as PNG/);
    assert.equal(existsSync(join(dir, "o.png")), false);
  } finally { c.close(); }
});

test("EXIF orientation is applied on read and image_info says the header disagrees", async () => {
  const { dir, dataHome } = sandbox("adv-orient-");
  const src = await orientedJpeg(join(dir, "o.jpg"));
  const c = client({ dataHome });
  try {
    await c.init();
    const info = JSON.parse(await c.text("image_info", { path: src }));
    // The SOF says 400x200; Orientation 6 turns it, so what the user sees is 200x400.
    assert.equal(info.width, 200);
    assert.equal(info.height, 400);
    assert.equal(info.declared_in_header, "400x200");
    assert.match(info.orientation_note, /applied on read/);
    assert.match(info.orientation_note, /will not be turned a second time/);
    const t = await c.text("image_resize", { path: src, width: 100, out_path: join(dir, "s.jpg") });
    assert.match(t, /Resized 200x400 to 100x200/);
  } finally { c.close(); }
});

test("an animated GIF is read as its first frame and every answer says so", async () => {
  const { dir, dataHome } = sandbox("adv-gif-");
  const src = animatedGif(join(dir, "anim.gif"));
  const c = client({ dataHome });
  try {
    await c.init();
    const info = JSON.parse(await c.text("image_info", { path: src }));
    assert.equal(info.frames, 2);
    assert.match(info.animation_note, /first frame only/);
    const t = await c.text("image_convert", { path: src, format: "png", out_path: join(dir, "a.png") });
    assert.match(t, /animated GIF with 2 frames/);
    assert.match(t, /does not write animation/);
  } finally { c.close(); }
});

test("a truncated GIF's decoder warning does not reach stdout", async () => {
  // omggif prints "Warning, gif stream shorter than expected." with console.log. On stdout
  // that is a bare line of English in the middle of the JSON-RPC stream; the client here
  // throws on any stdout line that is not JSON, so this test is the assertion.
  const { dir, dataHome } = sandbox("adv-stdout-");
  const full = readFileSync(animatedGif(join(dir, "anim.gif")));
  const cut = join(dir, "cut.gif");
  writeFileSync(cut, full.subarray(0, full.length - 12));
  const c = client({ dataHome });
  try {
    await c.init();
    await c.call("image_info", { path: cut });
    await c.call("image_convert", { path: cut, format: "png", out_path: join(dir, "c.png") });
    const still = await c.text("image_info", { path: await makePng(join(dir, "ok.png"), 40, 30) });
    assert.match(still, /"width": 40/);
  } finally { c.close(); }
});

test("a 16-bit PNG decodes and is re-encoded at 8 bits per channel", async () => {
  const { dir, dataHome } = sandbox("adv-16bit-");
  const w = 32, h = 32;
  const raw = Buffer.alloc(h * (1 + w * 6));
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 6);
    for (let x = 0; x < w; x++) {
      const o = off + 1 + x * 6;
      raw.writeUInt16BE((x * 2048) % 65536, o);
      raw.writeUInt16BE((y * 2048) % 65536, o + 2);
      raw.writeUInt16BE(((x + y) * 1024) % 65536, o + 4);
    }
  }
  const table = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = (buf) => { let c = 0xffffffff; for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, cc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 16; ihdr[9] = 2;
  const src = join(dir, "d16.png");
  writeFileSync(src, Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0)),
  ]));
  const c = client({ dataHome });
  try {
    await c.init();
    const info = JSON.parse(await c.text("image_info", { path: src }));
    assert.equal(info.width, 32);
    assert.equal(info.height, 32);
    const t = await c.text("image_convert", { path: src, format: "jpeg", out_path: join(dir, "d16.jpg") });
    assert.match(t, /Converted PNG to JPEG/);
    const out = readFileSync(join(dir, "d16.jpg"));
    assert.equal(out[0], 0xff);
    assert.equal(out[1], 0xd8);
  } finally { c.close(); }
});

test("an upscale says the pixels were interpolated", async () => {
  const { dir, dataHome } = sandbox("adv-up-");
  const one = join(dir, "one.png");
  writeFileSync(one, await noisy(1, 1, 4).getBuffer("image/png"));
  // Pro: 4000x4000 is 16 MP, which the free output cap refuses first.
  const c = client({ dataHome, key: proKey() });
  try {
    await c.init();
    const t = await c.text("image_resize", { path: one, width: 4000, out_path: join(dir, "up.png") });
    assert.match(t, /Resized 1x1 to 4000x4000/);
    assert.match(t, /interpolated, not new detail/);
  } finally { c.close(); }
});

test("watermark text: newline, transliteration, unrenderable text and overflow", async () => {
  const { dir, dataHome } = sandbox("adv-wm-");
  const src = await makePng(join(dir, "p.png"), 300, 200);
  const wide = await makePng(join(dir, "wide.png"), 1400, 400);
  const c = client({ dataHome, key: proKey() });
  try {
    await c.init();
    // A newline is a word separator, never a deletion.
    const nl = await c.text("image_watermark", { path: src, text: "PAID\nIN FULL", out_path: join(dir, "a.png") });
    assert.match(nl, /Watermarked "PAID IN FULL"/);
    // A Polish stroke is transliterated, not deleted into a different real word.
    const pl = await c.text("image_watermark", { path: wide, text: "OPŁACONE 已付款", out_path: join(dir, "b.png") });
    assert.match(pl, /Watermarked "OPLACONE"/);
    assert.match(pl, /1 character was outside the font/);
    assert.match(pl, /had no glyph/);
    // Nothing renderable left: refuse rather than draw an empty plate and call it a watermark.
    const cjk = await c.text("image_watermark", { path: src, text: "已付款", out_path: join(dir, "c.png") });
    assert.match(cjk, /empty after removing the characters/);
    assert.equal(existsSync(join(dir, "c.png")), false);
    // 500 characters do not fit in 300 px at the smallest face, and are refused, not clipped.
    const long = await c.text("image_watermark", { path: src, text: "X".repeat(500), out_path: join(dir, "d.png") });
    assert.match(long, /would be drawn off the right edge/);
    assert.equal(existsSync(join(dir, "d.png")), false);
  } finally { c.close(); }
});

test("the free tier caps the output, so a batch of camera-sized photos to 800 px is free", async () => {
  const { dir, dataHome } = sandbox("adv-tier-");
  const paths = [];
  for (let i = 0; i < 3; i++) paths.push(await makeJpeg(join(dir, `p${i}.jpg`), 2400, 1800, 85, i + 1));
  const out = join(dir, "web");
  const c = client({ dataHome });
  try {
    await c.init();
    const t = await c.text("image_batch_resize", { paths, width: 800, out_dir: out });
    assert.match(t, /Resized 3 images/);
    assert.equal(readdirSync(out).length, 3);
    // Writing 4.3 MP back out is still Pro.
    const big = await c.text("image_convert", { path: paths[0], format: "png", out_path: join(dir, "big.png") });
    assert.match(big, /free tier writes images up to 4 MP/);
    assert.equal(existsSync(join(dir, "big.png")), false);
  } finally { c.close(); }
});

test("a batch with a missing file in the middle writes nothing at all", async () => {
  const { dir, dataHome } = sandbox("adv-batch-");
  const a = await makePng(join(dir, "a.png"), 200, 100);
  const b = await makeJpeg(join(dir, "b.jpg"), 200, 100, 90);
  const out = join(dir, "out");
  mkdirSync(out, { recursive: true });
  const c = client({ dataHome });
  try {
    await c.init();
    for (const tool of ["image_batch_resize", "image_thumbnails"]) {
      const args = tool === "image_batch_resize"
        ? { paths: [a, join(dir, "gone.png"), b], width: 100, out_dir: out }
        : { paths: [a, join(dir, "gone.png"), b], size: 64, out_dir: out };
      const t = await c.text(tool, args);
      assert.match(t, /gone\.png does not exist/);
      assert.deepEqual(readdirSync(out), [], `${tool} left a partial batch`);
    }
  } finally { c.close(); }
});

test("dominant colours name a photograph as having no palette", async () => {
  const { dir, dataHome } = sandbox("adv-dom-");
  const photo = await makePng(join(dir, "noise.png"), 300, 200);
  const c = client({ dataHome, key: proKey() });
  try {
    await c.init();
    const r = JSON.parse(await c.text("image_dominant_colors", { path: photo }));
    assert.ok(r.colors.every((x) => typeof x.pixels === "number"));
    assert.match(r.note, /No colour covers even 1%/);
    assert.match(r.note, /not brand colours/);
  } finally { c.close(); }
});

test("every input is sha256-identical after a full pass of the write tools", async () => {
  const { dir, dataHome } = sandbox("adv-sha-");
  const png = await makePng(join(dir, "s.png"), 240, 160);
  const jpg = await makeJpeg(join(dir, "s.jpg"), 240, 160, 92);
  const before = { png: sha256(png), jpg: sha256(jpg) };
  const c = client({ dataHome, key: proKey() });
  try {
    await c.init();
    await c.call("image_resize", { path: png, width: 80, out_path: join(dir, "o1.png") });
    await c.call("image_convert", { path: png, format: "jpeg", out_path: join(dir, "o2.jpg") });
    await c.call("image_compress", { path: jpg, quality: 40, out_path: join(dir, "o3.jpg") });
    await c.call("image_crop", { path: jpg, x: 10, y: 10, width: 50, height: 50, out_path: join(dir, "o4.jpg") });
    await c.call("image_watermark", { path: png, text: "Acme", out_path: join(dir, "o5.png") });
    await c.call("image_strip_metadata", { path: jpg, out_path: join(dir, "o6.jpg") });
    await c.call("image_thumbnails", { paths: [png, jpg], size: 64, out_dir: join(dir, "th") });
    await c.call("image_batch_resize", { paths: [png, jpg], width: 100, out_dir: join(dir, "bt") });
  } finally { c.close(); }
  assert.equal(sha256(png), before.png);
  assert.equal(sha256(jpg), before.jpg);
});

test("src/ makes no network call", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const f of readdirSync(dir)) {
    const body = readFileSync(new URL(f, dir), "utf8");
    assert.equal(/\bfetch\s*\(/.test(body), false, `${f} calls fetch`);
    assert.equal(/node:(https?|net|dns|dgram|tls)/.test(body), false, `${f} imports a network module`);
    for (const url of body.match(/https?:\/\/[^\s"'`)]+/g) ?? []) {
      assert.ok(/mcp\.zovo\.one|github\.com\/theluckystrike|ns\.adobe\.com/.test(url), `${f} names ${url}`);
    }
  }
});

test("max_bytes searches quality once instead of leaving the caller to brute-force it", async () => {
  const { dir, dataHome } = sandbox("adv-bytes-");
  const src = await makeJpeg(join(dir, "photo.jpg"), 1200, 900, 95, 4);
  const c = client({ dataHome });
  try {
    await c.init();
    const out = join(dir, "web.jpg");
    const t = await c.text("image_compress", { path: src, quality: 80, max_width: 800, max_bytes: 120 * 1024, out_path: out });
    assert.match(t, /searched down from 80 in \d+ encodes to fit 120\.0 KB/);
    assert.ok(readFileSync(out).length <= 120 * 1024, "the output is over max_bytes");
    // A lossless output has no quality knob, so max_bytes there is refused, not ignored.
    const png = await c.text("image_compress", { path: src, max_bytes: 1024 * 100, out_path: join(dir, "w.png") });
    assert.match(png, /max_bytes needs a JPEG output/);
    assert.equal(existsSync(join(dir, "w.png")), false);
    // A target nothing can reach is named, not silently missed.
    const impossible = await c.text("image_compress", { path: src, max_bytes: 2048, out_path: join(dir, "tiny.jpg") });
    assert.match(impossible, /does not fit in 2\.0 KB as a JPEG at any quality/);
    assert.equal(existsSync(join(dir, "tiny.jpg")), false);
  } finally { c.close(); }
});

test("stripping metadata is free at any size: it writes the pixels it read", async () => {
  const { dir, dataHome } = sandbox("adv-strip-");
  const big = await makeJpeg(join(dir, "camera.jpg"), 2400, 1800, 92, 5);
  const c = client({ dataHome });
  try {
    await c.init();
    const t = await c.text("image_strip_metadata", { path: big, out_path: join(dir, "clean.jpg") });
    assert.match(t, /no metadata was carried across/);
    assert.match(t, /2400x1800/);
    assert.ok(existsSync(join(dir, "clean.jpg")));
  } finally { c.close(); }
});

test("the free tier names three dominant colours rather than refusing", async () => {
  const { dir, dataHome } = sandbox("adv-free-dom-");
  const img = noisy(120, 120, 2);
  for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) img.setPixelColor(y < 90 ? 0x5b3e8aff : 0xe8b23aff, x, y);
  const p = join(dir, "logo.png");
  writeFileSync(p, await img.getBuffer("image/png"));
  const c = client({ dataHome });
  try {
    await c.init();
    const r = JSON.parse(await c.text("image_dominant_colors", { path: p, count: 5 }));
    assert.equal(r.colors.length, 3);
    assert.equal(r.colors[0].hex, "#5b3e8a");
    assert.ok(r.colors[0].share_percent > 70);
    assert.equal(r.free_tier_color_cap, 3);
    assert.match(r.upgrade, /5 dominant colours instead of 3/);
  } finally { c.close(); }
  const pro = client({ dataHome, key: proKey() });
  try {
    await pro.init();
    const r = JSON.parse(await pro.text("image_dominant_colors", { path: p, count: 5 }));
    assert.equal(r.free_tier_color_cap, undefined);
  } finally { pro.close(); }
});
