// completion-gates.mjs — E-320 (D-098 ruling 2): the ONE gate list for a task's transition to DONE.
//
// Two writers change a task to DONE: task-synchronizer's update_task_status and
// orchestrator-mcp's run_handover. Each kept its own copy of the gates, and the copies drifted —
// run_handover marked E-314 DONE past a [BUILD_STALE] refusal (E-319), and then still lacked the
// CI gate. Both now call this function and keep no gate logic of their own; a gate added here
// reaches both.
//
//   1. E-249 (D-067 §3) the build gate — src/mcp/** and src/bin/** must be in the install mirror
//      and every running server must have booted the current build (checkCompletionBuildGate).
//   2. E-267 (D-072 §5a) the CI gate — a green local CI run for HEAD, or a tested ancestor that
//      differs only in .ai/ (checkCiDoneGate; inactive until the project has run `rein ci`,
//      REIN_CI_GATE=0 disables it).
//   3. E-431 (D-159 r9) the acceptance gate — a Tier 2 or Tier 3 E-## task above
//      ACCEPT_GATE_FLOOR needs an [ACCEPT_PASS] stamp from critic_acceptance for HEAD, or for an
//      ancestor that differs only in .ai/ (the CI gate's rule). The newest ACCEPT_* stamp that
//      stands for HEAD decides, so a later [ACCEPT_FAIL] voids an earlier pass. A task closed
//      unimplemented passes `superseded` (update_task_status superseded_by: "D-###"), which
//      skips this gate only. No environment switch (D-084 r1, D-087 r3).
//
// The texts stay where they are defined (build-stamp.mjs, ci-runs.js); a refusal is returned as
// rejection() — isError plus _meta.expected_rejection, so telemetry books REJECTED (D-049).

import { checkCompletionBuildGate } from "./build-stamp.mjs";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { checkCiDoneGate, aiOnlyAncestor } from "../mcp/shared/ci-runs.js";
import { rejection } from "./mcp-telemetry.mjs";

/**
 * @param {{cwd: string, db: object, id?: string, buildOpts?: object, env?: object}} o
 *   cwd — the project root (the directory holding .ai/); db — its state.sqlite handle;
 *   id — the task (for the caller's own logging; the gates do not depend on it);
 *   buildOpts — fixture mirror/run directories for tests/unit; env — the CI gate's environment;
 *   superseded — the task closes unimplemented by a decision: the acceptance gate is skipped.
 * @returns {null | object} null when every gate passes, else the MCP result to return as is.
 */
export function completionGates({ cwd, db, id, buildOpts = {}, env = process.env, superseded = false } = {}) {
  const build = checkCompletionBuildGate({ repoRoot: cwd, ...buildOpts });
  if (!build.ok) return rejection(build.message);
  const ci = checkCiDoneGate(db, cwd, env);
  if (!ci.ok) return rejection(ci.message);
  if (!superseded) {
    const accept = checkAcceptGate(db, cwd, id);
    if (!accept.ok) return rejection(accept.message);
  }
  return null;
}

// D-159 r9 (E-431 ruling, 2026-11-18): tasks at or below this id were reviewed before the
// acceptance evaluator existed and close without it.
export const ACCEPT_GATE_FLOOR = 444;

/**
 * The acceptance gate. Returns { ok, active, message }.
 * Active for an E-## task of tier 2 or 3 whose number is above ACCEPT_GATE_FLOOR.
 */
export function checkAcceptGate(db, repoRoot, id) {
  const m = /^E-(\d+)$/.exec(id || "");
  if (!m || Number(m[1]) <= ACCEPT_GATE_FLOOR) return { ok: true, active: false, message: "acceptance gate: not an E-## task above the floor" };
  const row = db.prepare("SELECT tier FROM tasks WHERE id = ?").get(id);
  const tier = row ? row.tier : null;
  if (tier !== 2 && tier !== 3) return { ok: true, active: false, message: `acceptance gate: ${id} is not Tier 2 or 3` };
  let head;
  try {
    head = execFileSync("git", ["-C", repoRoot, "rev-parse", "--verify", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch { head = null; }
  const stamps = db.prepare(
    "SELECT type, sha FROM stamps WHERE task_id = ? AND type IN ('ACCEPT_PASS', 'ACCEPT_FAIL') AND sha IS NOT NULL ORDER BY id DESC",
  ).all(id);
  for (const s of head ? stamps : []) {
    const standsFor = s.sha === head || aiOnlyAncestor(repoRoot, s.sha, head)?.ok;
    if (!standsFor) continue;
    if (s.type === "ACCEPT_PASS") return { ok: true, active: true, message: `acceptance gate: ${id} accepted at ${s.sha.slice(0, 7)}` };
    break;   // the newest stamp that stands for HEAD is a FAIL
  }
  const at = head ? head.slice(0, 7) : "(no HEAD)";
  return {
    ok: false, active: true,
    message: `[ACCEPT_GATE] ${id} is Tier ${tier} and has no [ACCEPT_PASS] stamp for HEAD ${at} or an ancestor that differs only in .ai/ — dispatch critic_acceptance`,
  };
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
