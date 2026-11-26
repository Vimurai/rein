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

Tier 2 and 3 also run `rein recheck` and print its lines under `Recorded checks`. A broken check
is a P0 like the others ([Acceptance replay](#acceptance-replay)).

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
| `[CHECK_GATE]` | A Tier 2/3 task has no `CHECKS_PASS` for HEAD, or a later `CHECKS_FAIL` voids it. Run `rein recheck`. |
| `[CI_GATE]` | The project has run `rein ci run`, and HEAD has no green run. `REIN_CI_GATE=0` lifts this one; say so when you use it. |

There is no switch for the stamp gates. A task closed without being built is closed as
superseded by a decision, which skips the stamp gates only.

## Acceptance replay

A task's acceptance is observed when it closes. Acceptance replay observes it again at every
later close, so a later change cannot break it unseen (D-176). **DONE stays true, or the record
says who ended it and why.**

A **check** is one acceptance clause in a form a machine can repeat: a shell command and one
expected result, named `<task>#<clause>` (`E-476#3`). When `critic_acceptance` passes a task, it
records a `CHECK` stamp for each clause that one read-only command in the project root observed
in a few seconds and that stays true while the task's product stands. Test runs and `rein ci run`
are not recorded: CI repeats them.

| Expect | Holds when |
| :--- | :--- |
| `exit=<n>` | the exit status is `<n>` |
| `empty` | stdout has no non-blank line |
| `lines=<n>` / `lines>=<n>` | stdout has exactly / at least `<n>` non-blank lines |
| `out=<text>` | stdout, trimmed, equals `<text>` |

A check is in one of three states:

- **holds**: the command gives the expected result now;
- **broken**: it does not (a 30-second limit and 64 KB of output also break it);
- **retired**: a later decision or task ended it on purpose, and a `CHECK_RETIRED` stamp names which.

`rein recheck` runs every live check (the newest per clause of each DONE task, less the retired
ones) and records one `CHECKS_PASS` or `CHECKS_FAIL` stamp for HEAD. A Tier 2 or 3 task closes
only with a `CHECKS_PASS` for HEAD (`[CHECK_GATE]`). `rein review 2` and `rein review 3` run it
for you.

**A broken check has two answers.** If the change broke a promise it should keep, it is a
regression: fix the code. If the promise was ended on purpose (a file renamed, a behaviour
replaced by a decision), retire the check and name who ended it:

```bash
rein recheck --retire E-476#3 --by D-181 --reason "lane-code.mjs moved to src/shared/lanes/"
```

The retirement is listed in full in `REVIEWS.md`, where the reviewer reads it.

**The commands come from the ledger.** `rein recheck` runs them in your shell, at the trust level
of the project's test suite. In a role pane, the role's sandbox bounds them; your own shell has
none. In a project you do not trust, read `rein recheck --list` before the first run: it prints
every command and runs nothing. `rein review 2` and `rein review 3` run the checks too, so read
the list before your first review there as well. The DONE gate never runs a check; it reads the stamp.

## The hooks

| Hook | Where | Checks |
| :--- | :--- | :--- |
| session start | plugin | Prints the session brief (at most 2 KB). |
| waiting signal | plugin | Sets the tmux pane options while a prompt waits. |
| pre-commit | git | Machine-local files, the privacy scan, record parity in a team project, the Architect's lane. No review stamp. |
| post-commit | git | Records the Engineer's commits in the lane ledger; closes `Fixes E-##` in a team project. |
| pre-push | git | Every pushed commit outside `.ai/` and `plans/` is in the lane ledger; the tip has a green, non-dirty `rein ci run` ([CI](ci.md)). |
| state import | git | Brings the machine's index up to what git tracks after a checkout or merge. |
| seatbelt (`hooks/pre-tool-use.sh`, `shared/seatbelt.mjs`) | `.claude/settings.json` (and the Architect's role file) | Every Bash call. Asks you (`ask`) before a recursive `rm` of home, root or the project root, a download piped into a shell, or a secret in the command. Advice, not a boundary: the [role sandbox](role-sandbox.md) is. |

A git hook that cannot run blocks the commit or push; the seatbelt fails open. `rein doctor` names the fix.
