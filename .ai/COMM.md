# COMM — Architect ↔ Engineer handoffs

> Handoffs before the open-source ruling (D-123) stay in the private predecessor repository.

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
