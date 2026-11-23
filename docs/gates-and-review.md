# Gates and review

Rein's rules are enforced by hooks, not by asking the model nicely. A rule the model forgets
still holds.

## Risk tiers

Every change is classified by `risk-analyzer-mcp` (or by the `[TIER_N]` tag in its commit
message):

| Tier | Typical change | Review before DONE |
| :--- | :--- | :--- |
| 1 | No behaviour change (docs, text, renames) | None |
| 2 | Everything else | `reviewer`, then `critic_acceptance` |
| 3 | The role boundary, the install, hooks, secrets, release signing | Tier 2 plus one `security_engineer` round |

`rein review <tier>` runs the deterministic checks and prints the agents to dispatch. The stamps
are checked when the task closes, not at commit: a Tier 2/3 task is refused DONE without
`REVIEW_PASS` and `ACCEPT_PASS` for HEAD (`[REVIEW_GATE]`, `[ACCEPT_GATE]`), and a Tier 3 task
also without `SEC_CLEARED` (`[SEC_GATE]`).

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

`rein gate off --minutes 15 --reason "…"` is the operator's escape, time-boxed (at most 60
minutes). Catastrophic commands still block, and each bypassed call is announced. Run it in
your own terminal — an agent cannot switch the gate off.

### 2. Pre-commit gate (git hook)

- No review stamp is needed to commit (review is checked at DONE).
- No conflict markers anywhere staged; every staged `.ai/*.json` must parse.
- Agent and skill frontmatter may not name tools that do not exist ("ghost tools"); `rein doctor
  --compliance` audits it on demand.

### 3. Pre-push gate (git hook)

The tip must have a green, non-dirty `rein ci run`. A tip that only adds `.ai/` bookkeeping on top
of a tested commit passes. A recorded skip is possible, with a mandatory reason — see
[Local CI](ci.md#skipping-once).

## Reviewers

Reviewers are subagents with a fixed brief, their own context and no stake in the change. Each
records a stamp through `task-synchronizer-mcp`; none edits `REVIEWS.md` directly.

| Agent | Checks | Stamps |
| :--- | :--- | :--- |
| `reviewer` | The diff against the task text and the blueprint it names; one test per changed behaviour at the cheapest layer (D-088); correctness and safety. | `REVIEW_PASS` / `REVIEW_FAIL` |
| `critic_acceptance` | Runs after the reviewer passes, on Tier 2 and 3: observes each clause of the task's acceptance line (runs the command, reads the file); a clause it cannot observe here is `UNVERIFIED` with the reason. A Tier 2/3 task is refused DONE (`[ACCEPT_GATE]`) without `ACCEPT_PASS` for HEAD. | `ACCEPT_PASS` / `ACCEPT_FAIL` |
| `security_engineer` | Tier 3 only: one round of threat review and active probing. | `SEC_CLEARED` / `SEC_BLOCKED` |

## Mid-task triggers

The Engineer's rulefile names skills that must run when a change touches certain things:

| Touched | Runs | Why |
| :--- | :--- | :--- |
| auth, secrets, capabilities | `security_engineer` agent | Threat model updated before the change lands |
| a new dependency | `dependency_gate` skill | Justification, alternatives and licence recorded |
| CI/CD configuration | `ci_gate` skill | Change and rollback plan recorded |
| a failing test | `rein-debug` skill | Commits stay locked until green |
| existing code | `repo-oracle` skill | History read before the edit |

## Test economics and the budget

Tests are kept cheap on purpose. Behaviour is expressed as rows in contract tables
(`tests/fixtures/*-cases.json`, one row per case) run in process; a shell suite is reserved for
what only a real process boundary can show. Every green CI run records the number of suites and
fast-tier seconds; the next run fails if one grows past its slack (suites +0, fast-tier time
+10 %). The numbers only go down. Raising one is a recorded decision:
`rein ci budget set --ruling D-### <field>=<n>`. See [Local CI](ci.md#the-test-budget).
