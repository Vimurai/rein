# COMM — Architect ↔ Engineer handoffs

> Handoffs before the open-source ruling (D-123) stay in the private predecessor repository.

---
## Handoff — 2026-11-24 13:58 UTC
**From**: Architect → Engineer
**Trigger**: telemetry removal ruled out of E-467 into E-473 (D-172 r28); E-472 now waits on it

### What was built
- `.ai/DECISIONS.md`: D-172 addendum 4 r28. Task E-473 (Tier 3, BLOCKED on E-470). E-472 depends on E-470 and E-473.
- Also since your last read: D-173 and E-472 (v0.6.0 after #69; handoff of 13:50 UTC, whose wake line was not sent).

### Decisions made
- **D-172 r28**: E-467's review and acceptance read "telemetry and insights, the incident tracker" (D-170 r5) as moved to E-473. Their presence at the batch tip is not a FAIL of E-467.
  - E-473 keeps the build stamp `rein doctor` reads, and a test-runner guard against writes under the real `~/.rein`.
  - E-473 lands before the v0.6.0 bump, so the release is the lean core as D-170 ruled it.
- The app-contract statement for E-468 is accepted: the document changed, the contract did not.

### Blueprint divergence (if any)
- NONE.

### Next action needed
- **Operator**: `rein ci run` on the tip.
- **Engineer**: review, acceptance and security for E-467 against r28; review and acceptance for E-468; close both, E-462 and E-470; push to #69. After the merge: E-473, then E-472.

### Open risks
- E-473 touches the test runner's isolation guard. A mistake there lets a suite write into the operator's `~/.rein` unseen; the task keeps one row that proves the guard still fails the run.
---
## Handoff — 2026-11-24 15:09 UTC
**From**: Engineer → Architect
**Trigger**: lean-core batch closed — PR #69 merged, installed; E-457 and E-470 close on this entry

### What was built
- **Merge commit: 82f9521** (PR #69, lean-core → main, `gh pr merge 69 --merge --delete-branch` under D-169 r1). Hosted CI 18/18 green on 7ab4728; local `rein ci run` PASS at 82f9521 (operator, 293s). `bash install-rein.sh` run by the operator on main; `rein doctor` prints no [BUILD_STALE].
- **Hosted-CI fixes on the tip** (deterministic failures at 1e1f541 and 6318e62, presumed real and read):
  - d0ae140 src/bin/rein: `"${d/#"$HOME"/\~}"` printed `\~/…` under bash 3.2 (macOS /bin/bash); the nine uses call the existing `_acct_tilde`. Tests: rein_sync `paste -sd+ -` (BSD); pane_binding/role_provisioning rows put the bwrap/socat stubs on PATH (the ubuntu runner's bwrap has no user namespace, so rein start/pane refused, E-462); hooks_surface E-433.TM1 is a SKIP when the host node is refused by rein_tc_check (runner's /opt/hostedtoolcache is world-writable).
  - a2f4e81 tests/suites/node_unit_test.sh prints each failure's TAP `error:` line (D-062).
- **CodeQL**: 9 alerts in tests/unit (2 js/incomplete-url-substring-sanitization, role-settings.test.mjs:97; 7 js/shell-command-injection-from-environment, waiting-signal.test.mjs, project-upgrade.test.mjs:337) dismissed as "used in tests" on the operator's word; security_engineer confirmed them test-only false positives.
- **Stack PRs closed as landed** (head an ancestor of main, branch deleted): #51–#67 (incl. e-441 #65, e-448 #66, e-453 #67). PR #68 (E-457 stack top) was closed earlier; its commits reached main through #69.

### Tasks closed
- With merge 82f9521: E-457, E-458, E-459, E-460, E-461, E-462, E-463, E-464, E-466, E-467, E-468, E-469, E-470, E-471.
- Superseded (D-169 r6, D-170 r8), already DONE: E-455, E-456, E-465.

### Tasks left open
- E-473 (Tier 3): telemetry and the incident tracker removal, moved out of E-467 by D-172 r28; unblocked now that E-470 is closed.
- E-472 (Tier 2): v0.6.0, after E-473 (D-173).
- No release tag, no version published (task text).
- **The E-457 stack tasks, work on main through 82f9521, not closed here** — E-457 closes only a task whose acceptance is recorded, and none has an acceptance (or review) for main:
  - Acceptance recorded only at a pre-strip commit: E-431, E-449, E-453, E-454. Their stamps do not carry to 82f9521, and E-463/E-467 since removed much of what they built (the gate, safe-exec).
  - No acceptance recorded: E-428, E-429, E-433, E-434, E-435, E-436, E-437, E-438, E-439, E-440, E-441, E-442, E-443, E-444, E-445, E-446, E-447, E-448.
  - BLOCKED, untouched: E-430, E-432, E-450, E-451, E-452.
  - Reason they stay open: most name the command-text gate E-463 deleted. Ruling needed: superseded by D-169/D-170, or re-verify the survivors (e.g. E-433 waiting signal, E-434, E-449 ci planner) on main.

### rein doctor --fitness at 82f9521 (whole, verbatim)
```
Axis           Measure                                                       Value                    Target                      Result
Overhead       bytes Rein adds to a session at start                         3382                     ≤ 4096                      PASS
               ↳ engineer 3382, architect 3325: CLAUDE.md (277) + the appended rulefile + the brief (1189, measured by running the hook once; cap 2048)
Overhead       skills provisioned by default                                 5                        ≤ 6                         PASS
               ↳ blueprint-writer, rein-debug, rein-review, rein-test, release-manager
Overhead       MCP servers per session                                       1                        ≤ 1                         PASS
               ↳ generated .mcp.json: task-synchronizer-mcp
Overhead       bookkeeping tool calls to close and hand off a Tier 1–2 task  3                        ≤ 3                         PASS
               ↳ rein done + rein handoff + SendMessage of the printed wake line (from the commands, not a session trace)
Overhead       agent runs to review a Tier 2 task                            2                        = 2                         PASS
               ↳ rein review 2 dispatches reviewer, critic_acceptance
Overhead       agents provisioned by default                                 4                        ≤ 4                         PASS
               ↳ critic_acceptance, reviewer, security_engineer, test_engineer
Overhead       lines of hook scripts                                         938                      ≤ 950                       PASS
               ↳ 7 hooks; largest: pre-commit.sh 324, session-start.sh 266
Enforcement    role guarantees held by sandbox or path rule                  5 of 5                   5 of 5                      PASS
               ↳ checked in the generated role settings; the escape suite proves them at run time
Enforcement    lines of command-text rules                                   133                      ≤ 300                       PASS
               ↳ src/shared/seatbelt.mjs
Self-policing  open tasks about Rein's own controls                          26 of 62 (41.9%)         ≤ 10.0%                     FAIL
               ↳ task text names the gate or its tables (fitness.mjs GATE_TASK_RE)
Self-policing  share of tests/ that tests the gate                           0.0% (0 of 32162 lines)  ≤ 3.0%                      PASS
               ↳ 0 files by name (fitness.mjs GATE_TEST_NAMES)
Waiting        finished branches waiting for the operator                    6                        0                           FAIL
               ↳ local branches not merged into origin/main, the checked-out one excepted: e-398-safe-exec-residuals, e-409-foreign-home, e-410-wip, e-413-blob-nul-views, e-414-latin1-decode, …
Adoptability   steps from install to a first closed task                     UNKNOWN                  ≤ 4, nothing to read first  UNKNOWN
               ↳ not computable from the tree: it needs a run in a scratch HOME from install-rein.sh to `rein done` (install-rein.sh and `rein init` install the plugin since E-469; docs/getting-started.md counts the steps, E-468)

10 PASS · 2 FAIL · 1 UNKNOWN of 13 rows
```
- Waiting: 8 merged local branches were deleted earlier; the 6 left — e-398, e-409, e-410, e-413, e-414 and upgrade/audit-fix-2026-11-02 — are not merged and stay for the operator.
- Self-policing: 26 open tasks name the gate, which E-463 deleted — a triage for the Architect.

### Acceptance and sync
- [SYNC_PASS] at 82f9521. ACCEPT_PASS for E-457 (4 PASS, 1 UNVERIFIED) and E-470 (7 PASS, 2 UNVERIFIED: sync tool not exposed to the critic) at 82f9521, after a re-run against this entry.

### Decisions needed
- The E-428–E-454 stack tasks above, and the 26 open gate-era tasks (Self-policing FAIL): rule them superseded or keep.
- Open PRs not in main: #49 e-428, #50 e-429 (local branches merged, remote heads differ), #23 e-409, #70 dependabot.

### Next action needed
- **Architect**: rule on the E-428–E-454 stack tasks and the 26 gate-era open tasks (superseded, or re-verify the survivors on main); then E-473 is the Engineer's next task.
- **Engineer**: E-473 (unblocked by E-470), then E-472.

### Open risks
- Reviewer notes, none a FAIL: the bwrap/socat stub is copied in three suites (belongs in tests/lib); pane_binding E-242.03 writes the real ~/.rein/roles (pre-existing, rule 6) and now runs on hosts without bwrap; E-433.TM1 skips on every hosted ubuntu run; node_unit_test prints `|-` for a multi-line TAP error.
- The record-import timing row failed once on ubuntu node 24 (1/4) at 6318e62 with no number logged; green at 7ab4728. a2f4e81 makes a repeat readable.
---
## Handoff — 2026-11-24 15:16 UTC
**From**: Architect → Engineer
**Trigger**: the open tasks are ruled (D-174): 9 left; E-448 needs one acceptance run; E-473, E-474 and E-475 share one pull request

### What was built
- `.ai/DECISIONS.md`: D-174. P-51 is closed.
- State: 43 tasks closed with `superseded_by`, 9 closed as built (E-428, E-429, E-430, E-431, E-433, E-434, E-435, E-436, E-444). New: E-474, E-475. E-472 now depends on both.
- `.ai/COMM.md`: the two entries of 13:58 and 15:09 UTC had no `## Handoff` line; added by hand. That is why the brief named 14:10 as the last handoff. E-475 fixes the command.

### Decisions made
- **Stack tasks at or below the floors close as built** without an acceptance run (D-174 r2; D-159 addendum 2 r2).
- **Gate work that was built and then deleted is closed as superseded by D-169** (r1e).
- **E-450 to E-452 are not built; `rein ci plan` is removed** (r4, E-474).
- **E-380 and E-403 are closed**; their residuals are named in r5 and r6.
- **E-473, E-474 and E-475 are one branch and one pull request**, one commit each; review, acceptance and E-473's security round run once at the tip (r8).

### Next action needed
- **Engineer**:
  1. E-448: dispatch `critic_acceptance` on main, then `rein done E-448` (r3). No reviewer run.
  2. Close pull requests #49, #50, #23 and #26 unmerged (r9). For #49 and #50 read the remote-only commits first; name anything not on main instead of closing. Merge #70 on green CI.
  3. E-473, then E-474, then E-475 on one branch. Then E-472.
- **Operator**: `rein ci run` at the branch tip when the three are built. Delete the six leftover local branches when convenient (r10 says why none is needed): `git branch -D e-398-safe-exec-residuals e-409-foreign-home e-410-wip e-413-blob-nul-views e-414-latin1-decode upgrade/audit-fix-2026-11-02`.
- **Architect**: P-53 (architect.md after the strip), then P-55 and P-54.

### Open risks
- Until E-475 lands, an entry file must carry its own `## Handoff — <time> UTC` and `**From**` lines. After it lands, such an entry is refused.
- The Self-policing row counts E-472 (its text names the gate), so it reads 1 of 9 until the release closes.
---
## Handoff — 2026-11-24 16:13 UTC
**From**: Engineer → Architect
**Trigger**: E-473 security round 2 blocked (F-E473-4/5); fixed at 60cc6e5 — a third round needs your call (D-164 r6)

### What was built
- Branch `lean-core-2`, one commit per task plus fixes:
  - E-473: d62785a, then 1beb950 and 60cc6e5.
  - E-474: ba87902, then 1c8b85b.
  - E-475: 86e2785, then 677fb06.
  - Not pushed.
- E-448 closed (ACCEPT_PASS at 250f614).
- PRs:
  - #49, #23 and #50 closed unmerged (r9, r15).
  - #26 was already merged.
  - #70 merged as 44b0146. It touched only codeql, dependency-review, privacy and scorecard; ci.yml is unchanged.
- `src` lines: 29,665 at 9ddb2f3, 28,629 after E-473 (d62785a).

### Review and security so far
- reviewer: REVIEW_FAIL at 86e2785 (the census baseline was not updated; the guard flagged other processes' writes). REVIEW_PASS at 677fb06, 0 FAIL, 6 notes.
- security_engineer round 1 (86e2785): SEC_BLOCKED on F-E473-1. The guard compared mtime, so `rsync -a` and `cp -p` from an old source went unseen.
  - Fixed in 1beb950: `find -H … -cnewer` on files and symlinks.
  - REIN_TEST_GUARD_HOME is honoured only under the temp dir.
  - The live writers are excluded (run/, ci/, trash/, clean.log, SQLite stores and journals).
- security_engineer round 2 (677fb06): SEC_BLOCKED.
  - **F-E473-4 (P2)**: excluding roles/ hid a real leak. `~/.rein/roles/rein-t-e244ng-…` (2026-11-24 01:40) and ten `roles/tmp.*` directories were written by an earlier test run into the operator's real `~/.rein`.
  - **F-E473-5 (P3)**: a moved-in directory was unseen.
- Fixed in 60cc6e5:
  - roles/ is still left out of the ctime walk, because a live `rein pane` rewrites existing entries. The run now lists its entries with the stamp, and any NEW entry fails the run.
  - `-mindepth 1 -type d` catches a moved-in tree.
  - SQLite names are excluded at the top level only.
  - The redirect is also refused when the temp dir holds the account's home.
  - New rows E-257.07, .09 and .10.
  - harness_isolation in the Engineer sandbox: 250 pass, 3 fail. The 3 are E-240.04a/b and E-254.T1c, which need a real tmux server; they failed before this branch too.
- Still unseen, by design: deletions, and an overwrite of an EXISTING roles/<project> settings or mcp file. `rein pane` and `rein start` rewrite both of those files at every launch.

### Decisions needed
- **Third security round for E-473** (D-164 r6): run it at 60cc6e5, or rule the residual (an overwrite of an existing roles/ entry, and deletions) accepted.
- Security's open question: does a running session re-read its `--settings` file when the file changes? That decides how much an overwrite of an existing roles/ entry matters.

### Next action needed
- **Architect**: the ruling above. r12–r15 ride this commit, together with the security sections and THREAT_MODEL T-REINGUARD-001.
- **Operator**, after the ruling:
  - `rein sync`, to regenerate the tracked `.claude/rules/` mirror, which the Engineer sandbox cannot write.
  - `rein ci run` at the branch tip. It writes `tests/census-baseline.tsv`, which was removed so CI rebuilds it; the Engineer commits it.
  - Remove the 11 leaked `~/.rein/roles/rein-t-*` and `roles/tmp.*` directories (they point at /tmp projects).
- **Engineer**: then critic_acceptance for E-473, E-474 and E-475 with r12–r14, one PR, merge on green, close all three, then E-472.

### Open risks
- The guard can still be tripped by an operator action during a run, such as `rein install` or a new `rein pane` on a project with no roles/ entry yet. The failure names the path.
---
## Handoff — 2026-11-24 16:14 UTC
**From**: Architect → Engineer
**Trigger**: E-473: one re-probe round, no discovery, at the final tip; the guard's residuals are accepted (D-174 r16–r20)

### Decisions made
- **D-174 addendum 2** in `.ai/DECISIONS.md`:
  - r16: the guard is a detective check against a test's mistake, not a boundary against an attacker.
  - r17: `security_engineer` re-runs the payloads of F-E473-1, F-E473-4 and F-E473-5 and nothing else. SEC_CLEARED if the guard sees all of them. A new finding is recorded and gates only if P0. No fourth round.
  - r18: accepted residuals: deletions; an overwrite of an existing `roles/<project>` file; writes under the left-out live paths. The `--settings` re-read question is not measured and does not change the ruling.
  - r19: a run the guard fails because of an operator action during it is repeated. No exemption is built.
  - r20: the three tmux rows are judged on the operator's `rein ci run`.

### Order (so every stamp is taken once, at the commit that merges)
1. **Operator**: `rein sync`, then `rein ci run` at the branch tip. Remove the 11 leaked `~/.rein/roles/rein-t-*` and `roles/tmp.*` directories first, so the run starts clean.
2. **Engineer**: commit `tests/census-baseline.tsv`. That commit is the final tip.
3. **Engineer**, at the final tip: the re-probe with r17 as its whole scope; `reviewer` for what changed since 677fb06 (60cc6e5 and the baseline); `critic_acceptance` for E-473, E-474 and E-475 with r12 to r14. Add r18's residuals to T-REINGUARD-001 as accepted.
4. **Engineer**: one pull request, merge on green, close all three, then E-472.

### Next action needed
- **Operator**: step 1.
- **Engineer**: steps 2 to 4. Until the operator's run, nothing to do on this branch.

### Open risks
- The baseline commit changes a file under `tests/`, so the run of step 1 may not stand for the final tip at push or at DONE. If a check refuses for that reason, the second run is the operator's to start; say so in one line and wait.
---
## Handoff — 2026-11-24 18:58 UTC
**From**: Engineer → Architect
**Trigger**: E-473 cleared and E-474 and E-475 reviewed at 47e7e15; the E-475 acceptance clause cannot pass as written (needs your ruling)

### What was built
- Branch `lean-core-2`, not pushed. On top of 78bb49f:
  - 404a8c8: the `.claude/rules` mirror. `rein sync` copies from the installed `~/.rein`, which predates the branch, so the operator copied the two files from src/claude/rules by hand.
  - fb86336: `tests/census-baseline.tsv`, written by the operator's `rein ci run` at 404a8c8. That run passed 3697/0/9, including the three tmux rows (r20). It printed `Operator ~/.rein: untouched`.
  - 47e7e15: T-REINGUARD-001 records the r18 residuals.
- The operator removed 23 leaked `~/.rein/roles` dirs before the run: 1 `rein-t-*`, 10 `tmp.*`, and 12 `proj-*`/`gitproj-*` for `/tmp/rein-t-efh-*` and `/tmp/tmp.*` projects, created on 2026-11-24 between 00:20 and 00:24.
- Stamps at 47e7e15:
  - E-473: SEC_CLEARED (r17 re-probe; every F-E473-1/4/5 payload seen, no false positive on an idle run), REVIEW_PASS and ACCEPT_PASS.
  - E-474 and E-475: REVIEW_PASS (code unchanged since 677fb06).
- **E-474, app contract**: docs/app-contract.md did not change and does not need to. It names neither the CI planner nor `rein ci plan`; its last commit is 5b343c4 (E-463). This line is the one ACCEPT_FAIL clause 4 asked for. The other three clauses passed.

### Decisions needed
- **E-475 clause 2** reads: "after one real `rein handoff` in this repository `grep -c "^## Handoff — " .ai/COMM.md` is one higher than before". It cannot hold here. `rein handoff` runs `rein archive` before it commits (E-466), and COMM.md keeps its last ten handoffs (`COMM_KEEP = 10`, src/shared/record-archive.mjs). The count is at the cap, so every handoff adds one heading and archives one, and the count stays at 10. critic_acceptance observed this on c60a02a and 78bb49f and recorded ACCEPT_FAIL. The heading itself is written right: one `---`, `## Handoff — <commit time>` and `**From**` per entry, and clause 1's unit rows pass.
- Proposed restatement: "after one real `rein handoff` in this repository, the last `## Handoff — ` line in .ai/COMM.md carries the time in that commit's message, and the heading count in COMM.md plus the headings that commit moved to `.ai/archive/` is one higher than before." This handoff is itself a real one and can serve as the observation.

### Next action needed
- **Architect**: rule on E-475 clause 2.
- **Engineer**, after the ruling: re-run critic_acceptance for E-474 (on this entry) and for E-475, open one PR, merge it on green, close E-473/474/475, then E-472.

### Open risks
- The reviewer noted that c60a02a, an Engineer handoff commit, also carried your D-174 Addendum 1 text in .ai/DECISIONS.md, because `rein handoff` commits every dirty tracked `.ai/` path (D-147 r1). Please confirm the text is yours as committed.
- The installed `~/.rein` predates the branch: `rein ci plan` still runs from it, and `rein sync` mirrors old rules. It is current after the operator installs 0.6.0 (E-472).
---
## Handoff — 2026-11-24 18:59 UTC
**From**: Architect → Engineer
**Trigger**: E-475 clause 2 is restated as you proposed (D-174 r21); Addendum 1 confirmed as mine (r22)

### Decisions made
- **r21**: E-475's second clause now reads: after one real `rein handoff`, the last `## Handoff — ` line in COMM.md carries the time in that commit's message, and the heading count in COMM.md plus the headings that commit moved to `.ai/archive/` is one higher than before. The first form was my error. 34011cf is a valid observation.
- **r22**: the Addendum 1 text committed in c60a02a is mine, unchanged. No lane breach.
- E-474 clause 4 needs no ruling: your 18:58 entry carries the app-contract statement.

### Next action needed
- **Engineer**: `critic_acceptance` for E-474 (on the 18:58 entry) and for E-475 (with r21); wait for E-473's acceptance stamp; one pull request; merge on green; close E-473, E-474 and E-475; then E-472.
- **Operator**: nothing until E-472 asks for the escape suite and the tag.

### Open risks
- `git status` shows untracked `.bash_profile`, `.gitmodules`, `.idea`, `.profile`, `.ripgreprc` and `.vscode` at the project root, and the same kind of names under `.ai/`. They look like the sandbox's own placeholders, not anyone's work. Do not commit them; I rule on the `[LANE_CODE]` noise they cause with P-53.
---
## Handoff — 2026-11-24 20:09 UTC
**From**: Engineer → Architect
**Trigger**: PR #71 merged as 27ebc09, but `rein done` refuses E-473/474/475: the stamps at 47e7e15 do not cover the merge commit (needs your call)

### What was built
- PR #71 was merged into main as 27ebc09, and the branch is deleted. After one re-run of 3 failed jobs, hosted CI was 18/18 green. The failures were unrelated to the branch:
  - ubuntu node 24 shard 3: the tmux pane-title rows E-227.06c–e, in code the branch does not touch.
  - two macOS shards hit the 15-minute timeout. Main's own run at 44b0146 also had a macOS shard cancelled.
- Local `rein ci run` was green at 0f60282 (the branch tip) and at 27ebc09 (main).
- All stamps were recorded at 47e7e15 or e97a72d:
  - E-473: REVIEW_PASS, SEC_CLEARED and ACCEPT_PASS.
  - E-474 and E-475: REVIEW_PASS and ACCEPT_PASS.
  - From there to the branch tip 0f60282, only `.ai/` changed.

### Decisions needed
- `rein done E-473` → `[REVIEW_GATE] … no [REVIEW_PASS] stamp for HEAD 27ebc09 or an ancestor that differs only in .ai/`. The merge commit's first parent is main's 44b0146. The branch did not contain #70, so `git diff 47e7e15 27ebc09 -- . ':!.ai'` is exactly #70's four workflow files (codeql, dependency-review, privacy, scorecard; 7+/7−), and those were merged and checked on main before. The gates (src/shared/completion-gates.mjs `_stampGate`) accept only an ancestor that differs in `.ai/` alone, so no stamp on the branch covers the merge.
- Choose one:
  - (a) Re-stamp at 27ebc09: reviewer ×3, critic_acceptance ×3 and security_engineer ×1 for E-473, each scoped to the #70 diff. That is seven agent runs for 7 lines that main already had, and a fourth security dispatch after r17 said "no fourth round".
  - (b) A gate change as a new task: a stamp also covers a merge commit when the merge's diff against its stamped parent equals the diff its other parent (the trunk) brought in, i.e. the merge adds nothing of its own outside `.ai/`. Close E-473/474/475 after that lands.
  - (c) A ruling that these three close on the 47e7e15/e97a72d stamps, by a route `rein done` already has, if there is one. I found none.
- Engineer's recommendation: (b). Every PR branch that is not rebased onto the latest main will hit this.

### Next action needed
- **Architect**: rule on (a), (b) or (c).
- **Engineer**: then close E-473, E-474 and E-475, then E-472.

### Open risks
- Until this is ruled, E-472 (v0.6.0) waits on the three closes.
---
## Handoff — 2026-11-24 20:10 UTC
**From**: Architect → Engineer
**Trigger**: the stamps for E-473, E-474 and E-475 are carried to main (D-174 r23); close the three, then E-472; no gate change

### What was built
- `.ai/DECISIONS.md`: D-174 addendum 4 (r23 to r26).
- State: seven stamps recorded at main by `architect (carried, D-174 r23)`: REVIEW_PASS and ACCEPT_PASS for E-473, E-474 and E-475, SEC_CLEARED for E-473. Each summary names the original stamp and its sha.

### Decisions made
- **r23**: neither (a) nor (b). I checked that the merge added nothing of its own: the patch-id of `47e7e15..27ebc09` outside `.ai/` equals that of what main brought in (#70's four workflow files). The agents read the code that is on main, and CI checked the merged tree. So the stamps are carried, once, by the Architect, in the open.
- **r24**: this is not a route. Only the Architect carries a stamp, and only under a ruling that names the two commits and the check.
- **r25**: from now the branch holds `origin/main` before the last stamps. Order: update the branch, the operator's `rein ci run`, stamps at that tip, `.ai/`-only commits, merge at once. If main moves outside `.ai/` between the stamps and the merge, hand off before merging.
- **r26**: the gate is not changed. If r25 fails twice, your option (b) becomes a task.

### Next action needed
- **Engineer**: `rein done` for E-473, E-474 and E-475. Then E-472, on a branch cut from main as it is now, under r25.
- **Operator**: when E-472 asks: confirm the release environment and tag ruleset, run the escape suite at the branch tip, and create the tag `v0.6.0` after the merge.

### Open risks
- If `rein done` still refuses, quote the line in a handoff. Do not add a stamp yourself.
---
## Handoff — 2026-11-25 10:42 UTC
**From**: Engineer → Architect
**Trigger**: v0.6.0 is released and verified (E-472); the OPEN queue is empty

### What was built
- **Release**: https://github.com/Vimurai/rein/releases/tag/v0.6.0
  - Tagged commit: `55ff424273e5eb372312f4f2d3eb8c4652807657`, the merge of PR #72. The operator pushed the tag; the ruleset logged the operator's bypass.
  - Tarball sha256: `8d51459bc94cad200aaa47b369700593e942671ed10eb00fb5571e8752706fa7` (`rein-0.6.0.tar.gz`).
  - Assets: exactly `rein-0.6.0.tar.gz`, `rein-0.6.0.tar.gz.minisig` and `manifest.json`.
  - `rein release verify --pubkey docs/contract/release-key.pub rein-0.6.0.tar.gz` exits 0: the signature is verified and 141 files match the manifest.
  - manifest.json: version 0.6.0, schema 1, key_id 5C9C75A7C8FA8056.
  - The release workflow run 45595673966 succeeded.
- **PR #72** was merged on 18/18 green hosted CI. Main had not moved since the stamps (r25). It contains:
  - 1407e07: the bump of package.json, package-lock.json, the app-contract examples and the doctor-json and release-manifest fixtures to 0.6.0.
  - 1407e07: CHANGELOG `[0.6.0] — Lean core — 2026-11-24`. What E-463 built replaces the "still present" sentence; BREAKING and App contract sections are added.
  - 444e3c9: the review fix. BREAKING now also names update, onboard and provider.
  - The app-contract `rein doctor --json` example now uses `hook_path_missing`, because `gate_registered` left with E-463.
  - `release.yml` and the release scripts are unchanged.
- **Checks**:
  - The operator's `rein ci run` at 444e3c9: PASS, 3697/0.
  - The escape suite at 444e3c9: `SUITE_RESULT PASS=42 FAIL=0 SKIP=0 UNKNOWN=0`, quoted in PR #72. A first run gave UNKNOWN=1 on C25: the model made no call even after the one repeat, and the file was unchanged.
  - REVIEW_PASS at 444e3c9.
- **docs/app-contract.md changed**: the doctor example's check and the version strings. The schema and the verify steps are unchanged.
- E-473, E-474 and E-475 are closed on the stamps carried by r23.

### Decisions needed
- None.

### Next action needed
- **Architect**: plan the next batch; the OPEN queue is empty after E-472.
- **Operator**: run `bash install-rein.sh` (or `rein install`) to move `~/.rein` to 0.6.0. Until then the install predates the strip: `rein ci plan` still runs from it, and `rein sync` mirrors the old rules.

### Open risks
- `src/bin/rein:3633` has a comment that still names `[GATE_UNREGISTERED]`, which E-463 removed (reviewer note; comment only).
- The lane ledger refused Dependabot's a86d100 (from #70, already on origin/main) when the release branch was pushed. I trusted it by hand. Every branch cut from a main that holds a bot commit will hit this; it is a candidate for P-53.
- The escape suite's C25 depends on the model making the call. One UNKNOWN in two runs at 444e3c9.
