# Blueprint — Rein: the complete rename and the v0.4.0 line (D-131, D-132)

## Goal & Architecture
The published tree still spells the product `ai-os` in 250 files, `AI_OS_*` in 158 and `aios`
in identifiers. The operator wants one name. This blueprint renames every spelling of the old
name to the Rein form, migrates existing installs and projects without a manual step, and
starts the public version line at `0.4.0`. Users: the operator's machine (installed from the
private line, projects stamped `4.0.0`), every future public user (fresh install, nothing to
migrate), and the Triad that performs the work inside the public clone under the privacy
gates. In one sentence: rename everything except the command `ai` and the directory `.ai/`,
keep the old names working for one release, ship as `v0.4.0`.

Sequence (D-132 r7): E-378 step 8 (ci.yml for `main`, branch protection) → step 9 (clone
switch, operator installs from the public clone — the last `install-ai-os.sh`) → E-382
(version, a small PR that proves the public flow) → E-384 (public CI matrix, D-133) → E-383 (rename, one PR, checked on the matrix) → tag `v0.4.0`
→ archive `ai-os-dev`.

## Core Concept
A **name map** applied mechanically to the whole tree except a short **history exclusion
list**, plus a **compatibility layer** (directory symlink, env fallback, project rewrite on
`ai sync`) that lives for exactly one minor release. The map is data (a table in this file
and a fixture in the repo), the gate is a grep: after the PR, the old spellings match zero
lines outside the exclusions, and CI asserts it.

## Components

### Component 1 — Version 0.4.0 (E-382, D-131)
- `package.json` `0.4.0`; `ai version` reads it; README badge from the tag.
- CHANGELOG: `[0.4.0]` on top (content: the open-source release D-123..D-130, the rename
  D-132, the privacy gates); the `[4.0.0]`, `[3.1.0]`, `[2.0.0]` entries under a heading
  `## Private predecessor (AI-OS, 2025–2026)`; nothing renumbered.
- `project-upgrade.mjs` restamps `4.0.0 → 0.4.0` as today (unordered, `.pre-0.4.0.json`
  copies). `.ai/blueprints/version-lifecycle.md` gets one sentence: the public line restarts
  at 0.4.0; 2.x–4.x are the predecessor's numbers. No epoch, no downgrade warning.
- Every `4.0.0` literal in tests or docs that means "the current version" reads it from
  `package.json` instead; a literal that means "the predecessor" stays.

### Component 2 — Name map (E-383, D-132 r1)
| Old | New | Where |
|---|---|---|
| `~/.ai-os` | `~/.rein` | installer, locate.sh, hooks, docs, settings templates |
| `AI_OS_<X>` | `REIN_<X>` | every env var; the resolver of Component 4 reads both |
| `AIOS_WORKSPACE` | `REIN_WORKSPACE` | task routing, installer |
| `AI_OS_HOME` | `REIN_HOME` | 36 uses |
| `[AI_OS_ROLE]` | `[REIN_ROLE]` | SessionStart hook, rulefile templates, contract tables |
| `install-ai-os.sh` | `install-rein.sh` | root; README quickstart; CI install step |
| `aios-record` (merge driver) | `rein-record` | templates, `ai sync`, `.gitattributes` |
| `project.aios_version` | `project.rein_version` | state-db, record-migrate, doctor, upgrade |
| `aios`/`AIOS` prefixes | `rein`/`REIN` | identifiers, temp-dir prefixes, test names |
| package names with `ai-os` | `rein` | root `@vimurai/rein`; any MCP package name |
| `AI-OS` / `ai-os` in prose | `Rein` / `rein` | README, docs, rulefiles, skills, agents, blueprints |
| `plans/native-vs-aios-audit.md` | `plans/native-vs-rein-audit.md` | the one plans/ filename |

Unchanged: `ai` (command, bin, the `ai-*` skill names), `.ai/`, hook file names, MCP server
names, the `[AI_OS_ROLE]`-pinning legacy tests named as such.

### Component 3 — History exclusions (D-132 r2)
Not rewritten: `.ai/DECISIONS.md`, `.ai/COMM.md`, `.ai/LOG.md`, `.ai/archive/**`,
`CHANGELOG.md` predecessor entries, the README "Where this comes from" paragraph, git
history. The grep gate (Component 6) reads this list from `tests/fixtures/rename-exclusions.json`.
The live blueprints and `architect.md` ARE rewritten by the Engineer — string substitution
only, one commit, the ruled §35 exception.

### Component 4 — Compatibility layer (D-132 r3–r5)
- **Directory**: `install-rein.sh` creates `~/.rein`; if `~/.ai-os` is a real directory and
  `~/.rein` is absent, move it and leave `~/.ai-os` → `~/.rein` as a symlink; an existing
  symlink is left alone. Doctor: `[LEGACY_HOME_LINK] ~/.ai-os → ~/.rein (remove after 0.5)`.
- **Env**: `src/shared/env.mjs` (new, tiny) and the matching function in `locate.sh` resolve
  `REIN_<X>` then `AI_OS_<X>`; doctor prints `[LEGACY_ENV] AI_OS_<X> → REIN_<X>` once per
  var. The hooks' untrusted-env guard keeps its fail-closed behaviour under the new name.
- **Projects** (`ai sync`): `.claude/settings.json` hook paths; `.gitattributes` and
  `.git/config` merge driver; rulefiles re-rendered; state key through `record-migrate`
  (reads `aios_version` for one release). Doctor: `[RENAME_PENDING] <file>` until synced.
- **Removal**: the 0.5 installer deletes the symlink and the env fallback; a tracked
  `docs/upgrading.md` section says so.

### Component 5 — Delivery (D-132 r7)
In the public clone: branch `rename/rein`, one PR, commits signed off as the noreply identity,
privacy scan + `ai ci run` + DCO green, merged, then `git tag -a v0.4.0` (release-manager
skill) and the GitHub release notes from the CHANGELOG entry. The operator reinstalls from
the merged `main` with `bash install-rein.sh && ai sync` (the first time under the new name).

### Component 6 — Gates
- Grep gate in CI (`tests/unit/rename-gate.test.mjs`): zero matches of
  `ai-os|AI-OS|AI_OS_|aios|AIOS` outside Component 3's list and outside the explicitly named
  legacy fallbacks (each carries the comment `rename:legacy-fallback`).
- Contract tables renamed in the same commit as the hooks; no suite deleted or skipped.
- Install proof in CI uses `install-rein.sh` in a throwaway HOME with a pre-seeded
  `~/.ai-os` to exercise the move + symlink path once.

## Data Model
```
tests/fixtures/rename-map.json          [{ "old": "AI_OS_HOME", "new": "REIN_HOME", "kind": "env|path|tag|id|prose|file" }]
tests/fixtures/rename-exclusions.json   ["\\.ai/DECISIONS\\.md", "\\.ai/COMM\\.md", "\\.ai/LOG\\.md", "\\.ai/archive/", "CHANGELOG\\.md#predecessor", "README\\.md#where-this-comes-from"]
state.project: { rein_version: "0.4.0", provisioned_at: ISO }   (aios_version read, never written, for one release)
doctor lines: [LEGACY_HOME_LINK] [LEGACY_ENV] [RENAME_PENDING]
```

## API / Interface Contracts
- `ai sync` — rewrites the three project surfaces (settings, merge driver, rulefiles) and
  restamps; prints one `merged|stamped` line per file; exit 0; a file it cannot parse is
  `error` and left untouched.
- `ai doctor` — the three new lines above; `[REIN_ROLE]` in the SessionStart stamp.
- `install-rein.sh` — idempotent; the move happens at most once; refuses to move when
  `~/.rein` already exists and `~/.ai-os` is a real directory (prints both paths, exit 2).
- `env.mjs: resolve(name) → { value, legacy: boolean }`.

## Security
- The rename touches the hooks and the installer (Tier 3): the untrusted-env guard, the
  locate chain and the role token keep their semantics; the security_engineer reviews the
  resolver, because a fallback that reads `AI_OS_*` after `REIN_*` must not let an inherited
  old variable override a new one (new wins; old only when new is unset).
- The symlink is created only inside `$HOME`; a `~/.ai-os` that is a symlink elsewhere is
  not followed.
- The privacy gates run on the PR; the rename commits carry no personal data by construction
  (string substitution of the product name only).

## Execution Constraints
- One PR, reviewable by diff stat: the mechanical commit (map applied) separate from the
  hand-written commits (resolver, installer move, sync rewrite, tests), so reviewers read the
  logic without 250 files of noise.
- The fast tier stays under its budget; the grep gate runs in the fast tier (one pass).
- No history rewrite, no force-push: `main` is protected.

## Rollback Plan
Revert the PR before 0.5: the symlink and the env fallback are symmetric, `record-migrate`
reads both keys, and the predecessor CHANGELOG is untouched. After 0.5 a revert needs a
re-rename, not planned.

## E-## Task Breakdown
| Task | Tier | Scope | Depends on |
|---|---|---|---|
| E-382 | 2 | Component 1: version 0.4.0, CHANGELOG restructure, version-lifecycle sentence, literals read from package.json | E-378 steps 8–9 |
| E-383 | 3 | Components 2–6: the rename, compatibility layer, project sync rewrite, grep gate, tag v0.4.0 | E-382 |
