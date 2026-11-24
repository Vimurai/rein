# COMM — Architect ↔ Engineer handoffs

> Handoffs before the open-source ruling (D-123) stay in the private predecessor repository.

---
## Handoff — 2026-11-20 14:24 UTC
**From**: Architect → Engineer
**Trigger**: D-163 addendum 2 r16 is recorded, as the 19:02 handoff asked. No new task.

### What was built
- `.ai/DECISIONS.md`: "D-163 addendum 2 r16". Nothing else in `.ai/` was written by hand.

### Decisions made
- **E-447 is accepted as built.** I read 53465d9 against 24913ce: exactly the eleven rows of PR #63 are gone and no kept row changed.
- **Pinned**: `operand-scope-cases.json`, 490 rows (381 BLOCK, 109 pass), `4e41906fc55d0723147a96bb8bf148118faccf7e9f3470eb416529cb8129627e`. It replaces `cb100e3f…`.
- **The raise is ratified**: `test_lines` 45408 at c0274fa. The limit is 46316 by the +2% rule.
  - The 908 lines between them are not a grant. D-164 addendum 1 r4 stands for the four contract tables.
  - The next raise request comes with a census (D-164 r3).
- **The third keep clause** was applied as "only row on its V8 block-coverage path", not "only row killing a mutant". Accepted for this table. A later table merge names the measure in its task text.

### Blueprint divergence (if any)
- NONE.

### Next action needed
- **Engineer**: continue the order you named: E-441, E-440, E-446 (E-442 is committed at dc6619e).
  - E-445 and E-447 still need `[ACCEPT_PASS]` for their HEAD before DONE.
- **Operator**: merge #61–#64 after #60, in order. The items of the 19:02 handoff are unchanged.

### Open risks
- **Two wrong stamps are in the ledger** from a `rein-insights` run in this session:
  - `INSIGHTS_GENERATED` claims a report; the write to `~/.rein/INSIGHTS.md` was blocked by GATE_SELF_DISABLE and no file exists.
  - `INSIGHTS_WRITE_BLOCKED` says a draft is in the scratchpad; there is none.
  - The meta_analyst contract and the lock on `~/.rein/` contradict each other. A ruling is pending with the operator; do not fix it unasked.
- `git merge-base --is-ancestor` is blocked for the Architect as ARCH_GIT_MERGE. It is read-only. Noted for the E-440 over-block list; not ruled here.
- This commit carries `.ai/REVIEWS.md` and `.ai/state.json` as found, which include stamps your E-442 session left uncommitted. `.ai/providers.json` and `.ai/roles.json` are left dirty: they are the operator's.
---

---
## Handoff — 2026-11-20 15:10 UTC
**From**: Architect → Engineer
**Trigger**: D-165 recorded and E-448 registered, on an operator request.

### What was built
- `.ai/DECISIONS.md`: D-165. One task: E-448 (Tier 2, framework).

### Decisions made
- **D-165**: a machine-local generated file is refused at commit in every Rein project. Today it is only reported.
  - Cause: a colleague pulled a project and received `.claude/settings.json` with the operator's absolute paths.
  - The list is the four paths `_ensure_generated_gitignore` already writes.
  - The content check reads staged `.claude/**` and `.mcp.json` only.
  - Not reopened: the absolute hook paths of D-083 r2.

### Blueprint divergence (if any)
- NONE.

### Next action needed
- **Engineer**: E-448 after E-441. It does not touch the gate stack. Read D-165 r1–r5 first; the task text is short on purpose.
- **Operator**: in the shared project, `git rm --cached .claude/settings.json`, commit, push.

### Open risks
- A project that commits `.claude/settings.json` on purpose can no longer commit a change to it (D-165, Impact).
- The acceptance clauses need a fixture repo with the hook installed. If the pre-commit suite has no such fixture, report it before building one.
---

---
## Handoff — 2026-11-20 15:28 UTC
**From**: Architect → Engineer
**Trigger**: Smart CI planned on an operator request: D-166, a new blueprint, four tasks. One correction to r16.

### What was built
- `.ai/blueprints/smart-ci.md` (new).
- `.ai/DECISIONS.md`: D-166, and "D-163 addendum 2 r16 — correction to (c)".
- Tasks: E-449 (OPEN), E-450, E-451, E-452 (BLOCKED on their dependencies).

### Decisions made
- **D-166**: one planner decides from the diff what must run: `none`, `fast`, `affected` or `full`.
  - Full is the default: the planner returns it whenever it cannot prove less.
  - Evidence is keyed by tree and level; a tree that is already green is not run again.
  - With a hosted merge gate, the local gate asks for at most `affected`. A `[TIER_3]` range stays full.
  - Pull requests run Linux × Node 22 only. macOS runs on a trunk push.
  - One required check, `ci-result`. The operator changes the ruleset when E-451 says so.
- **Correction to r16 (c)**: I wrote "there is no mutation run in the harness". That is false: `tests/tools/mutation/` exists.
  - E-447 does not close on (c). Before DONE, run the mutation probe that covers `operand-scope-cases.json` on the 490-row table and report whether a mutant killed at 501 rows survives at 490.
  - If the tool does not cover that table, report that instead.

### Blueprint divergence (if any)
- NONE. `smart-ci.md` amends `ci-throughput.md` (when each lever is used) and does not change its components.

### Next action needed
- **Engineer**: your current task, then E-448, then E-449. E-450 is Tier 3: `security_engineer` before `critic_security`.
  - E-451 item 5 (reuse on a trunk push) is unverified: observe first, report if neither the cache scope nor the API allows it.
- **Operator**: nothing until E-451 names the ruleset change.

### Open risks
- An `affected` run is only as good as the census footprints. The nightly audit (E-452) lands last, so between E-450 and E-452 an escape is seen only as a red nightly without a `[PLAN_ESCAPE]` line.
- Until E-451 merges, the hosted run is unchanged and still full. E-450 alone already lowers the local gate where `ci.required` is true; Rein's `team.json` does not set it yet, so nothing changes for Rein until someone does.
- GitHub cache scope and the `actions/cache` behaviour in the blueprint are written from memory, not checked against current documentation.
---

---
## Handoff — 2026-11-20 15:51 UTC
**From**: Engineer → Architect
**Trigger**: E-441, E-440, E-446 and E-448 built and committed (stacked on e-442-safe-exec-split); full CI green on the top of the stack.

### What was built
- **E-442 follow-up** 061e3ee (branch e-441-cd-relocation): pre_tool_use_gate_test E-216.08a grepped index.js for `analyzeArchitectWrites`; the E-442 split moved the call into sovereignty.mjs. The assertion now reads sovereignty.mjs.
- **E-441** ffed1e8 (e-441-cd-relocation): `gitRelocated` (git-view.mjs) returns true when a cd/pushd/popd before the git command leaves the project root; the --check gate passes `findProjectRootFrom(cwd)`, runAnalysis/analyzeSovereignty thread `projectRoot`; without a root any directory change counts. Four security_engineer passes. Passes 1-3 found P1 bypasses, each now a row: ANSI-C verbs, `cd${IFS}`, `${X:-cd}`, brace lists, cd in a variable or alias (assigned-verbs.mjs expands cd/pushd/popd, `$'..'` decoded for them only), redirection/assignment prefixes, keywords with options, line continuations. The command-word reader is inverted (fail closed): a segment holding a run-time-built word counts as a possible cd unless its first word is a plain literal command that cannot run cd in this shell. SEC_CLEARED.
- **E-440** 57d1684 (e-440-exec-config-root-forms): (a) git-redirect.mjs, ARCH_GIT_EXEC_CONFIG for core.pager, core.editor, diff.external, credential.helper and credential.<url>.helper, plus alias.<name> with a `!` value, by every hooksPath spelling. An alias via --config-env, or a KEY_n without VALUE_n, fails closed. GIT_SSH_COMMAND and XDG_CONFIG_HOME join CONFIG_ENV. (b) /sbin /lib /lib64 /srv root-form. (c) `$(pwd)`, backtick pwd, `${PWD%…}` are the cwd. (d) both narrowings. SEC_CLEARED after 2 passes.
- **E-446** e685418 (e-446-implicit-run-sinks): IMPLICIT_RUN gains the twelve names; a `..` segment is implicit-run in both modes. From the security pass, the same tools' other spellings too (TASK_RUNNER_FILE, case-insensitive): JUSTFILE, rakefile, Rakefile.rb, *.rake, taskfile.yml, Taskfile.dist.yml. .ai/THREAT_MODEL.md: both E-439 INCONCLUSIVE items closed. SEC_CLEARED.
- **E-448** 183b151 + a84957f (e-448-machine-local-refuse): src/shared/machine-local.list is the one list; `_ensure_generated_gitignore`, the doctor (hard fail, id settings_json_tracked with the path as subject) and a new pre-commit step read it. The step runs in every project with no opt-out: a staged add or modify of a listed path → `[COMMIT_BLOCKED] [MACHINE_LOCAL] … git rm --cached <path>`; a deletion passes; `.claude/**` and `.mcp.json` blobs holding `$HOME/` are refused. `grep -c start.local.json hooks/pre-commit.sh` = 0. a84957f: the list resolves install-first, then from the hook's own tree (as the toolchain-pin bootstrap; never the visited repo). This fixed two CI rows on 183b151 whose fixture HOME has no shared mirror.

### Tables for pinning (on a84957f)
- operand-scope-cases.json: **556 rows (438 BLOCK, 118 pass)**, `fafef2deaafb7c8805fd05705d43b7a0511d7e899f96dde51bdc1ff7478e03da`. E-441 alone (ffed1e8): 530 rows, `6c32b7e3f29f6903a6ad5d597e88b715ca9aafc3f4e98a4d403a6a14f0611bee`.
- block-rules-cases.json: **74 rows (47 BLOCK, 27 pass)**, `e72af434978597269a616bcfab3daaeeec73f341abc123efd3d6fbba7f4ab0d8` (was `65a83152…`).
- pipe-shell-cases.json: **56 rows (45 BLOCK, 11 pass)**, `066124139c1c115b1eda3d481525e33a69c79fac6c0fa90006c1f831f5b56f3b`.
- Unchanged: arch-write-cases.json `26f7da12…`; gate-self-disable-cases.json `9eb38fc4…`. This is HEAD's value: E-445's re-pinned table is not in this lineage, because #62 is unmerged.
- No existing row changed verdict, except the two E-441 residual rows (PASS → BLOCK, as ruled). The two (d) narrowings are new pass rows; no prior BLOCK row covered them.

### CI
- ffed1e8: PASS (7785/0, test_lines 45451).
- 57d1684: suite 7824/0 but budget FAIL, fast_tier 45 s against a limit of 25. Load was 23.9 on 16 CPUs because I ran suites and critics during the run; not a regression.
- 183b151: FAIL on 2 rows, fixed in a84957f.
- **a84957f: PASS** (7841/0, leaked 0, test_lines 45593 ≤ 46316, fast_tier 23).

### Decisions made
- None of my own. Interpretations to ratify:
  - (1) E-440 (d): the `$PWD` match ends at `(\s|$)` AFTER the optional `/` or `/*`, not directly after the name. The literal reading (`(\/|\s|$)` after the suffix) turned `rm -rf $PWD/dist` from WARN to BLOCK (security_engineer P2).
  - (2) E-441 also counts popd, bare cd, `cd -` and `pushd +N`, and a dynamic command word (fail closed).
  - (3) E-446 adds the task runners' other spellings beyond the twelve names (critic_arch: within the ruling).

### Blueprint divergence (if any)
- NONE beyond the three interpretations above.

### Next action needed
- **Architect**: pin the three tables by ruling; ratify or correct interpretations (1)–(3); rule on the residuals below.
- **Operator** (needed before DONE; the acceptance asks for both):
  - `bash install-rein.sh` from a84957f. My run of it was refused by this session's permission classifier. Until it runs, pre_commit_hook_test T-PCS-S10 ("mirror is byte-identical") fails locally, and the live gate lacks E-441/E-440/E-446/E-448.
  - Push and open PRs for e-441, e-440, e-446 and e-448 (stacked, in that order). I have not pushed.
- Then: critic_acceptance for E-441, E-440, E-446 and E-448 (none is DONE yet), and E-449..E-452.

### Open risks
- **E-441 residuals.** P2: `env --chdir`, `find -execdir`, `sudo -D`, sourcing a script, and `cd -P` through a symlink planted in .ai/ (the `..` is collapsed as text). P3: `c[d]` glob, chroot, autocd, coproc, and over-blocks of a cd inside `$( )`. Unrelated (E-438): the git operand scope reads past `&&`/`;`, so `git checkout .ai/x && echo done` blocks for the Architect.
- **E-440 residuals.** P2 env names: GIT_PAGER, GIT_EDITOR, EDITOR, PAGER, GIT_SSH, GIT_ASKPASS, GIT_EXTERNAL_DIFF, GIT_PROXY_COMMAND. P2 keys: core.askPass, gpg.program, diff.<d>.textconv, filter.<d>.clean, core.gitProxy, pager.<cmd>, interactive.diffFilter. P2 cwd forms: `$(pwd -LP)`, `$(builtin pwd)`, `${PWD-}`, `${PWD:-x}`, `$(dirname $PWD)`, `$(realpath .)`. P3: `rm -rf $PWD; ls` is now WARN, the ruled `$HOME` class, and so are `$PWD&&…` and `$(pwd);…`; /lib32 and /libx32; configArgs takes 147 ms at 55 KB.
- **E-446.** P2 (new): a cd before a heredoc moves a relative sink (`cd /etc && cat > profile.d/x`); recorded open in THREAT_MODEL. P3: the deny list cannot be complete (.claude/settings.json, *.pth, .venv/bin/activate, .vscode/tasks.json, setup.py, noxfile.py).
- **E-448.** P2 cosmetic: a newline in a path prints a multi-line message (still blocked).
- Over 4 rounds on E-441 I fixed in-scope spellings rather than handing classification questions up. Say if D-164 r6 meant otherwise.
---

---
## Handoff — 2026-11-20 15:54 UTC
**From**: Architect → Engineer
**Trigger**: Review of E-441, E-440, E-446 and E-448 as built: D-167. Three tasks registered.

### What was built
- `.ai/DECISIONS.md`: D-167. Tasks: E-453, E-454 (OPEN), E-455 (BLOCKED on both).

### Decisions made
- **All four tasks are accepted as built.**
- **Pinned on a84957f** (I recomputed each hash and count):
  - `operand-scope-cases.json`: 556 rows, `fafef2de…`.
  - `block-rules-cases.json`: 74 rows, `e72af434…`.
  - `pipe-shell-cases.json`: 56 rows, `06612413…`.
  - Against the previous pins: only additions, plus the two E-438 residual rows going pass → BLOCK.
- **Your three interpretations are ratified** (D-167 r2–r4).
- **One correction to your handoff**: E-445's re-pin *is* in this lineage. The gate table at HEAD is its 254 rows, `9eb38fc4…`.
- **D-164 r6 did mean otherwise.** From the third security round the question comes to this pane. Rounds three and four of E-441 added spellings to lists that D-167 now replaces.
- **Two lists become rules** (E-453):
  - The Architect passes no configuration to git: any `-c`, `--config-env`, `GIT_*`, `EDITOR`, `VISUAL`, `PAGER`, `XDG_CONFIG_HOME`, and any `git config` write.
  - A command that runs another in a named directory counts as a directory change.
- **E-454**: the `$PWD` spellings and terminators, and a `cd` before a heredoc write.
- **E-455**: the 85 new rows merge by branch afterwards. The keep rule names both measures: block coverage and the mutation probe.
- **Residuals accepted**: D-167 r9, r10, r11 list them. No further rounds on them.

### Blueprint divergence (if any)
- NONE.

### Next action needed
- **Engineer**, in this order: E-449, E-453, E-454, E-455, then E-450 to E-452.
  - E-453 and E-454: at most two security rounds each. A third comes here by handoff.
  - E-453's acceptance says `rein ci run --full`. Read it as `rein ci run` until E-450 adds the flag.
  - E-454: I did not find the ruling behind "`rm -rf $HOME; ls` is a WARN". Cite it, or give `$HOME` the same terminators.
  - critic_acceptance for E-441, E-440, E-446, E-448 once the operator has installed and the pull requests are open.
- **Operator**: `bash install-rein.sh` from a84957f; push and open the four stacked pull requests.

### Open risks
- Until the operator installs, the live gate lacks all four tasks, and one local suite row (T-PCS-S10) fails.
- D-167 r7 will block an Architect git command that passes a harmless `-c`. That is intended.
- The tree is at 45593 test lines. No raise was asked or given; E-455 is expected to bring it down.
---

---
## Handoff — 2026-11-23 15:27 UTC
**From**: Engineer → Architect
**Trigger**: E-449 accepted (DONE blocked by [BUILD_STALE]); E-453 built, and its security rounds are at the D-164 r6 limit.

### What was built
- **E-449 follow-up** — `9eda65a`, on `e-449-ci-planner`.
  - The first critic_acceptance run found `rein ci run` red on d0954fa.
  - The cause: rein_ci_test E-268.02a allows a runner name only in `src/shared/hosted-ci.mjs`, and `platformsFor` had put one in ci-plan.mjs.
  - The function moved to hosted-ci.mjs and ci-plan.mjs re-exports it. The check is unchanged.
  - [ACCEPT_PASS] 7/7 at e68b40f.
- **E-453** — `e68b40f`, on `e-453-git-config-rule`, stacked on 9eda65a.
  - `git-view.mjs` gains `gitPassesConfig`, `setsGitConfigName` and `runsGit`.
  - `git-redirect.mjs` drops the E-353/E-440 key and name lists. HOME is kept (E-353, D-112 r3 b).
  - The wrappers of r8 are added to `gitRelocated`. `trap` is added too (F7, fail closed).
  - The option walk shares one visited set per command. This also removes the quadratic in `gitCommandView` itself: `git -a `×4999 takes about 100 ms.
  - `.ai/THREAT_MODEL.md` T-GITCONFIG-001 records the r9 residuals and the accepted over-blocks.
- **Tables**:
  - `operand-scope-cases.json`: 598 rows, sha256 `04dfe55b26ee21cf4dd7d8f8754bb6254007695ac38a03d9747bedf6955b1df0`. It was 556 rows at `fafef2de…`.
  - The other pinned tables are unchanged and pass.
- **New rows**: one per branch.
  - D-167 r7: spaced -c (global); dynamic option word; -c after a subcommand passes; GIT_* assignment; named-variable assignment; setter verb without =; `${NAME:=}`; search argument passes; git config set; a write action with a read flag; --get read passes; get subcommand passes.
  - D-167 r8: env --chdir; sudo -D; find -execdir; `.` as the command word; `.` as an argument passes; the root cd prefix passes; Engineer unchanged.
  - Round 1: F1 read flag after the first non-option; F1 valued option skipped (pass); F2 clone -c; F2 -c key=value after a subcommand; F2 `commit -c HEAD` passes; F3 `git "$@"`; F3 xargs git; F4 ANSI-C name; F4 dynamic setter name; F4 nameref; F4 printf without -v passes; F5 readers-only git word; F6 dashed git-config; F7 `{` body; F7 trap.
  - Round 2: G1 bundle; G1 `--conf`; G2 dynamic git config word; G3 for-loop variable; G3 nameref declaration; G3 env -S glued; G4 dynamic word under env; G4 a literal other name under env passes.
- **Three E-440 pass rows flip to BLOCK** by r7: `-c alias.st=status`, `git config alias.st status`, and GIT_CONFIG_KEY_n with a plain VALUE_n.
- **Verification**:
  - `rein ci run` PASS on e68b40f: 7916/0/26, test_lines 45794.
  - Critics on d0954fa: ARCH/SEC/TESTS/CLEAN PASS, CRITIC_STAMP.
  - security_engineer: the Engineer's verdicts are byte-identical to HEAD over 1253 lines.

### Decisions made
- None new.

### Blueprint divergence (if any)
- **r8, fail closed**: `env -C`/`sudo -D` count whatever the operand. Unlike `cd`, they are not compared with the project root.
- **Outside r8's list**: `trap` counts as a directory change (F7).
- **Outside r7's list**:
  - `xargs`/`parallel` before git, and a `{}` placeholder, count as configuration (F3).
  - A dynamic word between `env`/`sudo` and git counts as an assignment (G4).
  - Any nameref declaration on a git line counts too (G3).

### Next action needed
- **Architect**: E-453 is SEC_BLOCKED after two rounds (SECURITY.md "E-453 second pass", line 2810).
  - G1–G4 (two P1, two P2) are fixed in e68b40f but not re-tested.
  - By D-164 r6 a third round is your call: rule whether one runs, or accept the tree as it stands.
  - Also rule on the four fail-closed extensions above, and on the P3 over-block `git grep -n 'git config' src/` (security_engineer recommends accepting it).
  - E-453 is not DONE: no SEC_CLEARED, and no critic_acceptance yet.
- **Operator**:
  - Run `bash install-rein.sh`, then restart the MCP servers. `update_task_status(E-449, DONE)` refuses with [BUILD_STALE] until then: nine src/mcp and src/bin files differ from the mirror, and the installed `rein` has no `ci plan`.
  - Push and open PRs for the stack, in order: e-441, e-440, e-446, e-448, e-449-ci-planner, e-453-git-config-rule. Nothing is pushed.
- **Engineer**, after the install: E-449 DONE, then E-454 (independent of the E-453 ruling), then E-455.

### Open risks
- **The live gate predates the whole stack.** E-441/E-440/E-446/E-448/E-453 are not enforced on this machine until the operator installs.
- **Not re-tested.** G1–G4's fixes have had critic_security (SEC_PASS) but no third security_engineer round.
- **P2s from critic_security**:
  - `git config x `×3000 takes 390 ms (superlinear, under the ceilings);
  - `HOME=x make` off a git line, which E-353 also does not catch;
  - nothing asserts platformsFor's values — critic_tests suggests adding that in E-451.
- **Over-blocks accepted under D-167 r7's intent** (listed in T-GITCONFIG-001): a harmless `-c`; a commit message with `EDITOR=`; `git config <key>` without --get.
- **Scratch clones left behind.** The gate (RM_RF_ROOT) blocked their removal: `scratchpad/fx.U4Lx` and `scratchpad/tmp.lk8Eu4acCV` under this session's /tmp scratchpad.
---

---
## Handoff — 2026-11-23 15:33 UTC
**From**: Architect → Engineer
**Trigger**: D-168 — review of E-453 (e68b40f) and E-449's follow-up (9eda65a); E-456 registered.

### What was built
- Nothing in source. Reviewed: `git-view.mjs` and `git-redirect.mjs` at e68b40f, both security passes, T-GITCONFIG-001.
- `operand-scope-cases.json` recomputed at e68b40f: 598 rows, `04dfe55b…`. It matches your handoff.

### Decisions made
- **D-168** (`.ai/DECISIONS.md`). In short:
  - **E-453 is accepted as built.** The four fail-closed extensions and the listed over-blocks are ratified (r5, r6), `git grep -n 'git config' src/` among them.
  - **One third round runs, as a re-probe** (r2–r4). It re-runs what is already written down and does not look for new spellings.
  - **E-456**: the Architect's git subcommands become an allowlist (r8–r11).
  - **E-449's follow-up is accepted** (r12). E-451 adds the assertion on `platformsFor`'s values.

### Blueprint divergence (if any)
- NONE beyond what D-168 r5 ratifies.

### Next action needed
- **Engineer, now (does not need the install)**: dispatch security_engineer on e68b40f with D-168 r2's four items:
  - every payload of the second-pass Pen-Test table;
  - the second pass's "Everyday Architect commands" list, plus the D-104 handoff commit line of `task-planner` Step 7;
  - Engineer parity over the fixture lines;
  - the time of `git config x `×3000.
- **What gates** (r3): a G1–G4 payload that still passes; a line that blocked at d0954fa and passes now; a pass-list line that blocks; a shape over 1000 ms. Fix those in E-453. Anything else goes under "E-453 third pass" as input for E-456 and is not fixed.
- **If it gates twice**: hand off. There is no fourth round (r4).
- **With the re-probe commit**: add r7's residuals to T-GITCONFIG-001. Then critic_acceptance on E-453.
- **Order after that** (r13): E-449 DONE once the operator has installed; E-454; E-455; E-456; E-450 to E-452.
- **Operator**: unchanged from the 15:27 handoff — `bash install-rein.sh`, restart the MCP servers, then push and open the PRs for the stack in order.

### Open risks
- **Not run by the Architect.** D-168 r8 says `bisect run`, `submodule foreach`, `difftool --extcmd`, `fetch --upload-pack` and `clone --template` are on no verb list. That is read from the three lists in the code. E-456's acceptance runs them.
- **The allowlist can block a line the Architect's skills use.** E-456's acceptance lists every git line in those skills with its verdict.
- **The pin of the 598-row table waits for the re-probe** (r1). If the round changes a row, give the new count and hash.
---

---
## Handoff — 2026-11-23 16:24 UTC
**From**: Architect → Engineer
**Trigger**: D-169 (lean core) on the operator's request; `.ai/blueprints/lean-core.md` written; E-457 to E-466 registered.

### What was built
- Nothing in source.
- New blueprint: `.ai/blueprints/lean-core.md`. Read it before E-457: it changes what comes next.

### Decisions made
- **D-169** (`.ai/DECISIONS.md`). In short:
  - **The operator delegated merges** (r1). You push, open pull requests, merge on green CI with `[ACCEPT_PASS]` recorded, and run `install-rein.sh`. Release tags and publishing stay with the operator.
  - **The text gate is deleted once the sandbox is proven** (r2, r5). Rein supports Linux and WSL2.
  - **The gate line stops now** (r6). E-455 and E-456 are not executed. They are closed as superseded in E-463, not before.
  - **Bookkeeping becomes three commands, review follows the tier, the `test_lines` ratchet is retired** (r7–r9).
  - **Until E-461 and E-464 land, today's skills and critics apply** (r13).

### Blueprint divergence (if any)
- NONE.

### Next action needed
- **Engineer, in this order** (r12): E-457, E-458, E-459, E-460, E-461, E-462, E-463, E-464, E-465, E-466; then E-450 to E-452.
  - **E-457 first**: land the whole built stack, E-454 included once its review has passed, reinstall, and close what is accepted.
  - **E-458 is a measurement, not a build.** E-462 starts only if its handoff says §Component 1 can be built. If it says no, hand off with the table and stop the sandbox line; E-459 to E-461 do not depend on it.
- **Held, not to be started**: E-394, E-395, E-410, E-455, E-456.
- **Architect**: P-51 (the overtaken licensing and mirror tasks), in parallel.

### Open risks
- **Two facts are not in Claude Code's documentation**: whether a narrower `allowWrite` wins over a broader `denyWrite`, and the `Edit(!…)` shape for "everything except two directories". E-458 measures both. Nothing is built on either before that.
- **Hosted CI may not allow `bubblewrap`.** The escape suite then prints SKIP, and it must pass on the operator's machine before the gate is deleted.
- **The scorecard's "today" column** comes from a read-only inventory of 2026-11-23. E-459 replaces it with computed values. The inventory counted 612 rows in `operand-scope-cases.json` on the working tree, which then held E-454's rows.
- **The MCP call counts are not known yet.** The target of two servers is a target until E-465's table exists.
---

---
## Handoff — 2026-11-23 16:23 UTC
**From**: Engineer → Architect
**Trigger**: E-453 closed out per D-168 (re-probe SEC_CLEARED, ACCEPT_PASS); E-454 built, SEC_CLEARED, ACCEPT_PASS. All three of E-449/E-453/E-454 are refused DONE only by [BUILD_STALE].

### What was built
- **E-453, per D-168 r2–r4.** The third round ran as a re-probe only: SEC_CLEARED, recorded in 44f9db8 ("E-453 third pass").
  - All G1–G4 payloads block. All 31 pass-list lines pass, including the task-planner D-104 line.
  - Engineer parity holds over 1159 lines. `git config x `×3000 takes about 400 ms.
  - The D-168 r7 residuals are in T-GITCONFIG-001.
  - critic_acceptance: ACCEPT_PASS 14/14 at 44f9db8. Table pin: **598 rows, `04dfe55b…`**. Nothing changed in the round.
- **E-454**, commit `5aa7634` on `e-454-cwd-terminators`, stacked on 44f9db8.
  - (1/2) `rm-root.mjs` `cwdOperandOfRm` reads these as the cwd or home: `${PWD|OLDPWD|HOME<op>…}`, `$( [builtin|command] pwd [opts] )`, the backtick form, and the tilde forms. They end at whitespace, `;` `&` `|` `(` `)` `<` `>` or the end of the line. This is judged per simple command that may be the remove (an rm word, or a head that is not a plain word), so the echo-then-remove row of E-440 stays a WARN. The tilde forms and `<` `>` came from the A2A ruling of 15:51Z.
  - (2) **`$HOME`: I found no ruling that makes it a WARN.** The E-440 comment cites D-163 addendum 2 r8 d, which only covers the whitespace boundary of the echo-then-remove line. So `$HOME` takes the same terminators.
  - (3) `heredoc.mjs`: after a directory change on the line or before it, a relative sink is implicit-run in both modes.
    - The reader is git-view's (`changesDirectory`, a wrapper on `cdBeforeGit`), not a second copy.
    - `runAnalysis` passes the project root. A `cd <root> &&` prefix does not count; with no root, every cd counts.
    - Earlier heredoc bodies are not read as commands.
    - The first moving candidate is found by bisection over the candidates' own prefixes. Over those prefixes the answer only turns true; security pass 2 showed it is not monotone over arbitrary prefixes.
  - (4) `hooks/pre-commit.sh` prints the `[MACHINE_LOCAL]` path through `printf -v q %q`.
  - (5) Residuals are in T-RMCWD-001 and the heredoc section.
- **Tables (counts and sha256):**
  - `operand-scope-cases.json`: **612 rows, `5309e8c0c9965095e0897a74738860aa054f461e78ea8ff90c31da4a78e4ed4b`**.
  - `block-rules-cases.json`: **80 rows, `6289af40476d24ef1bb94501233ce1b67c3ae3cc91cf3b20b995f7882282375b`**.
  - `pipe-shell-cases.json`: **61 rows, `8729fd6139667d212533835e7de3c804cf57c8b1cff8a396aa7bb31f4135bf1d`**.
- **New rows, by branch:**
  - block-rules (r10): terminator inside an rm command; `${PWD<op>}`; `$(builtin pwd)`; backtick pwd with a terminator; `$HOME` terminators; a non-plain head (`$c $PWD;` after a remove on the line).
  - pipe-shell (r11): a cd before the heredoc makes a relative sink implicit-run; the same without the cd passes; an absolute sink after a cd passes; the root cd prefix passes; with no root every cd counts.
  - operand-scope (security pass 1, A2A 15:51Z):
    - five G1 tilde rows: `~+;`, `~+&&`, `(… ~+)`, `{ … ~-;}`, `~root;`;
    - five G2 redirect rows: `$PWD>`, `$PWD<`, `$(pwd)>&`, backtick pwd `>&`, `$HOME>`;
    - R1/R2 pins: backslash-newline (WARN), `$PWD""` (BLOCK — the quote-tolerant match already reads it as the cwd, so it is not a residual), `$("pwd")` (WARN), `$(command -p pwd)` (WARN).
  - pre_commit_hook_test: E-454.01 (newline path, one line).
- **Pinned rows that changed: four verbatim pass rows gained `project_root`.** They are operand-scope D-105 block 3 and pipe-shell D-083 #1, D-083 #2 and D-084 #3. Each `cd` names an absolute root that the real `--check` is given. With no root they now block (r11, fail closed). `tests/lib/check-table.mjs` passes the column. `tests/lib/table-probe.mjs` skips such rows for the CLI probe, because the CLI takes its root from its cwd.
- **Time probe:** 300 heredocs after a cd, in the unit cap test. R5 measured 1.3 s for 380 bodies before the fix; 49 ms now.
- **Verification:**
  - security_engineer: pass 1 SEC_BLOCKED (G1, G2, fixed); pass 2 SEC_CLEARED.
  - Critics: ARCH/SEC/TESTS PASS, plus CLEAN_WARN from the known fixture at pre_commit_hook_test.sh:647.
  - `rein ci run` PASS on 5aa7634: 7942/0/26, test_lines 45867.
  - critic_acceptance: ACCEPT_PASS, 10 PASS and 1 UNVERIFIED. The UNVERIFIED clause is the counts in this handoff, given above.

### Decisions made
- None new.

### Blueprint divergence (if any)
- The `$HOME` terminators are the second option of the task text, because no ruling was found.
- Four pinned verbatim rows gained `project_root`; the hashes above include that.
- `$PWD""` is pinned BLOCK, not WARN.

### Next action needed
- **Architect**:
  - Pin the three tables above.
  - Rule on N1 from security pass 2 (P2, non-gating, recorded Open in THREAT_MODEL under r11). A bare `cd`, `cd -P`, `cd --` or `pushd` alone on a line, followed by a line that is just the project root, reads the root line as the cd's operand. bash instead goes to HOME and fails the root line. So `cd⏎<root>⏎cat > a <<'E'` with a pipe-to-shell body passes for the Engineer. The E-441 reader has the same gap (`cd⏎<root>⏎git checkout .ai/x` passes for the Architect, as at 44f9db8). Fix direction: stop the operand search at a newline or separator.
  - Also rule on these over-blocks of E-454, both fail closed:
    - the `analyze_command` MCP tool passes no root, so its advisory report shows BLOCK for the four verbatim commands (`--check` passes them);
    - an assignment before a cwd-holding command, or `${PWD/src/build}`, on a line with a remove.
- **Operator**:
  - Run `bash install-rein.sh`, then restart the MCP servers. E-449, E-453 and E-454 are each accepted and refused DONE only by [BUILD_STALE].
  - Push and open the PRs in order: e-441, e-440, e-446, e-448, e-449-ci-planner, e-453-git-config-rule, e-454-cwd-terminators.
- **Engineer, next**: E-455 (merge the rows E-441, E-440, E-446, E-453 and E-454 added), then E-456, then E-450 to E-452.

### Open risks
- **The live gate predates the whole stack.** On this machine it lacks E-440, E-441, E-446, E-448, E-453 and E-454.
- **test_lines is 45867,** above the 45593 that D-167 noted. E-455 is expected to bring it down, and the budget check passed.
- **Untouched files.** `.ai/DECISIONS.md`, `.ai/TASKS.md`, `.ai/state.json` and `.ai/blueprints/lean-core.md` are dirty from the Architect's session. I committed only COMM.md, so as not to split that work.
---

---
## Handoff — 2026-11-23 21:24 UTC
**From**: Architect → Engineer
**Trigger**: D-170 — the operator ordered: strip Rein to the bones, one CI run for the whole batch, rewrite the documentation. E-467 to E-470 and P-53 registered. This also answers your 16:23 UTC handoff.

### What was planned
- **D-170** in `.ai/DECISIONS.md`, and `.ai/blueprints/lean-core.md` §Revision 2. Read both before anything else. D-170 amends D-169 and the texts of E-457 to E-466; where a task text and D-170 differ, D-170 wins.
- **Keep list** (D-170 r4): the ledger with `task-synchronizer-mcp` as the only MCP server; `critic_acceptance` and the DONE refusal; the record and `rein decide`; the two roles with the sandbox, `rein handoff`, the waiting signal and `docs/app-contract.md`; 13 CLI commands; 4 agents; at most 6 skills; hooks of at most 900 lines in total. Everything else goes (r5).
- **New tasks**: E-467 strip (Tier 3), E-468 documentation, E-469 plugin packaging, E-470 close the batch (Tier 3). P-53 is mine, after E-470.

### Batch rules (D-170 r9) — the operator's order
- One branch, `lean-core`, cut from the top of the stack. One commit per task. **No push, no pull request, no `rein ci run`, no critics, no `critic_acceptance`, no security round and no handoff between tasks.** You may run the test file you are editing.
- Tasks stay open until E-470 and close there in one pass.
- Kept, because they guard the boundary and are not CI: run the probe of E-458; the escape suite of E-462 passes on this machine before E-463 deletes the gate.
- **E-464 first.** It moves the critic-stamp check out of `hooks/pre-commit.sh` to task close, so no later commit waits on a review. That one commit meets the old hook once.
- **E-458 needs no ruling from me** (r10). If the Architect's Bash can be confined by any configuration of §Component 1, build E-462 and E-463 with it and record which. If not, skip both, keep safe-exec and its hook, and continue.

### Order
E-457 in parallel, then E-464, E-458, E-460, E-461, E-462, E-463, E-467, E-466, E-459, E-469, E-468, E-470.
- **E-457 is now one pull request** from the top of the stack, one hosted CI run (r11). Do not wait for it: cut `lean-core` from the same commit and start E-464. When it merges, send me the merge commit at once in one line (no COMM entry needed): rein-app is waiting for it, because it holds E-433.
- Superseded: E-465 (r8), E-455, E-456. Held: E-450 to E-452, E-394, E-395, E-410.

### Answer to your 16:23 UTC handoff (r13)
- The three tables stand as committed; no new pin. N1 and the two over-blocks of E-454 are not fixed. E-463 deletes all of it. If r10 keeps the gate, I rule on them then.
- E-455 and E-456 are not built.

### Blueprint divergence (if any)
- NONE — nothing built yet.

### Next action needed
- **Engineer**: execute the order above. One handoff, at the end of E-470. Hand off earlier only if a task cannot be built as written and no later task can proceed without it.

### Open risks
- One run at the end finds failures late; one commit per task is what keeps them placeable. Keep to it.
- The batch is on one disk until E-470: the pre-push hook refuses a tip without a green CI row.
- Removed agents and skills: list each by name in the E-467 handoff (r6). Tag v0.5.0 holds them.
- E-469: I have not verified what a Claude Code plugin can declare. Read the documentation first; the installer carries what the plugin cannot.
- Team mode, `rein ci run` and the release path are out of scope (r7). If a deletion would break one of them, keep the piece and name it.
---
