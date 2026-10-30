# DIGEST — AI-OS v2 (Updated: 2026-10-22)

## Product
- Autonomous OS for AI coding agents: a Claude-native Triad (Architect `claude`/fable, Engineer `claude`/opus, headless Tester via `skill: ai-test`) coordinated through ACID SQLite state in `.ai/`, MCP servers, RBAC-gated skills and hooks. v4.0.0 tagged; the D-102 team arc (E-325..E-336) is built → v4.1.0 (E-334).

## Stack
- Node.js 22.5+ (ESM, node:sqlite), Bash CLI (`src/bin/ai`), Python 3 fallbacks, SQLite WAL, tmux (optional). CI: local `ai ci run` is the pre-push gate (D-072); a hosted check on PRs into `master` runs the same recipe (D-102 §5b, D-103) — GitHub Actions live, Azure Pipelines rendered but UNVERIFIED.

## Triad Health
- Architect: D-103 ruled (provider-neutral hosted check; E-335..E-337 registered); P-45 DONE. Open: P-43, P-44 (blocks E-301..E-303).
- Engineer: E-331, E-332, E-335, E-336, E-333 DONE (2026-10-19..22). PRs stacked, unmerged: #109 (E-325..E-332) → #110 (E-335) → #111 (E-336) → #112 (E-333). Waiting on the operator's merges for E-334.
- Tester: local PASS fed725d 5847/0/3 (E-333); hosted GitHub PASS on #109 (69abc8f 5795/0/11) and #110 (3af7fa1 5806/0/11) — the first Linux runs since E-268.

## Current Focus
- E-334 (OPEN, deps done): README Team setup (incl. `ai ci hosted <provider>` + per-provider policy table), CHANGELOG 4.1.0, bump, signed tag — after #109..#112 merge to master.
- E-337 (OPEN, after 4.1.0): GitLab + Bitbucket wrappers, need documented runs.
- E-301/E-302/E-303 BLOCKED on P-44 (Consolidation Map).

## Key Decisions
- D-103: hosted master check = contract (two commands: bootstrap + `ai ci run` on the merge result), wrappers rendered by `ai ci hosted`; GitHub + Azure in 4.1.0; "required for merge, pushes open" branch policy.
- D-102: team collaboration — record store, import on pull, id ranges, claims on origin/master, portable CI records, stamps by sha, archive in git, start.local.json + shared log.
- D-101/D-100/D-099: classifier v4; SendMessage is the only wake.
- D-088: test economics — consolidation map, census, budget ratchet.

## Known Risks
- Azure wrapper has never run on a real Azure DevOps project (`[CI_PROVIDER_UNVERIFIED]`, DEVOPS-011).
- SEC P2s for the Architect: downstream bootstrap clones a mutable TAG (pin a sha?); "bypass actors" policy lets code reach master past `--no-verify` (audit run only makes it visible).
- On bash 5 (Linux) `[GATE_INTERNAL_ERROR] … near line N` always says line 1 (EXIT-trap LINENO); the block itself is correct.
- `master` is hard-coded in wrappers and claims; downstream repos on `main` unaddressed.
- actions/cache@v4 + upload-artifact@v4 run on deprecated Node 20; ubuntu-latest → Ubuntu 26 from 2026-10-19.
- `.ai/` logs over threshold (COMM 2911, SESSION 4430 lines); rotation needs `skill: ai-archive`.
- Host load: suites time out (SUITE_TIMEOUT 180s) at load ≳15; a stray `.claude/worktrees/` checkout fails E-268.02a in working-tree runs only.

## MCP Servers
- filesystem, memory, vibe-check, task-synchronizer, safe-exec, blueprint-aligner, context-guardian, risk-analyzer, archive-manager, orchestrator, memory-manager, verification, patch, token-budget, propose-patch, approval, advisor, cache-manager.

## Recent Changes (last 10)
- 2026-10-22: E-333 start.local.json account override, `ai account use`, shared log `.ai/log/<localpart>.md`, `ai log path|recent` (PR #112)
- 2026-10-22: E-336 Azure Pipelines wrapper, unverified; `ai ci run` sets AI_OS_CI_LOG_DIR under TF_BUILD (PR #111, DEVOPS-011)
- 2026-10-21: E-335 `ai ci hosted` renderer + github template; ci.yml regenerated with the push audit run (PR #110)
- 2026-10-21: E-332 Linux portability — 36 first-hosted-run failures fixed (bash 5, GNU tools, /proc, argv cap) + host-named SKIPs
- 2026-10-20: tests/run.sh no longer dies silently when no census log is left (E-309.L10)
- 2026-10-20: E-332 hosted master check `.github/workflows/ci.yml` (DEVOPS-010); GitHub Actions re-enabled repo-wide by the operator
- 2026-10-19: D-103 ruled — provider-neutral hosted check (Architect)
- 2026-10-19: E-331 task claims on origin/master + Engineer claim gate
- 2026-10-19: E-330 task archive in git; E-329 stamps bound to a commit
- 2026-10-19: E-328 portable CI evidence; E-327 team.json + id ranges; E-326 import on pull
- 2026-10-28: SECURITY.md updated — E-379 privacy redaction pen-test (11 EXPLOITED: normalisation bypass, truncate-before-redact, env kill switch, EMAIL_RE quadratic); T-PRIVACY-001 added
- 2026-10-28: SECURITY.md updated — E-378 bootstrap/privacy-gate pen-test (P0: tag tagger identity, stale snapshot without gate, CLI fail-open exit 0); T-PRIVACY-002 added
- 2026-10-29: SECURITY.md updated — E-391 hard-cut review: gate token parity held; P1 old-path hook registrations fail open after rm (doctor ✓); P2 classifier OURS rewrites user 'X Gate Tamper' rules; P2 doctor PATH check still 'type -ap ai'; T-RENAME-001 E-391 addendum
- 2026-10-29: SECURITY.md updated — E-391 re-review: F1 core/F2/F3/F4/F6 closed; new N1 (P2, sync deletes a user's $CLAUDE_PROJECT_DIR hook by file name) blocks Tier 3; N2–N5 P3.
- 2026-10-29: SECURITY.md updated — E-391 third pass: N1–N5 + git-config note closed (77/0); new P3 M1–M7 (sync still drops bash -c/operator/$HOMEDIR entries; doctor ✓ on JS-invalid matcher, Bash-only matcher, type/timeout, settings.local disableAllHooks; raw escapes in doctor output); T-RENAME-001 third-pass note
- 2026-10-30: SECURITY.md updated — E-397 safe-exec ReDoS rewrites SEC_CLEARED (0 differential mismatches, no gate weakening; pre-existing viaConfig quadratic + decodedView RangeError noted).
