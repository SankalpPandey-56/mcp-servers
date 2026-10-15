// Loop 35, defect ledger D-R75 second half (docs/USER_VALUE_R14.md): tailor_to_job's
// keyword extractor counted measured non-keywords ("similar", "record", "reducing") in
// the target set, deflating the coverage figure it reported. They are stopwords now.
import "../../../test/_tmp-scope.mjs"; // run-scoped TMPDIR, removed on exit
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
process.env.XDG_DATA_HOME = mkdtempSync(join(tmpdir(), "mcp-resume-r35-"));

const { extractKeywords } = await import(join(here, "..", "dist", "tailor.js"));

test("D-R75: measured non-keywords no longer enter the keyword set", () => {
  const jd =
    "We are looking for a backend engineer with a strong track record of reducing " +
    "latency. Experience with PostgreSQL and Kubernetes required. A similar role in " +
    "fintech is a plus. You will own the record pipeline end to end.";
  const kws = extractKeywords(jd, 30, ["postgresql", "kubernetes"]);
  assert.ok(kws.length > 0, "extractor returned nothing - the test would pass vacuously");
  for (const noise of ["similar", "record", "reducing"]) {
    assert.ok(!kws.includes(noise), `non-keyword "${noise}" still extracted: ${kws.join(", ")}`);
  }
  assert.ok(kws.includes("postgresql"), `real skill lost: ${kws.join(", ")}`);
  assert.ok(kws.includes("kubernetes"), `real skill lost: ${kws.join(", ")}`);
});
