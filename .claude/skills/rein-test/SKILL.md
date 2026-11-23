---
name: rein-test
description: Use this skill when asked to run tests, before committing, or for Tier 3 releases. Runs the project's real test command by default; --generate dispatches the headless test_engineer Tester (Claude, sonnet) to write tests; --fast runs the Tester on haiku.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, Glob
context: default
agent: default
---

# Rein Test — the headless Tester

The Tester is the third Claude role (D-069): `tester` in `.ai/roles.json`, `headless: true`,
model `sonnet`. It has no pane — `rein pane tester` exits 2 and points here.

## Dynamic Context Injection
Test command: !REIN_LOCATE_UNTRUSTED_ENV=1; unset -f rein_locate rein_locate_enable_dev_tree rein_is_framework_clone 2>/dev/null; [ -f "${HOME}/.rein/shared/locate.sh" ] && . "${HOME}/.rein/shared/locate.sh"; c="$(rein_locate shared/test-command.mjs 2>/dev/null)"; [ -n "$c" ] && node "$c" 2>/dev/null || echo '{"command":null,"note":"helper unavailable — reinstall Rein"}'
Open tasks requiring tests: !grep -n "E-[0-9]" .ai/TASKS.md 2>/dev/null | grep -v "\[x\]" | head -5 || echo "(all tasks complete)"

## Resolve the command and the model

```bash
REIN_LOCATE_UNTRUSTED_ENV=1
unset -f rein_locate rein_locate_enable_dev_tree rein_is_framework_clone 2>/dev/null
[ -f "${HOME}/.rein/shared/locate.sh" ] && . "${HOME}/.rein/shared/locate.sh"
HELPER="$(rein_locate shared/test-command.mjs 2>/dev/null)"
node "$HELPER"           # default:  {"command":"npm test","source":"package.json","model":"sonnet"}
node "$HELPER" --fast    # --fast:   same command, "model":"haiku"
```

Run from the project root — the helper inspects the current directory. Detection order
(first match wins): `package.json` `scripts.test` (the `npm init`
placeholder does not count) → `tests/run.sh` → `pytest` (pytest.ini, conftest.py,
`[tool.pytest…]` in pyproject.toml, setup.cfg, tox.ini, or `tests/test_*.py`) → `go test ./...`
(go.mod). Exit 3 with `"command": null` means the project has no test command — say so and
stop; never invent one.

## Default run (no flag)

Run the resolved `command` from the project root and report the harness's own pass / fail /
skip counts. A SKIP is not a pass.

Gate: all tests must pass before any commit. If a test fails, you are **LOCKED** — exit
non-zero, report `[LOCKED]` with the failing assertion, and fix the failure (`skill: rein-debug`)
before proceeding.

**In a review** (the `reviewer` agent) the Rein runner is invoked as
`bash tests/run.sh --tier fast --changed <base>` — the unit layer, every contract table, and the
suites whose census footprint the change touches (E-298, D-088). The full matrix is `rein ci run`'s
and pre-push's job, not a review's.

## --generate — dispatch the Tester

Dispatch the `test_engineer` agent with the Agent tool, passing the task id, the resolved test
command and the model from the helper (`sonnet`, or `haiku` with `--fast`). It writes a test
plan, adds tests **only under `tests/`**, runs them and stamps `[TESTS_PASS]` / `[TESTS_FAIL]`
via `add_stamp`. Relay its counts and stamp; do not re-stamp. The Tester writes under the
test-economics rules (8–12 in `.claude/rules/test-harness.md`, D-088): the cheapest layer, and a
new test names the one it extends or replaces.

## --fast

Same as the default or `--generate`, with the Tester on `haiku` — a smoke tier for quick
checks, not a release gate.

The task's own review is by tier (E-464): `rein review <tier>` names the agents.
