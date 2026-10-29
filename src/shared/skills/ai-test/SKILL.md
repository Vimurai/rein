---
name: ai-test
description: Use this skill when asked to run tests, before committing, or for Tier 3 releases. Runs the project's real test command by default; --generate dispatches the headless test_engineer Tester (Claude, sonnet) to write tests; --fast runs the Tester on haiku; --vibe triggers the two-phase Vibe & Chaos audit (ux_reviewer + chaos_monkey).
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
non-zero, report `[LOCKED]` with the failing assertion, and fix the failure (`skill: ai-debug`)
before proceeding.

**In a review** (critic_tests, ai-review) the Rein runner is invoked as
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

---

## Vibe & Chaos Audit (--vibe flag)

Trigger this when the user requests `--vibe` or for any **Tier 3** release.

### Phase 1 — Visual Audit (ux_reviewer)
Use the `ux_reviewer` agent to:
1. Spin up the dev server (`npm run dev` or `npm start`).
2. Check each primary route for: CLS < 0.1, WCAG AA contrast, 44px touch targets, visible focus rings.
3. Run Lighthouse: Performance ≥ 80, Accessibility ≥ 90.
4. Rapid-click stress: 10× clicks on primary CTA.
5. Record the verdict via `mcp__task-synchronizer-mcp__add_stamp({type:"VIBE_CLEARED", agent:"ux_reviewer", summary:"Score X/10 — <one-line>"})` on a clean pass (no P0), or `type:"VIBE_BLOCKED"` on a P0. Do NOT append to `.ai/REVIEWS.md` directly — it is regenerated from the SQLite stamps table, so the stamp must go through `add_stamp` to surface there for `review_synthesizer` (which gates Tier 3 on `[VIBE_CLEARED]`).

Or use `vibe-check-mcp`:
```
run_vibe_audit(url: "http://localhost:3000")
run_chaos_test(url: "http://localhost:3000", interactions: 20)
get_performance_metrics(url: "http://localhost:3000")
```

### Phase 2 — Chaos Stress Test (chaos_monkey)
Use the `chaos_monkey` agent to:
1. Verify `[SEC_CLEARED]` in `.ai/LOG.md` before starting.
2. Run 5-phase chaos suite: invalid inputs, network latency, rapid-click, concurrent sessions, resource exhaustion.
3. Append `[CHAOS_REPORT] YYYY-MM-DD` to `.ai/REVIEWS.md`.
4. Tag `[CHAOS_CLEARED]` or `[CHAOS_BLOCKED]` in `.ai/LOG.md`.

### Required Stamps (Tier 3 Release Gate)
All three must exist before committing (recorded via `add_stamp`, surfaced in
`.ai/REVIEWS.md` / `.ai/LOG.md` — never hand-appended):
- `[VIBE_CLEARED]` (≤ 7 days old) — the stamp `review_synthesizer` requires for Tier 3
- `[CHAOS_CLEARED]`
- `[CRITIC_STAMP]` (from `skill: ai-review`)
