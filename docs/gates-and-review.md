# Gates and review

Rein's rules are enforced by hooks, not by asking the model nicely. A rule the model forgets
still holds.

## Risk tiers

Every change is classified by `risk-analyzer-mcp` (or by the `[TIER_N]` tag in its commit
message):

| Tier | Typical change | Review before commit |
| :--- | :--- | :--- |
| 1 | Documentation, config, comments, typos | None |
| 2 | Ordinary code | Blueprint alignment (`blueprint-aligner-mcp`) |
| 3 | Security, auth, secrets, state, hooks, removals of a protection | `critic_arch`, `critic_security` and `critic_tests` in parallel; `security_engineer` when auth or secrets are touched |

`skill: ai-review` picks the tier and runs what it requires.

## The three gates

### 1. Tool-call gate (pre-tool-use hook)

Runs before every tool call in either pane.

- **Role boundaries.** The Architect may write only under `.ai/` and `plans/`. The Engineer may
  not rewrite `.ai/architect.md`.
- **Destructive commands.** `rm -rf` outside the project, force pushes to protected branches,
  history rewrites and similar are refused or need approval. Commands are parsed, not
  pattern-matched on the raw string, so quoting tricks do not get through.
- **Secrets.** A private-key header, a key's encoded prefix, or a token-shaped string in a
  command line is refused, as is reading from the secrets directory.
- **Scope.** Writes outside the project and the agent's allowed paths are refused.

`ai gate off --minutes 15 --reason "…"` is the operator's escape, time-boxed (at most 60
minutes). Catastrophic commands still block, and each bypassed call is announced. Run it in
your own terminal — an agent cannot switch the gate off.

### 2. Pre-commit gate (git hook)

- The commit needs a review stamp bound to its parent commit. Commits that only touch `.ai/`
  bookkeeping (state, tasks, reviews, log, handoff notes) are exempt.
- No conflict markers anywhere staged; every staged `.ai/*.json` must parse.
- Agent and skill frontmatter may not name tools that do not exist ("ghost tools"); `ai doctor
  --compliance` audits it on demand.

### 3. Pre-push gate (git hook)

The tip must have a green, non-dirty `ai ci run`. A tip that only adds `.ai/` bookkeeping on top
of a tested commit passes. A recorded skip is possible, with a mandatory reason — see
[Local CI](local-ci.md#skipping-once).

## Critics

Critics are subagents with a fixed brief, their own context and no stake in the change. Each
records a stamp through `task-synchronizer-mcp`; none edits `REVIEWS.md` directly.

| Critic | Checks | Stamps |
| :--- | :--- | :--- |
| `critic_arch` | The diff against `.ai/architect.md` and the blueprint: role sovereignty, orphaned code, deviations. | `ARCH_PASS` / `ARCH_FAIL` |
| `critic_security` | OWASP Top 10 classes, leaked secrets, capability boundaries in `CAPABILITIES.md`. | `SEC_PASS` / `SEC_FAIL` |
| `critic_tests` | Each changed behaviour has one test at the cheapest layer that can observe it; a new test names what it extends. | `TESTS_PASS` / `TESTS_FAIL` |
| `critic_clean_code` | File-size limits, MCP stdout purity, banned secret patterns, naming, reuse of shared modules. | `CLEAN_PASS` / `CLEAN_FAIL` |

For Tier 3 releases, `review_synthesizer` aggregates every stamp into a release-readiness verdict.

## Mid-task triggers

The Engineer's rulefile names skills that must run when a change touches certain things:

| Touched | Runs | Why |
| :--- | :--- | :--- |
| auth, secrets, capabilities | `security_engineer` agent | Threat model updated before the change lands |
| a new dependency | `dependency_gate` skill | Justification, alternatives and licence recorded |
| CI/CD configuration | `ci_gate` skill | Change and rollback plan recorded |
| a failing test | `ai-debug` skill | Commits stay locked until green |
| existing code | `repo-oracle` skill | History read before the edit |

## Test economics and the budget

Tests are kept cheap on purpose. Behaviour is expressed as rows in contract tables
(`tests/fixtures/*-cases.json`, one row per case) run in process; a shell suite is reserved for
what only a real process boundary can show. Every green CI run records the number of suites, test
lines and fast-tier seconds; the next run fails if one grows past its slack (suites +0, test lines
+2 %, fast-tier time +10 %). The numbers only go down. Raising one is a recorded decision:
`ai ci budget set --ruling D-### <field>=<n>`. See [Local CI](local-ci.md#the-test-budget).
