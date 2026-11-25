# Blueprint — Acceptance replay: a closed task's acceptance is checked again at every later close (D-176)

> Owner: the Architect. Written 2026-11-25. Decision: D-176. Builds on `harness-fitness.md`
> §Component 3 (the acceptance evaluator) and `lean-core.md` §Component 5 (review by tier).

## Goal & Architecture
Today a task's Acceptance is observed once, when the task closes. Nothing says later that it
still holds. A later task can break it and the ledger still shows DONE.

This blueprint makes the observation repeatable. When `critic_acceptance` passes a task, it also
records the clauses that a plain command can check again. `rein recheck` runs those commands at
the current commit. A Tier 2 or Tier 3 task closes only when every recorded check of every
earlier task still holds or was retired by name.

It is for the operator and both roles. One sentence: **DONE stays true, or the record says who
ended it and why.**

Not a copy of anything the platform has: Claude Code has no task ledger and no acceptance
record, so it has nothing to replay. Not a second test suite either: a clause that a test
already proves is not recorded, because CI already repeats it.

## Core Concept
A **check** is one acceptance clause in a form a machine can repeat: a shell command and one
expected result. It belongs to a task and a clause number, written `E-476#3`.

A check has three states:
- **holds**: the command gives the expected result now;
- **broken**: it does not;
- **retired**: a later decision or task ended it on purpose, and a stamp names which.

A broken check is either a regression (fix the code) or a promise that was ended on purpose
(retire it and name the decision or task). There is no third answer, and that is the point.

## Components

### Component 1 — The check record (`src/shared/checks.mjs`, `add_stamp`, `critic_acceptance`)
- `critic_acceptance` records one `CHECK` stamp per replayable clause, before its `ACCEPT_PASS`
  stamp. On `ACCEPT_FAIL` it records none.
- A clause is replayable when all of these are true:
  1. it was `PASS` in this run;
  2. the observation was one command run in the project root, with no scratch directory;
  3. the command only reads (`git grep`, `git ls-files`, `grep`, `test -f`, `wc`, a `rein`
     command that only prints);
  4. it finishes in a few seconds;
  5. it is not a test run and not `rein ci run` (CI repeats those);
  6. it stays true for as long as the task's product stands. "After one handoff the count is
     one higher" is true once and is not recorded.
- `src/shared/checks.mjs` holds the grammar: parse a stamp summary into a check, and say why a
  summary is malformed. `add_stamp` calls it for the types `CHECK` and `CHECK_RETIRED` and
  refuses a malformed one with `[CHECK_MALFORMED]`.
- `REVIEWS.md` does not list `CHECK` stamps one by one. It prints one line per task:
  `E-476: 2 checks recorded`. `CHECK_RETIRED` stamps are listed in full, because they are
  decisions a reader should see.

### Component 2 — The replayer (`rein recheck`)
- Reads the live checks (see Data Model), runs each, compares, prints the broken ones and one
  summary line, and records one stamp for HEAD: `CHECKS_PASS` or `CHECKS_FAIL`.
- `rein recheck --list` prints the live checks and runs nothing.
- `rein recheck --retire <task>#<n> --by <D-### | E-### | P-##> --reason <text>` records a
  `CHECK_RETIRED` stamp. It refuses a `--by` that is not a heading in `DECISIONS.md` or a task
  in state, and a check id that is not live.
- The replayer runs in the caller's shell, so inside a role pane it runs inside that role's
  sandbox. **It is never called from the MCP server**, which runs outside the sandbox.

### Component 3 — The gate (`src/shared/completion-gates.mjs`, `rein review`)
- One new gate in the list for a Tier 2 or Tier 3 E-## task: a `CHECKS_PASS` stamp for HEAD, or
  for an ancestor that differs from HEAD only in `.ai/` (the rule the other stamps use).
  Without it: `[CHECK_GATE]` with the command to run.
- The gate reads the stamp. It runs nothing.
- `rein review 2` and `rein review 3` run `rein recheck` with their other deterministic checks,
  so the Engineer has no new step to remember.
- Tier 1 and P-## tasks are not gated. A Tier 1 change that breaks a check is found at the next
  Tier 2 close, or whenever someone runs `rein recheck`.
- A floor, as the earlier stamp gates have (`ACCEPT_GATE_FLOOR`, `REVIEW_GATE_FLOOR`): the gate
  applies to tasks with an id above the task that builds it.

## Data Model
No table and no column is added. A check is a stamp, and stamps already carry the task, the
agent, the time and the commit.

| Stamp type | Written by | Summary (one line) |
|---|---|---|
| `CHECK` | `critic_acceptance` | `<task>#<n> \| <expect> \| <command>` |
| `CHECK_RETIRED` | `rein recheck --retire` | `<task>#<n> \| <by> \| <reason>` |
| `CHECKS_PASS` | `rein recheck` | `[CHECKS_PASS] at <sha7> — <h> hold, <r> retired` |
| `CHECKS_FAIL` | `rein recheck` | `[CHECKS_FAIL] at <sha7> — <b> broken of <total>: <ids>` |

- `<command>` is everything after the second ` | `. One line, at most 400 characters. It may
  contain `|`.
- `<expect>` is exactly one of:

| Expect | Holds when |
|---|---|
| `exit=<n>` | the exit status is `<n>` |
| `empty` | stdout has no non-blank line (the exit status is not read) |
| `lines=<n>` | stdout has exactly `<n>` non-blank lines |
| `lines>=<n>` | stdout has at least `<n>` non-blank lines |
| `out=<text>` | stdout, trimmed, equals `<text>` |

- **The live set**: for each DONE task, the newest `CHECK` stamp per clause number, minus every
  id that has a `CHECK_RETIRED` stamp. A task that is reopened leaves the live set until it is
  DONE again.
- Nothing is recorded for the 170 tasks closed before this is built. The live set starts empty
  and grows from the first task closed after it.

## API / Interface Contracts

```
rein recheck [--list] [--json]
rein recheck --retire <task>#<n> --by <D-###|E-###|P-##> --reason <text>
```

| Call | stdout | Exit |
|---|---|---|
| `rein recheck`, all hold | `✓ [CHECKS_PASS] 14 hold, 2 retired (3.1 s)` | 0 |
| `rein recheck`, one broken | `✗ [CHECK_BROKEN] E-476#3 expected empty, got 2 lines: <command>` per broken check, then `✗ [CHECKS_FAIL] 1 broken of 14` | 1 |
| `rein recheck`, no live check | `✓ [CHECKS_PASS] 0 hold, 0 retired` | 0 |
| `rein recheck --list` | one line per live check: `<id> \| <expect> \| <command>` | 0 |
| `--retire`, good | `✓ E-476#3 retired by D-181` | 0 |
| `--retire`, unknown `--by` | `✗ [RETIRE_UNKNOWN] D-999 is not a decision or a task` | 1 |
| `--retire`, id not live | `✗ [CHECK_UNKNOWN] E-476#9 is not a live check` | 1 |
| a check runs past its time limit | it is broken: `… timed out after 30 s` | 1 |
| bad arguments | usage | 2 |

- `--json` prints `{ "sha": …, "holds": [ids], "broken": [{id, expect, got, command}], "retired": [ids] }`.
- A dirty working tree: the run is made and printed, but no `CHECKS_PASS` is recorded
  (`rein ci run` treats a dirty tree the same way). The line ends `(dirty: not recorded)`.
- The DONE gate's refusal: `✗ [CHECK_GATE] no CHECKS_PASS for HEAD — run: rein recheck`.
- The agent contract: `critic_acceptance` calls `add_stamp` once per replayable clause with
  `type: "CHECK"`, then once with the verdict. Its report to the caller is unchanged.

## Security
- **What is new**: a command that runs text taken from the ledger. That is why the replayer is
  a Tier 3 task with one `security_engineer` round.
- **Trust level**: the same as the project's test suite. Whoever can write a test that
  `rein ci run` executes can already run code as the caller. A planted `CHECK` stamp gives
  nothing more than a planted test does.
- **Where it runs**: in the caller's shell only. Inside a pane the role sandbox bounds it. The
  MCP server is outside the sandbox, so the gate reads a stamp and never runs a check.
- **The operator's own shell has no sandbox.** `rein recheck --list` shows every command
  before anything runs. The docs say to read the list first in a project the operator does not
  trust. No allowlist of commands is built: the text gate that tried to judge commands was
  3,497 lines and was deleted (D-169 r2).
- **A check is data for the evaluator too.** `critic_acceptance` records the command it ran
  itself, never a command a clause tells it to record.
- **Residuals, accepted**: any session can call `add_stamp`, so a `CHECKS_PASS` or a
  `CHECK_RETIRED` can be written without the command (the residual of D-159 addendum 2 r7; the
  stamp names its agent and commit). A retirement by the Engineer is not refused; it is in
  `REVIEWS.md` with its reason, and the reviewer reads it.
- No secret is read or stored. The command's environment is the caller's.

## Execution Constraints
- Checks run one after another, in the project root, with stdin closed.
- Time limit per check: 30 seconds. A check that needs more should have been a test.
- At most 64 KB of stdout is read per check; more is a broken check with `output too large`.
- The run prints its total time. If a full run passes 60 seconds, that is a finding for the
  Architect, not a reason to run in parallel.
- No new MCP tool, agent, skill or hook. The scorecard targets of `lean-core.md` are unchanged.
- One new module (`checks.mjs`) and one new CLI verb. Target: at most 250 lines of source
  outside tests.

## Rollback Plan
Each task is one commit.
- Revert the gate commit: tasks close as before; `rein recheck` stays as a report.
- Revert the replayer commit: no command reads the checks.
- Revert the record commit: the evaluator stops writing `CHECK` stamps. Stamps already written
  stay in the store and nothing reads them.
No migration runs in either direction, because no schema changes.

## E-## Task Breakdown
1. **The check record** (Tier 2): Component 1.
2. **`rein recheck`** (Tier 3): Component 2. After task 1.
3. **The gate and the docs** (Tier 2): Component 3, the command reference and
   `docs/` text. After task 2.

## Not built
- A backfill of checks for tasks closed before this.
- Checks for decisions (a ruling that names a command). That is the next step of D-176 and gets
  its own blueprint after this one has run for a few weeks; it can reuse the stamp grammar.
- A run at session start, in a hook, or in `rein ci run`.
