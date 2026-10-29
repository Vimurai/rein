# E-340 over-blocks — the blocked commands, verbatim (for `tests/fixtures/operand-scope-cases.json`)

All three were issued through the Bash tool on 2026-10-23 and blocked by the safe-exec gate.
They are ALLOW cases. Each fenced block is one command exactly as sent, taken from the session
transcripts; the table references them by block number so the prose is never copied twice.

## Block 1 — finding 6, Engineer session: `[RM_RF_ROOT]` charged the `cd` operand to the `rm`

```
cd /home/dev/Dev/rein; find .ai/stale-2026-10-15 -maxdepth 1 -printf '%f %s\n'; rm -rf .ai/stale-2026-10-15 && git status --short
```

## Block 2 — Architect session, first attempt: D-105 appended with a quoted heredoc, `[ARCH_GIT_PUSH]` from the body's prose

```
cat >> .ai/DECISIONS.md <<'EOF'

---

## D-105 — D-102 §4 and D-103 amended: claims, the claim gate and the hosted check use the project's TRUNK (`team.json` `trunk`, else `origin/HEAD`, else the one of `main`/`master` that exists), never a hard-coded `master`

**Date**: 2026-10-23
**Task**: E-339 (Engineer). Amends `.ai/blueprints/team-collaboration.md` §Summary, §Core Concept and §Component 4/5 — wherever they say `origin/master` read `origin/<trunk>`; this repository's trunk is `master`.
**Decision**: The branch that claims are pushed to, that the claim gate reads, that `session-start.sh` fetches and that the hosted check guards is the project's trunk, resolved by one function with no network: `.ai/team.json` `trunk` when set, else the clone's `refs/remotes/origin/HEAD`, else whichever one of `main` / `master` exists under `refs/remotes/origin/`. Nothing in `src/`, `hooks/` or the CI templates names `master` as a branch any more.

### Why needed
The Engineer's 2026-10-23 handoff (finding 1) and the operator: "claims should use the repos real main branch or a branch set in team.json." `src/mcp/shared/task-claims.mjs` hard-codes `refs/remotes/origin/master` (fetch refspec, push target, every message); `src/templates/ci/*.yml` and the `hosted-ci.mjs` policy text do the same. In any team project whose trunk is `main`, `claim_task` returns `NO_MASTER`, `listClaims` says nothing is claimed, and the claim gate refuses every source write on `engineer/e<N>-*` with a `[CLAIM_REQUIRED]` that cannot be satisfied — the 4.1.0 headline feature is locked for the most common trunk name. D-102 §4 wrote "origin/master" meaning this repository's trunk and the implementation took it literally; the blueprint is amended by this ruling.

### Rulings
1. **Field.** `.ai/team.json` gains an optional `"trunk": "<branch>"` (a plain branch name, never `refs/heads/…`). `validateTeam` rejects anything `git check-ref-format --branch <name>` refuses ("trunk must be a valid branch name"). The creator of `team.json` (`ai state migrate --team`) records `trunk` at creation time, resolved as: `--trunk <name>` flag; else the clone's `refs/remotes/origin/HEAD`; else `git ls-remote --symref origin HEAD` bounded to 10 s (an operator command may touch the network; `set-head` is not used because it writes refs into the clone); else refuse `[NO_TRUNK] pass --trunk <name>`. An existing `team.json` without `trunk` (this repository's) is NOT edited by `ai sync` — it is a tracked team-wide file; `ai doctor` prints `[TRUNK_UNSET] .ai/team.json has no trunk — resolved <name> from <source>; add "trunk": "<name>"` and the resolver's fallback chain serves it.
2. **One resolver, no network.** `src/mcp/shared/trunk.mjs` exports `resolveTrunk(root)` → `{ name, source: "team.json"|"origin/HEAD"|"origin/<name>" }` or `null`: (a) `team.json` `trunk`; (b) `git symbolic-ref -q refs/remotes/origin/HEAD` stripped of `refs/remotes/origin/`; (c) exactly one of `refs/remotes/origin/main`, `refs/remotes/origin/master` exists → that one; both exist with no `origin/HEAD` → `null` with reason `TRUNK_AMBIGUOUS`; neither → `null` with reason `NO_TRUNK`. Every caller that receives `null` returns `[NO_TRUNK] <reason> — set "trunk" in .ai/team.json (or: git remote set-head origin --auto)`; the claim gate's `[CLAIM_REQUIRED]` line appends that reason so the lock is never silent. `ai trunk` (new CLI verb) prints the resolved name on one line, exit 1 with the `[NO_TRUNK]` line otherwise, so skills, agents and docs use `$(ai trunk)` instead of a literal.
3. **The framework never runs `git remote set-head`.** Hooks, gates, MCP tools and `ai sync` stay off the network beyond D-102's two bounded calls (the session-start fetch and the claim's own push); `set-head --auto` additionally writes a ref into the user's clone. The doctor line prints the command for the operator to run by hand.
4. **`team.json` wins over `origin/HEAD`.** The tracked file is the team's contract and travels with the repository; `origin/HEAD` is a per-clone cache that a `--single-branch` or mirror clone may lack or hold stale. When both exist and differ, `ai doctor` prints `[TRUNK_MISMATCH] team.json trunk=<a>, origin/HEAD=<b>` (not fatal) and the claim path uses `<a>`; if `refs/remotes/origin/<a>` does not exist after the fetch the claim returns `[TRUNK_MISSING] origin has no branch <a>` instead of today's `NO_MASTER`.
5. **The sweep.** `git grep -n "\bmaster\b" src hooks` is the task's first and last command. Code paths: `task-claims.mjs` (`MASTER_REF`, the fetch refspec, the push target, every message now says `origin/<name>` with the resolved name), `session-start.sh`, `claim-gate.mjs`, `task-synchronizer-mcp` messages and tool descriptions, `cli-state.mjs`, `run-handover.mjs`. Templates: `src/templates/ci/github.yml` and `azure-pipelines.yml` take a `{{TRUNK}}` placeholder (`branches:`, the workflow `name:`, the concurrency group) rendered by `hosted-ci.mjs` from the resolver, and the per-provider `policy` text names the resolved branch; `ai ci hosted --check` must still report this repository's `ci.yml` as current (its rendering is byte-identical, trunk `master`). `src/templates/CAPABILITIES.md` lines "git fetch origin master" / "git push origin <sha>:refs/heads/master" become `<trunk>`; if any gate parses those lines literally it must match the resolved name. Agents `critic_tests.md` / `test_engineer.md` use `$(ai trunk)` for `merge-base` / `diff`. Prose: `ai` help, `ai-preflight` and `ai-task` SKILL.md, README, the blueprint, say "the trunk (`origin/<trunk>`; `master` in this repository)". Historical sentences ("master carried invalid JSON for four commits", D-062) are history and stay.
6. **4.1.0 waits.** E-334 (README "Team setup", CHANGELOG 4.1.0, tag) depends on E-339: the release's first-run document would otherwise teach "claims on origin/master" and the gate would lock out every `main` repository the document is written for. A known-issue note was considered and rejected (Alternatives 4).

### Alternatives considered
1. **Add `main` as a second literal fallback** — rejected: two literals instead of one; `trunk`, `develop` and release branches stay broken, and the templates would still render `master`.
2. **Always `origin/HEAD`, with `git remote set-head origin --auto` in `session-start.sh`** — rejected: a network call and a ref write in a hook path (ruling 3), and `origin/HEAD` is absent in some clones; a tracked field is deterministic across the team.
3. **A `trunk` field in `.ai/project.json`** — rejected: `project.json` exists only in record-store projects, while `ai ci hosted` renders in legacy projects too; `team.json` already carries the team's git policy (`ci`, `claim_ttl_days`).
4. **Ship 4.1.0 now with a known-issue note** — rejected: the note would sit in the same README section that onboards a team, and the claim gate failing closed on `main` is not a degradation but a lockout; the fix is Tier 2 and bounded (ruling 5 is a grep).
5. **The chosen chain (team.json → origin/HEAD → main|master)** — selected: explicit beats inferred, inferred beats a literal, and each step is a local read.

### Constraints driving this decision
- D-102 §4 and D-099/D-100: gate paths stay offline and deterministic; one bounded fetch per session start.
- D-104 posture: a tracked file, no env var; the doctor reports what the model would otherwise forget.
- D-103: the hosted check is a rendered contract; the rendering for this repository must not change.

### Impact
- Unlocks: E-339; E-334 (after E-339); E-337's GitLab/Bitbucket templates render `{{TRUNK}}` from the start.
- Risk if wrong: a wrong trunk resolution pushes claim commits to the wrong branch — mitigated by `[TRUNK_MISSING]` (the branch must already exist on origin) and the doctor mismatch line.

### Rollback
Delete `trunk` from `team.json` and the resolver falls back to `origin/HEAD` / `master`; reverting E-339 restores the literal. No data migration is involved.

---

## D-106 — Legacy-mode `state.json` is imported on pull per record, and view regeneration is refused while the index is behind HEAD

**Date**: 2026-10-23
**Task**: E-340 (Engineer). Amends `.ai/blueprints/team-collaboration.md` §Component 2 (import on pull), which today applies to record-store projects only.
**Decision**: In a project without `.ai/team.json` (legacy mode) the tracked `.ai/state.json` stays tracked and is the cross-machine truth, `state.sqlite` is the per-machine index of it, and the E-326 import runs in legacy mode too: when `HEAD:.ai/state.json` is a blob the index has not imported, its records are merged into the index per record (never deleting local work); every view regeneration and `verify_markdown_sync` first check the index against HEAD and refuse with `[STATE_BEHIND_HEAD]` instead of rewriting the committed views from a stale index.

### Why needed
Finding 5 (Engineer addendum, 2026-10-23): after merging PRs #109..#112 the local index still held the 2026-10-15 state (max E-324); the next regeneration rewrote `state.json`, `TASKS.md` and `REVIEWS.md` from it, silently undoing E-325..E-337 and the archive, and `verify_markdown_sync` reported `[SYNC_PASS]` because it compared the views against the same stale index. `getDbSeeded` imports `state.json` only when the database file does not exist (`src/mcp/shared/state-db.js:155-164`); `importRecords` returns `LEGACY` and `hooks/state-import.sh` exits early without `project.json`. Every pre-4.1 project used on two machines, this repository included, loses a pull this way.

### Rulings
1. **Keep tracking `state.json` in legacy mode.** It is the only thing that travels between machines before `ai state migrate --team`; D-102's migration itself reads it. Legacy mode gets the same posture D-102 gave team mode: the tracked artefact is the truth, sqlite is a rebuildable index.
2. **Import keyed on the blob.** The index records `last_import_blob` = `git rev-parse HEAD:.ai/state.json` (the blob id, so a commit that did not touch the file is a no-op without parsing) and mirrors it into gitignored `.ai/.last-import-blob` so `hooks/state-import.sh` can compare two strings in bash and start node only when they differ. Triggers: the E-326 four (`post-merge`, `post-checkout` branch, `post-rewrite`, SessionStart) plus `ai sync`; the hook's `project.json` early exit goes.
3. **Merge per record, never delete.** For each task in HEAD's document: absent locally → inserted; present on both sides → HEAD's version replaces the local one when HEAD's `updated_at` is newer (E-340 adds `updated_at` to every legacy task write; a record without it on either side takes HEAD when HEAD carries a `completed_at` the local record lacks or has an older one, else keeps local). Stamps, deltas and CI records are keyed by their natural key (timestamp + type + task) and inserted when absent. Id counters and `nextId` become the max of both sides. Project focus takes HEAD's value only when the local one is unchanged since the last import. Local-only records are never removed: a pull cannot erase the task the operator just added. The import prints one line: `[STATE_IMPORT] legacy: +N tasks (E-a..E-b), ~M updated, +K stamps from HEAD <sha7>`, and when records changed on both sides an informational `[STATE_DIVERGED] … consider: ai state migrate --team`.
4. **The guard.** Before any view regeneration (every MCP mutation path, `verify_markdown_sync`, `ai sync`) the synchronizer compares `HEAD:.ai/state.json` with the index, cached by blob id: if HEAD holds a task id the index lacks, or a stamp newer than the index's latest, the regeneration is refused with `[STATE_BEHIND_HEAD] HEAD has E-a..E-b the index lacks — run: ai state import` and `verify_markdown_sync` returns `[SYNC_FAIL]` carrying that line. `[SYNC_PASS]` is impossible while behind. The guard never writes.
5. **Escape.** `ai state import --force` ignores `last_import_blob` and reruns the merge (ruling 3). No env var and no flag that skips the guard: a regeneration that overwrites HEAD is the loss this ruling exists to prevent.

### Alternatives considered
1. **Stop tracking `state.json` in legacy mode and point multi-machine users to `ai state migrate --team`** — rejected: it removes the only transport pre-4.1 projects have, overnight, and the migration itself needs the tracked file on the second machine.
2. **Replace the index wholesale from HEAD when HEAD is newer** — rejected: it erases local uncommitted work (a task added since the last commit) and "newer" is undefined once two machines diverged; per-record merge is what E-326 already does for record files.
3. **Guard only (ruling 4) without import** — rejected: it turns silent loss into a hard stop with no way forward except hand surgery, which is what the operator did on 2026-10-23.
4. **Import keyed on the commit (`last_import_head`, as E-326)** — rejected for legacy: the single document changes on most commits only through its views; the blob id makes untouched commits free.
5. **Per-record merge plus guard (chosen)** — selected: no data path can lose records, the guard makes a stale index visible before it writes, and the operator's recovery becomes one command.

### Constraints driving this decision
- `.claude/rules/ai-bookkeeping.md`: views are generated; the fix must live in the generator, not in a hand edit.
- D-102 §Component 2 and E-326: same triggers, same vocabulary (`[STATE_IMPORT]`), same hook file.
- Hook cost: `post-checkout` runs on every branch switch — the bash blob compare keeps node out of the common path.

### Impact
- Unlocks: E-340; E-334 (4.1.0 depends on it — the "Team" release must not lose a pull on the projects it has not migrated).
- Risk if wrong: a merge rule that prefers the wrong side on a conflicting record — bounded to one record, visible in the `[STATE_IMPORT]` line, recoverable with `--force` after fixing the file.

### Rollback
Revert E-340; the index returns to seed-once behaviour. `.ai/.last-import-blob` is gitignored and safe to delete.

---

## D-107 — `ai sync` reports a failed step as FAILED (exit 1, cause on one line) and probes the safe-exec gate it leaves behind

**Date**: 2026-10-23
**Task**: E-341 (Engineer). Amends the E-98 "fail-open" note in `src/bin/ai` `_generate_repo_map`: non-fatal still means every step runs; it no longer means silent.
**Decision**: A sync step has three outcomes — ok, skipped (the tool is absent or disabled by its env var, by design) and FAILED (the tool is present, ran, and exited non-zero). A failed step prints `✗ <step>: <last stderr line>` and the path of its captured stderr, every step still runs, the summary says `Done. (steps: N ok, M skipped, F FAILED — see the ✗ lines)` and `ai sync` exits 1 when F > 0. A new last step `gate_check` runs the mirror's safe-exec analyzer exactly as `hooks/pre-tool-use.sh` does, on the command `true`; no verdict or a non-zero exit is `✗ gate_check: [SAFE_EXEC_BROKEN] <reason> — run: bash install-rein.sh`. Sync never runs the installer itself.

### Why needed
Findings 2 and 3 (Engineer, 2026-10-23): `ai sync` printed `⚠ REPO_MAP.md generation failed — non-fatal` with the cause discarded (`2>/dev/null`), then `Done. (steps: 13 ok)`; the same sync left the pre-tool-use gate returning `[SAFE_EXEC_UNAVAILABLE] safe-exec exited 1`, so every Bash call in both panes was blocked and the Engineer could not even commit the handoff that reported it. The operator: "this should not happen in future." Both are one defect: sync counts a step that failed as ok.

### Rulings
1. **Outcomes.** `_sync_step` reads the step's return code: 0 ok, 2 skipped, anything else FAILED. Each step function returns 2 for its by-design skips (node absent, server not installed, `REIN_DISABLE_*=1`) and lets a real failure through. Stderr of every step is captured to `${TMPDIR:-/tmp}/ai-sync-<step>.<pid>.log`; on failure the last non-empty line (cut at 200 chars) is printed after `✗ <step>:` with the log path. Nothing aborts early: all steps run, then the summary, then exit 1 if any failed.
2. **REPO_MAP.** `_generate_repo_map` drops `2>/dev/null`; the current failure's cause becomes visible and E-341 fixes it (acceptance: `ai sync` in this repository regenerates `.ai/REPO_MAP.md`). The map stays non-fatal in the sense of ruling 1 only.
3. **Gate probe.** The hook's analyzer invocation (locator, node, timeout, verdict parse) is factored into `src/shared/gate-probe.sh`, sourced by `hooks/pre-tool-use.sh` and by sync's `gate_check` step and `ai doctor`, so the probe cannot drift from the gate. The probe runs `true` through the analyzer; PASS is ok; anything else is FAILED with the analyzer's stderr line. `ai doctor` prints the same `✓ safe-exec gate: <verdict>` / `✗ … [SAFE_EXEC_BROKEN]` line.
4. **No self-repair.** `bash install-rein.sh` rewrites `~/.rein` and the git hooks; D-083's posture is that the gate's own install is an operator action, and a sync run from the Architect pane must not reinstall the gate that confines it. The failed line names the command; the operator runs it.
5. **Exit code consumers.** The SessionStart hook and any skill that calls `ai sync` treat exit 1 as "sync ran, something failed, read the ✗ lines" — not as a reason to skip the session.

### Alternatives considered
1. **Keep "non-fatal" warnings, add the error line only** — rejected: the summary would still say every step was ok and the exit code would still be 0; the operator's complaint is the lie, not the missing detail.
2. **Make a failed REPO_MAP abort sync** — rejected: the map is a derived cache; the remaining steps (hooks, gitignore, version stamp) matter more and must still run.
3. **Have sync run `install-rein.sh` when the gate is broken** — rejected (ruling 4).
4. **Three outcomes, capture stderr, probe the gate, exit 1 (chosen)** — selected: honest summary, zero new flags, and the probe shares the hook's code path.

### Constraints driving this decision
- E-125/E-291/D-083: the gate fails closed and is installed by the operator only.
- D-104/D-088 posture: no new environment variable to silence a failure.
- Skipped-by-design must stay quiet so a fresh clone without optional tools is not red.

### Impact
- Unlocks: E-341. Finding 3's root cause becomes diagnosable the first time it recurs.
- Risk if wrong: a step that legitimately returns non-zero on a clean machine turns sync red — the ✗ line says which, and the fix is to return 2 from that step's by-design branch.

### Rollback
Revert E-341: steps return to warn-and-continue. No state is involved.

---
EOF
echo "appended; D count: $(grep -c '^## D-' .ai/DECISIONS.md)"; tail -3 .ai/DECISIONS.md | head -1
```

## Block 3 — Architect session, second attempt: the same append with the `cd <abs> &&` prefix

```
cd /home/dev/Dev/rein && cat >> .ai/DECISIONS.md <<'EOF'

---

## D-105 — D-102 §4 and D-103 amended: claims, the claim gate and the hosted check use the project's TRUNK (`team.json` `trunk`, else `origin/HEAD`, else the one of `main`/`master` that exists), never a hard-coded `master`

**Date**: 2026-10-23
**Task**: E-339 (Engineer). Amends `.ai/blueprints/team-collaboration.md` §Summary, §Core Concept and §Component 4/5 — wherever they say `origin/master` read `origin/<trunk>`; this repository's trunk is `master`.
**Decision**: The branch that claims are pushed to, that the claim gate reads, that `session-start.sh` fetches and that the hosted check guards is the project's trunk, resolved by one function with no network: `.ai/team.json` `trunk` when set, else the clone's `refs/remotes/origin/HEAD`, else whichever one of `main` / `master` exists under `refs/remotes/origin/`. Nothing in `src/`, `hooks/` or the CI templates names `master` as a branch any more.

### Why needed
The Engineer's 2026-10-23 handoff (finding 1) and the operator: "claims should use the repos real main branch or a branch set in team.json." `src/mcp/shared/task-claims.mjs` hard-codes `refs/remotes/origin/master` (fetch refspec, push target, every message); `src/templates/ci/*.yml` and the `hosted-ci.mjs` policy text do the same. In any team project whose trunk is `main`, `claim_task` returns `NO_MASTER`, `listClaims` says nothing is claimed, and the claim gate refuses every source write on `engineer/e<N>-*` with a `[CLAIM_REQUIRED]` that cannot be satisfied — the 4.1.0 headline feature is locked for the most common trunk name. D-102 §4 wrote "origin/master" meaning this repository's trunk and the implementation took it literally; the blueprint is amended by this ruling.

### Rulings
1. **Field.** `.ai/team.json` gains an optional `"trunk": "<branch>"` (a plain branch name, never `refs/heads/…`). `validateTeam` rejects anything `git check-ref-format --branch <name>` refuses ("trunk must be a valid branch name"). The creator of `team.json` (`ai state migrate --team`) records `trunk` at creation time, resolved as: `--trunk <name>` flag; else the clone's `refs/remotes/origin/HEAD`; else `git ls-remote --symref origin HEAD` bounded to 10 s (an operator command may touch the network; `set-head` is not used because it writes refs into the clone); else refuse `[NO_TRUNK] pass --trunk <name>`. An existing `team.json` without `trunk` (this repository's) is NOT edited by `ai sync` — it is a tracked team-wide file; `ai doctor` prints `[TRUNK_UNSET] .ai/team.json has no trunk — resolved <name> from <source>; add "trunk": "<name>"` and the resolver's fallback chain serves it.
2. **One resolver, no network.** `src/mcp/shared/trunk.mjs` exports `resolveTrunk(root)` → `{ name, source: "team.json"|"origin/HEAD"|"origin/<name>" }` or `null`: (a) `team.json` `trunk`; (b) `git symbolic-ref -q refs/remotes/origin/HEAD` stripped of `refs/remotes/origin/`; (c) exactly one of `refs/remotes/origin/main`, `refs/remotes/origin/master` exists → that one; both exist with no `origin/HEAD` → `null` with reason `TRUNK_AMBIGUOUS`; neither → `null` with reason `NO_TRUNK`. Every caller that receives `null` returns `[NO_TRUNK] <reason> — set "trunk" in .ai/team.json (or: git remote set-head origin --auto)`; the claim gate's `[CLAIM_REQUIRED]` line appends that reason so the lock is never silent. `ai trunk` (new CLI verb) prints the resolved name on one line, exit 1 with the `[NO_TRUNK]` line otherwise, so skills, agents and docs use `$(ai trunk)` instead of a literal.
3. **The framework never runs `git remote set-head`.** Hooks, gates, MCP tools and `ai sync` stay off the network beyond D-102's two bounded calls (the session-start fetch and the claim's own push); `set-head --auto` additionally writes a ref into the user's clone. The doctor line prints the command for the operator to run by hand.
4. **`team.json` wins over `origin/HEAD`.** The tracked file is the team's contract and travels with the repository; `origin/HEAD` is a per-clone cache that a `--single-branch` or mirror clone may lack or hold stale. When both exist and differ, `ai doctor` prints `[TRUNK_MISMATCH] team.json trunk=<a>, origin/HEAD=<b>` (not fatal) and the claim path uses `<a>`; if `refs/remotes/origin/<a>` does not exist after the fetch the claim returns `[TRUNK_MISSING] origin has no branch <a>` instead of today's `NO_MASTER`.
5. **The sweep.** `git grep -n "\bmaster\b" src hooks` is the task's first and last command. Code paths: `task-claims.mjs` (`MASTER_REF`, the fetch refspec, the push target, every message now says `origin/<name>` with the resolved name), `session-start.sh`, `claim-gate.mjs`, `task-synchronizer-mcp` messages and tool descriptions, `cli-state.mjs`, `run-handover.mjs`. Templates: `src/templates/ci/github.yml` and `azure-pipelines.yml` take a `{{TRUNK}}` placeholder (`branches:`, the workflow `name:`, the concurrency group) rendered by `hosted-ci.mjs` from the resolver, and the per-provider `policy` text names the resolved branch; `ai ci hosted --check` must still report this repository's `ci.yml` as current (its rendering is byte-identical, trunk `master`). `src/templates/CAPABILITIES.md` lines "git fetch origin master" / "git push origin <sha>:refs/heads/master" become `<trunk>`; if any gate parses those lines literally it must match the resolved name. Agents `critic_tests.md` / `test_engineer.md` use `$(ai trunk)` for `merge-base` / `diff`. Prose: `ai` help, `ai-preflight` and `ai-task` SKILL.md, README, the blueprint, say "the trunk (`origin/<trunk>`; `master` in this repository)". Historical sentences ("master carried invalid JSON for four commits", D-062) are history and stay.
6. **4.1.0 waits.** E-334 (README "Team setup", CHANGELOG 4.1.0, tag) depends on E-339: the release's first-run document would otherwise teach "claims on origin/master" and the gate would lock out every `main` repository the document is written for. A known-issue note was considered and rejected (Alternatives 4).

### Alternatives considered
1. **Add `main` as a second literal fallback** — rejected: two literals instead of one; `trunk`, `develop` and release branches stay broken, and the templates would still render `master`.
2. **Always `origin/HEAD`, with `git remote set-head origin --auto` in `session-start.sh`** — rejected: a network call and a ref write in a hook path (ruling 3), and `origin/HEAD` is absent in some clones; a tracked field is deterministic across the team.
3. **A `trunk` field in `.ai/project.json`** — rejected: `project.json` exists only in record-store projects, while `ai ci hosted` renders in legacy projects too; `team.json` already carries the team's git policy (`ci`, `claim_ttl_days`).
4. **Ship 4.1.0 now with a known-issue note** — rejected: the note would sit in the same README section that onboards a team, and the claim gate failing closed on `main` is not a degradation but a lockout; the fix is Tier 2 and bounded (ruling 5 is a grep).
5. **The chosen chain (team.json → origin/HEAD → main|master)** — selected: explicit beats inferred, inferred beats a literal, and each step is a local read.

### Constraints driving this decision
- D-102 §4 and D-099/D-100: gate paths stay offline and deterministic; one bounded fetch per session start.
- D-104 posture: a tracked file, no env var; the doctor reports what the model would otherwise forget.
- D-103: the hosted check is a rendered contract; the rendering for this repository must not change.

### Impact
- Unlocks: E-339; E-334 (after E-339); E-337's GitLab/Bitbucket templates render `{{TRUNK}}` from the start.
- Risk if wrong: a wrong trunk resolution pushes claim commits to the wrong branch — mitigated by `[TRUNK_MISSING]` (the branch must already exist on origin) and the doctor mismatch line.

### Rollback
Delete `trunk` from `team.json` and the resolver falls back to `origin/HEAD` / `master`; reverting E-339 restores the literal. No data migration is involved.

---

## D-106 — Legacy-mode `state.json` is imported on pull per record, and view regeneration is refused while the index is behind HEAD

**Date**: 2026-10-23
**Task**: E-340 (Engineer). Amends `.ai/blueprints/team-collaboration.md` §Component 2 (import on pull), which today applies to record-store projects only.
**Decision**: In a project without `.ai/team.json` (legacy mode) the tracked `.ai/state.json` stays tracked and is the cross-machine truth, `state.sqlite` is the per-machine index of it, and the E-326 import runs in legacy mode too: when `HEAD:.ai/state.json` is a blob the index has not imported, its records are merged into the index per record (never deleting local work); every view regeneration and `verify_markdown_sync` first check the index against HEAD and refuse with `[STATE_BEHIND_HEAD]` instead of rewriting the committed views from a stale index.

### Why needed
Finding 5 (Engineer addendum, 2026-10-23): after merging PRs #109..#112 the local index still held the 2026-10-15 state (max E-324); the next regeneration rewrote `state.json`, `TASKS.md` and `REVIEWS.md` from it, silently undoing E-325..E-337 and the archive, and `verify_markdown_sync` reported `[SYNC_PASS]` because it compared the views against the same stale index. `getDbSeeded` imports `state.json` only when the database file does not exist (`src/mcp/shared/state-db.js:155-164`); `importRecords` returns `LEGACY` and `hooks/state-import.sh` exits early without `project.json`. Every pre-4.1 project used on two machines, this repository included, loses a pull this way.

### Rulings
1. **Keep tracking `state.json` in legacy mode.** It is the only thing that travels between machines before `ai state migrate --team`; D-102's migration itself reads it. Legacy mode gets the same posture D-102 gave team mode: the tracked artefact is the truth, sqlite is a rebuildable index.
2. **Import keyed on the blob.** The index records `last_import_blob` = `git rev-parse HEAD:.ai/state.json` (the blob id, so a commit that did not touch the file is a no-op without parsing) and mirrors it into gitignored `.ai/.last-import-blob` so `hooks/state-import.sh` can compare two strings in bash and start node only when they differ. Triggers: the E-326 four (`post-merge`, `post-checkout` branch, `post-rewrite`, SessionStart) plus `ai sync`; the hook's `project.json` early exit goes.
3. **Merge per record, never delete.** For each task in HEAD's document: absent locally → inserted; present on both sides → HEAD's version replaces the local one when HEAD's `updated_at` is newer (E-340 adds `updated_at` to every legacy task write; a record without it on either side takes HEAD when HEAD carries a `completed_at` the local record lacks or has an older one, else keeps local). Stamps, deltas and CI records are keyed by their natural key (timestamp + type + task) and inserted when absent. Id counters and `nextId` become the max of both sides. Project focus takes HEAD's value only when the local one is unchanged since the last import. Local-only records are never removed: a pull cannot erase the task the operator just added. The import prints one line: `[STATE_IMPORT] legacy: +N tasks (E-a..E-b), ~M updated, +K stamps from HEAD <sha7>`, and when records changed on both sides an informational `[STATE_DIVERGED] … consider: ai state migrate --team`.
4. **The guard.** Before any view regeneration (every MCP mutation path, `verify_markdown_sync`, `ai sync`) the synchronizer compares `HEAD:.ai/state.json` with the index, cached by blob id: if HEAD holds a task id the index lacks, or a stamp newer than the index's latest, the regeneration is refused with `[STATE_BEHIND_HEAD] HEAD has E-a..E-b the index lacks — run: ai state import` and `verify_markdown_sync` returns `[SYNC_FAIL]` carrying that line. `[SYNC_PASS]` is impossible while behind. The guard never writes.
5. **Escape.** `ai state import --force` ignores `last_import_blob` and reruns the merge (ruling 3). No env var and no flag that skips the guard: a regeneration that overwrites HEAD is the loss this ruling exists to prevent.

### Alternatives considered
1. **Stop tracking `state.json` in legacy mode and point multi-machine users to `ai state migrate --team`** — rejected: it removes the only transport pre-4.1 projects have, overnight, and the migration itself needs the tracked file on the second machine.
2. **Replace the index wholesale from HEAD when HEAD is newer** — rejected: it erases local uncommitted work (a task added since the last commit) and "newer" is undefined once two machines diverged; per-record merge is what E-326 already does for record files.
3. **Guard only (ruling 4) without import** — rejected: it turns silent loss into a hard stop with no way forward except hand surgery, which is what the operator did on 2026-10-23.
4. **Import keyed on the commit (`last_import_head`, as E-326)** — rejected for legacy: the single document changes on most commits only through its views; the blob id makes untouched commits free.
5. **Per-record merge plus guard (chosen)** — selected: no data path can lose records, the guard makes a stale index visible before it writes, and the operator's recovery becomes one command.

### Constraints driving this decision
- `.claude/rules/ai-bookkeeping.md`: views are generated; the fix must live in the generator, not in a hand edit.
- D-102 §Component 2 and E-326: same triggers, same vocabulary (`[STATE_IMPORT]`), same hook file.
- Hook cost: `post-checkout` runs on every branch switch — the bash blob compare keeps node out of the common path.

### Impact
- Unlocks: E-340; E-334 (4.1.0 depends on it — the "Team" release must not lose a pull on the projects it has not migrated).
- Risk if wrong: a merge rule that prefers the wrong side on a conflicting record — bounded to one record, visible in the `[STATE_IMPORT]` line, recoverable with `--force` after fixing the file.

### Rollback
Revert E-340; the index returns to seed-once behaviour. `.ai/.last-import-blob` is gitignored and safe to delete.

---

## D-107 — `ai sync` reports a failed step as FAILED (exit 1, cause on one line) and probes the safe-exec gate it leaves behind

**Date**: 2026-10-23
**Task**: E-341 (Engineer). Amends the E-98 "fail-open" note in `src/bin/ai` `_generate_repo_map`: non-fatal still means every step runs; it no longer means silent.
**Decision**: A sync step has three outcomes — ok, skipped (the tool is absent or disabled by its env var, by design) and FAILED (the tool is present, ran, and exited non-zero). A failed step prints `✗ <step>: <last stderr line>` and the path of its captured stderr, every step still runs, the summary says `Done. (steps: N ok, M skipped, F FAILED — see the ✗ lines)` and `ai sync` exits 1 when F > 0. A new last step `gate_check` runs the mirror's safe-exec analyzer exactly as `hooks/pre-tool-use.sh` does, on the command `true`; no verdict or a non-zero exit is `✗ gate_check: [SAFE_EXEC_BROKEN] <reason> — run: bash install-rein.sh`. Sync never runs the installer itself.

### Why needed
Findings 2 and 3 (Engineer, 2026-10-23): `ai sync` printed `⚠ REPO_MAP.md generation failed — non-fatal` with the cause discarded (`2>/dev/null`), then `Done. (steps: 13 ok)`; the same sync left the pre-tool-use gate returning `[SAFE_EXEC_UNAVAILABLE] safe-exec exited 1`, so every Bash call in both panes was blocked and the Engineer could not even commit the handoff that reported it. The operator: "this should not happen in future." Both are one defect: sync counts a step that failed as ok.

### Rulings
1. **Outcomes.** `_sync_step` reads the step's return code: 0 ok, 2 skipped, anything else FAILED. Each step function returns 2 for its by-design skips (node absent, server not installed, `REIN_DISABLE_*=1`) and lets a real failure through. Stderr of every step is captured to `${TMPDIR:-/tmp}/ai-sync-<step>.<pid>.log`; on failure the last non-empty line (cut at 200 chars) is printed after `✗ <step>:` with the log path. Nothing aborts early: all steps run, then the summary, then exit 1 if any failed.
2. **REPO_MAP.** `_generate_repo_map` drops `2>/dev/null`; the current failure's cause becomes visible and E-341 fixes it (acceptance: `ai sync` in this repository regenerates `.ai/REPO_MAP.md`). The map stays non-fatal in the sense of ruling 1 only.
3. **Gate probe.** The hook's analyzer invocation (locator, node, timeout, verdict parse) is factored into `src/shared/gate-probe.sh`, sourced by `hooks/pre-tool-use.sh` and by sync's `gate_check` step and `ai doctor`, so the probe cannot drift from the gate. The probe runs `true` through the analyzer; PASS is ok; anything else is FAILED with the analyzer's stderr line. `ai doctor` prints the same `✓ safe-exec gate: <verdict>` / `✗ … [SAFE_EXEC_BROKEN]` line.
4. **No self-repair.** `bash install-rein.sh` rewrites `~/.rein` and the git hooks; D-083's posture is that the gate's own install is an operator action, and a sync run from the Architect pane must not reinstall the gate that confines it. The failed line names the command; the operator runs it.
5. **Exit code consumers.** The SessionStart hook and any skill that calls `ai sync` treat exit 1 as "sync ran, something failed, read the ✗ lines" — not as a reason to skip the session.

### Alternatives considered
1. **Keep "non-fatal" warnings, add the error line only** — rejected: the summary would still say every step was ok and the exit code would still be 0; the operator's complaint is the lie, not the missing detail.
2. **Make a failed REPO_MAP abort sync** — rejected: the map is a derived cache; the remaining steps (hooks, gitignore, version stamp) matter more and must still run.
3. **Have sync run `install-rein.sh` when the gate is broken** — rejected (ruling 4).
4. **Three outcomes, capture stderr, probe the gate, exit 1 (chosen)** — selected: honest summary, zero new flags, and the probe shares the hook's code path.

### Constraints driving this decision
- E-125/E-291/D-083: the gate fails closed and is installed by the operator only.
- D-104/D-088 posture: no new environment variable to silence a failure.
- Skipped-by-design must stay quiet so a fresh clone without optional tools is not red.

### Impact
- Unlocks: E-341. Finding 3's root cause becomes diagnosable the first time it recurs.
- Risk if wrong: a step that legitimately returns non-zero on a clean machine turns sync red — the ✗ line says which, and the fix is to return 2 from that step's by-design branch.

### Rollback
Revert E-341: steps return to warn-and-continue. No state is involved.

---
EOF
echo "appended; D count: $(grep -c '^## D-' .ai/DECISIONS.md)"; tail -3 .ai/DECISIONS.md | head -1
```
