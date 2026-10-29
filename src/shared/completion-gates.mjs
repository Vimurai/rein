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
//      differs only in .ai/ (checkCiDoneGate; inactive until the project has run `ai ci`,
//      REIN_CI_GATE=0 disables it).
//
// The texts stay where they are defined (build-stamp.mjs, ci-runs.js); a refusal is returned as
// rejection() — isError plus _meta.expected_rejection, so telemetry books REJECTED (D-049).

import { checkCompletionBuildGate } from "./build-stamp.mjs";
import { checkCiDoneGate } from "../mcp/shared/ci-runs.js";
import { rejection } from "./mcp-telemetry.mjs";

/**
 * @param {{cwd: string, db: object, id?: string, buildOpts?: object, env?: object}} o
 *   cwd — the project root (the directory holding .ai/); db — its state.sqlite handle;
 *   id — the task (for the caller's own logging; the gates do not depend on it);
 *   buildOpts — fixture mirror/run directories for tests/unit; env — the CI gate's environment.
 * @returns {null | object} null when every gate passes, else the MCP result to return as is.
 */
export function completionGates({ cwd, db, buildOpts = {}, env = process.env } = {}) {
  const build = checkCompletionBuildGate({ repoRoot: cwd, ...buildOpts });
  if (!build.ok) return rejection(build.message);
  const ci = checkCiDoneGate(db, cwd, env);
  if (!ci.ok) return rejection(ci.message);
  return null;
}
