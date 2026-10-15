// Unit tests for the pure parts: storage round trip, keyword matching, the page budget,
// and the one property the cover letter must never break -- it states no fact the
// profile does not contain.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "mcp-resume-unit-"));

const { getProfile, setProfile, variantNames, profileText, sortExperienceNewestFirst } =
  await import(join(here, "..", "dist", "profile.js"));
const { renderResume, trimToPages, fixedWordCount, countWords, keywordReport, highlight, matchesKeyword, blocksToMarkdown } =
  await import(join(here, "..", "dist", "render.js"));
const { buildLetter, numbersIn, unsourcedNumbers, traceHighlight } = await import(join(here, "..", "dist", "letter.js"));
const { analyseGap, extractKeywords, suggestRewrites } = await import(join(here, "..", "dist", "tailor.js"));
const { blocksToProfile } = await import(join(here, "..", "dist", "read.js"));

const PROFILE = {
  name: "Ada Rowe",
  email: "ada@example.com",
  phone: "+48 500 100 200",
  location: "Warsaw, Poland",
  links: ["https://github.com/adarowe"],
  summary: "Backend engineer working on payment systems.",
  skills: ["TypeScript", "Node.js", "PostgreSQL", "Kubernetes"],
  experience: [
    {
      company: "Acme Pay", title: "Senior Engineer", start: "2021",
      bullets: [
        "Rebuilt the settlement pipeline in Node.js, cutting reconciliation time from 6 hours to 20 minutes",
        "Owned the PostgreSQL schema for ledger entries",
        "Ran the on-call rotation for the payments team",
        "Migrated batch jobs to Kubernetes",
      ],
    },
    {
      company: "Beta Corp", title: "Engineer", start: "2018", end: "2021",
      bullets: ["Built internal reporting in TypeScript", "Wrote the deployment pipeline"],
    },
  ],
  education: [{ school: "University of Warsaw", degree: "BSc Computer Science", start: "2014", end: "2018" }],
  certifications: ["CKA, 2023"],
  languages: ["Polish", "English"],
};

test("profile round trip: stored, read back field for field, variants listed", () => {
  setProfile(undefined, PROFILE);
  const back = getProfile();
  assert.ok(back);
  for (const k of Object.keys(PROFILE)) assert.deepEqual(back[k], PROFILE[k], `field ${k} did not survive`);
  assert.ok(back.updated, "no updated stamp");

  setProfile("Back End", { ...PROFILE, summary: "Variant summary." });
  assert.deepEqual(variantNames(), ["back-end", "default"]);
  assert.equal(getProfile("Back End").summary, "Variant summary.");
  assert.equal(getProfile().summary, PROFILE.summary, "the variant overwrote the default profile");
  assert.equal(getProfile("nothing-here"), null);
});

test("keyword matching is word-bounded, reported, and bolded without double wrapping", () => {
  assert.equal(matchesKeyword("we use Go daily", "go"), true);
  assert.equal(matchesKeyword("we use Google", "go"), false, "'go' must not match inside 'Google'");
  assert.equal(matchesKeyword("Node.js services", "node.js"), true);

  const r = renderResume(PROFILE, { style: "modern", keywords: ["Kubernetes", "PostgreSQL", "Rust", "Erlang"] });
  assert.deepEqual(r.keywords.matched, ["Kubernetes", "PostgreSQL"]);
  assert.deepEqual(r.keywords.missing, ["Rust", "Erlang"]);

  const text = JSON.stringify(r.blocks);
  assert.match(text, /\*\*Kubernetes\*\*/);
  assert.doesNotMatch(text, /Rust/, "a missing keyword must never be written into the document");
  assert.doesNotMatch(highlight("Kubernetes and Kubernetes", ["Kubernetes"]), /\*\*\*\*/);
  assert.deepEqual(keywordReport("a b c", ["b", "z", "  "]), { matched: ["b"], missing: ["z"] });
});

test("page trimming: the word budget is respected and the strongest bullets survive", () => {
  const fixed = fixedWordCount(PROFILE);
  const one = trimToPages(PROFILE.experience, ["Kubernetes"], fixed, 1, 450);
  assert.equal(one.budget, 450 - fixed);
  const keptWords = one.kept.reduce((n, b) => n + b.words, 0);
  assert.ok(keptWords <= one.budget, `kept ${keptWords} words over a budget of ${one.budget}`);
  assert.ok(one.estimatedPages <= 1, `estimated ${one.estimatedPages} pages for max_pages 1`);

  // Every role keeps at least its first bullet before any role gets a second one.
  for (let i = 0; i < PROFILE.experience.length; i++) {
    assert.ok(one.kept.some((b) => b.exp === i && b.index === 0), `role ${i} lost its first bullet`);
  }

  const tiny = trimToPages(PROFILE.experience, [], fixed, 1, fixed + 12);
  assert.ok(tiny.kept.length >= 1, "trimming must never return an empty resume");
  assert.equal(tiny.kept.length + tiny.dropped.length, 6, "a bullet went missing from the accounting");

  const big = trimToPages(PROFILE.experience, [], fixed, 3, 450);
  assert.equal(big.dropped.length, 0, "nothing should be trimmed at three pages");

  // A keyword hit outranks a later bullet of the same role.
  const kw = trimToPages(PROFILE.experience, ["Kubernetes"], fixed, 1, fixed + 30);
  assert.ok(kw.kept.some((b) => /Kubernetes/.test(b.text)), "the keyword bullet was trimmed away");
});

test("sortExperienceNewestFirst: an open role beats every dated role, then end desc, then start desc", () => {
  const oldestFirst = [
    { company: "Alpha", title: "Junior Dev", start: "2015", end: "2018", bullets: ["old job bullet"] },
    { company: "Beta Corp", title: "Engineer", start: "2018", end: "2021", bullets: ["Built internal reporting in TypeScript"] },
    { company: "Acme Pay", title: "Senior Engineer", start: "2021", bullets: ["current job bullet"] }, // no end = present
  ];
  const sorted = sortExperienceNewestFirst(oldestFirst);
  assert.deepEqual(sorted.map((e) => e.company), ["Acme Pay", "Beta Corp", "Alpha"]);
  // Original array is untouched.
  assert.equal(oldestFirst[0].company, "Alpha");

  // Free-text dates ("Jan 2021" style) parse too, not just bare years.
  const monthy = [
    { company: "Old", title: "T", start: "Jan 2019", end: "Mar 2020", bullets: [] },
    { company: "New", title: "T", start: "Apr 2020", end: "Dec 2021", bullets: [] },
  ];
  assert.deepEqual(sortExperienceNewestFirst(monthy).map((e) => e.company), ["New", "Old"]);
});

test("page trimming keeps the CURRENT role's bullets even when the caller entered experience oldest-first", () => {
  // Regression for Review V5 P1: scoreBullets/rankBullets read recency off array
  // position, trusting index 0 = newest. profile_set is responsible for that ordering;
  // this test feeds trimToPages the same oldest-first array a natural form-fill would
  // produce and checks the *current* job's bullet is NOT the one silently dropped.
  const oldestFirst = sortExperienceNewestFirst([
    {
      company: "Beta Corp", title: "Engineer", start: "2018", end: "2021",
      bullets: ["Wrote the deployment pipeline for the reporting service back in 2019"],
    },
    {
      company: "Acme Pay", title: "Senior Engineer", start: "2021",
      bullets: ["Rebuilt the settlement pipeline, cutting reconciliation time from 6 hours to 20 minutes"],
    },
  ]);
  assert.equal(oldestFirst[0].company, "Acme Pay", "sort did not put the open (current) role first");

  const fixed = fixedWordCount({ ...PROFILE, experience: oldestFirst });
  // A budget tight enough to fit only one of the two single-sentence bullets.
  const trim = trimToPages(oldestFirst, [], fixed, 1, fixed + 12);
  assert.equal(trim.kept.length, 1, "expected exactly one bullet to survive the tight budget");
  assert.equal(trim.kept[0].exp, 0, "the CURRENT role (index 0 after sorting) must be the one kept");
});

test("cover letter states no number that is not in the profile", () => {
  const letter = buildLetter(PROFILE, {
    company: "Zeta Systems", role: "Staff Engineer", tone: "formal",
    job_description: "Backend engineer for our payments platform. PostgreSQL and Kubernetes. Payments platform experience.",
  });
  const source = profileText(PROFILE) + "\nZeta Systems\nStaff Engineer";
  for (const n of numbersIn(letter.text)) {
    assert.ok(source.includes(n), `the letter states the number ${n}, which is not in the profile`);
  }
  assert.deepEqual(unsourcedNumbers(letter.text, [source]), []);
  // The check itself has to be able to fail, or the assertion above proves nothing.
  assert.deepEqual(unsourcedNumbers("I saved them 42 million.", [source]), ["42"]);

  // Every sentence of the proof section is a verbatim profile bullet.
  const bullets = PROFILE.experience.flatMap((e) => e.bullets);
  const quoted = letter.blocks.find((b) => b.type === "bullets").items;
  for (const line of quoted) {
    const bare = line.replace(/\s*\[add:[^\]]*\]\s*$/, "");
    assert.ok(bullets.includes(bare), `the letter invented a proof line: ${bare}`);
  }
  assert.ok(letter.text.includes("Acme Pay"), "the letter does not name the role it draws proof from");
});

test("cover letter leaves bracketed prompts for what the profile does not say", () => {
  const thin = { name: "Ada Rowe", email: "ada@example.com", experience: [], education: [] };
  const letter = buildLetter(thin, { company: "Zeta Systems", role: "Staff Engineer", tone: "warm" });
  assert.ok(letter.prompts.length >= 2, `expected bracketed prompts, got ${JSON.stringify(letter.prompts)}`);
  assert.match(letter.text, /\[add: one sentence on what you do\]/);
  assert.match(letter.text, /\[add: at least one role, with company, title and dates\]/);
  assert.equal(unsourcedNumbers(letter.text, [profileText(thin), "Zeta Systems", "Staff Engineer"]).length, 0);

  // A bullet with no figure asks for one instead of inventing one.
  const noMetric = {
    ...PROFILE,
    experience: [{ company: "Acme Pay", title: "Senior Engineer", start: "2021", bullets: ["Owned the PostgreSQL schema for ledger entries"] }],
  };
  const l2 = buildLetter(noMetric, { company: "Zeta", role: "Engineer", tone: "direct" });
  assert.ok(l2.prompts.includes("[add: metric]"), `expected [add: metric], got ${JSON.stringify(l2.prompts)}`);
});

test("a highlight the profile does not support is bracketed, not asserted", () => {
  const letter = buildLetter(PROFILE, {
    company: "Zeta", role: "Engineer", tone: "formal",
    highlights: ["Owned the PostgreSQL schema for ledger entries", "Led a team of 40 engineers"],
  });
  assert.deepEqual(letter.usedHighlights, ["Owned the PostgreSQL schema for ledger entries"]);
  assert.deepEqual(letter.unverifiedHighlights, ["Led a team of 40 engineers"]);
  assert.match(letter.text, /\[add: "Led a team of 40 engineers" is not in your profile/);
  // The number in the rejected highlight is only echoed back inside the bracket, never claimed.
  assert.doesNotMatch(letter.text, /^[^[]*40 engineers/m);
  assert.equal(traceHighlight("Migrated batch jobs to Kubernetes", PROFILE).ok, true);
  assert.equal(traceHighlight("Shipped a compiler in Rust", PROFILE).ok, false);
});

test("tailor_to_job: matched, missing, coverage and reorder-only rewrites", () => {
  const jd = `Senior Backend Engineer, payments platform.
    You will own reconciliation and the settlement pipeline. Reconciliation matters here.
    We use Rust and PostgreSQL. Rust in production is essential.`;
  const g = analyseGap(PROFILE, jd);
  assert.ok(g.keywords.length > 3);
  assert.ok(g.matched.includes("postgresql"), `postgresql should match: ${g.matched}`);
  assert.ok(g.missing.includes("rust"), `rust should be missing: ${g.missing}`);
  assert.ok(g.coverage > 0 && g.coverage <= 100);
  assert.equal(g.matched.length + g.missing.length, g.keywords.length);
  for (const kw of g.missing) assert.equal(matchesKeyword(JSON.stringify(g.rewrites), kw) && g.rewrites.some((r) => r.keyword === kw), false,
    `a missing keyword must never produce a rewrite: ${kw}`);

  const rw = suggestRewrites(PROFILE, ["reconciliation"]);
  assert.equal(rw.length, 1, "expected one reorder rewrite");
  const source = PROFILE.experience[0].bullets[0];
  assert.equal(rw[0].based_on, source);
  const wordsOf = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean).sort().join(" ");
  assert.equal(wordsOf(rw[0].suggestion), wordsOf(source), "a rewrite added or dropped a word");
  assert.match(rw[0].suggestion, /^Cutting reconciliation/);
  assert.deepEqual(extractKeywords("the and of for", 10), []);
});

test("markdown export carries the whole profile", () => {
  const r = renderResume(PROFILE, { style: "modern" });
  const md = blocksToMarkdown(PROFILE.name, r.blocks);
  for (const s of ["# Ada Rowe", "Acme Pay", "University of Warsaw", "PostgreSQL", "ada@example.com"]) {
    assert.ok(md.includes(s), `markdown is missing ${s}`);
  }
});

test("blocksToProfile reads a resume shape back out of blocks", () => {
  const blocks = [
    { type: "heading", level: 1, text: "Ada Rowe" },
    { type: "para", text: "ada@example.com  |  +48 500 100 200  |  Warsaw" },
    { type: "heading", level: 2, text: "Summary" },
    { type: "para", text: "Backend engineer." },
    { type: "heading", level: 2, text: "Skills" },
    { type: "para", text: "TypeScript, PostgreSQL" },
    { type: "heading", level: 2, text: "Experience" },
    { type: "heading", level: 3, text: "Senior Engineer, Acme Pay (2021 - present)" },
    { type: "bullets", ordered: false, items: ["Owned the ledger schema"], levels: [0] },
    { type: "heading", level: 2, text: "Education" },
    { type: "bullets", ordered: false, items: ["BSc Computer Science, University of Warsaw (2014 - 2018)"], levels: [0] },
  ];
  const { profile, sectionsFound } = blocksToProfile(blocks);
  assert.equal(profile.name, "Ada Rowe");
  assert.equal(profile.email, "ada@example.com");
  assert.equal(profile.summary, "Backend engineer.");
  assert.deepEqual(profile.skills, ["TypeScript", "PostgreSQL"]);
  assert.equal(profile.experience.length, 1);
  assert.equal(profile.experience[0].company, "Acme Pay");
  assert.equal(profile.experience[0].title, "Senior Engineer");
  assert.equal(profile.experience[0].start, "2021");
  assert.equal(profile.experience[0].end, undefined, "a current role must not be given an end date");
  assert.deepEqual(profile.experience[0].bullets, ["Owned the ledger schema"]);
  assert.equal(profile.education[0].school, "University of Warsaw");
  assert.ok(sectionsFound.includes("experience"));
});
