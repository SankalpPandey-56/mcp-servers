// End to end over stdio JSON-RPC, the way a client drives it: add suppliers, list
// and search the directory, read and change a record, stamp reviews, run the
// due-review report, export CSV and Markdown, remove rows, and hit the free-tier cap.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(here, "..", "dist", "index.js");
const REPO = join(here, "..", "..", "..");

/* ------------------------------------------------------------------- fixtures */

const BOX = {
  name: "Shenzhen Box Co", category: "Packaging", contact_name: "Maria Chen",
  email: "sales@shenzhenbox.example", phone: "+86 755 5555 0100",
  website: "https://shenzhenbox.example", payment_terms: "Net 30", lead_time_days: 21,
  notes: "Minimum order 500 units, ask Maria for the kraft line.",
};
const FASTENER = {
  name: "Acme Fasteners", category: "Hardware", contact_name: "Bob Patel",
  email: "orders@acme.example", payment_terms: "50% upfront", lead_time_days: 7,
};
const INK = { name: "Inkredible Inks", category: "Print", lead_time_days: 3 };

/* --------------------------------------------------------------------- client */

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), "mcp-supplier-list-"));
  return {
    dir,
    env: { XDG_DATA_HOME: join(dir, "data"), XDG_CONFIG_HOME: join(dir, "cfg") },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function client(env) {
  const child = spawn(process.execPath, [ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, MCP_LICENSE_KEY: "", ...env },
  });
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
    async init() {
      const r = await send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "0" } });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      return r;
    },
    async call(name, args) {
      const r = await send("tools/call", { name, arguments: args ?? {} });
      assert.ok(r.result, `${name} failed: ${JSON.stringify(r.error)}`);
      return { text: r.result.content?.[0]?.text ?? "", isError: r.result.isError === true };
    },
    async json(name, args) {
      const r = await this.call(name, args);
      assert.equal(r.isError, false, r.text);
      try { return JSON.parse(r.text); } catch { assert.fail(`${name} did not return JSON:\n${r.text}`); }
    },
    close() { child.kill(); },
  };
}

const proKey = () => execFileSync(process.execPath, [join(REPO, "scripts", "sign-license.mjs"), "supplier-list"], { encoding: "utf8" }).trim();

/* ---------------------------------------------------------------------- tests */

test("initialize, tools/list, supplier_add then supplier_list shows the added row", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    const init = await c.init();
    assert.equal(init.result.serverInfo.name, "mcp-supplier-list");

    const list = await c.send("tools/list", {});
    const names = list.result.tools.map((t) => t.name).sort();
    for (const want of ["supplier_add", "supplier_due_review", "supplier_export", "supplier_get",
      "supplier_list", "supplier_mark_reviewed", "supplier_remove", "supplier_update",
      "license_activate", "license_status"]) {
      assert.ok(names.includes(want), `missing tool ${want}; got ${names.join(", ")}`);
    }

    const added = await c.json("supplier_add", BOX);
    assert.match(added.created.id, /^SUP-\d{4}-0001$/);
    assert.equal(added.created.name, "Shenzhen Box Co");
    assert.equal(added.created.lead_time_days, 21);
    assert.equal(added.created.last_reviewed, null, "a new record has never been reviewed");

    const dir = await c.json("supplier_list", {});
    assert.equal(dir.count, 1);
    assert.equal(dir.suppliers[0].id, added.created.id, "the added row is in the list");
    assert.equal(dir.suppliers[0].name, "Shenzhen Box Co");
    assert.equal(dir.suppliers[0].payment_terms, "Net 30");
    assert.deepEqual(dir.categories, ["Packaging"]);
  } finally {
    c.close(); s.cleanup();
  }
});

test("filters, get, update and remove over a three-supplier directory", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const box = (await c.json("supplier_add", BOX)).created;
    const acme = (await c.json("supplier_add", FASTENER)).created;
    const ink = (await c.json("supplier_add", INK)).created;

    // category filter is exact and case-insensitive
    const packaging = await c.json("supplier_list", { category: "packaging" });
    assert.equal(packaging.count, 1);
    assert.equal(packaging.suppliers[0].id, box.id);
    // text search reaches across fields, notes included
    const kraft = await c.json("supplier_list", { q: "kraft" });
    assert.equal(kraft.count, 1);
    assert.equal(kraft.suppliers[0].id, box.id);
    // A to Z by name
    const all = await c.json("supplier_list", {});
    assert.deepEqual(all.suppliers.map((x) => x.name), ["Acme Fasteners", "Inkredible Inks", "Shenzhen Box Co"]);

    // get by partial name
    const got = await c.json("supplier_get", { supplier: "inkred" });
    assert.equal(got.id, ink.id);
    assert.equal(got.website, null);

    // update touches only what is passed
    const upd = await c.json("supplier_update", { supplier: ink.id, payment_terms: "Due on receipt", lead_time_days: 5 });
    assert.deepEqual(upd.changed.sort(), ["lead_time_days", "payment_terms"]);
    assert.equal(upd.updated.payment_terms, "Due on receipt");
    assert.equal(upd.updated.lead_time_days, 5);
    assert.equal(upd.updated.name, "Inkredible Inks", "untouched fields stay");

    // a rename to an existing name is refused
    const clash = await c.call("supplier_update", { supplier: ink.id, name: "acme fasteners" });
    assert.equal(clash.isError, true);
    assert.match(clash.text, /already holds that name/);

    // remove returns the record and frees the row
    const gone = await c.json("supplier_remove", { supplier: acme.id });
    assert.equal(gone.removed.name, "Acme Fasteners");
    const after = await c.json("supplier_list", {});
    assert.equal(after.count, 2);
    // the number is burned, not reissued
    const next = (await c.json("supplier_add", { name: "New Vendor", category: "Misc" })).created;
    assert.notEqual(next.id, acme.id);
  } finally {
    c.close(); s.cleanup();
  }
});

test("review stamps and the due-review report", async () => {
  const s = sandbox();
  const key = proKey();
  const c = client({ ...s.env, MCP_LICENSE_KEY: key });
  try {
    await c.init();
    const box = (await c.json("supplier_add", BOX)).created;
    const acme = (await c.json("supplier_add", FASTENER)).created;

    // a review dated tomorrow is refused
    const future = await c.call("supplier_mark_reviewed", { supplier: box.id, date: "2099-01-01" });
    assert.equal(future.isError, true);
    assert.match(future.text, /after today/);

    // one record reviewed long ago, one never reviewed
    const stamped = await c.json("supplier_mark_reviewed", { supplier: box.id, date: "2020-01-01" });
    assert.equal(stamped.reviewed.last_reviewed, "2020-01-01");

    const due = await c.json("supplier_due_review", { days: 90 });
    assert.equal(due.due_count, 2, "the stale record and the never-reviewed record are both due");
    assert.equal(due.due[0].id, box.id, "most overdue first: the 2020 review outranks a record added today");
    assert.equal(due.due[1].id, acme.id);
    assert.equal(due.due[1].never_reviewed, true, "never reviewed is due whatever its age");
    assert.equal(due.fresh_count, 0);

    // reviewing today takes a record off the report
    await c.json("supplier_mark_reviewed", { supplier: acme.id });
    const after = await c.json("supplier_due_review", { days: 90 });
    assert.equal(after.due_count, 1);
    assert.equal(after.due[0].id, box.id);
    assert.equal(after.fresh_count, 1);
  } finally {
    c.close(); s.cleanup();
  }
});

test("export renders CSV free and Markdown on Pro, with quoted cells", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    await c.json("supplier_add", BOX); // notes hold a comma, so the CSV cell must quote
    await c.json("supplier_add", FASTENER);

    const csv = await c.call("supplier_export", {});
    assert.equal(csv.isError, false);
    const lines = csv.text.trim().split("\n");
    assert.equal(lines[0], "id,name,category,contact_name,email,phone,website,address,payment_terms,lead_time_days,notes,last_reviewed");
    assert.equal(lines.length, 3, "header plus two rows");
    assert.match(csv.text, /Acme Fasteners,Hardware,Bob Patel/);
    assert.match(csv.text, /"Minimum order 500 units, ask Maria for the kraft line\."/, "a comma in notes is quoted");

    // filtered export
    const onlyHardware = await c.call("supplier_export", { category: "hardware" });
    assert.equal(onlyHardware.text.trim().split("\n").length, 2);
    assert.match(onlyHardware.text, /Acme Fasteners/);

    // Markdown is a Pro feature on the free tier
    const mdFree = await c.call("supplier_export", { format: "markdown" });
    assert.equal(mdFree.isError, true);
    assert.match(mdFree.text, /Pro feature/);
    assert.match(mdFree.text, /mcp\.zovo\.one\/buy\/supplier-list/);
    c.close();

    const pro = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
    try {
      await pro.init();
      const md = await pro.call("supplier_export", { format: "markdown" });
      assert.equal(md.isError, false);
      assert.match(md.text, /^\| id \| name \| category \|/);
      assert.match(md.text, /\| --- \| --- \|/);
      assert.match(md.text, /\| Shenzhen Box Co \| Packaging \| Maria Chen \|/);
    } finally { pro.close(); }
  } finally {
    // c.close() runs mid-test too; killing an already-dead child is a no-op, and a
    // failure before that line must not leave the server child alive, because a
    // spawned child refs the event loop and node --test would then never exit.
    c.close(); s.cleanup();
  }
});

test("guards: bad dates, bad email, duplicate name, ambiguous refs, empty update", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const box = (await c.json("supplier_add", BOX)).created;
    await c.json("supplier_add", { name: "Bolt Barn", category: "Hardware" });
    await c.json("supplier_add", { name: "Bolt Depot", category: "Hardware" });

    // a date that is not a date
    const badDate = await c.call("supplier_mark_reviewed", { supplier: box.id, date: "2026-02-30" });
    assert.equal(badDate.isError, true);
    assert.match(badDate.text, /not a real date/);

    // an email that is not an email
    const badEmail = await c.call("supplier_add", { name: "X", category: "Y", email: "not-an-email" });
    assert.equal(badEmail.isError, true);
    assert.match(badEmail.text, /does not look like an email/);

    // the same name twice makes two records of one supplier: refused
    const dup = await c.call("supplier_add", { name: "shenzhen box co", category: "Packaging" });
    assert.equal(dup.isError, true);
    assert.match(dup.text, /already in the directory/);

    // a partial name matching two suppliers is refused with the candidates
    const amb = await c.call("supplier_get", { supplier: "bolt" });
    assert.equal(amb.isError, true);
    assert.match(amb.text, /matches more than one supplier/);

    // an update with nothing to change is refused
    const empty = await c.call("supplier_update", { supplier: box.id });
    assert.equal(empty.isError, true);
    assert.match(empty.text, /nothing to change/);

    // unknown supplier names the known ones
    const miss = await c.call("supplier_get", { supplier: "No Such Co" });
    assert.equal(miss.isError, true);
    assert.match(miss.text, /no supplier matches/);
  } finally {
    c.close(); s.cleanup();
  }
});

test("free tier: the eleventh supplier is refused, removing one frees the slot, Pro lifts the cap", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    let first = "";
    for (let i = 1; i <= 10; i++) {
      const r = await c.json("supplier_add", { name: `Supplier ${i}`, category: `Cat ${i % 3}` });
      assert.ok(r.created.id, `supplier ${i} should be added`);
      if (!first) first = r.created.id;
    }
    const eleventh = await c.call("supplier_add", { name: "Supplier 11", category: "Cat 1" });
    assert.equal(eleventh.isError, true);
    assert.match(eleventh.text, /10 suppliers/);
    assert.match(eleventh.text, /Nothing was written/);
    assert.match(eleventh.text, /Pro/);

    // the due-review report is Pro-only on the free tier
    const dueFree = await c.call("supplier_due_review", {});
    assert.equal(dueFree.isError, true);
    assert.match(dueFree.text, /Pro feature/);
    assert.match(dueFree.text, /mcp\.zovo\.one\/buy\/supplier-list/);

    // removing one frees its slot, no key needed
    await c.json("supplier_remove", { supplier: first });
    const freed = await c.json("supplier_add", { name: "Supplier 11", category: "Cat 1" });
    assert.ok(freed.created.id, "removing a supplier frees the slot on the free tier");
    c.close();

    // Pro takes the cap off entirely
    const pro = client({ ...s.env, MCP_LICENSE_KEY: proKey() });
    try {
      await pro.init();
      const status = await pro.json("license_status", {});
      assert.equal(status.tier, "pro");
      for (let i = 12; i <= 13; i++) {
        const r = await pro.json("supplier_add", { name: `Supplier ${i}`, category: "Cat 2" });
        assert.ok(r.created.id, `Pro supplier ${i} should be added over the free cap`);
      }
      const list = await pro.json("supplier_list", {});
      assert.equal(list.count, 12);
      // and the due-review report runs
      const due = await pro.json("supplier_due_review", { days: 90 });
      assert.equal(due.due_count, 12, "nothing was ever reviewed, so everything is due");
    } finally { pro.close(); }
  } finally {
    c.close(); s.cleanup();
  }
});

test("license_status on the free tier names the tier and the checkout", async () => {
  const s = sandbox();
  const c = client(s.env);
  try {
    await c.init();
    const r = await c.json("license_status", {});
    assert.equal(r.tier, "free");
    assert.equal(r.product, "supplier-list");
    assert.match(r.upgradeUrl, /mcp\.zovo\.one\/buy\/supplier-list/);
    const bad = await c.call("license_activate", { key: "MCPL1.nope.nope" });
    assert.equal(bad.isError, true);
  } finally {
    c.close(); s.cleanup();
  }
});
