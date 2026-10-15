// The library logic on its own: the starter set, search ranking, variable extraction,
// filling with bracketed prompts for what is missing, and the markdown import round trip.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// load() reads XDG_DATA_HOME; point it at an empty sandbox so the seed path is what runs.
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "mcp-clauses-lib-"));

const { load, CATEGORY_ORDER, STARTER_NOTE } = await import(join(here, "..", "dist", "store.js"));
const { STARTER_CLAUSES } = await import(join(here, "..", "dist", "starter.js"));
const lib = await import(join(here, "..", "dist", "library.js"));
const { assemble } = await import(join(here, "..", "dist", "assemble.js"));

test("the starter set is 25 clauses, all marked generic template, not legal advice", () => {
  const db = load();
  assert.equal(db.seeded, true);
  assert.equal(db.clauses.length, 25);
  assert.equal(STARTER_CLAUSES.length, 25);
  assert.equal(new Set(db.clauses.map((c) => c.id)).size, 25, "starter ids must be unique");
  for (const c of db.clauses) {
    assert.equal(c.starter, true, `${c.id} is not marked as a starter`);
    assert.equal(c.note, STARTER_NOTE, `${c.id} carries no not-legal-advice note`);
    assert.ok(CATEGORY_ORDER.includes(c.category), `${c.id} has an unknown category ${c.category}`);
    assert.ok(c.body.length > 80, `${c.id} body is too short to be usable`);
  }
  // The 25 intents the product promises.
  for (const id of ["scope-of-work", "payment-terms", "late-fees", "ip-assignment", "confidentiality",
    "termination", "liability-cap", "revisions", "expenses", "governing-law", "force-majeure",
    "independent-contractor", "non-solicit", "acceptance", "warranty-disclaimer", "dispute-resolution",
    "notices", "entire-agreement", "severability", "assignment", "data-protection", "portfolio-rights",
    "kill-fee", "rush-fee", "change-requests"]) {
    assert.ok(db.clauses.some((c) => c.id === id), `starter set is missing ${id}`);
  }
});

test("the documented variables are actually used by the starter bodies", () => {
  const all = new Set();
  for (const c of load().clauses) for (const v of lib.clauseVariables(c)) all.add(v);
  for (const v of ["client", "fee", "late_fee_percent"]) assert.ok(all.has(v), `no starter clause uses {{${v}}}`);
  // Every declared variable must appear in its own body, or the declaration is a lie.
  for (const c of load().clauses) {
    const inBody = lib.extractVariables(c.body);
    for (const v of c.variables) assert.ok(inBody.includes(v), `${c.id} declares {{${v}}} but does not use it`);
  }
});

test("search ranks a title match above a body mention", () => {
  const clauses = load().clauses;
  const hits = lib.search(clauses, "payment");
  assert.ok(hits.length >= 3, `only ${hits.length} hits for 'payment'`);
  assert.equal(hits[0].clause.id, "payment-terms", `top hit was ${hits[0].clause.id}`);
  assert.ok(hits[0].score > hits[hits.length - 1].score, "ranking is flat");
  // A clause that only mentions payment in its body still appears, but lower.
  const ipRank = hits.findIndex((h) => h.clause.id === "ip-assignment");
  const termsRank = hits.findIndex((h) => h.clause.id === "payment-terms");
  assert.ok(ipRank === -1 || ipRank > termsRank, "a body mention outranked the title match");
  // Category filter narrows.
  assert.ok(lib.search(clauses, "payment", { category: "payment" }).every((h) => h.clause.category === "payment"));
  // Tag filter is exact-all.
  const tagged = lib.search(clauses, "fee", { tags: ["payment"] });
  assert.ok(tagged.every((h) => h.clause.tags.includes("payment")), "tag filter leaked");
  assert.equal(lib.search(clauses, "zzzznothing").length, 0);
});

test("search matches on word boundaries: \"fee\" does not match inside \"coffee\"", () => {
  const clauses = [
    { id: "coffee-perk", title: "Office Coffee Perk", category: "general", tags: [], variables: [],
      language: "en", body: "The company provides free coffee in the office kitchen.", history: [], created: "", updated: "" },
    { id: "late-fee", title: "Late Payment Fee", category: "payment", tags: [], variables: [],
      language: "en", body: "A late fee applies after the due date.", history: [], created: "", updated: "" },
  ];
  const hits = lib.search(clauses, "fee");
  assert.equal(hits[0].clause.id, "late-fee", `expected the real "fee" match first, got ${hits.map((h) => h.clause.id).join(", ")}`);
  // "Office Coffee Perk" contains "fee" only as a substring of "coffee": a fluke
  // substring hit must never outrank a clause that says the word for real (Review V5 P2).
  assert.ok(hits[0].score > (hits.find((h) => h.clause.id === "coffee-perk")?.score ?? 0));

  // "art" is a substring of "party" and "contract" but a whole word in neither; a title
  // that only contains it as a substring must not outrank a clause with a real "art" hit.
  const artClauses = [
    { id: "party-def", title: "Party Definitions", category: "general", tags: [], variables: [],
      language: "en", body: "This section defines the contracting parties to the contract.", history: [], created: "", updated: "" },
    { id: "artwork", title: "Artwork Licence", category: "ip", tags: [], variables: [],
      language: "en", body: "The client licenses the delivered art for commercial use.", history: [], created: "", updated: "" },
  ];
  const artHits = lib.search(artClauses, "art");
  assert.equal(artHits[0].clause.id, "artwork", `expected the real "art" match first, got ${artHits.map((h) => h.clause.id).join(", ")}`);
});

test("variable extraction is order-preserving and deduplicated", () => {
  assert.deepEqual(lib.extractVariables("pay {{fee}} {{currency}} to {{client}}, {{fee}} again"), ["fee", "currency", "client"]);
  assert.deepEqual(lib.extractVariables("{{ spaced }}"), ["spaced"]);
  assert.deepEqual(lib.extractVariables("no variables here"), []);
  // Declared-first ordering, undeclared appended.
  assert.deepEqual(lib.clauseVariables({ body: "{{b}} {{a}}", variables: ["a"] }), ["a", "b"]);
});

test("a bracketed prompt carries no underscore, which the docx writer would eat", () => {
  // Measured: the docx engine parses inline markdown, so [late_fee_percent] reaches Word as
  // [latefeepercent] -- the underscore pair reads as an italic marker.
  assert.equal(lib.promptFor("late_fee_percent"), "[late fee percent]");
  assert.equal(lib.promptFor("fee"), "[fee]");
  assert.ok(!lib.promptFor("a_b.c-d").includes("_"));
});

test("fill replaces what it has and brackets what it does not", () => {
  const r = lib.fillVariables("Fee {{fee}} {{currency}}, interest {{late_fee_percent}} percent.", { fee: "4500", currency: "EUR" });
  assert.equal(r.text, "Fee 4500 EUR, interest [late fee percent] percent.");
  assert.deepEqual(r.filled, ["fee", "currency"]);
  assert.deepEqual(r.unfilled, ["late_fee_percent"]);
  // An empty string counts as no value, not as a value.
  assert.deepEqual(lib.fillVariables("{{x}}", { x: "   " }).unfilled, ["x"]);
});

test("assemble numbers clauses, opens with the disclaimer and lists open items", () => {
  const clauses = load().clauses.filter((c) => ["payment-terms", "late-fees"].includes(c.id));
  const r = assemble({ title: "Service Agreement", clauses, client: "Beta Corp", values: { fee: "4500", currency: "EUR" } });
  assert.equal(r.blocks[0].text, "Service Agreement");
  assert.equal(r.blocks[1].text, lib.DISCLAIMER);
  assert.match(r.markdown, /^# Service Agreement/);
  assert.match(r.markdown, /Client: Beta Corp/);
  assert.match(r.markdown, /## 1\. Payment Terms/);
  assert.match(r.markdown, /## 2\. Late Payment/);
  assert.match(r.markdown, /4500 EUR/);
  assert.ok(r.unfilled.includes("late_fee_percent"));
  assert.match(r.markdown, /- \[late fee percent\]/);
  assert.ok(!r.markdown.includes("{{"), "an unfilled variable was left as raw {{...}}");
});

test("markdown export imports back to the same clauses", () => {
  const clauses = load().clauses;
  const md = lib.toMarkdown(clauses);
  const back = lib.parseMarkdown(md);
  assert.equal(back.length, clauses.length, "round trip lost or gained clauses");
  const byTitle = new Map(back.map((c) => [c.title, c]));
  for (const c of clauses) {
    const r = byTitle.get(c.title);
    assert.ok(r, `round trip lost "${c.title}"`);
    assert.equal(r.body, c.body, `body changed for ${c.id}`);
    assert.equal(r.category, c.category);
    assert.deepEqual(r.tags, c.tags);
    assert.deepEqual(r.variables, c.variables);
    assert.equal(r.language, c.language);
    assert.equal(r.note, c.note);
  }
});

test("markdown import tolerates a hand-written file", () => {
  const parsed = lib.parseMarkdown([
    "# My clauses", "", "Some preamble that is not a clause.", "",
    "## Retainer", "category: payment", "tags: retainer, monthly", "",
    "The client pays {{monthly_fee}} on the first of each month.", "",
    "## Bare clause", "", "No metadata at all.",
  ].join("\n"));
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].title, "Retainer");
  assert.deepEqual(parsed[0].tags, ["retainer", "monthly"]);
  assert.equal(parsed[1].category, "general");
  assert.equal(parsed[1].language, "en");
});

test("markdown import keeps body prose that opens with a metadata-like word (Review V5 P2)", () => {
  const parsed = lib.parseMarkdown(
    "## Payment Terms\n\nnote: Client must pay within 30 days of invoice date.\n\nLate payments accrue interest.\n",
  );
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].title, "Payment Terms");
  assert.equal(parsed[0].note, undefined, "a body sentence must not be captured as note metadata");
  assert.match(parsed[0].body, /^note: Client must pay within 30 days of invoice date\./,
    "the metadata-like opening sentence was dropped from the body");
  assert.match(parsed[0].body, /Late payments accrue interest\.$/);

  // A real, short metadata block right after the title is still recognised.
  const withRealMeta = lib.parseMarkdown(
    "## Confidentiality\ncategory: confidentiality\nnote: generic template, not legal advice\n\n" +
    "Each party keeps the other's confidential information secret.\n",
  );
  assert.equal(withRealMeta[0].category, "confidentiality");
  assert.equal(withRealMeta[0].note, "generic template, not legal advice");
  assert.equal(withRealMeta[0].body, "Each party keeps the other's confidential information secret.");
});

test("json round trip keeps every field", () => {
  const clauses = load().clauses.slice(0, 3);
  const back = lib.parseClauseJson(lib.toClauseJson(clauses));
  assert.equal(back.length, 3);
  assert.equal(back[0].title, clauses[0].title);
  assert.equal(back[0].body, clauses[0].body);
  assert.deepEqual(back[0].variables, lib.clauseVariables(clauses[0]));
  assert.throws(() => lib.parseClauseJson('{"nope":1}'), /clauses array/);
});

test("ids stay unique when titles collide", () => {
  const taken = new Set(["retainer"]);
  assert.equal(lib.makeId("Retainer", taken), "retainer-2");
  taken.add("retainer-2");
  assert.equal(lib.makeId("retainer!", taken), "retainer-3");
});
