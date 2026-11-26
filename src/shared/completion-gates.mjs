// completion-gates.mjs — E-320 (D-098 ruling 2): the ONE gate list for a task's transition to DONE.
//
// Two writers change a task to DONE: task-synchronizer's update_task_status and
// orchestrator-mcp's run_handover. Each kept its own copy of the gates, and the copies drifted —
// run_handover marked E-314 DONE past a [BUILD_STALE] refusal (E-319), and then still lacked the
// CI gate. Both now call this function and keep no gate logic of their own; a gate added here
// reaches both.
//
//   1. E-249 (D-067 §3) the build check — src/mcp/** and src/bin/** in the install mirror, every
//      running server on the current build (checkCompletionBuildGate). Since E-461 (D-169 r7) it
//      no longer refuses DONE: a stale build is one [BUILD_STALE] line pushed onto `notes`.
//   2. E-267 (D-072 §5a) the CI gate — a green local CI run for HEAD, or a tested ancestor that
//      differs only in .ai/ (checkCiDoneGate; inactive until the project has run `rein ci`,
//      REIN_CI_GATE=0 disables it).
//   3. E-431 (D-159 r9) the acceptance gate — a Tier 2 or Tier 3 E-## task above
//      ACCEPT_GATE_FLOOR needs an [ACCEPT_PASS] stamp from critic_acceptance for HEAD, or for an
//      ancestor that differs only in .ai/ (the CI gate's rule). The newest ACCEPT_* stamp that
//      stands for HEAD decides, so a later [ACCEPT_FAIL] voids an earlier pass. A task closed
//      unimplemented passes `superseded` (update_task_status superseded_by: "D-###"), which
//      skips the stamp gates only. No environment switch (D-084 r1, D-087 r3).
//   4. E-464 (D-169 r8, D-170 r9) review by tier; the stamp check moved here from pre-commit.
//      Tier 1: nothing. Tier 2: [REVIEW_PASS] from the reviewer and the [ACCEPT_PASS] above.
//      Tier 3: those and [SEC_CLEARED] from the security_engineer round. Same rule as (3): the
//      newest PASS/FAIL pair that stands for HEAD (or an .ai/-only ancestor) decides. Tasks at or
//      below REVIEW_GATE_FLOOR were reviewed by the critics at commit time and close without it.
//   5. E-480 (D-176, acceptance-replay.md §Component 3) the check gate — a Tier 2 or Tier 3 E-##
//      task above CHECK_GATE_FLOOR needs a [CHECKS_PASS] stamp (any task's: the replay is of the
//      whole ledger) for HEAD or an .ai/-only ancestor; the newest CHECKS_PASS/CHECKS_FAIL that
//      stands for HEAD decides. The gate READS the stamp and runs nothing: the replayer runs only
//      in the caller's shell, never in the MCP server, which is outside the role sandbox.
//
// The texts stay where they are defined (build-stamp.mjs, ci-runs.js); a refusal is returned as
// rejection() — isError plus _meta.expected_rejection: bad input, not a malfunction (D-049).

import { checkCompletionBuildGate } from "./build-stamp.mjs";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { checkCiDoneGate, aiOnlyAncestor } from "../mcp/shared/ci-runs.js";
import { rejection } from "./mcp-result.mjs";

/**
 * @param {{cwd: string, db: object, id?: string, buildOpts?: object, env?: object}} o
 *   cwd — the project root (the directory holding .ai/); db — its state.sqlite handle;
 *   id — the task (for the caller's own logging; the gates do not depend on it);
 *   buildOpts — fixture mirror/run directories for tests/unit; env — the CI gate's environment;
 *   superseded — the task closes unimplemented by a decision: the acceptance gate is skipped;
 *   notes — an array the advisory [BUILD_STALE] line is pushed onto (E-461), for the caller to print.
 * @returns {null | object} null when every gate passes, else the MCP result to return as is.
 */
export function completionGates({ cwd, db, id, buildOpts = {}, env = process.env, superseded = false, notes = null } = {}) {
  const build = checkCompletionBuildGate({ repoRoot: cwd, ...buildOpts });
  if (!build.ok && Array.isArray(notes)) notes.push(buildStaleLine(build.message));
  const ci = checkCiDoneGate(db, cwd, env);
  if (!ci.ok) return rejection(ci.message);
  if (!superseded) {
    for (const gate of [checkReviewGate, checkAcceptGate, checkSecGate, checkChecksGate]) {
      const r = gate(db, cwd, id);
      if (!r.ok) return rejection(r.message);
    }
  }
  return null;
}

/**
 * E-461 (D-169 r7): the one line a stale build prints at DONE, from the gate's full text — its
 * first line without the mark and the colon, and the fix.
 */
export function buildStaleLine(message) {
  const first = String(message || "").split("\n")[0].replace(/^✗\s*/, "").replace(/:\s*$/, "");
  return `${first} — not refused; install: bash install-rein.sh, then restart the MCP servers`;
}

// E-464 (D-170 r9): tasks at or below this id were built while pre-commit required a
// [CRITIC_STAMP] for every commit, and close without a [REVIEW_PASS] or [SEC_CLEARED].
export const REVIEW_GATE_FLOOR = 457;

function _head(repoRoot) {
  try {
    return execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { return null; }
}

/**
 * The newest `pass`/`fail` stamp of task `id` that stands for HEAD (its sha, or an ancestor that
 * differs only in .ai/) decides: → { ok, sha }. No such stamp: { ok: false, sha: null }.
 */
function _verdictForHead(db, repoRoot, id, pass, fail, head) {
  // E-480: id null reads the stamps of every task (CHECKS_PASS is recorded for HEAD, not a task).
  const stamps = id === null
    ? db.prepare("SELECT type, sha FROM stamps WHERE type IN (?, ?) AND sha IS NOT NULL ORDER BY id DESC").all(pass, fail)
    : db.prepare("SELECT type, sha FROM stamps WHERE task_id = ? AND type IN (?, ?) AND sha IS NOT NULL ORDER BY id DESC").all(id, pass, fail);
  for (const s of head ? stamps : []) {
    if (s.sha === head || aiOnlyAncestor(repoRoot, s.sha, head)?.ok) return { ok: s.type === pass, sha: s.sha };
  }
  return { ok: false, sha: null };
}

/** One stamp gate: active for an E-## task above `floor` whose tier is in `tiers`. → { ok, active, message } */
function _stampGate(db, repoRoot, id, { floor, tiers, pass, fail, tag, agent, what, anyTask = false, refusal = null }) {
  const m = /^E-(\d+)$/.exec(id || "");
  if (!m || Number(m[1]) <= floor) return { ok: true, active: false, message: `${what}: not an E-## task above the floor` };
  const row = db.prepare("SELECT tier FROM tasks WHERE id = ?").get(id);
  const tier = row ? row.tier : null;
  if (!tiers.includes(tier)) return { ok: true, active: false, message: `${what}: ${id} is not Tier ${tiers.join(" or ")}` };
  const head = _head(repoRoot);
  const v = _verdictForHead(db, repoRoot, anyTask ? null : id, pass, fail, head);
  if (v.ok) return { ok: true, active: true, message: `${what}: ${id} ${pass} at ${v.sha.slice(0, 7)}` };
  if (refusal) return { ok: false, active: true, message: refusal };
  const at = head ? head.slice(0, 7) : "(no HEAD)";
  return {
    ok: false, active: true,
    message: `[${tag}] ${id} is Tier ${tier} and has no [${pass}] stamp for HEAD ${at} or an ancestor that differs only in .ai/ — dispatch ${agent}`,
  };
}

/** The review gate (E-464): a Tier 2 or 3 E-## task above REVIEW_GATE_FLOOR needs [REVIEW_PASS]. */
export function checkReviewGate(db, repoRoot, id) {
  return _stampGate(db, repoRoot, id, { floor: REVIEW_GATE_FLOOR, tiers: [2, 3], pass: "REVIEW_PASS", fail: "REVIEW_FAIL",
    tag: "REVIEW_GATE", agent: "reviewer", what: "review gate" });
}

/** The security gate (E-464): a Tier 3 E-## task above REVIEW_GATE_FLOOR needs [SEC_CLEARED]. */
export function checkSecGate(db, repoRoot, id) {
  return _stampGate(db, repoRoot, id, { floor: REVIEW_GATE_FLOOR, tiers: [3], pass: "SEC_CLEARED", fail: "SEC_BLOCKED",
    tag: "SEC_GATE", agent: "security_engineer", what: "security gate" });
}

// D-159 r9 (E-431 ruling, 2026-11-18): tasks at or below this id were reviewed before the
// acceptance evaluator existed and close without it.
export const ACCEPT_GATE_FLOOR = 444;

/**
 * The acceptance gate. Returns { ok, active, message }.
 * Active for an E-## task of tier 2 or 3 whose number is above ACCEPT_GATE_FLOOR.
 */
export function checkAcceptGate(db, repoRoot, id) {
  return _stampGate(db, repoRoot, id, { floor: ACCEPT_GATE_FLOOR, tiers: [2, 3], pass: "ACCEPT_PASS", fail: "ACCEPT_FAIL",
    tag: "ACCEPT_GATE", agent: "critic_acceptance", what: "acceptance gate" });
}

// E-480 (D-176): the check gate applies to tasks above the one that built it, so E-478 to E-480
// close without the replay they introduce.
export const CHECK_GATE_FLOOR = 480;

/** The check gate (E-480): a Tier 2 or 3 E-## task above CHECK_GATE_FLOOR needs [CHECKS_PASS] for HEAD. */
export function checkChecksGate(db, repoRoot, id) {
  return _stampGate(db, repoRoot, id, { floor: CHECK_GATE_FLOOR, tiers: [2, 3], pass: "CHECKS_PASS", fail: "CHECKS_FAIL",
    tag: "CHECK_GATE", what: "check gate", anyTask: true,
    refusal: "[CHECK_GATE] no CHECKS_PASS for HEAD — run: rein recheck" });
}

/**
 * update_task_status superseded_by (E-431 ruling): the value must be a D-### that DECISIONS.md
 * carries as a `## D-###` heading. Returns null when it does, else the refusal line.
 */
export function checkSupersededBy(aiDir, value) {
  if (typeof value !== "string" || !/^D-\d+$/.test(value)) {
    return `[SUPERSEDED_BY_INVALID] superseded_by must be a decision id like D-159, got ${JSON.stringify(value)}`;
  }
  let text = "";
  try { text = readFileSync(join(aiDir, "DECISIONS.md"), "utf8"); } catch { /* absent → refused below */ }
  const heading = new RegExp(`^## ${value}(?=[\\s—]|$)`, "m");
  return heading.test(text) ? null : `[SUPERSEDED_BY_UNKNOWN] ${value} has no '## ${value}' heading in .ai/DECISIONS.md`;
}
