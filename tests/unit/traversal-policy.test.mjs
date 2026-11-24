// traversal-policy.test.mjs — E-222 (D-057 §2): context-aware PATH_TRAVERSAL grading. Moved from
// tests/suites/traversal_policy_test.sh (E-301, D-088: a pure function is tested in the unit
// layer); the rows and their ids are unchanged.
//
// `run_review`'s traversal check was one flat regex — any added line containing `../` was a P0
// that BLOCKED the commit. That blocked E-220's fix for a real vulnerability, on an idiom
// (`"${_sd}/../shared/x.mjs"`) already present at four other sites in the same file. The
// fixtures run in BOTH directions on purpose: loosening a security check is only safe if the
// cases it must still catch are enumerated beside the ones it must stop catching.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { classifyTraversal } = await import(resolve(repo, "src/shared/traversal-policy.mjs"));
const POLICY = readFileSync(resolve(repo, "src/shared/traversal-policy.mjs"), "utf8");
// E-464: run_review's checks moved to `rein review` (src/shared/review-checks.mjs); the source rows read it.
const ORCH = readFileSync(resolve(repo, "src/shared/review-checks.mjs"), "utf8");
const AI_BIN = readFileSync(resolve(repo, "src/bin/rein"), "utf8");

const grade = (line, strict = false) => classifyTraversal(line, { strict })?.severity ?? "none";

// The input→grade rows (E-222.01 must still block, .02 script-relative is advisory, .03 silent
// lines, .04 the dangerous shape governs, .05a/.09 comments and the strict rollback) are a table:
// tests/fixtures/traversal-policy-cases.json. JSON, because the review gate's traversal check
// reads every `../` in a source file as code and JSON values as data (E-55).
const cases = JSON.parse(readFileSync(resolve(repo, "tests/fixtures/traversal-policy-cases.json"), "utf8"));
test("the table carries every grade (it cannot pass empty)", () => {
  for (const want of ["P0", "P1", "none"]) assert.ok(cases.some((c) => c.want === want), want);
});
for (const c of cases) test(`${c.want}: ${c.label}`, () => assert.equal(grade(c.line, c.strict), c.want, c.line));

// ── E-428: file-aware rows (extends the table above; graded through classifyDiffTraversal,
// the function run_review calls). A test file's traversal is advisory; a reasoned
// `rein:allow PATH_TRAVERSAL` marker suppresses and is reported; strict ignores both. ──
const { classifyDiffTraversal } = await import(resolve(repo, "src/shared/traversal-policy.mjs"));
const fileCases = JSON.parse(readFileSync(resolve(repo, "tests/fixtures/traversal-file-cases.json"), "utf8"));
const oneLineDiff = (file, line) => `+++ b/${file}\n@@ -0,0 +1,1 @@\n${line}\n`;
const notMarkdown = () => { throw new Error("not read for non-markdown files"); };
test("the file table carries every grade (it cannot pass empty)", () => {
  for (const want of ["P0", "P1", "none"]) assert.ok(fileCases.some((c) => c.want === want), want);
});
for (const c of fileCases) test(`${c.want}: ${c.label}`, () => {
  const { traversal, suppressed } = classifyDiffTraversal(oneLineDiff(c.file, c.line), { strict: !!c.strict, readFile: notMarkdown });
  assert.equal(traversal?.severity ?? "none", c.want, `${c.file}: ${c.line}`);
  if (c.reason) assert.deepEqual(suppressed, [{ file: c.file, line: 1, reason: c.reason }]);
  else assert.deepEqual(suppressed, []);
});
test("E-428.06: a P0 later in the diff still governs after a suppression and an advisory", () => {
  // Rows from the table (the literals stay in JSON, which the review gate reads as data):
  // a reasoned marker, a test-file advisory, then a src/ P0 — in that order.
  const row = (prefix) => fileCases.find((c) => !c.strict && c.label.startsWith(prefix));
  const [marked, advisory, blocking] = [row("E-428.04"), row("E-428.01"), row("E-428.02")];
  const diff = [marked, advisory, blocking].map((c) => oneLineDiff(c.file, c.line)).join("");
  const { traversal, suppressed } = classifyDiffTraversal(diff, { readFile: notMarkdown });
  assert.equal(traversal.severity, "P0");
  assert.equal(traversal.file, blocking.file);
  assert.equal(suppressed.length, 1);
});
// The blueprint-aligner's CAPABILITIES_BYPASS rows went with the server (E-467, D-170 r5).
test("E-428.07: run_review reports every suppression with its reason", () =>
  assert.match(ORCH, /id: "TRAVERSAL_SUPPRESSED"[\s\S]{0,200}s\.reason/));

// ── E-222.5: the rollback flag restores the flat regex (05a is a table row) ──
test("E-222.05b: run_review reads REIN_REVIEW_STRICT_TRAVERSAL", () => assert.match(ORCH, /REIN_REVIEW_STRICT_TRAVERSAL/));

// ── E-222.6: the policy has exactly one definition; run_review delegates the per-line loop
// (E-224 moved it into the shared module, so the gate and these rows run the same code) ──
test("E-222.06a: the anchor list is exported from one module", () => assert.match(POLICY, /export const SCRIPT_RELATIVE_ANCHORS/));
test("E-222.06b: run_review keeps no second copy of the regex", () => assert.doesNotMatch(ORCH, /traversalPattern/));
test("E-222.06c: run_review delegates to the shared policy", () => assert.match(ORCH, /classifyDiffTraversal\(diff/));

// ── E-222.7: an advisory is REPORTED, never dropped ──
test("E-222.07a: a P1 traversal is emitted as a WARN row", () =>
  assert.match(ORCH, /status: traversal\.severity === .P0. \? .FAIL. : .WARN./));
test("E-222.07b: the report names the anchor that excused it", () => assert.match(ORCH, /anchored to /));

// ── E-222.8: the real diff that motivated this passes ──
test("E-222.08a: src/bin/rein's own locator bootstrap is not P0", () => {
  const real = AI_BIN.split("\n").find((l) => l.includes("shared/locate.sh"));
  assert.ok(real, "src/bin/rein names shared/locate.sh");
  assert.notEqual(grade(`+${real}`), "P0");
});

// ── E-464 (D-169 r8): `rein review <tier>` — the checks run_review made, on a diff, and the
// agents the tier dispatches. Extends the source rows above with the behaviour itself; E-169's
// sovereignty rows moved here from mcp_servers_test.sh.
const { reviewChecks, reviewReport, TIER_DISPATCH } = await import(resolve(repo, "src/shared/review-checks.mjs"));
const diffOf = (file, line) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -0,0 +1 @@\n+${line}\n`;
test("E-464.R1: the dispatch list per tier — 1 none; 2 reviewer then critic_acceptance; 3 plus security_engineer", () => {
  assert.deepEqual(TIER_DISPATCH, { 1: [], 2: ["reviewer", "critic_acceptance"], 3: ["reviewer", "critic_acceptance", "security_engineer"] });
  assert.match(reviewReport(1, "").text, /none — Tier 1 needs no review and no stamp/);
  // E-469: the agents ship in the rein plugin, so the report names them plugin-scoped.
  assert.match(reviewReport(3, "").text, /1\. rein:reviewer .*\n {2}2\. rein:critic_acceptance .*\n {2}3\. rein:security_engineer .*SEC_CLEARED/);
});
test("E-464.R2 (E-169): an Architect-owned file or any blueprint is a P0, and a P0 dispatches nothing", () => {
  for (const f of [".ai/architect.md", ".ai/blueprints/x.md"]) {
    assert.equal(reviewChecks(diffOf(f, "text"), { env: {} }).find((c) => c.id === "SOVEREIGNTY_VIOLATION")?.severity, "P0", f);
  }
  const r = reviewReport(2, diffOf(".ai/blueprints/x.md", "text"), { env: {} });
  assert.equal(r.p0, 1);
  assert.match(r.text, /none yet — fix the 1 P0 finding/);
  assert.doesNotMatch(r.text, /1\. reviewer/);
});
