---
paths:
  - "tests/**"
---

# Test harness rules (tests/)

Source: `.ai/blueprints/test-harness-isolation.md` (D-061…D-071). Each rule is a standing
review question for `critic_tests` and `rein-review`.

1. **What the machine has (E-236)**: every assertion states what it needs from the host. An
   optional need is a recorded SKIP via `skip_unless_cmd` / `skip_unless_env` — never a
   fabricated PASS or FAIL. "It passed in my working tree" is not evidence about the commit.
2. **How fast it is (E-239)**: a performance assertion names a same-host baseline measured in
   the same run (`elapsed ≤ k × baseline + slack`); an absolute budget applies only when
   `CI=true`. Print baseline and elapsed every run.
3. **What a run leaves behind (E-240)**: register cleanup BEFORE creating external state; name
   temp things with `mktemp` entropy, never `$$`. `tests/run.sh` diffs tmux servers, sandbox
   processes and temp dirs, and a leak fails the run on CI. The detector is
   machine-wide: never run suites while a `rein ci run` is in progress.
4. **Trap chaining (E-241)**: use `on_exit <cmd>`; a raw `trap … EXIT` after sourcing
   `assert.sh` is a finding.
5. **The scan that never ran (E-251)**: build a scan corpus with `corpus_or_fail <min> <root>…`
   — "can this scan return an empty set and still pass?"
6. **The instrument recorded the test (E-257)**: a run writes telemetry only to a per-run temp
   path; nothing under `~/.rein/` except a per-run temp path.
7. **Inherited launch variables (E-264)**: `LAUNCH_VARS` is stripped once, centrally, in
   `tests/lib`. A suite that needs one sets it explicitly. A hook or resolver that starts
   ranking a new launch variable adds it to the list in the same change.
7b. **A fixture HOME carries the record (E-345, D-109 r1)**: a suite that points HOME at a temp
   dir and runs a hook or `rein` creates it with `tc_fixture_home` / `tc_link_shared` /
   `tcFixtureHome` (tests/lib/toolchain-fixture.*) — the toolchain record the install writes.
   The hooks' fallback dir list is never extended for a host. `tests/run.sh` refuses a suite
   that skips the helper (exemptions per rule, with a reason, in
   tests/fixtures/fixture-home-exemptions.json); `REIN_TEST_EMPTY_FALLBACK=1` runs the
   fixtures with the fallback emptied, the proof that a suite passes on any host.

## Test economics (D-088 — rationale in `.ai/blueprints/test-economics.md`)
A test is a claim about a BEHAVIOUR, at the cheapest layer that can observe it, and it pays rent.
8. **Name it for the behaviour.** A suite is named for what it observes; a task id lives in a
   comment or a table-row `label`, never in a suite name (`test_suite_naming` enforces it).
9. **Cheapest layer.** A pure function is tested in `tests/unit` under `node --test`; a bash
   suite exists only where a process boundary (a hook, `exec`, tmux, git, the installer) is the
   thing under test. Several inputs to one rule are rows of a contract table
   (`tests/fixtures/<family>-cases.json`, one runner), not one assertion each.
10. **Replace or justify.** A NEW test names the existing test it extends or replaces; extending
   a contract table beats adding a suite.
11. **Delete with a LOG line.** A test whose behaviour another test or table already covers is
   deleted with one `.ai/LOG.md` line naming what covers it. A `T-*` regression pin is deleted
   only when the Architect's Consolidation Map names the row that now carries it.
12. **The budget only moves down.** `rein ci run` records suites, test lines and fast-tier
   seconds; exceeding the best recorded value fails the run, and raising it is a D-ruling.

## A new CI failure is presumed REAL until you have read its log (D-062 / E-238)
After a run of environmental failures it is tempting to file the next one the same way. Two
failures once nearly dismissed as flakes were reporting committed corruption (invalid JSON in
`.ai/state.json` on master for four commits).
- Read `rein ci log --failed` before forming a theory; `rein ci status` says which commit it covers.
- Only a clean `rein ci run` is evidence about a commit. When a failure does not reproduce,
  rebuild its layout (worktree and throwaway HOME under the system temp dir, deps installed)
  before theorising (E-265).
- Call something a flake only once you can say WHY — a named nondeterminism: timing,
  ordering, network, host speed, or another process on the machine — not "it passed on the
  rerun".
