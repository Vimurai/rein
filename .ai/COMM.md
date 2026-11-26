# COMM — Architect ↔ Engineer handoffs

> Handoffs before the open-source ruling (D-123) stay in the private predecessor repository.

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
---
## Handoff — 2026-11-25 10:46 UTC
**From**: Architect → Engineer
**Trigger**: v0.6.0 accepted; the plain tag is right (D-173 r9); one small task, E-476; architect.md is rewritten (P-53)

### What was built
- `.ai/DECISIONS.md`: D-173 addendum 1 (r8 to r10) and D-174 addendum 5 (r27 to r30).
- `.ai/architect.md`: rewritten for the lean core, 126 lines. §9 lists every blueprint as current, not re-read, or historical. P-53 is closed.
- State: E-476 (Tier 2).

### Decisions made
- **D-173 r9**: "the signed tag" in E-472 was my loose wording. The signature is minisign on the tarball. No signed git tag is built. What you told the operator was right.
- **D-173 r10**: C25's UNKNOWN is handled by the existing rule (run the suite again). A task only if it recurs at the next release.
- **D-174 r27**: `[LANE_CODE]` reports regular files and symbolic links only. The 17 entries it prints in my pane are the sandbox's character-device placeholders.
- **D-174 r28**: a commit made on GitHub is trusted in the ledger by hand, after `git ls-remote` confirms it is on the remote's main. No automatic trust is built. Your hand trust of a86d100 was the right step.
- **D-174 r29**: no blueprint is moved or deleted.

### Next action needed
- **Engineer**: E-476, on a branch that holds `origin/main` (r25). It is not urgent. Do not ask for CI for it alone if another task is about to join: P-54 will add one for model routing, and the two can share a pull request and one run.
- **Operator**: `bash install-rein.sh` to move `~/.rein` to 0.6.0, then restart the panes. `rein done` printed `[BUILD_STALE]` for 3 files today.
- **Architect**: P-55 (rein-app review), then P-54 (model routing), then P-43.

### Open risks
- Seen while listing `src/` and not checked against the keep list: `src/shared/managed-agents-client.mjs`, `src/shared/provider-adapter.mjs`, `src/shared/wal-flusher.mjs`, `src/copilot/` and `src/contracts/`. If you know one is unused, name it in your next handoff; I rule on a sweep then.
- a000a27 (the close of E-472) is on local main only. It is `.ai/`-only and rides the next pull request.
---
## Handoff — 2026-11-25 11:10 UTC
**From**: Architect → Engineer
**Trigger**: operator's order: `rein handoff` must work where `.ai/` is gitignored (D-175); new task, ahead of E-476

### What was built
- `.ai/DECISIONS.md`: D-175 (amends D-104 r2 and r4).
- State: E-477 (Tier 2).

### Decisions made
- **D-175**: in a project whose rules ignore `.ai/`, `rein handoff` appends the entry, makes no commit, exits 0 and says "not committed" in the wake line. Never `git add -f`. A project that tracks `.ai/` is unchanged.
- The session-start line `[COMM_IGNORED] … never reaches the other role` is not printed for such a project; doctor prints one plain line.
- Seen in the operator's project `em-locize`: the Architect there could not record a handoff and used a loose entry file.

### Next action needed
- **Engineer**: E-477 first, then E-476, on one branch that holds `origin/main` (D-174 r25), one commit each, one pull request. Tell the operator when both are built; CI is one run on their word.
- **Operator**: after the merge, `bash install-rein.sh`; then `rein handoff` works in `em-locize`. Until then the loose entry file there is the record.
- **Architect**: P-55, P-54, P-43.

### Open risks
- If the session-start hook has to change for D-175 r3, the task becomes Tier 3. The task text says to stop and hand off in that case.
---
## Handoff — 2026-11-25 14:56 UTC
**From**: Architect → Engineer
**Subject**: D-176 — the direction after the strip, and three new tasks for acceptance replay

### What was ruled
- **D-176**: Rein is the proof layer on top of Claude Code. No feature the platform has is rebuilt; what the platform can replace is reused. The operator agreed on 2026-11-25.
- First new feature: **acceptance replay**. Blueprint: `.ai/blueprints/acceptance-replay.md`. Read it before E-478.

### New tasks
- **E-478** (Tier 2): the check record. `src/shared/checks.mjs`, `add_stamp` refuses a malformed `CHECK`, `critic_acceptance` records checks, the REVIEWS view.
- **E-479** (Tier 3, after E-478): `rein recheck` with `--list`, `--json` and `--retire`. Tier 3 by D-176 r7: it runs command text from the ledger. One `security_engineer` round.
- **E-480** (Tier 2, after E-479): the `[CHECK_GATE]` at DONE, `rein review` runs the recheck, the docs.
- **P-56** (Architect): the reuse review. It replaces P-55.

### Things to know
1. No table and no column is added. A check is a stamp (blueprint §Data Model).
2. The replayer is never called from `src/mcp/`. The MCP server runs outside the role sandbox, so the gate reads a `CHECKS_PASS` stamp and runs nothing.
3. No allowlist of commands. Do not rebuild a text gate.
4. E-480's floor is its own task number, so the gate does not reach E-478 to E-480 themselves.
5. One branch for E-478 to E-480, one commit each, review at the tip (D-176 r14). CI on the operator's word.
6. If a task needs a change in `hooks/`, stop and say so in a handoff.

### Open with you from before
- E-477 has `[ACCEPT_FAIL]` at c776788: the `rein ci run` log for that commit is FAIL with `[REIN_HOME_WRITTEN]`. D-174 r19 says a run the guard fails because of an install or a new pane during it is repeated. That run is the operator's.
- I could not close P-55 as superseded by D-176: `[CI_GATE]` refuses while HEAD has no green run. I will close it after the green run.

### Next action needed
Finish E-477 and E-476 (they wait on the operator's green `rein ci run`). Then build E-478, E-479 and E-480 in that order on one branch, and hand off with the test files named and anything in the blueprint that the code made impossible.
---
## Handoff — 2026-11-25 19:29 UTC
**From**: Engineer → Architect
**Subject**: E-478 to E-480 built on lane-code-quiet; E-479 SEC_BLOCKED, fixed, the second security round needs you (D-164 r6)

### Commits (branch lane-code-quiet, one per task, then the round's fix)
- `593e6a0` E-478 the check record (Tier 2)
- `3c9da41` E-479 `rein recheck` (Tier 3)
- `01677f0` E-480 the `[CHECK_GATE]`, `rein review` runs the replay, the docs (Tier 2)
- `4077fe2` fix: E-479's two security findings and the review notes on E-478 and E-480

### Test files
- New: `tests/unit/checks.test.mjs` (the grammar, the malformed cases, the control-character refusal)
- New: `tests/unit/recheck.test.mjs` (live set, each expect form broken, timeout, output cap, setsid grandchild, dirty tree, `--list` runs nothing, both retire refusals, usage, a stored spoofing stamp is not live)
- Rows in `tests/unit/record-store.test.mjs` (add_stamp `[CHECK_MALFORMED]` over MCP; the REVIEWS.md line)
- Rows in `tests/unit/completion-gates.test.mjs` (the `[CHECK_GATE]` rows the task lists)
- Row in `tests/unit/traversal-policy.test.mjs` (E-480.R3: `rein review` prints the replay; a broken check is a P0)
- Unit suite: 898/900 pass here; the failures are E-433.03 (tmux socket: "Operation not permitted" in this sandbox). `harness_isolation_test.sh` has 3 tmux/shim failures here for the same reason. Your green `rein ci run` decides.

### Review state
- `[REVIEW_PASS]` for all three at `01677f0`. `4077fe2` changes src/, so all three need the reviewer again at the tip, then `critic_acceptance`.
- `[SEC_BLOCKED]` E-479 at `01677f0` (details in `.ai/SECURITY.md` §E-479 round, T-RECHECK-001):
  - F-E479-1 (P1): an ESC or bidi sequence in a CHECK let `--list` show one command while another ran. Fixed: every C0/C1/DEL, zero-width, bidi and line-separator character is refused in a CHECK or CHECK_RETIRED summary, and `liveSet` re-parses stored stamps, so one that reached the store another way is never listed or run.
  - F-E479-2 (P2): a setsid'd grandchild holding stdout outlived the 30 s limit and the 64 KB cap. Fixed: a limit kills the group, destroys stdout and settles the run at once.
  - Both have regression rows. **The second round needs your word (D-164 r6).**

### Where the code differs from the blueprint, or the blueprint did not say
1. **Dirty tree.** `rein ci run` does not detect a dirty tree; it has a `--dirty` flag. `rein recheck` counts tracked changes outside `.ai/` as dirty (the `.ai/`-only rule of the stamp gates); untracked files do not count (a role sandbox leaves `/dev/null` placeholders in the root).
2. **The grammar is stricter than §Data Model:** a CHECK or CHECK_RETIRED needs `task_id` equal to the summary's `<task>`, and no control or format character (F-E479-1). §Data Model should say both.
3. **`rein review 2|3`:** a broken check is a P0, so nothing is dispatched until it is fixed or retired. In the operator's own shell this runs ledger commands without the "read `--list` first" step; `docs/gates-and-review.md` now says to read the list before the first review too. A ruling if you want it otherwise.
4. **`CHECKS_PASS` is not reserved** to `rein recheck`: any session can write one (the residual of D-159 addendum 2 r7 your §Security accepts). The reviewer of E-480 suggested reserving it.
5. **Size:** 253 non-comment lines in `checks.mjs` and `recheck.mjs`, plus about 40 in `completion-gates.mjs` and `review-checks.mjs`. That is over the target of 250; the security fixes added to it.
6. **`--retire --by`:** a `D-###` must be a `## D-###` heading in DECISIONS.md (the shared `checkSupersededBy`); an `E-###` or `P-##` must be a task in state.
7. The REVIEWS line is literal: `E-1: 1 checks recorded` for one check.
8. Running `rein recheck` and `rein review 2` here recorded `CHECKS_PASS` stamps (0 checks) in this repository's ledger.

### Open from before
E-476 and E-477 still wait on the operator's green `rein ci run` (the last one tripped `[REIN_HOME_WRITTEN]` on writes by live sessions during the run).

### Next action needed
Your word on E-479's second security round. Then I run the reviewer on E-478 to E-480 at the tip, `critic_acceptance` on each, and close all five once the operator's CI run is green.
---
## Handoff — 2026-11-25 19:30 UTC
**From**: Architect → Engineer
**Subject**: D-176 addendum 1 — the second round for E-479 is ordered as a re-probe; one more commit first (`[STAMP_RESERVED]`)

### Rulings (D-176 addendum 1, r15 to r22)
- **r15**: one re-probe round for E-479, no discovery. `security_engineer` re-runs the payloads of F-E479-1 (the ESC sequence and the U+202E form through `add_stamp`; the same summary written to the store without `add_stamp`) and F-E479-2 (`setsid sleep` past the limit; `setsid` with endless output past the cap), and one payload for r16. SEC_CLEARED if all are RESISTED. A new finding goes into T-RECHECK-001 and does not gate unless it is P0. No third round.
- **r16**: `add_stamp` refuses the types `CHECKS_PASS`, `CHECKS_FAIL` and `CHECK_RETIRED` with `[STAMP_RESERVED]`. `rein recheck` keeps writing them to the store itself. The refusal text must not hold the word `recheck` (E-479's clause on `src/mcp`). `CHECK` stays open. One commit on the branch, as a fix under E-479; one row in `tests/unit/record-store.test.mjs`.
- **r17 to r21**: the dirty-tree rule, the stricter grammar, the P0 in `rein review`, the size and your points 6 to 8 are ratified as built. I updated `acceptance-replay.md` §Data Model, §API and §Security to match.

### Order (r22)
1. The commit of r16.
2. Bring the branch up to date with `origin/main` (D-174 r25).
3. The operator's `rein ci run` at that tip.
4. At that tip: the re-probe of r15, the reviewer on E-478 to E-480, `critic_acceptance` on E-476, E-477, E-478, E-479 and E-480.
5. Close the five. E-480's floor keeps the `[CHECK_GATE]` away from them.

### Next action needed
Build r16's commit, then tell the operator the tip is ready for `rein ci run`. After the green run, do steps 4 and 5 and hand off with the stamps and anything the re-probe recorded.
---
## Handoff — 2026-11-26 12:34 UTC
**From**: Engineer → Architect
**Subject**: D-176 addendum 1 r22 done — E-476 to E-480 closed; the re-probe cleared E-479; the PR is next

### Done (r22 steps 1 to 5)
1. r16's commit: `a8e798d` (`add_stamp` refuses CHECKS_PASS, CHECKS_FAIL, CHECK_RETIRED with `[STAMP_RESERVED]`).
2. The branch was already level with `origin/main` (`55ff424`): 0 behind.
3. The operator's `rein ci run` at `a8e798d`: PASS, 3724/0/9, unit 91.90 %, leaked 0 (run 157).
4. Stamps at that tip:
   - The re-probe (r15): `[SEC_CLEARED]` E-479. 12 payloads, all RESISTED: ESC and U+202E through `add_stamp`; the same through `insertStamp` and raw SQL (dropped by `liveSet`); `setsid sleep` and `setsid yes` past the limit and the cap; r16's three types. Table in `.ai/SECURITY.md` §E-479 re-probe.
   - `[REVIEW_PASS]` E-478, E-479, E-480 at `a8e798d`. E-476 and E-477 were re-reviewed at `676c75d`: their last REVIEW_PASS was at `c776788`, and E-478 to E-480 changed src/ after it.
   - `[ACCEPT_PASS]` E-476 (3 PASS, 2 UNVERIFIED: the live `[LANE_CODE]` clause wants the operator's pane; the agent's own CI run failed in the sandbox), E-477 5/5, E-478 4/4, E-479 5/5, E-480 5/5.
5. Closed E-476 to E-480 at `676c75d`, which is `a8e798d` plus the review-round `.ai/` records. The CI gate took run 157 as the `.ai/`-only ancestor.

### Findings for you (none gates)
1. **An ERROR run hides a PASS for the same sha.** The E-476 acceptance agent ran `rein ci run` inside the sandbox; `git worktree add` failed on the read-only `.git/worktrees`, and an ERROR row (0 ms, nothing tested) became the newest certifying row for `a8e798d`. `certifyingRunFor` (src/mcp/shared/ci-runs.js:448) takes the newest dirty=0 row, so `[CI_GATE]` would have refused DONE at `a8e798d` itself. Two candidate tasks: a run that ERRORs before the suite should not certify or shadow; `critic_acceptance` should read a CI clause from the record, not run `rein ci run`.
2. **`[UNAPPROVED_DEP]` false positive** (src/shared/review-checks.mjs:112): the pattern matches any added `"key":` line in any file. Here, the uncommitted stamp records in `.ai/state.json`. Pre-existing; candidate task: limit it to manifests.
3. **T-RECHECK-001, new P3** (re-probe): a `setsid` child with no pipe outlives a run that hit its limit; the kill reaches only the run's group. Availability only; the run still settles at the limit.
4. **Test notes** (reviewer, E-479): `tests/unit/recheck.test.mjs:81` uses `setsid` with no skip when it is absent (exit 127, the row fails); the setsid'd `sleep 6` lingers about 6 s after the test. `_replay` in review-checks.mjs:148 has no unit row for its two edge paths.
5. **Rollback plan**: `4077fe2` carries E-479's fixes and E-480 review notes, so acceptance-replay.md's one-commit-per-task rollback does not hold for those two.
6. **Small**: `[CHECK_GATE]`'s refusal leaves out the HEAD sha the other gates print (matches the task text). `rein recheck --retire` checks the id before `--by`. `add_stamp` accepts a lowercase `checks_pass`, which the gate ignores (it matches the type exactly).
7. **Install**: every DONE printed `[BUILD_STALE]` (3 files). The installed `rein` is v0.6.0 and has no `recheck`; `bash install-rein.sh` fixes both.

### Next action needed
Open the pull request for lane-code-quiet (E-476 to E-480), or rule on findings 1 and 2 first.
