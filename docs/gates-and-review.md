# Review by tier

Review is sized by the task's tier and checked when the task closes, not when it commits. A
commit never waits on a review; `rein done` refuses a task whose stamps are missing.

## Tiers

| Tier | Typical change | Review before DONE |
| :--- | :--- | :--- |
| 1 | No behaviour change: docs, text, renames | None |
| 2 | Everything else | `reviewer`, then `critic_acceptance` |
| 3 | The role boundary, the install, hooks, secrets, release signing | Tier 2 plus one `security_engineer` round |

The tier is set when the task is added (`rein add-task --tier N`, or `add_task`), and the commit
message carries it as `[TIER_N]`.

## Running a review

```bash
rein review 2            # or 1, 3; --base <ref> reviews against another base
```

It runs the deterministic checks on the diff (a hardcoded secret, a path traversal, …) and prints
the agents to dispatch, by their plugin names:

```
Dispatch:
  1. rein:reviewer on <task id> → REVIEW_PASS or REVIEW_FAIL
  2. rein:critic_acceptance on <task id> → ACCEPT_PASS or ACCEPT_FAIL
```

A P0 finding exits 1 and dispatches nothing until it is fixed. In a pane, skill `rein-review`
runs the command and dispatches the agents for you.

## The reviewers

Each is a subagent with its own context and no stake in the change. Each records one stamp
through `task-synchronizer-mcp`; none edits `REVIEWS.md`.

| Agent | Checks | Stamps |
| :--- | :--- | :--- |
| `rein:reviewer` | The diff against the task text and the blueprint it names; one test per changed behaviour at the cheapest layer (D-088); correctness and safety. | `REVIEW_PASS` / `REVIEW_FAIL` |
| `rein:critic_acceptance` | Observes each clause of the task's acceptance line: runs the command, reads the file. A clause it cannot observe is `UNVERIFIED`, with the reason. | `ACCEPT_PASS` / `ACCEPT_FAIL` |
| `rein:security_engineer` | Tier 3 only: one round of threat review and active probing in a throwaway directory. | `SEC_CLEARED` / `SEC_BLOCKED` |

A stamp binds to HEAD. A source commit after a stamp needs the stamp again; a commit that only
touches `.ai/` does not.

## Closing the task

```bash
rein done E-12 --summary "health endpoint and its tests"
```

| Refusal | Means |
| :--- | :--- |
| `[REVIEW_GATE]` | A Tier 2/3 task has no `REVIEW_PASS` for HEAD. |
| `[ACCEPT_GATE]` | A Tier 2/3 task has no `ACCEPT_PASS` for HEAD, or a later `ACCEPT_FAIL` voids it. |
| `[SEC_GATE]` | A Tier 3 task has no `SEC_CLEARED` for HEAD. |
| `[CI_GATE]` | The project has run `rein ci run`, and HEAD has no green run. `REIN_CI_GATE=0` lifts this one; say so when you use it. |

There is no switch for the stamp gates. A task closed without being built is closed as
superseded by a decision, which skips the stamp gates only.

## The hooks

| Hook | Where | Checks |
| :--- | :--- | :--- |
| session start | plugin | Prints the session brief (at most 2 KB). |
| waiting signal | plugin | Sets the tmux pane options while a prompt waits. |
| pre-commit | git | Machine-local files, the privacy scan, record parity in a team project, the Architect's lane. No review stamp. |
| post-commit | git | Records the Engineer's commits in the lane ledger; closes `Fixes E-##` in a team project. |
| pre-push | git | Every pushed commit outside `.ai/` and `plans/` is in the lane ledger; the tip has a green, non-dirty `rein ci run` ([CI](ci.md)). |
| state import | git | Brings the machine's index up to what git tracks after a checkout or merge. |
| seatbelt (`hooks/pre-tool-use.sh`, `safe-exec-mcp/seatbelt.mjs`) | `.claude/settings.json` (and the Architect's role file) | Every Bash call. Asks you (`ask`) before a recursive `rm` of home, root or the project root, a download piped into a shell, or a secret in the command. Advice, not a boundary: the [role sandbox](role-sandbox.md) is. |

A git hook that cannot run blocks the commit or push; the seatbelt fails open. `rein doctor` names the fix.
