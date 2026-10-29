#!/usr/bin/env bash
# launch-vars.sh — E-264 (D-071 §4, test-harness-isolation.md §Inherited Launch Variables).
#
# Variables `ai pane`, `ai start` or the AI-OS shell EXPORT that a hook or resolver ranks
# ABOVE its own inputs. A suite run from a bound pane inherits them, and the hook obeys the
# pane instead of the test:
#   AI_OS_PANE_ROLE    `ai pane <role>`   — pre-commit.sh's advisory row 4 (restrict-only) and
#                                            stop-hook.sh's actor label read it (git_lane_test
#                                            once lost its whole Architect lane to it). Since
#                                            E-294 (D-087 r3) no GATE takes a role from it.
#   AI_OS_CALLER_ROLE  `ai pane <role>`   — the same advisory row 4, plus prompts / routing
#                                            (`ai add-task`, handoff)
#
# NOT listed: CLAUDE_CODE_SESSION_ID. Since E-294 pre-commit treats a session id that does not
# verify as the union (row 3), but tests/run.sh deliberately exports a synthetic one (the
# telemetry marker) and assert.sh re-strips this list in every suite — listing it would erase
# the marker. A suite that drives pre-commit sets CLAUDE_CODE_SESSION_ID explicitly instead.
#   AIOS_WORKSPACE     shell rc + .mcp.json env (E-62) — isFrameworkClone() consults it before
#                                            the package.json fallback (the E-249 gate never fired)
#   CLAUDE_CONFIG_DIR  `ai pane <role>` on a project bound to an account (E-315) — `ai account`,
#                                            the backstop and doctor default to it, so a suite run
#                                            from an account-bound pane would read that account
#
# They are stripped ONCE, here, by the runner and by assert.sh for a suite run on its own.
# A suite that needs one sets it explicitly in its own environment. The hooks are NOT taught
# to ignore these under a test flag — that would test a path production never takes.
#
# Adding a variable: when a hook or resolver starts ranking a launch variable, add it here in
# the same change. harness_isolation_test.sh fails on an entry nothing in hooks/ or src/ reads.
#
# Rollback: AI_OS_TEST_KEEP_LAUNCH_ENV=1 skips the strip.

LAUNCH_VARS=(AI_OS_PANE_ROLE AI_OS_CALLER_ROLE AIOS_WORKSPACE CLAUDE_CONFIG_DIR)

# strip_launch_vars — unset every LAUNCH_VARS entry in THIS shell (state, no output: it must
# run in the caller's shell, never in a $(…) subshell — review question #4).
strip_launch_vars() {
  [[ "${AI_OS_TEST_KEEP_LAUNCH_ENV:-0}" == "1" ]] && return 0
  local v
  for v in "${LAUNCH_VARS[@]}"; do unset "$v"; done
}
