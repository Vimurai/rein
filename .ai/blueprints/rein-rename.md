# Blueprint — Rein: the complete rename and the v0.4.0 line (D-131, D-132, D-132 addendum 2)

## Goal & Architecture
The published tree still spells the product `ai-os` in 250 files, `AI_OS_*` in 158 and `aios`
in identifiers; the command is `ai` in 271 files and 18 skills carry the `ai-` prefix. The
operator wants one name and no fallbacks. This blueprint renames every spelling of the old
name — the brand, the command, the skills — to the Rein form as a hard cut, and starts the
public version line at `0.4.0`. Users: the operator's machine (the only install today; the
operator migrates it by hand per §Component 4), every future public user (fresh install,
nothing to migrate), and the Triad that performs the work inside the public clone under the
privacy gates. In one sentence: rename everything except the directory `.ai/`, keep nothing of
the old names working, ship as `v0.4.0`.

Sequence (D-132 r7, addendum 2): E-378 step 8 (ci.yml for `main`, branch protection) → step 9
(clone switch, operator installs from the public clone) → E-382 (version) → E-384 (public CI
matrix, D-133) → E-383 (mechanical passes, built) → E-391 (command, skills, hard cut, classifier
v5, same PR, own commits) → tag `v0.4.0` → E-385 (mark) → E-390 (README) → E-392 (Windows leg)
→ archive `ai-os-dev`.

## Core Concept
A **name map** applied mechanically to the whole tree except a short **history and records
exclusion list**. No compatibility layer: no symlink, no environment fallback, no legacy
rewrite, no forwarder, no doctor hint — the old names exist only in history. The map is data
(a table in this file and a fixture in the repo), the gate is a grep: after the PR, the old
spellings, the old command and the old skill names match zero lines outside the exclusions,
and CI asserts it. Zero `rename:legacy-fallback` lines are allowed.

## Components

### Component 1 — Version 0.4.0 (E-382, D-131) — DONE
- `package.json` `0.4.0`; `rein version` reads it; README badge from the tag.
- CHANGELOG: `[0.4.0]` on top (content: the open-source release D-123..D-130, the rename
  D-132, the privacy gates); the `[4.0.0]`, `[3.1.0]`, `[2.0.0]` entries under a heading
  `## Private predecessor (AI-OS, 2025–2026)`; nothing renumbered.
- `project-upgrade.mjs` restamps `4.0.0 → 0.4.0` as today (unordered, `.pre-0.4.0.json`
  copies). `.ai/blueprints/version-lifecycle.md` gets one sentence: the public line restarts
  at 0.4.0; 2.x–4.x are the predecessor's numbers. No epoch, no downgrade warning.
- Every `4.0.0` literal in tests or docs that means "the current version" reads it from
  `package.json` instead; a literal that means "the predecessor" stays.

### Component 2 — Name map (E-383 rows 1–12 built; rows 13–18 are E-391, D-132 addendum 2 r1–r2, r9)
| Old | New | Where |
|---|---|---|
| `~/.ai-os` | `~/.rein` | installer, locate.sh, hooks, docs, settings templates |
| `AI_OS_<X>` | `REIN_<X>` | every env var; no resolver reads the old name |
| `AIOS_WORKSPACE` | `REIN_WORKSPACE` | task routing, installer |
| `AI_OS_HOME` | `REIN_HOME` | 36 uses |
| `[AI_OS_ROLE]` | `[REIN_ROLE]` | SessionStart hook, rulefile templates, contract tables |
| `install-ai-os.sh` | `install-rein.sh` | root; README quickstart; CI install step; no forwarder |
| `aios-record` (merge driver) | `rein-record` | templates, `rein sync`, `.gitattributes` |
| `project.aios_version` | `project.rein_version` | state-db, record-migrate, doctor, upgrade; the old key is not read |
| `aios`/`AIOS` prefixes, `ai_os_*` functions, `isUnderAiOs`/`isAiOsRepo` | `rein`/`REIN`, `rein_*`, `isUnderRein`/`isReinRepo` | identifiers, temp-dir prefixes, test names (gate is case-insensitive) |
| package names with `ai-os` | `rein` | root `@vimurai/rein`; any MCP package name |
| `AI-OS` / `ai-os` in prose | `Rein` / `rein` | README, docs, rulefiles, skills, agents, blueprints |
| `plans/native-vs-aios-audit.md` | `plans/native-vs-rein-audit.md` | the one plans/ filename |
| `ai <subcommand>` (the command) | `rein <subcommand>` | 271 files: installer, hooks, git hook stubs, settings and rulefile templates, skills, agents, contracts, suites, README, docs, live blueprints |
| `src/bin/ai`, `src/bin/ai-exec`, `src/bin/ai-account.sh` | `src/bin/rein`, `src/bin/rein-exec`, `src/bin/rein-account.sh` | the bin directory; installed as `~/.rein/bin/rein`; the installer deletes the old `ai` entry there |
| `ai-<skill>` (18 skills: archive, debug, digest, handoff, incident, insights, log, migration, preflight, profile, review, review-proposed-skills, seo, sync-state, task, test, triage, upgrade) | `rein-<skill>` | `.claude/skills/`, `src/shared/skills/`, `_SKILLS_INDEX.md`, `_SYNC_MANIFEST.json`, and every registry keyed on a skill name (rulefile templates, `src/claude/CLAUDE.md`, agents, `05_HANDSHAKE.md`, the RBAC map, the wake/skill tables in `src/bin/rein`, `comm-status.sh`, `markdown-exec.mjs`, `cli-state.mjs`, `legacy-import.mjs`, `telemetry.mjs`, `build-stamp.mjs`, hooks, `.claude/rules/`, suites, census baseline) |
| job `ai-ci-run`, display `ai ci run (<os>, node <n>, i/4)` | `rein-ci-run`, `rein ci run (…)` | `src/templates/ci/github.yml`, `requiredChecks()`, both profiles, the required-checks list on `main` (via `gh api`, in the merge step) |
| `AI-OS Gate Tamper (D-101)` rule text | `Rein Gate Tamper (D-132)` v5 (verbatim in D-132 addendum 2 r6) | `src/shared/classifier-backstop.py` constant + pin, `classifier_backstop_test.sh`; the E-318 refresh relabels installed copies |
| `rename:legacy-fallback` lines | (none) | the gate allows zero |

Unchanged: `.ai/` (the one survivor — no brand string; moving it would touch every project),
the skills without the `ai-` prefix (`arch-task`, `arch-oracle`, `arch-review`, `aqg-resolver`,
`ci_gate`, `repo-oracle`, …: the E-217 collision rule holds, `rein-review` ≠ `arch-review`),
the hook file names, the MCP server names, the tmux options (already `@rein_role`,
`@rein_account`).

### Component 3 — History and records exclusions (D-132 r2, addendum 2 r7)
Not rewritten — **history**: `.ai/DECISIONS.md`, `.ai/COMM.md`, `.ai/LOG.md`, `.ai/archive/**`,
`CHANGELOG.md` from the predecessor heading down, the README "Where this comes from"
paragraph, git history. **Records** (what was done, in the words it was done in):
`.ai/TASKS.md`, `.ai/state.json`, `.ai/REVIEWS.md`, `.ai/DEVOPS.md`. **Generated** (the next
`rein sync` and digest rewrite them): `.ai/DIGEST.md`, `.ai/REPO_MAP.md`. **Self-references**
(they must name what they rename): this blueprint, `tests/fixtures/rename-map.json`,
`tests/fixtures/rename-exclusions.json`, `tests/unit/rename-gate.test.mjs`. Nothing else: the
installer forwarder is deleted and the classifier files are rewritten (Component 6). The gate
reads this list from `tests/fixtures/rename-exclusions.json`, which must equal it.
The live blueprints, `architect.md` and the other `.ai/*.md` ARE rewritten by the Engineer —
string substitution only, one commit, the ruled §35 exception — and the substitution now
includes the command and the skill names.

### Component 4 — Hard cut and the operator's manual migration (D-132 addendum 2 r4–r5)
Withdrawn from this blueprint: the directory move and symlink, the `AI_OS_*` environment
fallback (`src/shared/env.mjs`, `rein_legacy_env_apply`), the legacy reads (`aios_version`,
`ci.aios_source`, `aios-record`), the `rein sync` legacy rewrites, the `install-ai-os.sh`
forwarder, the `[LEGACY_HOME_LINK]` / `[LEGACY_ENV]` / `[RENAME_PENDING]` doctor lines, the
`docs/upgrading.md` transition section, and the gate-guard and secret-rule rows that protected
the old home path. The commits that built them on the unpushed branch are removed (revert
commit or dropped — the Engineer's choice; the final tree is what is reviewed).

The operator (the only install) migrates by hand after the merge; the Engineer's handoff
carries this list verbatim, in this order (D-132 addendum 4 r1: the symlink goes LAST —
removing it before the projects are synced turns the gate off in every un-synced project,
because its settings register the hooks by the old absolute path and a hook that exits 127
is not a block). No code prints the old name; the installer and doctor name only what is
missing (addendum 4 r2):
1. `bash install-rein.sh` from the merged `main` (installs `~/.rein/bin/rein`; prints that
   the command is `rein`; then lists every registered project whose settings name a missing
   Rein hook path, each with `run: rein sync`).
2. `rein sync` in every project on that list (and any other): rulefiles, hook paths, merge
   driver and settings re-render from the templates; a Rein-named hook entry with a missing
   path is rewritten to the install path.
3. `rein doctor` in each project: no `[HOOK_PATH_MISSING]`, no `[GATE_UNREGISTERED]`,
   `[REIN_ROLE]` present.
4. Only now `rm ~/.ai-os` — today's reinstall left it as a symlink to `~/.rein`; it is a
   symlink, so `rm`, never `rm -r`. The gate rows that protected this path are gone, so it
   must go.
5. Remove any `AI_OS_*` export from shell rc files; nothing reads them.

Doctor and sync recognise a Rein hook entry by the hook's file name whatever directory it
names; doctor reports a missing path as `[HOOK_PATH_MISSING]`, no PreToolUse entry resolving
to the install's `hooks/pre-tool-use.sh` as `[GATE_UNREGISTERED]`, and a Rein-named hook
outside the install directory as `[HOOK_PATH_FOREIGN]`.

### Component 5 — Delivery (D-132 r7, addendum 2 r9)
In the public clone: branch `rename/rein`, one PR, the mechanical commits (E-383) separate
from the hand-written ones (E-391: command, skills, classifier v5, gate extension, the
removal of the compatibility layer), commits signed off as the noreply identity, privacy scan
+ `rein ci run` + DCO green. Because the job display name changes, the required-checks list
on `main` is updated with one `gh api` call in the merge step — new names in, old names out —
recorded in `.ai/DEVOPS.md`; then merge, `git tag -a v0.4.0` (release-manager skill) and the
GitHub release notes from the CHANGELOG entry. The operator then follows Component 4.

### Component 6 — Gates (D-132 addendum 2 r6, r8)
- Grep gate in CI (`tests/unit/rename-gate.test.mjs`), case-insensitive, zero matches outside
  Component 3's list, no `rename:legacy-fallback` exemption:
  - the brand: `ai[-_]os|aios`;
  - the command: `ai` + space + a subcommand, preceded by start-of-line or a character that is
    not a letter, digit, `_`, `.`, `/`, `@` or `-` (so `.ai/` never matches); the subcommand list
    is read from `src/bin/rein`'s dispatch table at test time;
  - the skills: `ai-` + one of the 18 suffixes, whole word;
  - literals: `bin/ai` (word end), `ai-exec`, `ai-account`, `ai-ci-run`, `ai ci run (`.
- Classifier text v5: constant and pin swapped together; `classifier_backstop_test.sh`
  asserts the `(D-132)` label and that `rein gate off` and the `~/.rein` tamper paths are
  blocked; the E-318 refresh test shows a `(D-101)` installed copy reported OUTDATED.
- The gate suites that assert tamper commands are blocked run against the `rein` token after
  the rename (a rule keyed on `ai` that stops matching is a fail-open — the risk this gate
  exists for); the security_engineer reviews the gate tables and the exempt lists.
- A provisioning test proves each role overlay resolves every skill it names; the skill-wake
  table names only `rein-*` skills.
- Contract tables renamed in the same commit as the hooks; no suite deleted or skipped.
- Install proof in CI uses `install-rein.sh` in a throwaway HOME: `~/.rein/bin/rein` exists,
  no `ai` entry beside it, `rein doctor` exit 0.

### Component 7 — Windows (WSL2) leg (E-392, D-132 addendum 2 r10; detail in `.ai/blueprints/public-ci.md` §Component 5)
`windows-latest × node 22 × 4 shards` in the public profile, informative until three green
runs on `main`, then required. Ubuntu 24.04 through the setup-wsl action (SHA-pinned), WSL 2
where the hosted image can start it, else WSL 1 named as such; the checkout is copied to the
Linux filesystem before anything runs; `bash install-rein.sh`; `rein ci run --shard i/4`.

## Data Model
```
tests/fixtures/rename-map.json          [{ "old": "AI_OS_HOME", "new": "REIN_HOME", "kind": "env|path|tag|id|prose|file|command|skill|job" }]
tests/fixtures/rename-exclusions.json   { files: { ".ai/DECISIONS.md", ".ai/COMM.md", ".ai/LOG.md", ".ai/TASKS.md", ".ai/state.json",
                                                   ".ai/REVIEWS.md", ".ai/DEVOPS.md", ".ai/DIGEST.md", ".ai/REPO_MAP.md",
                                                   ".ai/blueprints/rein-rename.md", "tests/fixtures/rename-map.json",
                                                   "tests/fixtures/rename-exclusions.json", "tests/unit/rename-gate.test.mjs" },
                                          prefixes: { ".ai/archive/" },
                                          sections: { "CHANGELOG.md" from the predecessor heading, "README.md" Where-this-comes-from } }
state.project: { rein_version: "0.4.0", provisioned_at: ISO }   (aios_version neither read nor written)
classifier RULE: "Rein Gate Tamper (D-132): …" (one line; the pin is its sha256)
skills: rein-<name> × 18 in .claude/skills and src/shared/skills; _SKILLS_INDEX.md and _SYNC_MANIFEST.json list only rein-* and unprefixed names
CI job: rein-ci-run; display "rein ci run (<os>, node <n>, i/4)"; requiredChecks() → the same strings
```

## API / Interface Contracts
- `rein <subcommand>` — the only command; `ai` is not found. The installer prints one line
  naming `rein`.
- `rein sync` — re-renders the project surfaces from the templates; prints one
  `merged|stamped` line per file; exit 0; no legacy detection.
- `rein doctor` — `[REIN_ROLE]` in the SessionStart stamp; no `[LEGACY_*]` or `[RENAME_PENDING]`.
- `install-rein.sh` — idempotent; creates `~/.rein`; deletes a stale `ai` in `~/.rein/bin`;
  never looks at the old home path.
- Skills — `skill: "rein-preflight"` etc.; a rulefile that names an `ai-*` skill is a gate
  failure, not a runtime fallback.
- `requiredChecks()` — returns the `rein ci run (…)` names; the merge step feeds them to `gh api`.

## Security
- The rename touches the hooks, the installer, the gate tables and the classifier (Tier 3).
  The specific risk is fail-open by token: a block rule or an exempt list keyed on `ai` that
  the mechanical pass misses silently stops matching `rein`. Component 6's suites assert the
  blocks after the rename; the security_engineer reviews every table that names the command.
- The gate rows that protected `~/.ai-os` are removed with the compatibility layer; the
  operator deletes the symlink (Component 4 step 2) so no protected content sits behind an
  unprotected path.
- The classifier text moves only by ruling (D-097 r4); v5 is quoted verbatim in D-132
  addendum 2 r6 and pinned.
- The privacy gates run on the PR; the rename commits carry no personal data by construction.

## Execution Constraints
- One PR, reviewable by diff stat: the mechanical commits (map applied) separate from the
  hand-written commits (classifier, gate, bin moves, skill registries, removal of the
  compatibility layer), so reviewers read the logic without 250 files of noise.
- The fast tier stays under its budget; the grep gate runs in the fast tier (one pass).
- No history rewrite on `main`, no force-push: `main` is protected. The unpushed branch may
  be rebased to drop the compatibility commits.
- The required-checks update and the merge happen in one sitting: between them no PR can go
  green.

## Rollback Plan
Revert the PR before the tag; the required-checks list is restored by the same `gh api` call
with the old names. After `v0.4.0` a revert is a re-rename, not planned. The operator's manual
migration (Component 4) has no automatic reverse: reinstalling the previous `main` restores
`ai` and `~/.ai-os` is re-created by that installer.

## E-## Task Breakdown
| Task | Tier | Scope | Depends on |
|---|---|---|---|
| E-382 | 2 | Component 1: version 0.4.0, CHANGELOG restructure, version-lifecycle sentence, literals read from package.json | E-378 steps 8–9 (DONE) |
| E-383 | 3 | Component 2 rows 1–12 (the brand, built on `rename/rein`), Component 3 fixtures, the first grep gate; its §Component 4 acceptance is withdrawn (E-391) | E-382 |
| E-391 | 3 | Component 2 rows 13–18 (command, bin, skills, CI names, classifier v5), Component 4 removal, Component 5 merge step, Component 6 gates; same PR, own commits, before the tag | E-383 |
| E-392 | 2 | Component 7 (with `public-ci.md` §Component 5): the Windows (WSL2) leg, informative then required | E-391 (after the tag) |
