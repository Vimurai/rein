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
const ORCH = readFileSync(resolve(repo, "src/mcp/orchestrator-mcp/index.js"), "utf8");
const AI_BIN = readFileSync(resolve(repo, "src/bin/ai"), "utf8");

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
test("E-222.08a: src/bin/ai's own locator bootstrap is not P0", () => {
  const real = AI_BIN.split("\n").find((l) => l.includes("shared/locate.sh"));
  assert.ok(real, "src/bin/ai names shared/locate.sh");
  assert.notEqual(grade(`+${real}`), "P0");
});
