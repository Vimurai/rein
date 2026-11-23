// tests/unit/completion-gates.test.mjs — the acceptance gate in src/shared/completion-gates.mjs
// (E-431, D-159 r9 and the E-431 ruling of 2026-11-18).
//
// Extends the E-320 rows in build-stamp.test.mjs, which pin that update_task_status, run_handover
// and `rein task done` all go through completionGates(). Those rows cover the build and CI gates;
// these cover the third gate, called through checkAcceptGate and completionGates on a real git
// fixture. Stamps are written by record-store's insertStamp, so their sha is the HEAD the server
// would bind (E-329), not a value the test chose.
//
// E-464 (D-169 r8, D-170 r9): the review-by-tier rows extend the same fixture — the stamp check
// moved from pre-commit to this gate list (Tier 2: REVIEW_PASS + ACCEPT_PASS; Tier 3: + SEC_CLEARED).
//
// Run standalone: node --test tests/unit/completion-gates.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { checkAcceptGate, checkReviewGate, checkSecGate, checkSupersededBy, completionGates, ACCEPT_GATE_FLOOR, REVIEW_GATE_FLOOR } from "../../src/shared/completion-gates.mjs";
import { getDb } from "../../src/mcp/shared/state-db.js";
import { insertStamp } from "../../src/mcp/shared/record-store.mjs";

function fixture(t) {
  const repo = mkdtempSync(join(tmpdir(), "accept-gate-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  const g = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8" }).trim();
  g("init", "-q"); g("config", "user.email", "t@t"); g("config", "user.name", "t");
  g("config", "commit.gpgsign", "false");
  mkdirSync(join(repo, ".ai"), { recursive: true });
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.js"), "// v1\n");
  writeFileSync(join(repo, ".ai", "DECISIONS.md"), "# DECISIONS\n\n## D-7 — a ruling\n\n## D-70 addendum 1 — more\n");
  const ai = join(repo, ".ai");
  const db = getDb(ai);
  const add = db.prepare("INSERT INTO tasks(id, owner, status, tier, description, created_at) VALUES (?, 'Engineer (Claude)', 'OPEN', ?, 'fixture', '2026-11-18T00:00:00Z')");
  for (const [id, tier] of [["E-445", 2], ["E-446", 3], ["E-447", 1], ["E-444", 2], ["P-500", 2], ["E-470", 2], ["E-471", 3], ["E-472", 1]]) add.run(id, tier);
  const commit = (msg) => { g("add", "-A"); g("commit", "-q", "-m", msg); return g("rev-parse", "HEAD"); };
  const stamp = (id, type) => insertStamp(ai, db, { type, agent: "critic_acceptance", task_id: id, timestamp: new Date().toISOString(), summary: "1 | PASS | fixture" });
  // The build gate reads a run dir and a mirror: both point into the fixture, never ~/.rein.
  mkdirSync(join(repo, ".run"), { recursive: true });
  const gateOpts = { cwd: repo, db, id: "E-445", env: { REIN_CI_GATE: "0" },
    buildOpts: { mirrorRoot: repo, runDir: join(repo, ".run"), frameworkOnly: false } };
  return { repo, ai, db, commit, stamp, gateOpts, write: (p, s) => writeFileSync(join(repo, p), s) };
}

test("a Tier 2 E-## task above the floor without [ACCEPT_PASS] is refused DONE with one line naming the stamp", (t) => {
  const f = fixture(t);
  const head = f.commit("one");
  const r = checkAcceptGate(f.db, f.repo, "E-445");
  assert.equal(r.ok, false);
  assert.equal(r.message.split("\n").length, 1, "one line");
  assert.equal(r.message, `[ACCEPT_GATE] E-445 is Tier 2 and has no [ACCEPT_PASS] stamp for HEAD ${head.slice(0, 7)} or an ancestor that differs only in .ai/ — dispatch critic_acceptance`);
  // The shared entry both status writers call refuses the same way, booked as a rejection.
  const refused = completionGates(f.gateOpts);
  assert.match(refused?.content?.[0]?.text ?? "", /^\[ACCEPT_GATE\] E-445 /);
  assert.equal(refused.isError, true);
});

test("exempt: Tier 1, a P-## task, and E-## at or below ACCEPT_GATE_FLOOR (444)", (t) => {
  const f = fixture(t);
  f.commit("one");
  assert.equal(ACCEPT_GATE_FLOOR, 444);
  for (const id of ["E-447", "P-500", "E-444"]) {
    const r = checkAcceptGate(f.db, f.repo, id);
    assert.equal(r.ok, true, `${id}: ${r.message}`);
    assert.equal(r.active, false);
  }
});

test("[ACCEPT_PASS] for HEAD, or for an ancestor that differs only in .ai/, opens the gate", (t) => {
  const f = fixture(t);
  f.commit("one");
  f.stamp("E-446", "ACCEPT_PASS");
  assert.equal(checkAcceptGate(f.db, f.repo, "E-446").ok, true, "stamped on HEAD");
  f.write(".ai/LOG.md", "bookkeeping\n");
  f.commit("chore(.ai): bookkeeping");
  assert.equal(checkAcceptGate(f.db, f.repo, "E-446").ok, true, "a bookkeeping commit above the stamp");
  f.write("src/a.js", "// v2\n");
  f.commit("source change after the review");
  const r = checkAcceptGate(f.db, f.repo, "E-446");
  assert.equal(r.ok, false, "a source change after the stamp needs a new run");
  assert.match(r.message, /^\[ACCEPT_GATE\] E-446 is Tier 3 /);
});

test("the newest ACCEPT_* stamp that stands for HEAD decides: a later [ACCEPT_FAIL] voids an earlier pass", (t) => {
  const f = fixture(t);
  f.commit("one");
  f.stamp("E-445", "ACCEPT_PASS");
  f.stamp("E-445", "ACCEPT_FAIL");
  assert.equal(checkAcceptGate(f.db, f.repo, "E-445").ok, false);
  f.stamp("E-445", "ACCEPT_PASS");
  assert.equal(checkAcceptGate(f.db, f.repo, "E-445").ok, true, "a new pass after the fix");
  f.stamp("E-447", "ACCEPT_PASS");   // another task's stamp never counts
  assert.equal(checkAcceptGate(f.db, f.repo, "E-446").ok, false);
});

test("superseded_by: names a '## D-###' heading or is refused; a superseded close skips only this gate", (t) => {
  const f = fixture(t);
  f.commit("one");
  assert.equal(checkSupersededBy(f.ai, "D-7"), null);
  assert.equal(checkSupersededBy(f.ai, "D-70"), null, "an addendum heading names its decision");
  assert.match(checkSupersededBy(f.ai, "D-8"), /^\[SUPERSEDED_BY_UNKNOWN\] D-8 /);
  assert.match(checkSupersededBy(f.ai, "D-7; rm"), /^\[SUPERSEDED_BY_INVALID\]/);
  assert.match(checkSupersededBy(f.ai, undefined), /^\[SUPERSEDED_BY_INVALID\]/);
  assert.equal(completionGates({ ...f.gateOpts, superseded: true }), null);
  assert.notEqual(completionGates(f.gateOpts), null);
});

test("E-464: review by tier at DONE — Tier 1 needs nothing; Tier 2 needs [REVIEW_PASS] then [ACCEPT_PASS]", (t) => {
  const f = fixture(t);
  const head = f.commit("one");
  const close = (id) => completionGates({ ...f.gateOpts, id })?.content?.[0]?.text ?? null;
  assert.equal(close("E-472"), null, "Tier 1: no stamp");
  assert.equal(REVIEW_GATE_FLOOR, 457);
  assert.equal(checkReviewGate(f.db, f.repo, "E-445").active, false, "built under the commit-time critics");
  assert.equal(close("E-470"), `[REVIEW_GATE] E-470 is Tier 2 and has no [REVIEW_PASS] stamp for HEAD ${head.slice(0, 7)} or an ancestor that differs only in .ai/ — dispatch reviewer`);
  f.stamp("E-470", "REVIEW_PASS");
  assert.match(close("E-470"), /^\[ACCEPT_GATE\] E-470 /, "reviewed, not yet accepted");
  f.stamp("E-470", "ACCEPT_PASS");
  assert.equal(close("E-470"), null);
  f.stamp("E-470", "REVIEW_FAIL");
  assert.match(close("E-470"), /^\[REVIEW_GATE\] /, "a later [REVIEW_FAIL] voids the pass");
});

test("E-464: Tier 3 also needs [SEC_CLEARED] for HEAD; a later [SEC_BLOCKED] voids it", (t) => {
  const f = fixture(t);
  f.commit("one");
  f.stamp("E-471", "REVIEW_PASS");
  f.stamp("E-471", "ACCEPT_PASS");
  const r = checkSecGate(f.db, f.repo, "E-471");
  assert.equal(r.ok, false);
  assert.match(r.message, /^\[SEC_GATE\] E-471 is Tier 3 and has no \[SEC_CLEARED\] .* — dispatch security_engineer$/);
  assert.equal(checkSecGate(f.db, f.repo, "E-470").active, false, "Tier 2 needs no security round");
  f.stamp("E-471", "SEC_CLEARED");
  assert.equal(completionGates({ ...f.gateOpts, id: "E-471" }), null);
  f.stamp("E-471", "SEC_BLOCKED");
  assert.match(completionGates({ ...f.gateOpts, id: "E-471" })?.content?.[0]?.text ?? "", /^\[SEC_GATE\] E-471 /);
});
