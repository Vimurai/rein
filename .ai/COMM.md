# COMM — Architect ↔ Engineer handoffs

> Handoffs before the open-source ruling (D-123) stay in the private predecessor repository.

---
## Handoff — 2026-11-24 13:40 UTC
**From**: Engineer → Architect
**Trigger**: batch close — one clause conflict that only you can settle (seatbelt location)

### What was built
- Review and acceptance ran for every batch task at 877f560. Clean: E-458, E-459, E-460, E-464, E-469. The rest fail on fixable gaps (being fixed in one commit: hook lines 937, README 200, E-462 refusal tests, census baseline) or on clauses your rulings already amend (r13, r16, r20, r22; D-170 r8 supersedes E-465).

### Next action needed
- **Architect**: E-463 clause 1 measures `wc -l src/mcp/safe-exec-mcp/*` (the seatbelt lives there). E-467 clause 1 says `find src/mcp` lists only shared and task-synchronizer-mcp, and E-468's grep forbids `safe-exec` in CONTRIBUTING.md and docs/ (two lines name `safe-exec-mcp/seatbelt.mjs`). They cannot all hold. Rule one:
  - (a) move the seatbelt to `src/shared/seatbelt.mjs` (my recommendation: no MCP server is left there; E-463's clause then reads that path); or
  - (b) keep `src/mcp/safe-exec-mcp/` and amend E-467 clause 1 and E-468's grep to allow it.
- Reply in one line; I build it in the same commit as the other fixes.

### Open risks
- Each code commit voids every task's stamps (they bind to HEAD). The fixes go in one commit, then one CI run, then one re-stamp round.
---
**Trigger**: seatbelt location ruled: (a), `src/shared/seatbelt.mjs` (D-172 addendum 2 r26)

### Decisions made
- **D-172 r26**: move the seatbelt to `src/shared/seatbelt.mjs` and delete `src/mcp/safe-exec-mcp/`.
  - E-463 clause 1 reads `wc -l src/shared/seatbelt.mjs`. E-467 clause 1 and E-468's grep stand as written.
  - The fitness row `command_text_lines` counts that one file, not `src/shared/`.
  - Installed copy: `~/.rein/shared/seatbelt.mjs`. The hook, `install-rein.sh`, CONTRIBUTING.md and docs/gates-and-review.md name the new path. `~/.rein/mcp/safe-exec-mcp/` becomes a legacy artefact for `rein clean`.
  - `locator_policy_test.sh` keeps every case, at the new path.
  - No extra security round; E-470's one round reads the move.

### Blueprint divergence (if any)
- NONE.

### Next action needed
- **Engineer**: build r26 in the same commit as the other fixes, then one CI run on the operator's word, then one re-stamp round.
- **Operator**: after that commit, `rein ci run`; `bash install-rein.sh` again, since the installed seatbelt path changes.

### Open risks
- Between the commit and the operator's reinstall, the installed hook still finds the old `~/.rein/mcp/safe-exec-mcp/seatbelt.mjs`. `rein clean` must not remove it before the new copy is installed.
---
## Handoff — 2026-11-24 13:10 UTC
**From**: Engineer → Architect
**Trigger**: lean-core batch report — PR #69 is up; the facts each batch task's Acceptance asks the handoff to carry

### What was built
- PR #69 (`lean-core` → main) is open; #68 is closed unmerged (D-172 r9). Local CI green at 1e1f541: 3896 passed, 0 failed, 9 skipped.
- 1e1f541 fixed the batch review at 877f560: the seatbelt moved to `src/shared/seatbelt.mjs` (D-172 r26), hooks 938 lines, README 200 lines, E-462's refusal tests, the census baseline. 375f32a: the installer's closing text no longer describes role tokens.
- E-455 and E-456 closed as superseded by D-169 (E-463 item 5); E-465 as superseded by D-170 r8.

### Escape suite (E-462, E-463; D-172 r6) — run by the operator on this machine at 1e1f541
```
claude 2.1.331 (Claude Code) · bubblewrap 0.11.1 · model haiku
✓ C01–C19, C21–C42 (C20 MCP server, C24 poisoned index, C29–C35 push lane, C36–C39 F3, C40 F4, C41 cwd, C42 rein start)
sessions (1 = control landed): a3b=1 e1b=1 a2=1 a3=1 a1=1 a6=1 a4=1 a5=1 e1=1
SUITE_RESULT PASS=42 FAIL=0 SKIP=0 UNKNOWN=0
```

### E-463 — full_seconds before and after
- Before: 623 s (the last green full run before the batch, 0a92961). After: 258 s (2e0f877 and 1e1f541). The gate's deletion is the larger part: no CI ran between E-463's parent and E-463.
- For the Architect to rule (E-463 clause): **E-394** (doctor reads disableAllHooks from every layer), **E-395** (doctor exits non-zero on [SAFE_EXEC_BROKEN]/[GATE_DEP_MISSING] — both lines are gone with the gate), **E-410** (`rein incident` as an install-tree writer of the gate's allowlist — the allowlist is gone), **P-52** (control review from `rein gate ledger` — the ledger is gone). Each names gate machinery E-463 deleted.

### E-467 — what was removed, by name
- Agents (15): chaos_monkey, db_architect, dependency_manager, devops_engineer, docs-architect, knowledge_architect, memory_curator, meta_analyst, performance_engineer, seo_content_generator, seo_engineer, seo_manager, sre_responder, ux_reviewer, vibe_sentinel.
- Skills (27): aqg-resolver, arch-oracle, arch-review, architectural-aligner, bug-reproducer, ci_gate, commit-crafter, copilot, dependency_gate, identity_guardian, obs_baseline, rein-archive, rein-incident, rein-insights, rein-migration, rein-profile, rein-review-proposed-skills, rein-seo, rein-sync-state, rein-triage, rein-upgrade, repo-oracle, scope_safety, seo_content_checklist, token-miser, trigger-audit, ux_template. (E-461 removed six more: arch-task, decision-recorder, rein-handoff, rein-log, rein-task, task-planner.)
- `git ls-files src | xargs cat | wc -l`: 96,377 at 887a818^ (the task text's 97,956 was measured earlier), 29,665 at 1e1f541. Kept: 4 agents (critic_acceptance, reviewer, security_engineer, test_engineer), 5 skills (blueprint-writer, rein-debug, rein-review, rein-test, release-manager), one MCP server.

### E-466 — COMM.md and its archive
- `grep -c "^## Handoff" .ai/COMM.md`: 10 before and after `rein archive`; `.ai/archive/COMM-2026.md` holds 105; sum 115, unchanged.

### E-461 — tool calls for close and handoff
- Closing a task is one call (`rein done`); a handoff is two (`rein handoff`, then SendMessage with its wake line): 3 in all, as in this turn.

### Decisions made
- None of mine. Clauses amended by rulings are read as amended: D-172 r13 (E-466's `rein task show` with E-427), r16 (hooks 950), r20 (docs/assets outside E-468's grep), r22 (blueprint-writer kept), r26 (seatbelt path), D-170 r8 (E-465).

### Next action needed
- **Architect**: rule E-394, E-395, E-410 and P-52 (close as superseded by D-169, or keep).
- **Operator**: `rein ci run` on the tip (375f32a changed install-rein.sh), and relaunch both panes.
- **Engineer**: then one review, acceptance and security round at that tip; close the batch tasks; push to #69.

### Open risks
- Clauses needing a live Architect session are covered by the escape suite's cases, not observed by hand.
- 18 other projects carry a stale hook path until `rein sync` runs in each (installer output).
---
**Trigger**: batch report reviewed and accepted; E-394, E-395, E-410, P-52 ruled superseded (D-172 r27); their close waits on the CI run

### What was built
- `.ai/DECISIONS.md`: D-172 addendum 3 r27.
- The four tasks are still OPEN. `update_task_status` refused each with `[CI_GATE] no green local CI run for HEAD 9fe3820`: 375f32a changed `install-rein.sh` after the last green run. I did not bypass it.

### Decisions made
- **D-172 r27**: all four close as superseded by D-169, not implemented.
  - E-394: a P3 finding from when hooks held the role boundary. The doctor's check of the project file stays.
  - E-395: both doctor lines went with the gate.
  - E-410: the allowlist went with the gate; E-467 removed the skill.
  - P-52: `rein gate ledger` went with the gate.
- The batch report is accepted as the facts each Acceptance asks for. Nothing in it needs a further ruling.

### Blueprint divergence (if any)
- NONE.

### Next action needed
- **Operator**: `rein ci run` on the tip, then relaunch both panes.
- **Engineer**: after the green run, in your close round, close E-394, E-395, E-410 and P-52 with `superseded_by: D-169` and the r27 line as summary. Then the review, acceptance and security round, the batch closes and the push to #69, as you planned.
- **Architect**: after #69 merges, P-51, then P-53, P-54, P-55.

### Open risks
- `.ai/blueprints/harness-fitness.md` §Component 2 still describes the ledger. P-53 covers `architect.md` only; I mark the blueprint section retired with P-51.
**Trigger**: the operator ordered v0.6.0 after #69 merges: D-173 and E-472 (BLOCKED on E-470)

### What was built
- `.ai/DECISIONS.md`: D-173. Task E-472, Tier 2, depends on E-470.

### Decisions made
- **D-173**: the lean core is released as v0.6.0 by the path v0.5.0 took.
  - The bump is its own pull request after #69, not a commit inside #69 (it would void the branch's stamps).
  - The operator creates and pushes the tag. The escape suite passes at the commit to be tagged, or no tag.
  - The demo recording does not hold the release.

### Blueprint divergence (if any)
- NONE.

### Next action needed
- **Engineer**: nothing changes now. Finish E-470 as planned; E-472 opens when it closes.
- **Operator**: for E-472, confirm the `release` environment still holds REIN_RELEASE_KEY and the `v*` ruleset; run the escape suite when asked; create the tag `v0.6.0` on the merge commit the Engineer names.

### Open risks
- `release.yml` has not run since the strip. If it calls anything E-467 removed, E-472 stops and becomes Tier 3. The workflow's dry run (`workflow_dispatch`) on main after #69 shows this before the tag.
---
## Handoff — 2026-11-24 14:10 UTC
**From**: Engineer → Architect
**Trigger**: batch close — the last round passed all but E-467's review (telemetry) and E-468's review (one statement); one ruling needed

### What was built
- Closed: E-458, E-459, E-460, E-461, E-463, E-464, E-466, E-469 (review, acceptance and, Tier 3, security at a902167/2c3f78c; CI green at 4db5ec2). E-462 waits on one acceptance stamp that did not land (re-dispatched).
- 5f9eb96: CONTRIBUTING.md puts seatbelt.mjs under src/shared/ (E-468 review note).

### E-468 — the app contract (the task asks the handoff to say whether it changed)
- **docs/app-contract.md changed, the contract did not.** 2bcaf5d: an example that named the removed orchestrator-mcp is generic now; the `rein pane` row says it writes the launch record instead of "never mints a role token". 5b343c4: the `rein gate on|status` row is removed with the gate (E-463). No command an app may call changed its arguments or output.

### Decisions needed
- **E-467's review FAILs on D-170 r5**: telemetry (src/shared/telemetry.mjs 799 lines, mcp-telemetry.mjs 181, incident-append.mjs 148) and the incident tracker remain, with their tests. The batch notes kept them for the gate, which is gone. Removing them needs a split (mcp-telemetry.mjs also holds the build stamp `rein doctor` uses for stale servers), a rewrite of tests/run.sh's telemetry-isolation guard (E-257) and harness_isolation's E-257 rows, and ~15 files.
- **The operator chose a follow-up task**: please register it (removal of telemetry, mcp-telemetry's recording half, incident-append and the hook incident writer, their tests and the run.sh guard; keep the build stamp) and amend E-467 so its review reads that removal as moved to the new task.

### Next action needed
- **Architect**: the ruling and the task above.
- **Operator**: `rein ci run` on the tip after that.
- **Engineer**: then review, acceptance and security for E-467, review and acceptance for E-468; close both and E-462; close E-470; push to #69.

### Open risks
- None new.
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
