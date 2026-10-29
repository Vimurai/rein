# Blueprint: Test Economics (D-088, 2026-10-04)

## Goal & Architecture
The suite has outgrown the code it protects: 33.6k lines of tests against 28.6k lines of
`src/` + `hooks/`; 152 bash suites (28k lines) against 8 node unit files (2.5k lines); a full
run of 12–17 minutes; 2,440 assertions labelled by TASK id and suites NAMED after tasks
(`e143_test.sh`, `e140_e141_e142_test.sh`, `robustness_p7_p12_test.sh`). The protection is
real — the harness found every defect of the D-060..D-071 arc — but the COST curve is wrong,
and the process that produced it has an add rule and no delete rule. This blueprint gives the
suite an economy: a layer rule, a replace-or-justify rule, a deletion rule, a budget that
ratchets down, and the tools that make those rules checkable. Users: the Engineer (writes and
runs tests), `critic_tests` / `test_engineer` (enforce), the Architect (rules on deletions of
security pins), `ai ci run` (records the budget).

## Core Concept
**A test is a claim about a behaviour, at the cheapest layer that can observe it, and it pays
rent.** Not "a task's assertions", not "coverage of a path". Three consequences: tests are named
and grouped by BEHAVIOUR (task ids are comments, never names); a pure function is tested in
`tests/unit` and a bash suite exists only where a process boundary (hook, `exec`, tmux, git,
installer) is the thing under test; a test that duplicates another's footprint or pins an
incident now covered by a contract table is deleted, with a LOG line, not a review.

## Components
1. **Census — `tests/tools/census.mjs`** (E-297). One pass over the suite, machine-readable
   and human-readable. Per suite: assertion count; wall time from the last run (parsed from
   `tests/run.sh` output or the `~/.ai-os/ci` records); task-label density (labels per
   assertion); the *footprint* — the set of `src/`/`hooks/` files the suite exercises, recorded
   DYNAMICALLY by the harness (`tests/lib` logs every `node <path>` / `bash <path>` / `ai`
   spawn to a per-run file, so the footprint is what ran, not what was mentioned) plus the
   static references; and `last_real_failure` from the CI records (never failed = never paid
   rent). Derived lists: **merge candidates** (footprint overlap ≥ 80% with another suite),
   **move-to-unit candidates** (every spawn is `node <src module> <args>` with stdout parsed —
   a pure function driven through a process), **delete candidates** (never failed AND
   footprint fully covered by a contract table or another suite), **misnamed** (task id in the
   suite name). Output: `~/.ai-os/ci/census-<date>.json` + a markdown summary on stdout. The
   first census is the input to the Architect's Consolidation Map (P-44).
2. **Tiers and selection — `tests/run.sh --tier fast|full`, `--changed <ref>`** (E-298).
   `fast` = `tests/unit` + every contract-table suite (`*_cases.json` runners): budget 60 s on
   CI. `full` = today's matrix, run by `ai ci run` and pre-push only. `--changed <ref>` selects
   the suites whose census footprint intersects the files changed since `<ref>`, always
   including `fast`. `critic_tests` runs `--tier fast --changed <base>` — never the full matrix
   in a review. A suite with no footprint entry runs in `full` only (no footprint ⇒ unknown).
3. **Rules and mandates** (E-299). `src/claude/rules/test-harness.md` gains a "Test economics"
   section (the five rules under *Core Concept* and *Security*, one copy — the blueprint keeps
   the rationale, D-082 r5). `critic_tests` mandate changes from "every modified `src/` path has
   coverage" to: **every changed BEHAVIOUR has one test at the cheapest layer that can observe
   it; a NEW test names the existing test it extends or replaces; a suite or label named for a
   task is FAIL; a bash suite whose every assertion drives a pure node function is FAIL
   (belongs in `tests/unit`)**. `test_engineer` writes under the same mandate and prefers
   extending a contract table over a new suite. `standards.json` gains `test_suite_naming`
   (no `^e\d+|_e\d+|p\d+_` in `tests/suites/*.sh` names; existing names exempted BY NAME until
   their wave renames them, D-065) and `test_label_density` (a suite with more labels than
   assertions is a finding). `ai-test` SKILL text follows.
4. **Contract tables — the consolidation primitive** (E-301, E-302). The pattern that already
   works: `arch-write-cases.json` + `pipe-shell-cases.json` — a JSON table of `{label, cmd,
   want}` rows, one runner, sha256-pinned where the gate is frozen. Every rule family gets one:
   `GATE_SELF_DISABLE` (`gate-guard.mjs`), the sovereignty rules (`analyzeSovereignty`), the
   heredoc lexer (`heredoc.mjs` — it already has `pipe-shell-cases.json`; absorb the
   per-task assertions around it), the standards checker (`standards.json` rules), the role
   verdicts (`--check-path` × role × path class). A table row replaces the per-task assertion
   that pinned the same input; the task id survives as the row's `label`. A table is tested
   ONCE, in `tests/unit`, by the runner — not again from bash.
5. **Mutation probe — one-off, not CI** (E-300). Stryker over `src/shared`, `src/mcp/shared`
   and `src/mcp/safe-exec-mcp` with the node unit layer as the test command: a test that kills
   no mutant is a deletion candidate; a surviving mutant in a gate is a MISSING table row. Run
   through `dependency_gate` (it is a dev dependency, even if invoked once); results go to the
   Consolidation Map, the dependency does not stay in `package.json` unless the gate approves.
6. **Consolidation Map — Architect-owned** (P-44, section appended to this blueprint). For
   every current suite: `keep` / `merge → <suite>` / `move → tests/unit/<file>` / `table →
   <cases.json>` / `delete (covered by …)`. Security pins (`T-*` regression cases) are never
   deleted by the Engineer on the census alone — the map says so per row, and the row cites
   the table or suite that now carries the behaviour. The map is the acceptance list of waves 1
   and 2.
7. **Ratchet — `ai ci run` records the budget** (E-303). Each green run records `suites`,
   `test_lines`, `fast_tier_seconds`, `full_seconds` in the CI record; a run FAILS when any of
   the first three exceeds the best recorded value by more than the slack (suites +0,
   test_lines +2%, fast tier +10%), so the numbers can only move down; `ai doctor`/`ai ci
   status` print the current budget. Raising a budget is a D-ruling with the census attached.
   Timing and RSS fields (`full_seconds`, `peak_rss_mb`, `peak_sum_rss_mb`) are RECORDED and
   never ratcheted (D-118 r1: four idle full runs spread 10.3%, so a fixed-slack gate fails on
   host load). Instead `ai ci status` and `ai doctor` print `[BUDGET_DRIFT] <field> <latest>
   vs median-of-5 <value> (+N%)` when the latest green run exceeds the median of the last five
   green runs by more than 25% on any of those fields — a line, never a FAIL (E-366).

## Data Model
```
~/.ai-os/ci/census-<date>.json
{ "generated": "<ISO>", "commit": "<sha>",
  "suites": [ { "name": "pane_binding", "file": "tests/suites/pane_binding_test.sh",
     "assertions": 105, "labels": 98, "wall_ms": 14200,
     "footprint": ["src/bin/ai", "src/shared/resolve-launch.mjs"],
     "spawn_shape": "process|pure-node|mixed",
     "last_real_failure": "2026-09-10T…|null",
     "candidates": ["merge:pane_option_binding", "misnamed"] } ],
  "totals": { "suites": 152, "unit_files": 8, "test_lines": 33579, "src_lines": 28622 } }

tests/fixtures/<family>-cases.json           (contract table; one runner per table)
[ { "label": "E-291.05g", "cmd": "git add src/shared/gate-override.py", "want": "pass" } ]

CI record (ci-record.mjs) gains: { "budget": { "suites": N, "test_lines": N,
  "fast_tier_seconds": N, "full_seconds": N } }
```
Targets (recorded here, enforced by the ratchet once reached): suites 152 → ≤ 60;
`test_lines` ≤ `src_lines`; fast tier < 60 s; full run < 5 min; task-named suites 0; every
gate rule family has a table.

## API / Interface Contracts
- `node tests/tools/census.mjs [--json <path>] [--since <ref>]` — exit 0; the markdown
  summary on stdout; the JSON at the path or the default under `~/.ai-os/ci/`.
- `bash tests/run.sh [--tier fast|full] [--changed <ref>] [pattern]` — defaults unchanged
  (`full`, all suites), so every existing caller keeps its behaviour; `--changed` without a
  census file falls back to `full` and says so.
- `ai ci run` records the budget block; `ai ci status` prints it; a budget regression is a
  FAIL with the three numbers (recorded, measured, slack) on one line.
- A contract table runner: `node tests/unit/<family>-cases.test.mjs` under `node --test`;
  the table's sha256 is asserted where the gate is frozen (D-056).

## Security
- **Security contracts are tables, byte-pinned.** `arch-write-cases.json` stays byte-identical
  through every wave (D-056); each new gate table is pinned the same way once its family is
  frozen by ruling. Consolidation moves assertions INTO tables; it never reduces the set of
  inputs a gate is tested against — the census proves it (the pre-wave input set is a subset
  of the post-wave table rows, asserted in the wave's own acceptance).
- A regression pin for a `T-*` threat-model entry is deleted only when the Consolidation Map
  (Architect) names the row that carries it now.
- The mutation tool is a dev dependency through `dependency_gate` + `critic_security`; it runs
  locally, never in `ai ci run`, and its report contains no secrets (it reads the suite only).
- The footprint recorder in `tests/lib` writes only to the per-run temp path (rule 6, E-257).

## Execution Constraints
- Census < 5 s on the census JSON alone; the dynamic footprint is recorded during a normal run
  at < 1 ms per spawn (an `echo >> file`).
- Fast tier ≤ 60 s on CI; `--changed` on a one-file change ≤ 90 s.
- bash 3.2; the ratchet uses only the CI record (no new store).
- Waves touch `tests/**` only, plus the rules/agent/skill texts in E-299; `src/` behaviour is
  unchanged by every task here except E-298's runner flags and E-303's record field.

## Rollback Plan
Each task reverts as one PR. Deleted suites are in git history; a wave's PR description lists
every deleted or merged file with the row that replaced it, so a wrongly deleted test is a
`git show <sha>:<path>` away. The ratchet reverts by removing the budget block; the mandate
text reverts with E-299.

## E-## Task Breakdown
- **E-297** (Tier 2): Component 1, the census tool + the dynamic footprint recorder.
- **E-298** (Tier 2): Component 2, tiers and `--changed` selection; `critic_tests` runs fast.
- **E-299** (Tier 2): Component 3, rules + mandates + two standards rules.
- **E-300** (Tier 2): Component 5, the one-off mutation probe (through `dependency_gate`).
- **P-44** (Architect, after E-297 and E-300): Component 6, the Consolidation Map.
- **E-301** (Tier 3, after P-44; also after E-294, which rewrites four harness files): wave 1 —
  the gate families: tables, moves, merges, deletions per the map.
- **E-302** (Tier 2, after P-44): wave 2 — everything that is not a gate.
- **E-303** (Tier 2, after E-301 and E-302): Component 7, the ratchet.
- **E-366** (Tier 1, after E-303): the `[BUDGET_DRIFT]` line in `ai ci status` and `ai doctor` (D-118 r1).

## CI Resources — memory, lanes, fixtures, waiting (D-091, 2026-10-12)
D-088 gave the suite a delete rule; it did not touch what a run COSTS while it exists. Measured
on 2026-10-05 (census, 7342fac) and 2026-10-12 (CI logs): `tests/run.sh` runs 152 suites
strictly serially (summed suite time 1,715 s; 17 suites over 30 s, the ten slowest = 754 s =
44% of the clock; 70 suites under 2 s); 20 suites run `install-ai-os.sh` and 13 run `ai init`
as SETUP; 50 `sleep N` sites in 19 suites wait a fixed time instead of polling; the runner has
no per-suite deadline, so a hung suite holds the run; `ai ci run` records load average but not
memory, and parses only the AI-OS `SUITE_RESULT` line, so every downstream project (vitest,
node --test) records `pass=0`. The local-ci blueprint deferred parallelisation "if the run
exceeds ten minutes" — it does, and D-091 funds it. Users: the Engineer (runs the suite many
times a day), `ai ci run` (the DONE gate), downstream projects (two client projects) whose CI
records are blind today.

### Core Concept
**A run is budgeted in four resources — memory, wall time, setup repeats, waiting — and each is
measured by the run that spends it.** Parallelism is by RESOURCE CLASS, not by count: a suite
that owns a machine-wide thing (a tmux server, the installer as subject, a port, a perf
budget) runs alone; everything else shares lanes. Memory caps lanes, not core count.

### Components
8. **Poll, never sleep; every suite has a deadline** (E-307). `tests/lib/assert.sh` gains
   `wait_for <predicate-cmd> <timeout_ms> [interval_ms]` — polls the predicate until it exits
   0 or the deadline passes, prints elapsed on failure, bash 3.2, no `timeout(1)` dependency.
   The 50 `sleep N` sites are replaced by `wait_for` on the condition they were waiting for;
   the few that wait for a NEGATIVE (nothing must happen for N ms) are kept under a named
   allowlist in the suite with the reason on the line. `tests/run.sh` runs each suite under a
   watchdog (`AIOS_SUITE_TIMEOUT`, default 180 s; a suite may declare a larger budget with a
   `# AIOS_SUITE_TIMEOUT=<s>` header line read by the runner): a suite past its deadline is
   killed with its process group, reported as `[SUITE_TIMEOUT] <suite> after <s>s` and counted
   FAIL; its leak diff and cleanup still run.
9. **Fixtures built once per run, cloned per suite** (E-308 — SUPERSEDED by D-092, see the amendment at the end of this section; no template is built). The runner builds ONE throwaway
   HOME template per run (`$AIOS_TEST_TMPDIR/home-template`, `bash install-ai-os.sh` from the
   tree under test — the same mirror-lag rule as `ai ci run`'s install step) and the harness
   gains `test_home_clone [label]`: a per-suite HOME cloned from the template (APFS `cp -c`,
   fallback `cp -R`), registered for cleanup, under the lane's temp prefix. Suites that run the
   installer or `ai init` as SETUP switch to the clone; suites whose SUBJECT is the installer or
   `ai init` keep the real call and are listed by name in the suite header
   (`# AIOS_INSTALLER_SUBJECT`). The footprint recorder already counts installer spawns, so
   the census shows the before/after.
10. **Lanes by resource class, with a per-lane leak diff** (E-309). `tests/run.sh --lanes N`
   (`AIOS_TEST_LANES`; default 1 = today's behaviour, so every caller is unchanged). Each suite
   carries a resource class, derived from the census spawn data plus a header declaration
   (`# AIOS_EXCLUSIVE: tmux|installer|port|perf`): EXCLUSIVE suites (tmux, `ai watch`, the
   installer as subject, port binders, suites with `assert_perf` — host load changes the ratio,
   E-239) run in one serial lane AFTER the shared lanes finish; every other suite is
   distributed longest-first by its last census `wall_ms`. A lane owns a socket and temp
   prefix suffix (`aios-test-L2-`, `aios-t-L2-`), and the leak snapshot is filtered by the
   lane's prefix, so a leak is attributed to a lane AND a suite; per-suite output is captured
   and printed in suite order, and CENSUS rows are merged. `ai ci run --lanes N` (default
   `min(4, cores/2)`, recorded in the row) passes it through; the one-run-per-project lock is
   unchanged. The lane count is capped by memory, not cores: the runner refuses more lanes
   than `free_memory / 1.5 GB` and says so.
11. **Record what is budgeted; read every runner's summary** (E-310). `ai ci run` measures the
   suite step's peak resident memory (`/usr/bin/time -l` on macOS, `-v` on Linux) and records
   `peak_rss_mb`, `lanes`, `suite_seconds` and the ten slowest suites in the CI row; `ai ci
   status` prints them. The summary parser gains vitest (`Test Files … / Tests N passed | M
   failed`), node `--test` (`# pass N / # fail N`), pytest (`N passed, M failed`) and jest
   shapes, so a downstream project's row carries its real counts. The E-303 budget block
   records `peak_rss_mb` and `full_seconds`; neither is ratcheted (D-118 r1 withdrew the
   "+10% once both land" plan — the drift line in Component 7 replaces it).

### Data Model
```
CI row (ci-record.mjs) gains: { "lanes": N, "peak_rss_mb": N, "suite_seconds": N,
  "slowest": [ { "suite": "pane_binding", "wall_ms": 115600 }, … 10 ] ,
  "runner": "aios|vitest|node-test|pytest|jest" }
Suite header declarations (comment lines, read by tests/run.sh and census.mjs):
  # AIOS_SUITE_TIMEOUT=<seconds>      # AIOS_EXCLUSIVE: tmux|installer|port|perf
  # AIOS_INSTALLER_SUBJECT            # AIOS_SLEEP_ALLOWED: <reason>
Lane namespaces: AIOS_TEST_SOCK_PREFIX=aios-test-L<n>-  AIOS_TEST_TMP_PREFIX=aios-t-L<n>-
```
Targets: full run < 6 min on the operator's Mac at 4 lanes BEFORE any consolidation, < 5 min
after waves 1–2 (the D-088 target, now reachable); installer spawns per run ≤ the subject
allowlist; `sleep N` sites 0 outside the allowlist; peak RSS recorded on every run.

### API / Interface Contracts
- `wait_for <cmd> <timeout_ms> [interval_ms]` → 0 when the predicate passes, 1 at the
  deadline with `wait_for: <cmd> not true after <ms> ms` on stderr.
- `test_home_clone [label]` → prints the cloned HOME path; exit 2 when no template exists
  (a suite run outside `tests/run.sh` builds its own via the existing path).
- `bash tests/run.sh [--lanes N] …`; `ai ci run [--lanes N]`; both refuse `N` above the
  memory cap with the cap printed. `--lanes 1` is byte-equivalent in results to today.
- `ai ci status` prints `lanes`, `peak_rss_mb`, `suite_seconds` and the slowest ten.

### Security
- Lanes never share a HOME, socket prefix or temp prefix; a suite that reaches outside its
  lane is a leak and FAILS the run exactly as today (E-240), now attributed to the lane.
- The watchdog kills the suite's process GROUP only (never by name, never machine-wide).
- The HOME template is built from the tree under test by the existing installer; no new
  install path, no write under the real `~/.ai-os` (E-304 holds).
- Summary parsers read log text only; they never execute project code.
- `tests/fixtures/arch-write-cases.json` stays byte-identical (D-056); the gate suites are
  resource-classed, not changed.

### Execution Constraints
- bash 3.2; `wait_for` costs one `sleep <interval>` per poll (default 50 ms); the watchdog is
  one background subshell per suite.
- Clone < 1 s on APFS; the template build is one installer run per full run.
- A memory cap of 1.5 GB per lane is the first estimate; E-310's `peak_rss_mb` replaces the
  guess with a measurement and the cap is re-ruled on data.
- Downstream projects set worker caps in their own runner config (vitest `maxWorkers`, a
  serial group for browser tests) — project-level tasks in their own `.ai/`, not here.

### Rollback Plan
`--lanes` defaults to 1 and `wait_for` is additive: reverting E-309 or E-307 is one PR each
and no suite changes behaviour at `--lanes 1`. The HOME template helper falls back to the
suite's own installer call when the template is absent. New CI row fields are ignored by
older readers; the summary parsers fall back to the AI-OS line.

### E-## Task Breakdown (D-091)
- **E-307** (Tier 2): Component 8 — `wait_for`, sleep replacement, per-suite watchdog.
- **E-308** (Tier 2): Component 9 — HOME template per run, `test_home_clone`, setup suites
  converted, subject suites declared.
- **E-309** (Tier 2, after E-307 and E-308): Component 10 — lanes by resource class,
  per-lane leak diff, `ai ci run --lanes`, memory cap.
- **E-310** (Tier 2, after E-309): Component 11 — peak RSS, lanes and slowest-ten in the CI
  row; vitest / node --test / pytest / jest summary parsers; the budget fields.
- **P-44** is ordered by wall time: the Consolidation Map lists the ten slowest suites first.

### D-092 amendment (2026-10-12): Component 9 superseded — there is no setup install to clone
The "20 suites run the installer and 13 run `ai init` as setup" figure in this section came
from `grep`, not from the census spawn data. The Engineer's survey (COMM.md 2026-10-12): 15 of
the 20 only grep the installer's text or name it in a payload; 12 of the 13 only mention
`ai init`. The CENSUS_FP rows of the last CI run show real installer spawns in exactly five
suites — init_upgrade, mirror_hygiene, exec_form_hooks (under `env`, invisible to the
recorder), provider_workspace, installer_node_check — and in every one the installer or
`ai init` IS the subject. A template would cost one install per run and save none. The ~35
suites that hand-build a partial `~/.ai-os` copy one to three directories, already cheaper
than a clone. This is the fifth census variety again (DIGEST: "the scan that never ran"):
a count of MENTIONS stood in for a count of RUNS, and the blueprint carried it. **A
blueprint number about what the suite DOES comes from the footprint, never from grep.**
What survives of Component 9, as E-311 (Tier 1): the `# AIOS_INSTALLER_SUBJECT` header on
the five subject suites (E-309's exclusive-lane classification reads it); the footprint
recorder taught to see `env … bash <path>` and path-invoked installer / `ai init` spawns;
the census printing installer spawns per suite. `test_home_clone` and the per-run template
are not built. E-309 now depends on E-307 and E-311.

### D-093 amendment (2026-10-13): the lane target, the installer class and the memory cap, re-ruled on E-309's data
E-309 measured on the operator's Mac (b9901a3, quiet host): 1 lane 1586 s, 4 lanes 926 s,
identical totals (5830/0/2), leaked 0. At 4 lanes the 128 shared suites are 920 s of work
(≈ 230 s per lane) and the 24 exclusive suites run serially for 568 s, of which the four
installer-subject suites are 322 s (mirror_hygiene 93, init_upgrade 92, exec_form_hooks 70,
provider_workspace 67), pane_binding 44 and ai_watch 27.

**Target (replaces "< 6 min at 4 lanes").** The bound at N lanes is
`shared_work / N + exclusive_serial`; a parallel target is derived from that critical path,
never from the whole run divided by N — the D-091 figure was the latter and was never
reachable. Before consolidation: 926 s at 4 lanes (measured). After E-312: ≤ 10 min at
4 lanes (installer suites leave the serial tail: ≈ 1242 s / 4 + 246 s ≈ 556 s). After waves
1–2: < 5 min (D-088, unchanged). P-44 marks each suite's lane class and puts the exclusive
suites first within the ten slowest, because the serial phase is what the lanes cannot cut.

**Component 10, classification (amended).** `# AIOS_INSTALLER_SUBJECT` names the subject; it
no longer implies EXCLUSIVE. An installer-subject suite is shared-lane eligible when the
footprint recorder shows every installer / `ai init` spawn it makes with a HOME under the
lane's HOME clone or the lane's temp prefix (the recorder records the spawn's HOME beside the
command; the census prints it). Any other HOME on such a spawn, or a tmux / `ai watch` /
port / `assert_perf` match, keeps the suite exclusive; `# AIOS_EXCLUSIVE: installer` forces it.
The installer copies the mirror and runs no `npm install`, so concurrent installs cost disk
and memory only; E-312 proves the memory with E-310's measurement (peak RSS at 4 lanes after
≤ 1.25 × before, else the four suites get the explicit header back).

**Component 10, memory cap (amended).** Available memory is the kernel's figure: macOS
`kern.memorystatus_level` (percent) × `hw.memsize` — on this host 34% × 17 GB ≈ 5.8 GB where
the vm_stat page sum (free + inactive + speculative + purgeable) read ≈ 3 GB and clamped the
default `ai ci run` to one lane; Linux `MemAvailable` from `/proc/meminfo`. The per-lane
figure is the last recorded `peak_rss_mb / lanes` × 1.25 with a 512 MB floor (read from this
project's newest CI record, the same source as the wall hints), falling back to 1.5 GB when
no run has recorded one. `AIOS_TEST_FREE_MB` is a fixture stand-in read by `tests/run.sh`
only; `ai ci run` does not forward it — there is no operator opt-out of the cap, the cap is
corrected by measuring better.

**Accepted as built.** The CI-row `lanes` column lands with E-310; the `[ci] lanes=N` log line
carries it until then. "bash install-ai-os.sh" in acceptance lines means "install from
`../ai-os-stable` after the merge" (E-304); task text from here on says that.

- **E-312** (Tier 2, after E-310): the three amendments above — recorder records HOME per
  installer spawn and the census prints it; classification reads it; kernel availability
  figure; per-lane figure from the last recorded peak; `ai ci run` stops forwarding the
  override; wall time at 1 and 4 lanes and peak RSS before/after in LOG.md.

### D-094 amendment (2026-10-13): the cap reads a sampled concurrent sum, not rusage's largest process
E-310 (51bc569) records `peak_rss_mb` from `/usr/bin/time`, which is `ru_maxrss` of the largest
waited-for child: 281 MB at 1 lane and at 4 lanes, 238 MB for two concurrent 200 MB probes.
D-093's `peak_rss_mb / lanes × 1.25` therefore always reached the floor and could not see four
concurrent installs. **Before a formula uses a measured field, this blueprint names what the
field measures — which process, which window.**

Two fields from here on. `peak_rss_mb` (E-310) = largest single process in the suite step; it
names a runaway and stays. `peak_sum_rss_mb` (E-313) = the maximum, sampled once per second by
`tests/run.sh`, of the summed RSS of every lane's process groups (the groups the watchdog
tracks); approximate between samples, which the slack absorbs. The lane cap's per-lane figure
is the last recorded `peak_sum_rss_mb / lanes × 1.25`, floor 512 MB, fallback 1.5 GB when no
record carries the field. E-312's installer check ("after ≤ 1.25 × before") reads the sum, so
E-313 lands before E-312 closes. E-303's budget block records `peak_sum_rss_mb` (not ratcheted — D-118 r1; the drift line covers it).

Data model: CI row gains `peak_sum_rss_mb`; the run prints `[run] peak_sum_rss_mb=N samples=K`.
Measured so far: 4 lanes 927 s (suite 870 s), default 1595 s (suite 1537 s, clamped to 1 lane
by the page sum), `peak_rss_mb` 281 at both.

- **E-313** (Tier 2, OPEN, before E-312 closes): the sampler, the field, the cap on the sum.
- **E-312** part 3: the kernel-figure half proceeds; the per-lane half is E-313's.

### D-096 amendment (2026-10-13): E-312 and E-313 accepted; the 4-lane target is measured, not estimated
Measured on c8f7f55 (operator's Mac): 1 lane 1561 s; 4 lanes 753 s (suite_seconds 696), both
5862/0/2, leaked 0; `peak_sum_rss_mb` 547 at 1 lane and 579 at 4 (sampler 0.60% / 0.69% of
suite time); `peak_rss_mb` 281 at both. The four installer-subject suites now share lanes
(census: exec_form_hooks tmp×1, init_upgrade tmp×13, mirror_hygiene tmp×7, provider_workspace
run×1); concurrent memory at 4 lanes 756 MB with them pinned exclusive vs 640 MB shared, so no
`# AIOS_EXCLUSIVE: installer` pin. gate_abort_test joined the exclusive phase (`perf`: a 10 s
timer bounded at +1.5 s measured 12.3 s under contention). installer_node_check stays exclusive
on bare `mktemp -d` HOMEs (E-302 row: `test_tmpdir`, as exec_form_hooks).

**Target line (replaces D-093's "after E-312: ≤ 10 min").** That figure was an estimate
(≈ 556 s) assuming perfect packing and no contention; it is withdrawn. The bound stays
`shared_work / N + exclusive_serial`; before consolidation it is the MEASURED 753 s at 4 lanes
(926 s before E-312). After waves 1–2: < 5 min (D-088, unchanged). A target line from here on is
a measurement or a formula over measurements, never an estimate.

**Memory line (final form).** `Memory: <avail> MB available (<kernel source>) / <per-lane> MB
per lane (<last peak_sum_rss_mb at N lanes × 1.25 | fallback>) → cap K lane(s)`, printed on
every multi-lane run; `ai ci status/list` print `peak RSS <largest process>, <concurrent sum>`.

## Consolidation Map (P-44, D-112, 2026-10-28 — census on a1b76e4)

### Inputs
- **Census** `node tests/tools/census.mjs` on a1b76e4 (2026-10-28): 146 bash suites, 26 unit
  files, 42,453 test lines vs 34,835 src lines (1.22); dynamic footprint for 146/146; failure
  history 8 CI runs since 2026-10-27 (the log directory keeps 14 runs, so "never failed" is
  eight runs of evidence). Three misnamed suites. No move-to-unit candidate by the census's
  strict rule (every spawn is `node <src module>`) — the moves below are by inspection of
  the suite's spawn shape (`mixed`, one-module footprint, assertions on parsed stdout).
- **E-300 mutation report**: `~/.ai-os/ci/mutation-<date>.json` is NOT present on the
  planning machine and no packet reached COMM.md. The unit-file deletion candidates it would
  name are therefore deferred: every `tests/unit/*.test.mjs` is `keep` here. E-302 attaches
  the probe report when one is run (`bash tests/tools/mutation/probe.sh`), else reports the
  gap — the map is amended by ruling, never by the Engineer, when it arrives.
- The census's 48 suite-level **delete** candidates are refused as deletes (eight runs of
  history is too thin for D-088 r4). Each becomes a **merge** whose receiving suite drops
  only an assertion whose `input → verdict` pair already exists in that suite or in a table;
  every dropped label is listed in the PR description. That is "delete (covered by …)" at
  assertion level, which is where the duplication actually is.

### Vocabulary
`keep` (file stays, may be renamed in place) · `merge → <suite>` (assertions move into that
suite, file deleted, task ids become section comments) · `rename → <suite>` (this file IS the
receiving suite under its behaviour name) · `move → tests/unit/<file>` (pure-function rows
leave bash) · `table → tests/fixtures/<family>-cases.json` (input→verdict rows become table
rows labelled by their task id; the suite's remaining process-boundary rows follow the
`remainder` clause). One row per current suite; a suite appears exactly once.

### Contract tables (wave 1)
| Table | Family | Runner (tests/unit) | Byte-pinned (D-056 class) |
|---|---|---|---|
| `arch-write-cases.json` (exists) | Architect Write/Edit paths | `arch-write-cases.test.mjs` (new; the D-056 sha256 assertion moves here from architect_write_gate) | YES — sha256 unchanged through both waves |
| `role-verdict-cases.json` (new) | `--check-path` × role (architect, engineer, none) × path class | `role-verdict-cases.test.mjs` | YES at landing (D-087 role model is frozen; the sha is recorded in E-301's LOG line and asserted) |
| `gate-self-disable-cases.json` (new) | `GATE_SELF_DISABLE` (`gate-guard.mjs`) | `gate-self-disable-cases.test.mjs` | YES at landing (D-089 r5 froze the rule) |
| `gate-relative-home-cases.json` (exists) | relative `~/.ai-os` writes after `cd HOME` | `gate-relative-home-cases.test.mjs` (as built in E-301, D-116 r1; `gate-guard-home.test.mjs` keeps its process rows) | YES |
| `secret-cases.json` (exists) | `SECRET_IN_COMMAND` | `secret-cases.test.mjs` (new; replaces the bash driver run) | YES (D-080 contract) |
| `pipe-shell-cases.json` (exists) | heredoc lexer and the remote-pipe rules | `pipe-shell-cases.test.mjs` (new; absorbs the E-291 per-task rows around it) | YES (D-083, D-111 r4) |
| `operand-scope-cases.json` (exists, 240 rows) | sovereignty families × role (git/deploy/rm/mkdir/touch, code-string carriers, git redirects, root forms) | `operand-scope.test.mjs` (exists) | NO — E-350 residuals are still open (D-112 r3); pinned by the ruling that closes them |
| `block-rules-cases.json` (new) | role-independent `BLOCK_RULES` (`RM_RF_ROOT`, `FORK_BOMB`, `MKFS`, `DD_DISK_WIPE`, the remote-pipe rules, `DROP_TABLE`, …) | `block-rules-cases.test.mjs` | NO — `RM_RF_ROOT` moved in E-350 and moves again with the residuals |
| `standards-cases.json` (new) | every `standards.json` rule, the E-225 operand walk, program position, re-tokenised operands | `standards-cases.test.mjs` (absorbs `standards-test-rules.test.mjs`) | NO — rules grow with `standards.json` |

Rules for every table: **one JSON row per line** (`[{"label":…,"role":…,"cmd":…,"want":…},` —
the six-line pretty form costs more lines than the bash it replaces; `arch-write-cases.json`
keeps its bytes). A table is run **in process** (the `inproc-tables.mjs` pattern:
`runAnalysis` with `--check` semantics), once, by its unit runner. The **spawn path** is
probed once per table — ONE blocking and ONE passing row through the real `--check` CLI —
in `safe_exec_test` (the only bash suite that may reference a `-cases.json` path; the fast
tier selects by that reference, so no other suite names a table path, not even in a comment
that `select-suites.mjs` would match).

### Wave 1 — gate families (E-301; 23 suites → 10, +7 unit runners, +2 unit files)
| Suite | Disposition | Carries |
|---|---|---|
| architect_write_gate | table → `arch-write-cases.json` runner + `role-verdict-cases.json` (the E-216 widened-gate rows); remainder (the hook's Write/Edit branch with a live token) merge → pre_tool_use_gate_test | E-216, E-294.11y (sha assertion) |
| safe_exec | table → `block-rules-cases.json`; its driver runs of `secret`, `pipe-shell`, `gate-relative-home` become the unit runners above; **keep (slimmed)** as the `--check` CLI boundary: exit codes 0/2, the budget line, one spawn probe per table | T-ROLE-001 → row label in `role-verdict-cases.json`; E-44, E-287.01, E-291.PS1, E-294.RH1 as row labels |
| pre_tool_use_gate | keep; absorbs safe_exec_unavailable, hook_toolchain and architect_write_gate's hook branch | T-HITL-004 (hook enforcement), T-HOOKENV-001 |
| safe_exec_unavailable | merge → pre_tool_use_gate_test | E-289 |
| hook_toolchain | merge → pre_tool_use_gate_test | T-HOOKENV-001, E-286 |
| gate_abort | keep (its `AIOS_EXCLUSIVE: perf` header and timers stay) | E-292 |
| gate_override | keep; the "agent cannot switch its own gate off" rows table → `gate-self-disable-cases.json` | E-291; D-089 r5 widening rows |
| role_token | keep (mint, verify, prune through live processes) | E-129..E-294, D-087 |
| caller_role | merge → mcp_role_interceptors_test (the census delete "covered by role_token" is refused: the suite carries a pin) | T-PATCHMCP-001 |
| e143 | rename → mcp_role_interceptors_test (misnamed); absorbs caller_role | E-143 |
| git_lane | keep; absorbs git_hooks_stub | T-GITLANE-001 |
| git_hooks_stub | merge → git_lane_test | E-41 |
| conflict_gate | rename → pre_commit_hook_test; absorbs mcp_stdout_purity, pre_commit_standards_gate and standards_checker's CLI rows | E-238 |
| mcp_stdout_purity | merge → pre_commit_hook_test | E-48 |
| pre_commit_standards_gate | merge → pre_commit_hook_test | E-82 |
| standards_checker | table → `standards-cases.json`; remainder (the CLI through the pre-commit hook) merge → pre_commit_hook_test | E-80 |
| program_position | table → `standards-cases.json` | E-234 |
| operand_retokenise | table → `standards-cases.json` | E-231 |
| locator_policy | keep | T-LOCATOR-001 (hooks half) |
| skill_locator | rename → skill_lines_test; absorbs skill_consent | T-LOCATOR-001 (skills half) |
| skill_consent | merge → skill_lines_test | E-232 |
| markdown_exec | move → `tests/unit/markdown-exec.test.mjs` (pure `markdown-exec.mjs`); its T-LOCATOR-001 mention stays as a comment — the pin's carriers are locator_policy and skill_lines | E-224 |
| traversal_policy | move → `tests/unit/traversal-policy.test.mjs` | E-222 |

Wave 1 also takes ONE thing from a wave-2 suite: pane_binding's Write/Edit-gate assertions
(labels T-HITL-004, T-ROLE-001, the E-208 gate rows) become `role-verdict-cases.json` rows;
the file itself is a wave-2 row below. That is 23 wave-1 files plus that excerpt.

Wave 1 proof (amended D-113 — the census does NOT record `--check` inputs; E-301 recorded
them by running the 24 wave-1 sources against a throwaway worktree whose `index.js` appends
`{mode, input, exit}` per call; that instrumented copy is never committed, the procedure is
one paragraph in `tests/tools/README.md`): every pre-wave `(mode, input, verdict)` triple is
checked in as one row per line of `tests/fixtures/wave1-inputs.json`, classed **`table`** or
**`boundary:<kept suite>`**, and `tests/unit/consolidation-subset.test.mjs` asserts:

- **`table`** rows (pure: the verdict is a function of input × role alone) — the row exists
  in the post-wave table its `mode` maps to (`--check` → `block-rules`, `operand-scope`,
  `secret`, `pipe-shell`, `gate-self-disable`, `gate-relative-home`, `arch-write`;
  `--check-path` → `role-verdict` only; corrected twice on 2026-10-28, D-116 r1: arch-write's
  rows are `--check` commands), matched on the
  normalised input, the role where the table carries one, and the verdict. Paths are
  normalised to `<proj>/…`, `<home>/…`, `<outside>/…` before matching; an input that is pure
  AFTER normalisation (a fixture-temp path whose verdict depends only on being outside the
  project) is `table`, not `boundary`.
- **`boundary:<suite>`** rows (context-bound: the same input verdicts differently on process
  state no table runner models — an active `ai gate off` override, the E-331 claim gate in a
  team project, an unverified token, `--session` with no value) — the named carrier suite is
  a map `keep`/`rename` target that exists post-wave and its text still contains the input
  verbatim. Each row names its `context` (`override`, `claim_gate`, `unverified_token`,
  `empty_session`, …) so a reviewer can see why it is not a row. The verdict assertion stays
  the carrier's own; the proof checks presence, not verdict.
- The two classes partition the recorded set: no third class, and the test fails on an
  unclassed row. **Nothing leaves a kept suite without becoming a table row.** No table gains
  a context column (D-113): `role-verdict-cases.json` models the D-087 role model only and is
  byte-pinned at landing; process state belongs to the suite that owns the process.

### Wave 2 — everything else (E-302; 123 suites → 35, +8 unit files)
| Suite | Disposition | Carries |
|---|---|---|
| ai_start | keep; absorbs ai_start_surface, alternate_screen_env, aios_workspace_env | E-227, E-228, E-50, E-62 |
| ai_start_surface | merge → ai_start_test | — |
| alternate_screen_env | merge → ai_start_test | — |
| aios_workspace_env | merge → ai_start_test | — |
| pane_binding | keep; absorbs pane_option_binding, overlay_path, role_identity (gate rows left in wave 1) | E-208, E-269, E-242, E-213 |
| pane_option_binding | merge → pane_binding_test | — |
| overlay_path | merge → pane_binding_test | — |
| role_identity | merge → pane_binding_test | — |
| role_provisioning | keep; absorbs role_runtime, role_config, provider_adapter, headless_tester | E-212, E-215, E-135, E-138, E-255 |
| role_runtime | merge → role_provisioning_test | — |
| role_config | merge → role_provisioning_test | — |
| provider_adapter | merge → role_provisioning_test | — |
| headless_tester | merge → role_provisioning_test | — |
| provider_workspace | keep (installer subject, own lane) | E-244 |
| init_upgrade | keep (installer subject) | E-270 |
| installer_node_check | keep (installer subject, exclusive HOMEs) | E-69 |
| exec_form_hooks | keep (installer subject) | T-HOOKENV-002 |
| mirror_hygiene | keep (installer subject) | E-273 |
| classifier_backstop | keep | E-293 |
| ai_clean | keep | E-272 |
| test_harness_isolation | rename → harness_isolation_test; absorbs leaked_state, launch_vars (its `AIOS_SUITE_TIMEOUT` header carries over), skip_accounting, telemetry_isolation, perf_budget | E-156, E-240, E-264, E-236, E-257, E-239 |
| leaked_state | merge → harness_isolation_test | — |
| launch_vars | merge → harness_isolation_test | — |
| skip_accounting | merge → harness_isolation_test | — |
| telemetry_isolation | merge → harness_isolation_test | — |
| perf_budget | merge → harness_isolation_test | — |
| node_unit | keep (the bridge) | E-206 |
| native_surface | rename → hooks_surface_test; absorbs session_start_cache, stop_hook, telemetry_hook_matcher, cache_wiring | E-284, E-126, T-HM-01..04 |
| session_start_cache | merge → hooks_surface_test | — |
| stop_hook | merge → hooks_surface_test | — |
| telemetry_hook_matcher | merge → hooks_surface_test | T-HM-01, T-HM-02, T-HM-03, T-HM-04 |
| cache_wiring | merge → hooks_surface_test | — |
| cli | keep; absorbs idempotency, blueprints_index, doctor_env, legacy_mention, mcp_json_user_servers, agent_logic | E-34, E-110, E-175, E-256, E-274, T-01 |
| idempotency | merge → cli_test | — |
| blueprints_index | merge → cli_test | — |
| doctor_env | merge → cli_test | — |
| legacy_mention | merge → cli_test | — |
| mcp_json_user_servers | merge → cli_test | — |
| agent_logic | merge → cli_test | — |
| sync_reachability | rename → ai_sync_test; absorbs sync_prune, memory_palace_sync, path_rules, mcp_doc_sync, registry_sync, mcp, skill_prune | E-247, E-220, E-145, E-282, E-52, E-283 |
| sync_prune | merge → ai_sync_test | — |
| memory_palace_sync | merge → ai_sync_test | — |
| path_rules | merge → ai_sync_test | — |
| mcp_doc_sync | merge → ai_sync_test | — |
| registry_sync | merge → ai_sync_test | — |
| mcp | merge → ai_sync_test | — |
| skill_prune | merge → ai_sync_test | — |
| ai_ci_run | rename → ai_ci_test; absorbs ai_ci_record, ai_ci_gate, actions_decommission | E-265, E-266, E-267, E-268 |
| ai_ci_record | merge → ai_ci_test | — |
| ai_ci_gate | merge → ai_ci_test | — |
| actions_decommission | merge → ai_ci_test | — |
| telemetry | keep; pure rows move → `tests/unit/telemetry.test.mjs` (extends `telemetry-naming.test.mjs`); absorbs mcp_telemetry, task_velocity | E-84, E-153, E-259 |
| telemetry_migration | move → `tests/unit/telemetry.test.mjs` (a fixture sqlite, no process) | E-154 |
| mcp_telemetry | merge → telemetry_test | — |
| task_velocity | merge → telemetry_test | — |
| meta_analyst | rename → meta_cognition_test; absorbs insights_staleness, and the agent-text rows of instinct_stager and skill_promoter | E-85, E-86, E-93, E-94 |
| insights_staleness | merge → meta_cognition_test; probe rows move → `tests/unit/insights-staleness.test.mjs` | — |
| instinct_stager | move → `tests/unit/instinct-stager.test.mjs`; agent-text rows merge → meta_cognition_test | — |
| skill_promoter | move → `tests/unit/skill-promoter.test.mjs`; remainder merge → meta_cognition_test | — |
| incident_append | rename → incident_tracker_test; absorbs incident_aggregator | E-65, E-66, E-67 |
| incident_aggregator | merge → incident_tracker_test (its perf row keeps the E-239 two-number form) | — |
| framework_task_routing | rename → task_synchronizer_test; absorbs managed_agents_sync_hook, nextid_drift, role_header_view, token_optimization, dag_dependency, sovereignty_lock, structured_outputs, critic_stamp (the census's five-way overlap cluster plus the other task-synchronizer tool suites) | E-63, E-74, E-109, E-136, E-107/E-108, E-91, E-101, E-12 |
| managed_agents_sync_hook | merge → task_synchronizer_test | — |
| nextid_drift | merge → task_synchronizer_test | — |
| role_header_view | merge → task_synchronizer_test | — |
| token_optimization | merge → task_synchronizer_test | — |
| dag_dependency | merge → task_synchronizer_test | — |
| sovereignty_lock | merge → task_synchronizer_test | E-101 |
| structured_outputs | merge → task_synchronizer_test | — |
| critic_stamp | merge → task_synchronizer_test | — |
| verify_sync_per_task | rename → state_views_test; absorbs verify_sync, state_json, cli_add_task, migrate_state | E-60, E-102, E-82/P-40, E-198, E-89 |
| verify_sync | merge → state_views_test | — |
| state_json | merge → state_views_test | — |
| cli_add_task | merge → state_views_test | — |
| migrate_state | merge → state_views_test | — |
| archive_manager_state | rename → state_archive_test; absorbs archive_pointer, archive_tasks, sqlite_wal_checkpoint | E-111, E-245, E-112, E-53 |
| archive_pointer | merge → state_archive_test | — |
| archive_tasks | merge → state_archive_test | — |
| sqlite_wal_checkpoint | merge → state_archive_test | — |
| wal_flusher_node | move → `tests/unit/wal-flusher.test.mjs` | E-57 |
| managed_agents_client | rename → managed_agents_test; absorbs state_projector_sync, managed_agents_spike; pure client rows move → `tests/unit/managed-agents-client.test.mjs` | E-70, E-73, E-47 |
| state_projector_sync | merge → managed_agents_test (pure rows → the unit file above) | — |
| managed_agents_spike | merge → managed_agents_test (`tests/managed_agents_spike.js` moves to `tests/tools/`) | — |
| resilience | keep | T-RES-01..T-RES-16 |
| advisor_mcp | keep | T-A2A-01..T-A2A-12 |
| approval_mcp | keep; absorbs session_traceability | T-HITL-001..T-HITL-005, E-49 |
| session_traceability | merge → approval_mcp_test | — |
| cache_manager_mcp | rename → cache_manager_test; absorbs mcp_tester | E-11, E-176 |
| mcp_tester | merge → cache_manager_test | — |
| mcp_integration | rename → mcp_servers_test; absorbs mcp_behavioral, booted_build, policy_hot_reload, blueprint_aligner, verification, browser_optin, the token-budget-mcp section of e140_e141_e142 and the process rows of robustness_p7_p12 | E-49, E-27, E-249, E-237, E-45, E-111, E-235 |
| mcp_behavioral | merge → mcp_servers_test | — |
| booted_build | merge → mcp_servers_test | — |
| policy_hot_reload | merge → mcp_servers_test | — |
| blueprint_aligner | merge → mcp_servers_test | — |
| verification | merge → mcp_servers_test | — |
| browser_optin | merge → mcp_servers_test | — |
| e140_e141_e142 | rename → propose_patch_test (misnamed); token-budget section → mcp_servers_test; absorbs propose_patch_apply, patch_readonly_scope, patch_project_boundary, patch_mcp | T-GH-001, T-PI-001 |
| propose_patch_apply | merge → propose_patch_test | — |
| patch_readonly_scope | merge → propose_patch_test | T-PROPOSEPATCH-002 |
| patch_project_boundary | merge → propose_patch_test | E-221 |
| patch_mcp | merge → propose_patch_test | E-137 |
| orchestrator_dispatch | keep | E-92 |
| robustness_p7_p12 | move → `tests/unit/bounded-reads.test.mjs` (misnamed; the pure bounded-read helpers); process rows merge → mcp_servers_test | P-7..P-12 |
| repo_map_wiring | rename → repo_map_test; absorbs ast_parser, repo_map_generate, repo_mapper | E-95..E-98 |
| ast_parser | merge → repo_map_test | — |
| repo_map_generate | merge → repo_map_test | — |
| repo_mapper | merge → repo_map_test | — |
| multimodal_memory | rename → memory_palace_test; absorbs memory_manager | E-46, E-110 |
| memory_manager | merge → memory_palace_test | — |
| memory_batch_scanner | move → `tests/unit/memory-batch-scanner.test.mjs` | E-75 |
| memory_worker_pool | move → `tests/unit/memory-worker-pool.test.mjs` | E-76 |
| multi_variation_state_tracker | rename → seo_cluster_test; absorbs seo_manager, seo_engineer, seo_content_generator | E-87, E-88, E-90 |
| seo_manager | merge → seo_cluster_test | — |
| seo_engineer | merge → seo_cluster_test | — |
| seo_content_generator | merge → seo_cluster_test | — |
| critic_clean_code | rename → agent_contracts_test; absorbs specialist_agents, security_engineer_agent, skill_context, vibe_stamp_alignment, task_planner_routing, ai_debug_skill (every "grep the agent/skill file for its contract" suite) | E-81, E-149..E-152, E-44, E-100, E-113, E-64, E-43 |
| specialist_agents | merge → agent_contracts_test | — |
| security_engineer_agent | merge → agent_contracts_test | — |
| skill_context | merge → agent_contracts_test | — |
| vibe_stamp_alignment | merge → agent_contracts_test | — |
| task_planner_routing | merge → agent_contracts_test | — |
| ai_debug_skill | merge → agent_contracts_test | — |
| skill_evals | keep | E-285 |

### T-* regression pins — carrier after both waves
| Pin | Carried by |
|---|---|
| T-A2A-01..12 | advisor_mcp_test |
| T-HITL-001..005 | approval_mcp_test; T-HITL-004 also pre_tool_use_gate_test (enforcement) and `role-verdict-cases.json` rows (the pane rows) |
| T-ROLE-001 | `role-verdict-cases.json` rows (from safe_exec, pane_binding); `standards-test-rules` rows inside `standards-cases.test.mjs` (string assembly, r2) |
| T-PATCHMCP-001 | mcp_role_interceptors_test |
| T-GH-001, T-PI-001 | propose_patch_test |
| T-PROPOSEPATCH-002 | propose_patch_test |
| T-HOOKENV-001 | pre_tool_use_gate_test |
| T-HOOKENV-002 | exec_form_hooks_test |
| T-GITLANE-001 | git_lane_test |
| T-LOCATOR-001 | locator_policy_test (hooks half), skill_lines_test (skills half) |
| T-RES-01..16 | resilience_test |
| T-HM-01..04 | hooks_surface_test |
| T-SEC-001 | `tests/unit/census.test.mjs` (untouched) |

### Arithmetic against the D-088 r5 targets
- **Suites**: 146 → 10 (wave 1) + 35 (wave 2) = **45 ≤ 60**. Unit files 26 → 43.
- **Test lines** (today 42,453: suites 28,302, unit 6,784, fixtures 2,956, lib 2,078, tools/runner
  2,333): merged or renamed suites shed their header, lib sourcing and summary blocks
  (≈ 100 files × 22 lines ≈ −2,200); bash→unit moves halve their lines (≈ 3,000 → 1,500,
  −1,500); assertion-level dedupe inside merges (the 48 covered suites hold ≈ 6,800 lines, 40%
  duplicated pairs ≈ −2,700); bash rows into one-line table rows (≈ 400 rows × 5 lines → 400,
  −1,600). Projection **≈ 34,450 ≤ 34,835** — a 1% margin, so E-302's shortfall clause is
  expected to be exercised: the report names the rows that would close it.
- **Fast tier**: today `node_unit` 21 s + the two table-referencing suites (31 s + 32 s) is
  over budget off CI. After wave 1: `node_unit` (+7 in-process runners, ≈ +8 s) + the slimmed
  `safe_exec_test` (≤ 8 spawn probes) ≈ **37 s < 60 s**.
- **Full run**: the five installer suites keep their own lanes; the two widest merges
  (harness_isolation ≈ 75 s, task_synchronizer ≈ 10 s) stay under the 300 s suite timeout.
- **Task-named suites**: 3 → 0 (`test_suite_naming` exemption list empties in E-302).
- **Gate rule families with a table**: all five named in Component 4, plus `block-rules` and
  the two existing `secret` / `gate-relative-home` tables.
