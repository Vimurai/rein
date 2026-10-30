// tests/unit/instinct-stager.test.mjs — node:test unit suite for E-93 instinct staging
// (ecc-integrations.md §Components 1 & 2): src/shared/instinct-stager.mjs, in process.
//
// REPLACES instinct_stager_test.sh (E-302, D-088 r2): confidence gating, malformed and
// dangerous rejection, path-traversal neutralisation, inert frontmatter, provenance headers.
// Its agent-text rows (T-93.10, the meta_analyst Instinct-Extraction prompt) moved to
// tests/suites/meta_cognition_test.sh. Labels are the bash assertions' own.
// Run standalone:  node --test tests/unit/instinct-stager.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { stageInstincts } from "../../src/shared/instinct-stager.mjs";

const REPO = resolve(import.meta.dirname, "../..");
const ROOT = mkdtempSync(join(tmpdir(), "rein-t-instinct-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const PDIR = join(ROOT, "proposed");

// Mixed batch: 1 valid, 1 low-conf, 1 malformed, 2 dangerous, 1 traversal, 1 empty-slug.
const d = stageInstincts([
  { pattern_id: "INST-01", confidence_score: 0.85, trigger_condition: "When resolving a failing test", proposed_skill_content: "# Test-Fix Instinct\n\nRun the failing test, form a hypothesis, fix, re-run." },
  { pattern_id: "INST-02", confidence_score: 0.5, trigger_condition: "low confidence", proposed_skill_content: "# Low\n\nbody" },
  { pattern_id: "INST-03", confidence_score: 0.9, trigger_condition: "missing content" },
  { pattern_id: "INST-04", confidence_score: 0.95, trigger_condition: "danger", proposed_skill_content: "# Danger\n\nrm -rf /tmp/x" },
  { pattern_id: "INST-05", confidence_score: 0.95, trigger_condition: "secret", proposed_skill_content: "# Sec\n\nAKIAABCDEFGHIJKLMNOP here" },
  { pattern_id: "../../etc/passwd", confidence_score: 0.99, trigger_condition: "traversal", proposed_skill_content: "# Trav\n\nharmless body" },
  { pattern_id: "!!!", confidence_score: 0.99, trigger_condition: "empty slug", proposed_skill_content: "# Empty\n\nbody" },
], { proposedDir: PDIR });
const reason = (id) => d.skipped.filter((s) => s.pattern_id === id).map((s) => s.reason).join(",");

// ── T-93.01: valid high-confidence instinct is staged ───────────────────────
test("T-93.01: 2 staged (INST-01 + traversal-slug)", () => assert.equal(d.staged.length, 2));
test("T-93.01: INST-01 staged", () => assert.ok(d.staged.some((s) => s.pattern_id === "INST-01")));
test("T-93.01: proposed/inst-01/SKILL.md exists", () => assert.ok(existsSync(join(PDIR, "inst-01", "SKILL.md"))));
// ── T-93.02..06: skipped, each with its reason ──────────────────────────────
test("T-93.02: INST-02 below-confidence", () => assert.ok(reason("INST-02").includes("below-confidence")));
test("T-93.03: INST-03 missing content", () => assert.ok(reason("INST-03").includes("missing-proposed_skill_content")));
test("T-93.04: INST-04 rm -rf rejected", () => assert.ok(reason("INST-04").includes("dangerous-content:destructive-rm")));
test("T-93.05: INST-05 aws-key rejected", () => assert.ok(reason("INST-05").includes("dangerous-content:aws-key")));
test("T-93.06: '!!!' unsafe-pattern_id", () => assert.ok(d.skipped.some((s) => String(s.reason).includes("unsafe-pattern_id"))));
// ── T-93.07: a path-traversal pattern_id is neutralised and stays inside proposedDir ──
const trav = d.staged.find((s) => s.pattern_id === "../../etc/passwd")?.path ?? "";
test("T-93.07: traversal slug stays under proposedDir", () => assert.ok(trav.includes(PDIR + "/")));
test("T-93.07: no traversal escape in path", () => assert.ok(!trav.includes("/etc/passwd/")));
// ── T-93.08: the staged skill is INERT (cannot auto-fire) ───────────────────
const body = existsSync(join(PDIR, "inst-01", "SKILL.md")) ? readFileSync(join(PDIR, "inst-01", "SKILL.md"), "utf8") : "";
test("T-93.08: disable-model-invocation true", () => assert.ok(body.includes("disable-model-invocation: true")));
test("T-93.08: user-invocable false", () => assert.ok(body.includes("user-invocable: false")));
test("T-93.08: status proposed", () => assert.ok(body.includes("status: proposed")));
// ── T-93.09: provenance header + HITL gate reference + body ─────────────────
test("T-93.09: AUTO-GENERATED marker", () => assert.ok(body.includes("AUTO-GENERATED INSTINCT")));
test("T-93.09: approval-mcp (E-94) ref", () => assert.ok(body.includes("approval-mcp (E-94)")));
test("T-93.09: carries pattern_id", () => assert.ok(body.includes("INST-01")));
test("T-93.09: carries skill body", () => assert.ok(body.includes("Test-Fix Instinct")));
// ── T-93.11: the staging area is documented in source ───────────────────────
test("T-93.11: src/claude/skills/proposed/README.md exists", () => assert.ok(existsSync(join(REPO, "src/claude/skills/proposed/README.md"))));
