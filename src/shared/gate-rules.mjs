// gate-rules.mjs — E-432 (D-159 r7, harness-fitness.md §Component 2): the closed list of gate rule
// ids a pre-tool-use block is attributed to in telemetry (tool_executions.rule).
//
// Format (A2A ruling 2026-11-18 15:10, Q3): `<hook bracket code>:<analyzer id as printed>`, or the
// bare bracket code on a hook-only path. When a report prints several ids the first one counts
// (sovereignty violations print before policy blocks). Every string the hook can write is listed
// here exactly; anything else is written as UNLISTED, never stored as given. The list holds no
// command text, path or argument — only these fixed tokens reach telemetry.
//
// tests/unit/gate-rules.test.mjs runs every BLOCK row of the pinned verdict tables through the
// analyzer and asserts the attributed id is on this list, so a new analyzer rule cannot land
// UNLISTED without a test saying so.

/** The hook's bracket codes (hooks/pre-tool-use.sh, each exit-2 path). */
export const GATE_CODES = Object.freeze([
  "SAFE_EXEC_BLOCK",        // the analyzer's --check verdict was BLOCK, or the backstop fired
  "SOVEREIGNTY_BLOCK",      // the Write/Edit path gate (--check-path) refused
  "SAFE_EXEC_UNAVAILABLE",  // the analyzer was found but gave no verdict
  "TOOLCHAIN_STALE",        // node or python3 missing
  "GATE_INTERNAL_ERROR",    // unparseable payload, an abort or a signal inside the hook
]);

// safe-exec --check: BLOCK_RULES, the WARN_RULES (printed after the blocks, never first, listed
// for completeness), the size refusal, the Architect sovereignty ids (index.js, git-redirect.mjs,
// architect-writes.mjs) and the claim gate's codes (claim-gate.mjs → task-claims.mjs claimGate).
const ARCH_GIT_VERBS = ["reset", "revert", "checkout", "clean", "merge", "rebase", "push", "pull", "branch"];
const CHECK_IDS = [
  "RM_RF_ROOT", "CURL_PIPE_SHELL", "WGET_PIPE_SHELL", "DROP_TABLE", "FORK_BOMB", "DD_DISK_WIPE",
  "MKFS", "FIND_DELETE_ROOT", "REDIRECT_TO_SYSTEM_FILE", "CHMOD_ROOT", "GATE_SELF_DISABLE",
  "SECRET_IN_COMMAND",
  "RM_RF", "DD_DEVICE", "CHMOD_777", "SUDO_SU", "GIT_FORCE_PUSH", "HISTORY_CLEAR",
  "INPUT_TOO_LARGE",
  ...ARCH_GIT_VERBS.map((v) => `ARCH_GIT_${v.toUpperCase()}`),
  "ARCH_RM_RF", "ARCH_MKDIR", "ARCH_TOUCH",
  "ARCH_DEPLOY_SSH", "ARCH_DEPLOY_RSYNC", "ARCH_DEPLOY_SCP", "ARCH_DEPLOY_NPM_PUBLISH", "ARCH_DEPLOY_DOCKER_PUSH",
  "ARCH_CODE_STRING_DEPTH", "ARCH_GIT_DIR_OVERRIDE", "ARCH_GIT_EXEC_CONFIG", "ARCH_GIT_HOOKS_PATH",
  "ARCH_ARCHIVE_EXTRACT", "ARCH_GIT_WRITE", "ARCH_INLINE_INTERPRETER", "ARCH_REDIRECT_UNPARSED",
  "ARCH_SHELL_WRITE", "ARCH_WRITE_UNPARSED",
  "CLAIM_REQUIRED", "TEAM_INVALID", "CLAIM_GATE_ERROR",
  // The hook's own backstop, when the analyzer gave no verdict.
  "BACKSTOP_CATASTROPHIC", "BACKSTOP_GATE_TOUCH",
];
// safe-exec --check-path (the Write/Edit gate).
const CHECK_PATH_IDS = ["ARCH_WRITE_OUTSIDE_SCOPE", "GATE_SELF_DISABLE", "CLAIM_REQUIRED", "TEAM_INVALID", "CLAIM_GATE_ERROR"];

/** Every value tool_executions.rule may hold, plus UNLISTED. */
export const GATE_RULES = Object.freeze([
  ...GATE_CODES,
  ...CHECK_IDS.map((id) => `SAFE_EXEC_BLOCK:${id}`),
  ...CHECK_PATH_IDS.map((id) => `SOVEREIGNTY_BLOCK:${id}`),
]);
export const UNLISTED = "UNLISTED";
const RULE_SET = new Set(GATE_RULES);

/** A value from the closed list, or UNLISTED. Never returns its input unless it is listed. */
export function normalizeGateRule(value) {
  return typeof value === "string" && RULE_SET.has(value) ? value : UNLISTED;
}

/**
 * The analyzer id a safe-exec block report names: its first `Rule: ID` line, which every BLOCK
 * report prints before any echo of the command or path (security_engineer P2-1 — the echo can hold
 * any text). A report without one (an analyzer crash) names none. Mirrors _gate_reject in
 * hooks/pre-tool-use.sh, the writer; this copy lets the unit test drive the tables in process.
 */
export function firstReportId(report) {
  const m = /^Rule: ([A-Z][A-Z0-9_]*)$/m.exec(String(report ?? ""));
  return m ? m[1] : null;
}
