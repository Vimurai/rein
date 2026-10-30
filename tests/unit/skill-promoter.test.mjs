// tests/unit/skill-promoter.test.mjs — node:test unit suite for E-94 approval-gated skill
// promotion (ecc-integrations.md §Components 2 & §Security): src/shared/skill-promoter.mjs,
// in process, staging through the real instinct-stager.
//
// REPLACES skill_promoter_test.sh T-94.01..08 (E-302, D-088 r2): APPROVED promotion and
// frontmatter activation, fail-closed REJECTED / NON_TTY / missing decisions, no-clobber of an
// active skill, the dangerous-content re-scan, and unsafe slugs. Its remainder (T-94.09, the
// meta_analyst promotion text) moved to tests/suites/meta_cognition_test.sh. EXTENDS
// tests/unit/instinct-stager.test.mjs. Labels are the bash assertions' own.
// Run standalone:  node --test tests/unit/skill-promoter.test.mjs

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stageInstincts } from "../../src/shared/instinct-stager.mjs";
import { promoteSkill, listProposedSkills } from "../../src/shared/skill-promoter.mjs";

const ROOT = mkdtempSync(join(tmpdir(), "rein-t-promoter-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let _n = 0;
const root = () => { const d = join(ROOT, `r${++_n}`); mkdirSync(d); return d; };
const INSTINCT = [{ pattern_id: "INST-01", confidence_score: 0.9, trigger_condition: "after green tests",
  proposed_skill_content: "# Commit Instinct\n\nStage, write a Conventional Commit, push." }];

// stageAndPromote(decision|undefined) → { res, proposedList, proposedExists, activeExists, activeContent }
const stageAndPromote = (decision) => {
  const r = root(); const PDIR = join(r, "proposed"), ADIR = join(r, "active");
  stageInstincts(INSTINCT, { proposedDir: PDIR });
  const proposedList = listProposedSkills(PDIR).map((s) => s.slug);
  const res = promoteSkill("inst-01", { proposedDir: PDIR, activeDir: ADIR, decision });
  const ap = join(ADIR, "inst-01", "SKILL.md");
  return { res, proposedList, proposedExists: existsSync(join(PDIR, "inst-01", "SKILL.md")),
    activeExists: existsSync(ap), activeContent: existsSync(ap) ? readFileSync(ap, "utf8") : "" };
};

// ── T-94.01 / T-94.02: listed, then an APPROVED decision promotes + activates ─
const ok = stageAndPromote({ status: "APPROVED", id: 7 });
test("T-94.01: proposal listed before promote", () => assert.ok(ok.proposedList.includes("inst-01")));
test("T-94.02: promoted=true", () => assert.equal(ok.res.promoted, true));
test("T-94.02: active SKILL.md written", () => assert.equal(ok.activeExists, true));
test("T-94.02: model-invocation enabled", () => assert.ok(ok.activeContent.includes("disable-model-invocation: false")));
test("T-94.02: user-invocable enabled", () => assert.ok(ok.activeContent.includes("user-invocable: true")));
test("T-94.02: status active", () => assert.ok(ok.activeContent.includes("status: active")));
test("T-94.02: promotion provenance stamp", () => assert.ok(ok.activeContent.includes("PROMOTED to active via approval-mcp HITL gate (E-94)")));
test("T-94.02: proposal removed from staging", () => assert.equal(ok.proposedExists, false));
test("T-94.02: stale PROPOSED provenance stripped", () => assert.ok(!ok.activeContent.includes("PROPOSED, NOT ACTIVE")));

// ── T-94.03..05: every non-APPROVED decision is fail-closed ─────────────────
const rej = stageAndPromote({ status: "REJECTED" });
test("T-94.03: not promoted", () => assert.equal(rej.res.promoted, false));
test("T-94.03: reason not-approved", () => assert.equal(rej.res.reason, "not-approved:REJECTED"));
test("T-94.03: no active skill", () => assert.equal(rej.activeExists, false));
test("T-94.03: proposal preserved", () => assert.equal(rej.proposedExists, true));
test("T-94.04: NON_TTY refused", () => assert.equal(stageAndPromote({ status: "NON_TTY" }).res.reason, "not-approved:NON_TTY"));
test("T-94.05: no-decision refused", () => assert.equal(stageAndPromote(undefined).res.reason, "not-approved:no-decision"));

// ── T-94.06: no-clobber of an existing active skill ─────────────────────────
const clob = (() => {
  const r = root(); const PDIR = join(r, "proposed"), ADIR = join(r, "active");
  stageInstincts(INSTINCT, { proposedDir: PDIR });
  mkdirSync(join(ADIR, "inst-01"), { recursive: true });
  writeFileSync(join(ADIR, "inst-01", "SKILL.md"), "# REAL ACTIVE SKILL\n", "utf8");
  const res = promoteSkill("inst-01", { proposedDir: PDIR, activeDir: ADIR, decision: { status: "APPROVED" } });
  return { res, kept: readFileSync(join(ADIR, "inst-01", "SKILL.md"), "utf8") };
})();
test("T-94.06: refuses to clobber active", () => assert.ok(String(clob.res.reason).includes("active-skill-exists")));
test("T-94.06: existing active untouched", () => assert.ok(clob.kept.includes("REAL ACTIVE SKILL")));

// ── T-94.07: the dangerous-content re-scan blocks promotion (defence in depth) ─
test("T-94.07: dangerous content blocked even if approved", () => {
  const r = root(); const PDIR = join(r, "proposed");
  mkdirSync(join(PDIR, "danger"), { recursive: true });
  writeFileSync(join(PDIR, "danger", "SKILL.md"),
    "---\nname: danger\ndisable-model-invocation: true\nuser-invocable: false\nstatus: proposed\n---\n# Danger\nrm -rf /tmp/x\n");
  const res = promoteSkill("danger", { proposedDir: PDIR, activeDir: join(r, "active"), decision: { status: "APPROVED" } });
  assert.ok(String(res.reason).includes("dangerous-content"));
});

// ── T-94.08: an unsafe slug is rejected ─────────────────────────────────────
test("T-94.08: unsafe slug refused", () => {
  const r = root();
  const res = promoteSkill("../escape", { proposedDir: join(r, "p"), activeDir: join(r, "a"), decision: { status: "APPROVED" } });
  assert.ok(String(res.reason).includes("unsafe-slug"));
});
