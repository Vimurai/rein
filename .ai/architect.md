# ARCHITECT — Rein after the strip

> The top-level description of Rein as it is on `main` from v0.6.0. Decisions are in
> `.ai/DECISIONS.md`; where this file and a decision differ, the decision wins.
> Owner: the Architect. Rewritten 2026-11-25 (P-53, D-170, D-174).

## 1. What Rein is
Rein adds four things to Claude Code that the platform does not have (D-170). Everything else
was removed; tag `v0.5.0` holds what left.

1. **A durable task ledger.** Tasks, tiers, acceptance text and stamps live in `.ai/state.sqlite`
   and survive sessions. `TASKS.md`, `REVIEWS.md` and `DIGEST.md` are generated views.
2. **DONE by observed acceptance.** A Tier 2 or Tier 3 task closes only after a fresh agent has
   observed each clause of its Acceptance text.
3. **A decision record.** `DECISIONS.md`, `COMM.md` and the blueprints say why the code is as it is.
4. **Two roles with enforced lanes.** An Architect who plans and an Engineer who builds, each in
   its own pane, kept apart by the sandbox and not by instructions.

## 2. Roles and lanes
- **Architect**: writes `.ai/` and `plans/` only. Its session starts in `<project>/.ai`, so the
  sandbox makes nothing else writable (D-172 r2a). It has no network domain and does not push.
- **Engineer**: writes the project, not the Architect's blueprints, `architect.md` or
  `DECISIONS.md`. It cannot write `~/.rein`; the install is the operator's act (D-172 r8).
- **The boundary is the role settings file** that `rein pane <role>` passes to `claude --settings`:
  sandbox on, no unsandboxed retry, the write list, the `Edit` deny rules, no bypass mode
  (D-169 r3). Models and providers per role are in `.ai/roles.json` and `.ai/providers.json`.
- **The lane ledger** (`src/shared/lane-ledger.mjs`): the post-commit hook records every commit
  made outside the Architect's lane, and the pre-push hook refuses a pushed commit that changes
  a path outside `.ai/` and `plans/` unless the ledger names it.
- **The seatbelt** (`src/shared/seatbelt.mjs`) is a short advisory list of commands. It is not
  the boundary. The command-text gate was deleted (E-463).
- **Reports, not controls**: `[LANE_CODE]` names files under `.ai/` and `plans/` that are not
  records (D-172 r24). The test runner's guard reports a write under the real `~/.rein`
  (D-174 r16).
- **Proof**: `tests/suites/sandbox_escape_test.sh`, run on the operator's machine at every
  release with 0 FAIL and 0 UNKNOWN (D-172 r6, D-173 r4). Measured on Linux and WSL2 only.
- Pane mode is the only mode (D-171 r1). Details: `docs/role-sandbox.md`.

## 3. The ledger and the DONE gates
- One MCP server: `task-synchronizer-mcp`. Tasks are added with `add_task`, which refuses a task
  without a verb, a tier and an observable Acceptance clause.
- `src/shared/completion-gates.mjs` is the one gate list for DONE:
  - a green `rein ci run` for HEAD, or for an ancestor that differs only in `.ai/`;
  - Tier 2: `[REVIEW_PASS]` and `[ACCEPT_PASS]` for HEAD by the same rule;
  - Tier 3: those and `[SEC_CLEARED]`.
- A task overtaken by a decision closes with `superseded_by: D-###`.
- **A branch holds `origin/main` before its last stamps are taken**, so the merge commit differs
  from the stamped tip in `.ai/` only (D-174 r25). Only the Architect carries a stamp to another
  commit, under a ruling that names both commits and the check (D-174 r24).

## 4. Review by tier (D-169 r8)
| Tier | What | Review |
|---|---|---|
| 1 | no behaviour change: docs, text, renames | none |
| 2 | everything else | `reviewer`, then `critic_acceptance` |
| 3 | role boundary, install, hooks, secrets, release signing | Tier 2 plus one `security_engineer` round |

A further security round is the Architect's to order, as a re-probe of named payloads with no
discovery (D-164 r6, D-168 r2). Review is checked at task close, not at commit.

## 5. The record
- `rein decide --file <entry>` appends a numbered entry to `DECISIONS.md`. An addendum to an
  existing decision is written into the file by the Architect.
- `rein handoff --to <role> --file <entry>` writes the heading, appends the entry to `COMM.md`,
  archives all but the last ten entries, commits every changed `.ai/` path and prints the wake
  line for `SendMessage`.
- `rein done <id> --summary <text>` closes a task through the gates of section 3.
- Blueprints are written with the `blueprint-writer` skill. Their state is listed in section 9.

## 6. What ships
- **CLI**: `init`, `start`, `pane`, `sync`, `doctor` (with `--fitness`), `done`, `handoff`,
  `decide`, `review`, `ci run`, `state import`, `digest build`, `archive`, plus the release
  commands and `clean`.
- **Agents (4)**: `reviewer`, `critic_acceptance`, `security_engineer`, `test_engineer`.
- **Skills (5)**: `blueprint-writer`, `rein-review`, `rein-test`, `rein-debug`, `release-manager`.
- **Hooks (7)**: session start, waiting signal, state import, pre-commit, post-commit, pre-push,
  pre-tool-use.
- **Packaging**: the agents, skills and hooks ship as one Claude Code plugin; `rein init` writes
  the role settings files, which a plugin cannot carry (E-469).
- **For rein-app**: the waiting signal (`@rein_waiting`, D-160) and `docs/app-contract.md`.
  Whether rein-app is still needed is P-55.

## 7. CI and releases
- **CI runs once per batch, on the operator's word** (D-170 r1). Not between tasks.
- `rein ci run` is the local run. Hosted CI on GitHub Actions is the matrix of D-133. The
  Engineer merges on green hosted CI with the stamps recorded (D-169 r1).
- **Releases**: a pull request with the bump and the CHANGELOG; the operator creates and pushes
  the tag; `release.yml` builds the tarball, signs it with minisign and publishes; the Engineer
  verifies the assets with `rein release verify` (D-156, D-173). The signature is on the tarball.
  The git tag is a plain tag (D-173 addendum 1).
- The privacy scan (`src/shared/publish-scan.mjs`) runs at commit and in `privacy.yml`. Its
  accepted residuals are in D-174 r5 and r6.

## 8. The bar and what is not ruled
- `rein doctor --fitness` prints the scorecard of `lean-core.md` §Data Model. A row is done when
  the command says PASS (D-169 r11). Targets: at most 1 MCP server, 6 skills, 4 agents, 950 hook
  lines, 4096 bytes added to a session at start.
- **Left as it is, not ruled**: team mode (`team.json`, claims, the shared log). See
  `team-collaboration.md` and `docs/team-mode.md`.
- **Direction (D-176)**: Rein is the proof layer on top of Claude Code. No feature the platform
  has is rebuilt; a part the platform can replace is reused. First new feature: acceptance
  replay (`acceptance-replay.md`, E-478 to E-480). After it: rulings that are checked, then a
  brief by relevance; neither is ordered yet.
- **Open**: the reuse review of every part that may overlap with the platform, rein-app
  included (P-56); model routing by tier (P-54), which waits for that review.

## 9. Blueprints
All are in `.ai/blueprints/`. None is moved or deleted: decisions cite them by path, and git
holds them either way (D-174 r13).

**Current** (describe what is on `main`; a section about a removed part is dead text):
`lean-core`, `acceptance-replay` (ordered, not built yet), `harness-fitness` (the digest and the acceptance evaluator; its control ledger was
not built), `release-artifact`, `accounts`, `role-abstraction`, `team-collaboration`, `local-ci`,
`public-ci`, `ci-throughput`, `test-economics` (D-088 stands; the line budget is retired),
`test-harness-isolation`, `engineering-standards`, `open-source-release`, `version-lifecycle`,
`readme`, `demo-video`, `rein-rename`, `mcp` (a generated view).

**Not re-read after the strip** (read against the code before relying on one): `agents`,
`capabilities`, `database-integrity`, `git-hooks`, `structured-outputs`, `task-routing`,
`wal-checkpoint-node`, `workspace`.

**Historical** (the unit was removed, or the work is long done; kept as the record):
`aligner-hardening`, `architect-provider-parity`, `ast-repository-map`, `audit-remediations`,
`automated-incident-response`, `bootloader`, `caching`, `claude-code-optimizations`,
`claude-native-consolidation`, `cli-collapse`, `code-execution`, `dependency-maintenance`,
`doctor-and-cache-optimizations`, `drift-resolution-2026`, `ecc-integrations`,
`incident-tracker`, `interactive-bridge`, `interop`, `managed-agents-state-reconciliation`,
`mcp-router`, `meta-cognition`, `multimodal-rag-batching`, `native-first`,
`performance-profiling`, `post-audit-followups`, `seo-keyword-multiplier`, `smart-ci`,
`sovereignty-hardening`, `standards-checker-import-fix`, `system-hardening-phase3`,
`telemetry-hardening`, `token-optimization`, `universal-telemetry`, `workflow-optimizations`.
