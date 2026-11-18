# Test census 2026-11 (E-435, amended by D-164 r2)

Date: 2026-11-18. Tree: `e-438-git-verb-base` at a047f8c; `main` at 3fb9253. This is a report only.
Nothing under `tests/` or `src/` was changed, and no budget was set.

## Summary

| Table | Result |
|---|---|
| 1. Behaviours asserted at more than one layer (release-artifact arc and the tasks after it, E-417..E-434, E-430) | **15 clear duplicates** across 6 tasks, plus 3 borderline cases and 2 same-layer duplicates listed separately. In every case the cheapest layer is the unit layer. Each suite row also asserts something the unit row cannot see (an exit code, or a file the process did not write), so a merge would trim the suite row, not delete it. |
| 2. test_lines between D-157 and D-162 | Recorded D-157 = **43602**, measured on `main` = **43922**, recorded D-162 = **44481**. Tasks merged to main: **+320** (= 43922 − 43602). Tasks inside D-162's value but not on main: **+559** (= 44481 − 43922). Total **+879** = 44481 − 43602. **Gap: 0.** The 44144 that `rein ci budget` prints today is the ratchet's minimum and is reconciled exactly too (§2.3). |
| 3a. Gate arc not on main, net test lines against main | E-436 **+32**, E-437 **0**, E-393 **+274**, E-353 **+100**, E-438 **+79**. Gate arc subtotal **+485**. The whole stack over main (E-428..E-438) is **+1156** = 45078 − 43922, gap 0. |
| 3b. Rows that reach the same verdict through the same branch | `gate-self-disable-cases.json`: **13 groups with more than one row, covering 220 of 225 rows**. The largest is **143 rows** that block through one branch, `namesGateOff` with the three words on one line of both V1 and V2. The E-438 rows of `operand-scope-cases.json`: **12 groups with more than one row, covering 55 of 79 rows**. The largest is **13 rows** that block through the unknown-option branch, seen by all three views. Together: 25 groups covering 275 rows. |

What the Architect may want to rule on first (D-164 r3):

- **gate-self-disable-cases.json, group G-A (143 rows).** Every row in it is decided by `namesGateOff` before any other reader runs. 117 of these rows were written for the frozen word reader or the CLI regex (the wrapper, re-read and pipe rows of E-393 and E-291). They no longer reach their verdict through that reader. §3b.1 lists what each row would hit if the predicate were removed.
- **Operand-scope rows E1 (13) and E2 (7).** Each row names a different git global option. All reach the verdict through the same option class and the same three views.

---

## 1. Duplicated behaviours (E-435's own table)

### Method

- **Task set.** I took the release-artifact arc's merges to `main` from `git log --first-parent main`: #34 E-423, #35 E-417, #36 E-418, #37 E-420, #38 E-421, #39 E-422, #40 E-425, #41 E-426, #42 E-427, #43 E-419, #45 E-424, #46 E-419b. The tasks not on main I took from their commits on the stack: E-428 (1c4b16e, 35bf126), E-429 (9ccd5a0, 1f35b0f), E-433 (d71bc61, b23d5eb, 878445a, b2cc602), E-434 (b468a67, e4ff5b3) and E-430 (7656a56, c9b22c8, 83829e0).
- **What I compared.** For each merge or commit I ran `git diff <parent> <commit> -- tests` and listed every added assertion: `assert_*` lines in suites, `test(...)` names in unit files, and fixture rows. I then read the added code to see which function or process each assertion drives.
- **Layers** (per `.ai/blueprints/test-economics.md`). *unit* is `tests/unit/*.test.mjs` run by node:test, together with the fixtures those files read. *suite* is `tests/suites/*.sh`. No live rows were added by the arc. The tmux row E-433.03 is a unit test that skips when tmux is absent.
- **What counts as a duplicate.** One behaviour, through the same production function, observed at two layers. I recorded it even when the suite row adds a process-boundary claim, and named that claim in the last column. I did not count a duplicate when the suite row observes something the unit row cannot reach.
- **Files compared.**
  - unit: `tests/unit/release-manifest.test.mjs`, `doctor-json.test.mjs`, `accounts.test.mjs`, `ci-runs.test.mjs`, `ci-summary.test.mjs`, `gate-pins.test.mjs`, `traversal-policy.test.mjs`, `digest-build.test.mjs`, `waiting-signal.test.mjs`, `build-stamp.test.mjs`, `publish-scan.test.mjs`, `project-upgrade.test.mjs`
  - fixtures: `tests/fixtures/release/*.json`, `ci-summary-cases.json`, `traversal-file-cases.json`, `digest-cases.json`, `waiting-signal-cases.json`, `legacy-mention-allowlist.json`
  - libraries: `tests/lib/release-unpack.mjs`, `tests/lib/json-schema-lite.mjs`
  - suites: `mirror_hygiene_test.sh`, `installer_node_check_test.sh`, `init_upgrade_test.sh`, `state_archive_test.sh`, `cli_test.sh`, `rein_ci_test.sh`, `rein_start_test.sh`, `exec_form_hooks_test.sh`, `role_token_test.sh`, `hooks_surface_test.sh`, `agent_contracts_test.sh`, `orchestrator_dispatch_test.sh`, `task_synchronizer_test.sh`, `rein_sync_test.sh`, `mcp_servers_test.sh`

### 1.1 Clear duplicates (15)

| # | Task | Behaviour | Unit assertion | Suite assertion | Cheapest layer | What only the suite row adds |
|---|---|---|---|---|---|---|
| D1 | E-418 | `verifyTarball` passes a tarball that matches its manifest | `tests/unit/release-manifest.test.mjs` "E-418.04" (first two asserts) | `tests/suites/mirror_hygiene_test.sh` E-418.06c | unit | the CLI exit code on the real stage |
| D2 | E-422 | the generator's `layout` equals `tests/fixtures/release/layout-v1.json` | `release-manifest.test.mjs` "E-422.04" (`pinned` deepEqual MIRRORED/OPERATOR_OWNED) | `mirror_hygiene_test.sh` E-422.01b | unit | none: `layout` is the constant pair the unit row compares |
| D3 | E-420 | `checkInstalled` refuses a hard-linked file | `release-manifest.test.mjs` "E-420.05" ("F1: a second name for the inode") | `mirror_hygiene_test.sh` E-420.02e | unit | exit 3 (02e) and no pin written (02f) |
| D4 | E-421 | the doctor document's `(id, subject)` pairs are unique | `doctor-json.test.mjs` "E-421.04" | `tests/suites/init_upgrade_test.sh` E-421.01b (`duplicate (id, subject)` check) | unit | none for this clause |
| D5 | E-421 | `fix` is the command after `run: ` (GATE_UNREGISTERED → `rein sync`) | `doctor-json.test.mjs` "E-421.03" (first assert) | `init_upgrade_test.sh` E-421.01b (`g.fix !== "rein sync"`) | unit | that a real doctor run emits `gate_registered` |
| D6 | E-421 | the document's `status` is `fail` when one record fails | `doctor-json.test.mjs` "E-421.04" (`d.status === "fail"`) | `init_upgrade_test.sh` E-421.01b (`d.status !== "fail"`) | unit | none for this clause |
| D7 | E-427 | every record's `scope` is one of install/host/project | `doctor-json.test.mjs` "E-427.01" (every table id, and `render` takes scope from the table) | `init_upgrade_test.sh` E-427.02a | unit | the ids a real run emits (the unit row derives them from `_dr` call sites in `src/bin/rein`) |
| D8 | E-425 | cargo `test result:` lines are summed, and `ignored` counts as skip | `tests/fixtures/ci-summary-cases.json` rows "cargo test --workspace: one test result line per test binary…" and "cargo: a FAILED binary counts its failures…" (via `ci-summary.test.mjs`) | `tests/suites/rein_ci_test.sh` E-425.02b, E-425.02c | unit | that a real `cargo` ran (02a, 02d–02f) |
| D9 | E-433 | a launch record's tmux socket and pane are read back and used | `waiting-signal.test.mjs` "E-433.09: under the pinned PATH the recorded tmux receives the call" (`-S ${SOCK}`) | `tests/suites/role_token_test.sh` E-433.R01b | unit | `tmux-target` printed directly |
| D10 | E-433 | an invalid tmux pair (relative socket, bad pane) gives no target | `waiting-signal.test.mjs` "E-433.02: the hook prints nothing … a bad record" (targets `["relative.sock", PANE]`, `[SOCK, "%x"]`) | `role_token_test.sh` E-433.R01c | unit | none: R01c drives `launch-record.py` directly |
| D11 | E-430 / E-429 | `digest-build check` is fresh after a build that follows a state change | `tests/fixtures/digest-cases.json` "E-429.03 check is stale after a task closes without a rebuild, fresh after build" | `tests/suites/hooks_surface_test.sh` E-430.S01b | unit | none: S01a (the hook rebuilt) is the suite's own claim |
| D12 | E-430 / E-429 | a build on an unchanged tree leaves `.ai/` clean | `digest-cases.json` "E-429.01 a second build on an unchanged tree prints [DIGEST_OK] and leaves git status clean" | `hooks_surface_test.sh` E-430.S01c | unit | that the hook calls the builder |
| D13 | E-430 / E-429 | a symlinked `DIGEST.md` is refused | `digest-cases.json` "E-429.05 a symlinked DIGEST.md is refused and left untouched" | `hooks_surface_test.sh` E-430.S01d | unit | the hook's `[DIGEST_BUILD_FAILED]` context line |
| D14 | E-428 | CAPABILITIES_BYPASS flags a traversal literal in a `src/` file | `tests/unit/traversal-policy.test.mjs` "aligner flags: E-428.02 the same literal in src/ still blocks" | `tests/suites/mcp_servers_test.sh` "E-55: literal cat ../../etc/passwd in .js still flagged" | unit | none: since E-428 the suite row calls the same `capabilitiesBypassMatches` through `node -e` |
| D15 | E-428 | CAPABILITIES_BYPASS exempts a test file | `traversal-policy.test.mjs` "aligner allows: E-428.01 …" (4 rows) | `mcp_servers_test.sh` "E-56: ${SCRIPT_DIR}/../lib/assert.sh in tests/suites allowed", "E-56: ${SCRIPT_DIR}/../.. in tests/lib allowed" | unit | none: same function as D14 |

Notes:

- **Origin of D14 and D15.** The suite rows predate D-149. E-428 rewired them to call the shipped function in place of a copy (`mcp_servers_test.sh`, −11 lines). That rewiring is what made them duplicates of the unit table. Every spawn in these rows is `node -e` driving a pure function, which is the blueprint's "move-to-unit" class.
- **Process boundary.** Most of the suite rows (D1, D3, D5, D7, D8, D9, D11–D13) carry a second claim that only the process boundary can observe. The census rule is "one test at the cheapest layer", so the clause that duplicates the unit row is the part to trim. The row itself would stay.

### 1.2 Borderline cases (not counted)

| Task | Behaviour | Unit | Suite | Why not counted |
|---|---|---|---|---|
| E-418 | the generator is deterministic | `release-manifest.test.mjs` "E-418.03" (`buildTarball` twice → same bytes) | `mirror_hygiene_test.sh` E-418.06b (two CLI runs → byte-identical `manifest.json`) | the two rows check different objects: the tarball bytes, and `manifest.json` from a real tree |
| E-420 | a changed byte in an unpacked file is found | `release-manifest.test.mjs` "E-420.04" (a tampered file stops the mode fix) | `mirror_hygiene_test.sh` E-420.02a–02c | the unit row observes the mismatch only indirectly; only the suite asserts the finding |
| E-426 | the shipped lock's bytes equal the manifest's sha256 | generic per-file sha256 in "E-418.03"/"E-418.04" | `mirror_hygiene_test.sh` E-426.01e | the suite row pins one specific file after `npm ci`, which is a process claim |

### 1.3 Same-layer duplicates (outside E-435's question; for completeness)

- `doctor --json` in `rein help`: `init_upgrade_test.sh` E-421.01e, and `cli_test.sh` E-422.03a, which covers `doctor` `--json` through `tests/fixtures/release/cli-surface.json`.
- Every record has a valid scope: `init_upgrade_test.sh` E-427.02a, and E-422.02a, whose schema validation requires `scope`.

No duplicates were found for E-417, E-419, E-419b, E-423, E-424, E-426 (the gate-pins row is about lock contents, not install), E-434 (suite only) or E-429's doctor fix (no test lines).

---

## 2. test_lines between D-157 and D-162

### Method

- **How test_lines is counted.** I used the census formula, `tests/tools/census.mjs` `inventory()`: the number of `\n` bytes in every file under `tests/`, except `tests/census-baseline.tsv` (E-386). `rein ci run` writes this into the run's `budget_json`. `rein ci budget` prints `budgetBest()` (`src/mcp/shared/ci-budget.js`): the minimum over green, clean runs from the last row that carries a ruling. `budget set` writes the ruled value over the latest green run's `budget_json` (`budgetSet`).
- **My script.** I applied the same formula to git trees (`git ls-tree` plus `git cat-file`). It reproduces the CI-recorded values wherever a run measured a clean tree: 653d548 = 43602, 3b52957 = 44038, 878445a = 44476, ff6b511 = 44481, fd1696b = 44144, 120e539 = 45078. Per-commit deltas are taken along `--first-parent`.
- **Today's `rein ci budget`.** It prints the following line, and no measured value:
  `test budget: suites 45, test_lines 44144, … — ruled by D-162 at ce1d431`
  "Measured on main" is therefore taken from the CI record for main: `ci_runs` id 97, sha 3994640, branch main, PASS, test_lines 43922. 3fb9253, the current `main`, adds only `.ai/` changes (#48), and the formula gives 43922 there too.

### 2.1 The two recorded values

| Ruling | Recorded value | ci_runs row it was written on | Tree it measures |
|---|---|---|---|
| D-157 | 43602 | id 81, 9eae996 (e-421-doctor-json) | E-422 tree with main merged, 653d548 (measured 43602 in run 83) |
| D-162 | **44481** | id 102, ce1d431 (e-428-traversal-test-exemption) | E-433 tree ff6b511 (measured 44481 in runs 105/106). D-162's text expected 44476, which is 878445a; b2cc602 then added 5 lines, and the measured 44481 was used, as D-162 r1 allows. |

### 2.2 Net test lines per task (git log evidence)

**(a) Merged to main after D-157 (from 653d548 to 3fb9253):**

| Task | Merge | Net test lines | Files |
|---|---|---|---|
| E-422 (rest after the D-157 tree) | d84dd17 (#39) | +4 | `fixtures/release/operator-owned-cases.json` (30b9e52) |
| E-425 | 60e0537 (#40) | +107 | `rein_ci_test.sh` +62, `ci-runs.test.mjs` +24, `ci-summary-cases.json` +20, `ci-summary.test.mjs` +1 |
| E-426 | f7b3554 (#41) | +68 | `mirror_hygiene_test.sh` +51, `gate-pins.test.mjs` +17 |
| E-427 | cac86a4 (#42) | +63 | `mirror_hygiene_test.sh` +23, `init_upgrade_test.sh` +22, `doctor-json.test.mjs` +18 (`doctor-sample.json` 73/73, net 0) |
| E-419 | a67bc1d (#43) | +78 | `release-manifest.test.mjs` +74, `throwaway.key` +2, `throwaway.pub` +2 |
| E-424 | 32b4930 (#45) | 0 | none |
| E-419b | 3994640 (#46) | 0 | none |
| chore (task index) | 3fb9253 (#48) | 0 | `.ai/` only |
| **Subtotal** | | **+320** | 43602 → 43922 |

**(b) Inside D-162's value but not yet on main (from 3fb9253 to ff6b511):**

| Task | Commits | Net test lines | Files |
|---|---|---|---|
| E-428 | 1c4b16e, 35bf126 | +42 | `traversal-policy.test.mjs` +35, `traversal-file-cases.json` +18, `mcp_servers_test.sh` −11 |
| E-429 | 9ccd5a0 (1f35b0f: 0) | +180 | `digest-build.test.mjs` +99, `digest-cases.json` +80, `release/cli-surface.json` +1 |
| E-433 | d71bc61 +254, b23d5eb +25, 878445a +53, b2cc602 +5 | +337 | `waiting-signal.test.mjs` +261, `exec_form_hooks_test.sh` +31, `waiting-signal-cases.json` +24, `role_token_test.sh` +11, `release/pane-options.json` +10 |
| **Subtotal** | | **+559** | 43922 → 44481 (matches D-162's "net +559") |

**Total D-157 → D-162: +320 + 559 = +879 = 44481 − 43602. Gap: 0.**

### 2.3 The two "recorded" values that were not set by a ruling

The ratchet takes the minimum over green runs since the ruling row. Twice, a branch that did not yet carry other tasks' rows measured lower than the ruled value and lowered the recorded figure:

| Printed as recorded | Source run | Tree | Reconciliation |
|---|---|---|---|
| 43381 (the "recorded" in D-162's text) | id 85, d916614, e-425-cargo-step | E-425's first commit on f11d270, which was `main` before E-422 merged | f11d270 = 43298, plus d916614's own +83 = 43381 |
| **44144** (printed by `rein ci budget` today, and the "recorded" in D-164) | id 107, fd1696b, e-429-digest-builder | main + E-428 + E-429, without E-433 | 43922 + 42 + 180 = 44144 |

So the 44144 that the D-164 request is measured against is not a ruled value. It lies 337 lines (exactly E-433's rows) below the 44481 that D-162 ruled. Against the ruled value, E-438's tree (45078) is +597 and within the 2 % limit (45370). Against the ratcheted 44144 it is +934, over the 45026 limit. I report this and do not judge it; the ratchet behaved as `budgetBest()` is written.

---

## 3. D-164 r2's added table

### 3a. The gate arc not on main: net test lines per task against main

**Method.** The same census formula, applied along `--first-parent` between consecutive branch tips: main 3fb9253 → e-430-digest-triggers bf5de9f → e-437-migration-schema-line 0f110ec → e-393-gate-lock 9fc384c → e-353-safe-exec-residuals c0ff540 → e-438-git-verb-base a047f8c. Only `tests/` is counted, and `tests/census-baseline.tsv` is excluded, so f58eb7f counts 0.

| Task | Commits | Net test lines | Files |
|---|---|---|---|
| E-436 | e6d3320 | +32 | `waiting-signal.test.mjs` +21, `rein_start_test.sh` +10, `waiting-signal-cases.json` +1 |
| E-437 | 5db23ec | 0 | none |
| E-393 | b5db31e +266, 0e64eb8 +4, 9b0d305 +2, b5188c9 +2 | +274 | `gate-self-disable-cases.json` +196, `gate_override_test.sh` +61 then −17, `gate-self-disable-cases.test.mjs` +4 +19 +2, `consolidation-subset.test.mjs` +4, `rename-gate.test.mjs` +3, `rename-map.json` +2 |
| E-353 | 43eec4f | +100 | `operand-scope-cases.json` +62, `pipe-shell-cases.json` +20, `block-rules-cases.json` +18 |
| E-438 | 120e539 (f58eb7f: 0, baseline excluded) | +79 | `operand-scope-cases.json` +79 (one line per row) |
| **Gate arc subtotal** | | **+485** | 44593 → 45078 |

For the whole stack over main, the tasks below e-430's tip are E-428 +42, E-429 +180, E-433 +337, E-434 +69 (`rein_start_test.sh`) and E-430 +43 (`hooks_surface_test.sh` +44, `build-stamp.test.mjs` +7, `rein_sync_test.sh` +1, `agent_contracts_test.sh` −6, `task_synchronizer_test.sh` −2, `orchestrator_dispatch_test.sh` −1). Adding the gate arc gives 671 + 485 = **+1156** = 45078 − 43922, gap 0. Measured against the recorded 44144, E-438's 45078 is +934. Of that, 337 is E-433's (§2.3), 69 E-434's, 43 E-430's and 485 the gate arc's.

### 3b. Rows that reach the same verdict through the same branch of the same reader

**Method.** I ran each row through `runAnalysis` (the function both table runners call), in a throwaway HOME and cwd built as the runner builds them. All 225 and all 79 verdicts match the tables (0 mismatches). For each row I then traced the branch that decides the verdict, using two scripts outside the repository:

- `the session's scratchpad` (with `gateclass2.mjs` and `gg-trace.mjs`). `gg-trace.mjs` is a copy of `gate-guard.mjs` with trace points added and no logic changed.
- `the session's scratchpad` and `gitgroup.mjs`. They contain an instrumented copy of `views()` from `git-view.mjs`, with the same logic.

**Row ids.** Row ids are 0-based array indexes (`#n`). Where a gate row's label ends in a tag such as `[P04]`, the tag is shown. Labels in the gate table are not unique: 21 rows share the E-291.05f label and 45 share the E-393 F1-F8 label.

#### 3b.1 `tests/fixtures/gate-self-disable-cases.json` (225 rows: 179 BLOCK, 46 pass; role engineer throughout)

**Order of the readers.** `selfDisableHits` evaluates `namesGateOff`, the three-word predicate, first and returns as soon as it is true. Only when it is false are the name rules read: first on the raw (heredoc-stripped) text, then on V1. Within the name rules the order is: the CLI regex, then the frozen word reader `gateCommandHit`, then the override-file name, then the write rules.

**Branches.**
- For `namesGateOff`, the branch is which view holds the three words on one line: V1, V2 or both.
- For the name rules, the branch is the first rule that fires, and whether it fired on the raw text or on V1.
- For pass rows, the branch is the reason every reader declines.

**Groups with more than one row (13 groups, 220 rows):**

| Group | Rows | Verdict | Reader and branch | Row ids |
|---|---|---|---|---|
| G-A | 143 | BLOCK | `namesGateOff`, three words on one line of **V1 and V2**, single-line text | #0 #4–#13 #22 #29 #30 #32 #33 #35–#55 #67–#82 #89–#92 #96 #97 #100–#103 #105 #107–#130 #132–#137 #144[O12] #145[R01] #148[R06] #149[R07] #150[R08] #151[N40] #152[N41] #153[N45] #156[C03] #160[P04] #161[P05] #165[P09]–#171[P15] #173[P17] #174[P18] #176[P20]–#190[P34] #192[P36]–#194[P38] #196[P40]–#204[Q08] #206[Q11] #207[OB10] |
| G-B | 25 | pass | every reader declines: fewer than two of the three words in either view, and no name rule fires | #21 #24–#28 #58 #59 #62–#64 #83–#86 #141 #142 #146[R02] #147[R03] #162[P06] #163[P07] #164[P08] #210[OB13] #213[OB16] #216[OB19] |
| G-C | 16 | pass | every reader declines: two of the words named, the third absent, and no name rule fires | #23 #60 #61 #65 #66 #138–#140 #143 #172[P16] #175[P19] #209[OB12] #211[OB14] #212[OB15] #214[OB17] #215[OB18] |
| G-D | 7 | BLOCK | `namesGateOff`, V1 and V2, **multi-line** text (the per-line split decides) | #94 #157[P01] #158[P02] #159[P03] #217[OB20] #218[OB21] #220[addendum-bsnl] |
| G-E | 6 | BLOCK | `namesGateOff`, **V1 only**, single line | #14 #31 #34 #93 #98 #131 |
| G-F | 4 | BLOCK | name rule on raw: the frozen word reader `gateCommandHit`, plain program word (no wrapper or re-read) | #87 #88 #99 #195[P39] |
| G-G | 4 | pass | the three words only inside an inert heredoc body, which is stripped before the views | #208[OB11] #222[D01] #223[D02] #224[D03] |
| G-H | 3 | BLOCK | name rule on raw: `CLI_GATE` regex | #1 #56 #57 |
| G-I | 3 | BLOCK | name rule on raw: `CD_INTO` plus a write after entering | #15 #16 #20 |
| G-J | 3 | BLOCK | `namesGateOff`, **V1 only**, multi-line | #95 #205[Q09] #221 |
| G-K | 2 | BLOCK | name rule on raw: `DASH_C_INTO` | #17 #18 |
| G-L | 2 | BLOCK | `namesGateOff`, **V2 only** | #106 #191[P35] |
| G-M | 2 | BLOCK | name rule on **V1**: override-file name (D-163 r6) | #154[N51] #155[N52] |

**Single-row branches (5):**
- #2: override-file name on raw.
- #3: `WRITE_VERB`.
- #19: `REDIRECT_INTO`.
- #104: the word reader through `env -S` (split string, re-read).
- #219[addendum-split-lines] (pass): all three words present, but not on one line of either view.

**What G-A would hit without the predicate.** These rows are decided by `namesGateOff`, so the reader each was written for never runs in the verdict. The breakdown below says which reader each row would reach first if the predicate were absent; I report it so a merge can keep one row per shadowed branch:

| If the predicate were absent, the row would reach first | Rows | Row ids |
|---|---|---|
| nothing (only the predicate blocks it) | 26 | #22 #137 #145[R01] #148[R06] #149[R07] #150[R08] #151[N40] #152[N41] #153[N45] #161[P05] #165[P09]–#171[P15] #176[P20] #178[P22]–#183[P27] #186[P30] #207[OB10] |
| `CLI_GATE` regex on raw | 22 | #0 #4–#13 #40 #45–#47 #54 #118 #126 #134 #136 #156[C03] #196[P40] |
| `CLI_GATE` regex on V1 | 3 | #160[P04] #173[P17] #174[P18] |
| word reader, plain program word | 22 | #29 #30 #32 #33 #35 #55 #89 #91 #96 #97 #107–#111 #114 #119 #194[P38] #197[Q01] #201[Q05] #202[Q06] #206[Q11] |
| word reader, a pipe into a shell reading stdin (`… \| bash`, `\| sh`; #185, #189 and #193 also pass through `env`, `nice` or `xargs`) | 10 | #184[P28] #185[P29] #187[P31] #188[P32] #189[P33] #192[P36] #193[P37] #198[Q02] #199[Q03] #204[Q08] |
| word reader, a here-string into a shell | 4 | #112 #113 #190[P34] #200[Q04] |
| word reader, a re-read program string (`bash -c`, `script -c`, `su -c`, `env … script`, `flock … -c`, `ssh … '…'`) | 16 | #51 #53 #71–#73 #82 #90 #100 #101 #120–#123 #135 #177[P21] #203[Q07] |
| word reader, a wrapper and its flags skipped | 37 | env: #36 #49 #92 #102 #103; taskset: #68 #69 #125; sudo: #38 #117; timeout: #48 #116; ionice: #67 #124; watch: #70 #132; nice #37, stdbuf #39, flock #41, exec #42, command #43, time #44, xargs #52, script #74, strace #75, doas #76, unshare #77, chronic #78, chrt #79, faketime #80, runuser #81, eatmydata #127, ssh #128, systemd-run #130, setsid #144[O12]; chains: #50 (env+nice+sudo), #133 (env+nice+nohup+setsid+stdbuf+timeout) |
| word reader, `find -exec` | 1 | #115 |
| word reader, `env -S` split string | 1 | #105 |
| word reader, `at` reading stdin from a pipe | 1 | #129 |

Each row is in exactly one line of this breakdown, and the lines sum to 143 (26 + 22 + 3 + 22 + 10 + 4 + 16 + 37 + 1 + 1 + 1). A row that combines features is placed by its most specific one: a pipe or here-string before a re-read, and a re-read before a plain wrapper. The G-D, G-E, G-J and G-L rows have their own shadowed branches. They are left out here because they are already separate groups.

#### 3b.2 The rows E-438 added to `tests/fixtures/operand-scope-cases.json` (79 rows, #438–#516: 58 BLOCK, 21 pass)

**Branches recorded per row (reader: `src/mcp/safe-exec-mcp/git-view.mjs`):**
- the option class on the path from `git` to the verb: none, space-valued set, `=` option, unknown option (two candidates, and which one hit), or a `$`/backtick word;
- the verb's spelling: plain, quoted, ANSI-C `$'…'`, or locale `$"…"`, plus whether the `git` word itself is quoted;
- whether the redirect-drop is needed, meaning the row fails with the drop removed;
- which views catch the row: SC (`shellCommands`), CUT1 (the cut on `; | & newline`), CUT2 (the cut that also splits on `( )` and backticks);
- whether the verb comes from the assigned-verb expansion;
- for reset and checkout, `gitRelocated` or the `..` rejection in `isSafeArchitectPath` (`architect-writes.mjs`).

**Groups with more than one row (12 groups, 55 rows):**

| Group | Rows | Verdict (rule) | Branch | Row ids |
|---|---|---|---|---|
| E1 | 13 | BLOCK (ARCH_GIT_PUSH) | unknown option, the +1 candidate is the verb; plain verb; SC+CUT1+CUT2 | #455 `-p`, #456 `-P`, #457 `--paginate`, #458 `--no-pager`, #459 `--bare`, #460 `--no-replace-objects`, #461 `--literal-pathspecs`, #462 `--no-optional-locks`, #470 `--glob-pathspecs`, #471 `--noglob-pathspecs`, #472 `--icase-pathspecs`, #473 `--no-lazy-fetch`, #474 `--no-advice` |
| E2 | 7 | BLOCK (ARCH_GIT_PUSH) | space-valued option; plain verb; SC+CUT1+CUT2 | #439 `-C .`, #444 `-c a.b=c`, #450 `--namespace x`, #452 `--exec-path /x`, #454 `--config-env a.b=C`, #476 `--attr-source HEAD`, #477 `--super-prefix x` |
| E3 | 6 | pass (architect) | the candidate after a space-valued option is a plain word that is not a forbidden verb | #467 `-C . log`, #469 `-C . commit -m "push later"`, #487 `-C .. log`, #505 `push{,}` (residual), #515 spaced `{fd}` (boundary), #516 `{a,b}` (boundary) |
| E4 | 5 | BLOCK (ARCH_GIT_PUSH) | space-valued option; **redirect-drop needed**; CUT1+CUT2 (SC is blinded by the apostrophe) | #508 `-C .>x`, #511 `{fd}>f`, #512 `{fd}<f`, #513 `{fd}>&-`, #514 `{fd}>>f` |
| E5 | 5 | pass (engineer) | role: the git rules are Architect-only, so `analyzeSovereignty` does not run | #463 #464 #465 #466 #489 |
| E6 | 4 | BLOCK (ARCH_GIT_PUSH) | `=` option; plain verb; SC+CUT1+CUT2 | #449 `--namespace=x`, #451 `--exec-path=/x`, #453 `--config-env=a.b=C`, #475 `--attr-source=HEAD` |
| E7 | 3 | BLOCK (ARCH_GIT_CHECKOUT) | space-valued option, then `gitRelocated` lifts the `.ai/` exemption; SC+CUT1+CUT2 | #482 `-C /tmp/other`, #483 `-C ..`, #485 `-c core.worktree=/tmp/o` |
| E8 | 3 | BLOCK (ARCH_GIT_PUSH) | space-valued option; the redirect is glued after the verb (the word ends at `<`/`>`, so no drop is needed); CUT1+CUT2 (SC blinded) | #501 `push>/dev/null`, #503 `push<x`, #504 `push>&2` after a heredoc apostrophe |
| E9 | 3 | pass (architect) | the candidates after an unknown option are not forbidden verbs | #468 `--no-pager diff`, #488 `--no-advice status`, #497 `--no-pager log --oneline -- push.md` |
| E10 | 2 | BLOCK (ARCH_GIT_PUSH) | space-valued option; plain verb; CUT1+CUT2 only (an apostrophe in a comment or heredoc blinds SC) | #478 (comment), #479 (heredoc body) |
| E11 | 2 | BLOCK (ARCH_GIT_PUSH) | no option; ANSI-C verb decoded; SC+CUT1+CUT2 | #490 `$'push'`, #495 `$'\x70ush'` |
| E12 | 2 | pass (architect) | checkout with no option; every target under `.ai/`; `gitRelocated` false (scopedSafe). Both rows are the `cd` residual (E-441). | #499 #500 |

**Single-row branches (24).** Each is the only row for its combination:

| Row | Branch |
|---|---|
| #438 | quoted `git` word, no option |
| #440 | quoted `git`, through the assigned-verb expansion |
| #441 | space-valued option, through the assigned-verb expansion |
| #442 | reset: quoted `git`, no target |
| #443 | reset: space-valued option, no target |
| #445 | `--git-dir=` (`=` option); also ARCH_GIT_DIR_OVERRIDE; the raw regex also hits via `.git push` |
| #446 | `--git-dir` (space-valued); also ARCH_GIT_DIR_OVERRIDE; the raw regex also hits |
| #447 | `--work-tree=` (`=` option); also ARCH_GIT_DIR_OVERRIDE |
| #448 | `--work-tree` (space-valued); also ARCH_GIT_DIR_OVERRIDE |
| #480 | space-valued option; CUT2 only (a paren in a quoted substitution) |
| #481 | `${A:+-C .}`, a `$` word |
| #484 | reset after `gitRelocated` |
| #486 (pass) | checkout after `-C .`, scopedSafe |
| #491 | ANSI-C verb after a space-valued option |
| #492 | ANSI-C reset, no target |
| #493 | ANSI-C verb through the assigned-verb expansion |
| #494 | locale `$"push"` |
| #496 | `..` rejection in `isSafeArchitectPath`; the raw regex also hits |
| #498 | unknown option, the +2 candidate after a second unknown (`grep -n push`) |
| #502 | quoted verb glued to a redirect, CUT1+CUT2 |
| #506 | backtick word, then `$` word; CUT1 only |
| #507 | `$( )` word, then space-valued; CUT1 only |
| #509 | no option; redirect-drop needed (`git >x push`) |
| #510 | unknown option; fd redirect-drop needed (`2>/dev/null`) |

---

## Could not determine, or determined only partly

- **The "measured value on main" in `rein ci budget`.** The command prints only the recorded (ratcheted) value. The measured value on main is taken from `ci_runs` id 97 (main, 3994640, 43922) and confirmed by the census formula on 3fb9253 (43922). No `rein ci run` was made on main today; this task does not order one.
- **Whether a duplicate is "the same behaviour".** In Table 1 this is a reading of the assertions. The process-boundary clause each suite row adds is named, so the Architect can draw the line differently.
- **The "shadowed" reader for G-A.** I found it by running the name rules with the predicate skipped, from an instrumented copy of `gate-guard.mjs` in the scratchpad. The copy's logic is unchanged, but it is not the shipped file. The primary grouping (G-A to G-M) uses only the shipped modules plus the exported regexes from that copy.
