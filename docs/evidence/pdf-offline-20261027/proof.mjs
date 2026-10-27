// Evidence runner for the existing MCP stdio server. This is not a PDF CLI.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const source = resolve(process.argv[2] ?? './source');
const out = resolve(process.argv[3] ?? './results');
assert(!existsSync(out), 'Use a fresh results directory to preserve earlier evidence');
mkdirSync(out, { recursive: true });
const fixtures = join(out, 'fixtures');
mkdirSync(fixtures);
const sha256 = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const checks = [];
const check = (name, details = {}) => checks.push({ name, passed: true, ...details });

// Tiny deterministic PDF writer. No application operation is replaced by this.
function fixture(path, label) {
  const objects = [null,
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>',
    '',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>',
    '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  for (const [object, page] of [[4, 1], [6, 2]]) {
    const content = `BT /F1 18 Tf 60 760 Td (SYNTHETIC-${label}-PAGE-${page}) Tj ET\n`;
    objects[object] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}endstream`;
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let n = 1; n < objects.length; n++) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${n} 0 obj\n${objects[n]}\nendobj\n`;
  }
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  writeFileSync(path, pdf);
  assert(readFileSync(path).length <= 50 * 1024);
}
const a = join(fixtures, 'a.pdf'), b = join(fixtures, 'b.pdf');
fixture(a, 'A'); fixture(b, 'B');
const hashesBefore = { a: sha256(a), b: sha256(b) };
const sandbox = join(out, 'deny-network.sb');
writeFileSync(sandbox, '(version 1)\n(allow default)\n(deny network*)\n');
const env = {
  PATH: process.env.PATH,
  XDG_DATA_HOME: join(out, 'data'),
  XDG_CONFIG_HOME: join(out, 'config'),
  TMPDIR: out,
};
// No inherited keys, account credentials, business profiles, or license files.
const probe = execFileSync('/usr/bin/sandbox-exec', ['-f', sandbox, process.execPath, '--input-type=module', '-e',
  "import net from 'node:net';const s=net.connect({host:'1.1.1.1',port:443});s.on('connect',()=>process.exit(1));s.on('error',e=>{console.log(e.code);process.exit(e.code==='EPERM'?0:2)});s.setTimeout(2000,()=>process.exit(3));"], { env, encoding: 'utf8' }).trim();
assert.equal(probe, 'EPERM');
check('network denied by OS sandbox', { probe });

const entry = join(source, 'servers/pdf/dist/index.js');
const child = spawn('/usr/bin/sandbox-exec', ['-f', sandbox, process.execPath, entry], {
  env, cwd: out, stdio: ['pipe', 'pipe', 'pipe'],
});
const transcript = [], pending = new Map();
let buffer = '', stderr = '', id = 0;
child.stderr.on('data', x => { stderr += x; });
child.stdout.on('data', chunk => {
  buffer += chunk;
  while (buffer.includes('\n')) {
    const p = buffer.indexOf('\n'), line = buffer.slice(0, p).trim();
    buffer = buffer.slice(p + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    transcript.push({ direction: 'response', message: msg });
    const waiter = pending.get(msg.id);
    if (waiter) { pending.delete(msg.id); clearTimeout(waiter.timer); waiter.resolve(msg); }
  }
});
function send(method, params) {
  return new Promise((resolve, reject) => {
    const message = { jsonrpc: '2.0', id: ++id, method, params };
    transcript.push({ direction: 'request', message });
    const timer = setTimeout(() => { pending.delete(message.id); reject(new Error(`Timeout ${method}`)); }, 10000);
    pending.set(message.id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify(message) + '\n');
  });
}
async function call(name, args = {}, refuse = false, expected) {
  const r = await send('tools/call', { name, arguments: args });
  assert(!r.error, JSON.stringify(r.error));
  assert.equal(Boolean(r.result.isError), refuse, `${name} returned unexpected status`);
  const text = r.result.content.map(x => x.text ?? '').join('\n');
  if (expected) assert.match(text, expected);
  return text;
}
// Poppler is an independent reader, not the implementation's pdf-lib parser.
function inspect(path, markers) {
  const info = execFileSync('pdfinfo', [path], { encoding: 'utf8' });
  const count = Number(/^Pages:\s+(\d+)/m.exec(info)[1]);
  const text = execFileSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8' });
  const pages = text.split('\f').filter(x => x.trim());
  assert.equal(count, markers.length);
  assert.equal(pages.length, markers.length);
  pages.forEach((text, n) => assert(text.includes(markers[n]), `${path} page ${n + 1} order mismatch`));
  return { pages: count, text, sha256: sha256(path), bytes: readFileSync(path).length };
}
const outputs = {};
try {
  const init = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'funding-feasibility-proof', version: '1' } });
  assert(init.result);
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const status = JSON.parse(await call('license_status'));
  assert.equal(status.tier, 'free');
  assert.equal(status.reason, 'no license found');
  check('real license gate remains free without a key', { tier: status.tier, reason: status.reason });
  await call('pdf_info', { path: a }, false, /"pages": 2/);
  await call('pdf_text', { path: a }, false, /SYNTHETIC-A-PAGE-2/);
  check('real MCP info and text read the fixture');
  const merged = join(out, 'merged.pdf');
  await call('pdf_merge', { paths: [a, b], out_path: merged });
  outputs.merge = inspect(merged, ['SYNTHETIC-A-PAGE-1', 'SYNTHETIC-A-PAGE-2', 'SYNTHETIC-B-PAGE-1', 'SYNTHETIC-B-PAGE-2']);
  check('merge preserves all four pages in input order');
  const picked = join(out, 'picked.pdf');
  await call('pdf_pages', { path: a, pages: '2,1,1', out_path: picked });
  outputs.pages = inspect(picked, ['SYNTHETIC-A-PAGE-2', 'SYNTHETIC-A-PAGE-1', 'SYNTHETIC-A-PAGE-1']);
  check('page extraction preserves requested order and duplicates');
  await call('pdf_split', { path: a, ranges: '1,2', out_path_pattern: join(out, 'split-{n}.pdf') });
  outputs.split1 = inspect(join(out, 'split-1.pdf'), ['SYNTHETIC-A-PAGE-1']);
  outputs.split2 = inspect(join(out, 'split-2.pdf'), ['SYNTHETIC-A-PAGE-2']);
  check('split writes the two expected one-page files');
  const rotated = join(out, 'rotated.pdf');
  await call('pdf_rotate', { path: a, degrees: 90, pages: '2', out_path: rotated });
  outputs.rotate = inspect(rotated, ['SYNTHETIC-A-PAGE-1', 'SYNTHETIC-A-PAGE-2']);
  const rotations = execFileSync('pdfinfo', ['-f', '1', '-l', '2', rotated], { encoding: 'utf8' });
  assert.match(rotations, /Page\s+1 rot:\s+0/);
  assert.match(rotations, /Page\s+2 rot:\s+90/);
  check('rotation affects only page two', { rotations: [0, 90] });
  const stamped = join(out, 'stamped.pdf');
  await call('pdf_stamp', { path: a, text: 'PAID', position: 'bottom-right', out_path: stamped });
  outputs.stamp = inspect(stamped, ['SYNTHETIC-A-PAGE-1', 'SYNTHETIC-A-PAGE-2']);
  assert.equal((outputs.stamp.text.match(/PAID/g) ?? []).length, 2);
  check('free PAID stamp reaches both output pages');
  for (const [name, args, pattern, absent] of [
    ['pdf_reorder', { path: a, order: [2, 1], out_path: join(out, 'pro-reorder.pdf') }, /Pro feature/, 'pro-reorder.pdf'],
    ['pdf_stamp', { path: a, text: 'CUSTOM', out_path: join(out, 'pro-stamp.pdf') }, /free tier stamps/, 'pro-stamp.pdf'],
    ['pdf_merge', { paths: [a, b, a, b, a, b], out_path: join(out, 'six.pdf') }, /free tier merges up to 5/, 'six.pdf'],
    ['pdf_pages', { path: a, pages: '3', out_path: join(out, 'bad-page.pdf') }, /page past the end/, 'bad-page.pdf'],
    ['pdf_rotate', { path: a, degrees: 45, out_path: join(out, 'bad-rotation.pdf') }, /multiples of 90/, 'bad-rotation.pdf'],
    ['pdf_pages', { path: a, pages: '1', out_path: a, overwrite: true }, /also an input/, null],
    ['pdf_info', { path: 'https://example.invalid/private.pdf' }, /URL, not a file path/, null],
  ]) {
    await call(name, args, true, pattern);
    if (absent) assert(!existsSync(join(out, absent)));
    check(`guard ${checks.filter(x => x.name.startsWith('guard ')).length + 1}`, { tool: name, expected: pattern.source, noOutput: absent });
  }
  // A pre-existing output is also protected, including its exact bytes.
  const existing = sha256(merged);
  await call('pdf_merge', { paths: [b, a], out_path: merged }, true, /already exists/);
  assert.equal(sha256(merged), existing);
  check('existing output is not overwritten without consent');
  const hashesAfter = { a: sha256(a), b: sha256(b) };
  assert.deepEqual(hashesAfter, hashesBefore);
  check('input SHA256 hashes unchanged after all operations', { hashesBefore, hashesAfter });
  assert(!existsSync(join(out, 'config/mcp-servers/license.json')));
  check('no license activated or stored');
  const report = { status: 'passed', checks, outputs, fixtureHashes: hashesBefore, environment: { node: process.version, platform: process.platform, architecture: process.arch, networkPolicy: 'OS deny network*', inheritedEnvironment: Object.keys(env), serverEntry: entry }, scope: 'Existing free MCP stdio operations only. No standalone PDF core or CLI was implemented.' };
  writeFileSync(join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: checks.length, outputPageCounts: Object.fromEntries(Object.entries(outputs).map(([name, x]) => [name, x.pages])), fixtureHashes: hashesBefore }));
} finally {
  child.stdin.end();
  child.kill();
  await new Promise(resolve => child.once('close', resolve));
  writeFileSync(join(out, 'transcript.json'), JSON.stringify(transcript, null, 2) + '\n');
  writeFileSync(join(out, 'server-stderr.txt'), stderr);
}
