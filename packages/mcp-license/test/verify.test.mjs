import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { verifyLicense } from "../dist/index.js";
const sign = (...a) => execFileSync("node", [new URL("../../../scripts/sign-license.mjs", import.meta.url).pathname, ...a]).toString().trim();
test("valid product key verifies", () => { assert.equal(verifyLicense(sign("time-tracker"), "time-tracker").ok, true); });
test("bundle key verifies for any product", () => { assert.equal(verifyLicense(sign("*"), "spreadsheet").ok, true); });
test("wrong product rejected", () => { assert.equal(verifyLicense(sign("invoice"), "spreadsheet").ok, false); });
test("expired rejected", () => { assert.equal(verifyLicense(sign("*", "", "1000"), "invoice").reason, "expired"); });
test("tampered rejected", () => { const k = sign("*"); const parts = k.split("."); const sig = parts[2]; const mid = Math.floor(sig.length / 2); const flipped = sig[mid] === "A" ? "B" : "A"; parts[2] = sig.slice(0, mid) + flipped + sig.slice(mid + 1); assert.equal(verifyLicense(parts.join("."), "invoice").ok, false); });
test("garbage rejected", () => { assert.equal(verifyLicense("hello", "x").ok, false); });

// --- hardening 2026-09-02 -------------------------------------------------
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, sign as edSign } from "node:crypto";
import { createLicenseGate } from "../dist/index.js";

const PEM = readFileSync(new URL("../../../keys/license-private.pem", import.meta.url), "utf8");
const b64u = (b) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
/** Sign an arbitrary payload object with the real private key (shape tests, #19). */
function mint(payload) {
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  return `MCPL1.${body}.${b64u(edSign(null, Buffer.from(body), createPrivateKey(PEM)))}`;
}
const nowS = () => Math.floor(Date.now() / 1000);

// #19 payload shape validation
test("#19 payload must be an object with the right field types", () => {
  const base = { v: 1, p: "invoice", id: "aabbccddeeff", iat: nowS() };
  assert.equal(verifyLicense(mint(base), "invoice").ok, true);
  assert.equal(verifyLicense(mint({ ...base, v: 2 }), "invoice").reason, "unsupported version");
  assert.equal(verifyLicense(mint({ ...base, v: "1" }), "invoice").reason, "unsupported version");
  assert.equal(verifyLicense(mint({ ...base, p: 5 }), "invoice").reason, "bad payload");
  assert.equal(verifyLicense(mint({ ...base, id: 123 }), "invoice").reason, "bad payload");
  assert.equal(verifyLicense(mint({ ...base, id: "" }), "invoice").reason, "bad payload");
  assert.equal(verifyLicense(mint({ ...base, iat: "1788352878" }), "invoice").reason, "bad payload");
  assert.equal(verifyLicense(mint({ ...base, iat: 1.5 }), "invoice").reason, "bad payload");
  assert.equal(verifyLicense(mint({ ...base, iat: Number.MAX_SAFE_INTEGER + 10 }), "invoice").reason, "bad payload");
  assert.equal(verifyLicense(mint([1, 2, 3]), "invoice").reason, "bad payload");
});

test("#19 exp must be a positive safe integer and exp <= now is expired", () => {
  const base = { v: 1, p: "invoice", id: "aabbccddeeff", iat: nowS() };
  // exp: 0 used to read as "lifetime"; it is now a bad payload.
  assert.equal(verifyLicense(mint({ ...base, exp: 0 }), "invoice").reason, "bad payload");
  assert.equal(verifyLicense(mint({ ...base, exp: -1 }), "invoice").reason, "bad payload");
  assert.equal(verifyLicense(mint({ ...base, exp: "9999999999" }), "invoice").reason, "bad payload");
  assert.equal(verifyLicense(mint({ ...base, exp: 1.5 }), "invoice").reason, "bad payload");
  // exp exactly equal to now is expired, not valid.
  const t = nowS();
  assert.equal(verifyLicense(mint({ ...base, exp: t }), "invoice", t).reason, "expired");
  assert.equal(verifyLicense(mint({ ...base, exp: t + 1 }), "invoice", t).ok, true);
  // absent exp is lifetime
  assert.equal(verifyLicense(mint(base), "invoice").ok, true);
});

// #18 cache must re-check exp on every isPro() call
test("#18 an expiring license stops being Pro without restarting the process", async () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-license-test-"));
  const prevCfg = process.env.XDG_CONFIG_HOME;
  const prevKey = process.env.MCP_LICENSE_KEY;
  process.env.XDG_CONFIG_HOME = dir;
  const t = nowS();
  process.env.MCP_LICENSE_KEY = mint({ v: 1, p: "invoice", id: "aabbccddeeff", iat: t, exp: t + 1 });
  try {
    const gate = createLicenseGate({ product: "invoice" });
    assert.equal(gate.isPro(), true, "should start Pro");
    await new Promise((r) => setTimeout(r, 1500));
    assert.equal(gate.isPro(), false, "cached verification must not outlive exp");
    assert.equal(gate.status().tier, "free");
    assert.equal(gate.status().reason, "expired");
  } finally {
    if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevCfg;
    if (prevKey === undefined) delete process.env.MCP_LICENSE_KEY; else process.env.MCP_LICENSE_KEY = prevKey;
  }
});

// #20 license.json is written 0600
test("#20 activate writes license.json with mode 0600", () => {
  const dir = mkdtempSync(join(tmpdir(), "mcp-license-test-"));
  const prevCfg = process.env.XDG_CONFIG_HOME;
  const prevKey = process.env.MCP_LICENSE_KEY;
  process.env.XDG_CONFIG_HOME = dir;
  delete process.env.MCP_LICENSE_KEY;
  try {
    const gate = createLicenseGate({ product: "invoice" });
    const r = gate.activate(sign("invoice"));
    assert.equal(r.ok, true, r.reason);
    const p = join(dir, "mcp-servers", "license.json");
    assert.equal(statSync(p).mode & 0o777, 0o600);
    assert.equal(gate.isPro(), true);
  } finally {
    if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevCfg;
    if (prevKey === undefined) delete process.env.MCP_LICENSE_KEY; else process.env.MCP_LICENSE_KEY = prevKey;
  }
});
