# Architect Provider Parity (Claude as Architect)

## Goal & Architecture
**Goal**: A provider that is bound to the `architect` role (D-054, `ai pane architect`) receives
**everything the previous Architect providers (agy / gemini) had**: the Architect skill set, the
Architect-side agents, Architect permissions, an Architect-aware rulefile bootstrap, role-correct
MCP spawn identity, and a role-scoped git lane. Today `ai sync` provisions by **provider directory**
(`src/claude/*` → `.claude/`, `src/agents/*` → `.agents/`), which silently equates provider with role.
Under D-054 provisioning must be **role-aware**: a provider directory receives the shared assets plus
the assets of every role that provider serves per `.ai/roles.json`.

**Architecture**: keep the D-052 vendor directories as adapters; add a role manifest to
`src/config/registry.json` that maps each role to its skill/agent source directories; make
`do_sync`, the settings overlay generator, the hooks, and `ai doctor` consult `.ai/roles.json` ×
the manifest instead of hardcoding `claude=engineer`, `agents/gemini=architect`.

## Parity Inventory (measured 2026-09-04)
| Surface | agy/gemini Architect has | Claude provider gets today | Gap |
|---|---|---|---|
| MCP servers | 25 via `.agents/mcp_config.json` (safe-exec spawn env `AI_OS_CALLER_ROLE=architect`) | 25 via `.mcp.json` (shared by both panes; spawn env = engineer) | Spawn identity — closed by E-208 launch env; verify |
| Skills | shared (25) + `src/agents/skills` (15: blueprint-writer, task-planner, decision-recorder, arch-review, architectural-aligner, digest_updater, review_synthesizer, ux_template, aqg-resolver, identity_guardian, seo_content_checklist, ai-seo, ai-task, repo-oracle, proposed) | shared + `src/claude/skills` (9, Engineer-side) | **15 Architect skills missing** from `.claude/skills` |
| Agents | 21 via agy plugin (built from `src/claude/agents` + `src/gemini/agents`) | 13 from `src/claude/agents` | **7 missing**: ux_reviewer, docs-architect, knowledge_architect, meta_analyst, memory_curator, seo_manager, seo_content_generator |
| Rulefile | `GEMINI.md → ARCHITECT.md` auto-load | `CLAUDE.md → ENGINEER.md`; `ARCHITECT.md` appended by `ai pane` (E-208) | `ARCHITECT.md` assumes `activate_skill`; needs the ENGINEER.md-style runtime ladder (Skill tool → MCP → activate_skill) |
| Permissions | agy: no allow-list gate | `.claude/settings.json` allow-list is Engineer-scoped (68 rules, legacy `Bash(gemini -p *)`) | Architect overlay needs `ai add-task`/`ai handoff` Bash allows + `handoff_control`, `add_topic_seed`, `add_cluster_page`, `check_role_access` |
| Identity labels | owner "Architect (Agy)" hardcoded in `cli-add-task.mjs`; Stop hook stamps Actor "Claude" | same | Labels must be `<Role> (<provider>)` from roles.json |
| Git | agy has no git tool → Engineer proxy-commits `.ai/` edits (D-053 precedent) | Claude Architect HAS git | New capability: Architect-scoped commit lane (path-scoped, see §Git Lane) |
| Health | `ai doctor` reports agy plugin install state | — | Per-role provisioning report |

## Components
1. **Role manifest** (`src/config/registry.json` → `roles`):
   ```json
   "roles": {
     "architect": { "skill_dirs": ["agents/skills"], "agent_dirs": ["gemini/agents"], "rulefile": "ARCHITECT.md" },
     "engineer":  { "skill_dirs": ["claude/skills"], "agent_dirs": ["claude/agents"], "rulefile": "ENGINEER.md" },
     "shared":    { "skill_dirs": ["shared/skills"] }
   }
   ```
   Directory names stay vendor-named (D-052); the manifest is the only place that says which role they serve.
2. **Role-aware `do_sync`**: for each provider in `.ai/roles.json`, the provider's skill/agent target dir
   receives `shared` + every served role's dirs (union, byte-identical copies, `_SKILLS_INDEX.md` regenerated).
   A provider serving both roles gets everything. **Same-name collisions (D-055 R2, E-217)**: two role
   directories MUST NOT ship different content under one skill name — the Architect's lifecycle copies are
   named `arch-task` / `arch-oracle` (E-149 pattern; the Engineer keeps `ai-task` / `repo-oracle`). A
   single-role workspace keeps the historical role-overrides-shared behaviour; a multi-role workspace treats
   any remaining collision as a sync ERROR (non-zero exit), never a silent choice. Agent `.md` files from `src/gemini/agents` MUST be
   normalized to the Claude agent frontmatter contract (`name`, `description`, `allowed-tools`,
   `context: fork`, `agent: general-purpose`) — verify each of the 7 loads in `/agents`.
3. **Architect settings overlay** (`.claude/settings.architect.json`, generated per E-208): adds the Architect
   allow rules (`Bash(ai add-task *)`, `Bash(ai handoff *)`, `mcp__task-synchronizer-mcp__handoff_control`,
   `add_topic_seed`, `add_cluster_page`, `mcp__context-guardian-mcp__check_role_access`); the base
   settings drop the legacy `Bash(gemini -p *)`. Deny rules are NOT the sovereignty mechanism (the hook is).
4. **Role-correct identity everywhere**: `AI_OS_CALLER_ROLE` in the `ai pane` launch env reaches every MCP
   server spawned by that pane (parity with agy's per-server env freeze) — acceptance: `analyze_command`
   from the Architect pane reports `caller_role=architect`. Owner labels become `Architect (<provider>)` /
   `Engineer (<provider>)`; the Stop hook stamps `Actor: <provider> (<role>)`.
5. **ARCHITECT.md runtime ladder**: mirror ENGINEER.md — Step 1 Skill tool `ai-preflight`, Step 2
   `run_preflight`, Step 3 `activate_skill`; skill invocation "use the Skill tool when present"; the Gemini
   Model Mandate moves under a "Provider notes" heading. Content of the Forbidden Zone / §35 unchanged.
6. **`ai doctor` per-role report**: for each role → provider, print whether the provider dir holds the role's
   skills/agents, whether the overlay exists, and whether the rulefile is present.

## Git Lane (Architect-scoped commits) — ruling
A Claude Architect may commit **only** when every staged path is under `.ai/` or `plans/`. The pre-commit
hook resolves the session role through `safe-exec --verify-role <session id>`, where the session id comes
from the harness-provided session-id env var (E-129 records are keyed by session id and a git hook receives
no payload, so there is no "role-stamp file" to read — amended per E-214). Fallback order: `AI_OS_PANE_ROLE`,
then `AI_OS_CALLER_ROLE`, then `engineer`. Role `architect` + any staged path outside that scope → BLOCK
(`[SOVEREIGNTY_BLOCK]`, hint: hand the change list to the Engineer). For an architect-scoped commit the
`[CRITIC_STAMP]` requirement is **waived** (critics review `src/`; `.ai/` docs have no diff for them) — all
other Gate 2 checks (credential scan, co-modification warning, REVIEWS.md hand-edit checks) still run.
**(D-055 R4, E-218)** The waiver is granted ONLY when the role came from the verified session record; the env
fallbacks may produce the restrictive outcome (BLOCK) but never the waiver. Accepted residuals are recorded in
`THREAT_MODEL.md` T-GITLANE-001 (`--amend` index↔HEAD~ gap, unauthenticated record selection,
`--no-verify`/`merge`/`cherry-pick`). Engineer
role behaviour is unchanged. This retires the D-053 proxy-commit workaround for same-provider Triads only;
agy Architects keep using the Engineer proxy.

## Shared Helpers (aligner contract — D-057 §4)
| Helper | Owner task | Purpose |
|---|---|---|
| `src/mcp/shared/caller-role.mjs` | E-219 | Server-side role derivation: verified session record → spawn-frozen env → restrictive default (`architect`). |
| `src/mcp/safe-exec-mcp/architect-writes.mjs` | E-216 | Shell write-redirect policy; contract = `tests/fixtures/arch-write-cases.json`. |
| `src/shared/provider-adapter.mjs` | E-210 | Provider `launch` / `print_mode` argv templates and child-env allowlist (`PATH`, `HOME`, `USER`, `child_env_keep`). |
| `src/shared/role-manifest.mjs` | E-212 | Role → source-directory manifest from `registry.json`. |
| `src/shared/sync-manifest.mjs` | E-220 | `_SYNC_MANIFEST.json` writer/reader; prune only in-manifest + unmodified + gone-from-source. |
| install-first resolver (`src/shared/locate.sh` + `locate.mjs`) | E-223 | Helpers resolve from `~/.ai-os` first; dev tree only inside the framework clone. Hooks set `AI_OS_LOCATE_UNTRUSTED_ENV=1` (env is attacker-supplied). Dev-tree rollback is **`ai --dev-tree` (argv)** — D-058 §1 superseded D-057's env-var sentence. Skills reach it via the installed mirror (E-225). |
| `src/shared/markdown-exec.mjs` | E-224 | Executable-markdown classifier: `!`-lines and executable-tagged fences are code, the rest is documentation; shared by `run_review` and the standards checker. **Anchor contract extensions (D-060, ratified)**: `.ai/state.json` is an exact-path allowlist (task text is data); ES module specifiers (`import`/`export … from`, `import()`, `require()`) are script-relative anchors; whole-line `//` / `#` comments are documentation. **Consent rule (D-060 §3, E-232)**: a `!`-line may run framework helpers via the resolver or read-only inspection only — never a project-supplied program. **Operand re-tokenisation (D-060 §2, E-231)**: `bash -c` / `eval` / `xargs` / heredoc operands are re-tokenised, depth capped at 1 (ratified D-061 §1). **Consent rule mechanism (ratified D-061 §1)**: a denylist of EXECUTION shapes — execution, not mention. **Program-position rule (D-061 §2, E-234; wording ratified D-062 §1)**: program position is open at the segment head and after an interpreter or a position-restarting wrapper, and it CLOSES on the first operand that actually resolves the program — it stays open for an unreadable variable (`node "$HELPER"`) or an allowlisted entrypoint (`bash tests/run.sh …`), because neither says what runs. Once closed, remaining tokens are arguments; data-typed extensions are never programs. **Hot reload (D-061 §5, E-237)**: long-running servers load these policy modules through `loadPolicy(name)`, re-importing on mtime change. |

Two-phase writes (`propose_patch` → `confirm_patch`, E-221) bind the pending record to `project_root` + a
project-relative path and re-run every check (`safePath`, role, project equality) at confirm time.

## Security
- Provisioning copies files; it grants no new tool capability by itself. Capability in a Claude Architect
  pane is bounded by (a) the E-208 `Write|Edit` sovereignty gate, (b) the pre-tool-use Bash gate keyed on
  the token role, (c) the Git Lane above. Tier 3 review (`security_engineer`) is mandatory for E-214.
- Agent `.md` normalization must not widen `allowed-tools` beyond what the agy plugin `toolNames` granted.

## Execution Constraints
- Depends on **E-208** (launcher, overlay, token role) — no parity task may start before it is DONE.
- Byte-identical mirrors: `src/` canonical → `.claude/` / `.agents/` / `~/.ai-os/` (E-201 lesson).
- No new dependencies.

## Rollback Plan
- Remove `roles` from `registry.json`; `do_sync` falls back to the provider-directory mapping. Delete the
  copied Architect skills/agents from `.claude/`; delete the overlay. Revert `pre-commit.sh` Git Lane.

## E-## Task Breakdown
- **E-212** (Tier 2, dep E-208): Role manifest + role-aware skill/agent provisioning in `ai sync` (§Components 1–2).
- **E-213** (Tier 2, dep E-208): Architect overlay permissions + role-correct identity labels + MCP spawn-identity acceptance (§Components 3–4).
- **E-214** (Tier 3, dep E-208): Architect-scoped Git Lane in `pre-commit.sh` (§Git Lane).
- **E-215** (Tier 2, dep E-212): ARCHITECT.md runtime ladder + `ai doctor` per-role provisioning report (§Components 5–6).
- **E-216** (Tier 3, D-055 R1): widen the Architect write gate — overlay deny rules for MCP write tools + shell write-redirect policy in `analyzeSovereignty` (see `role-abstraction.md §Security`).
- **E-217** (Tier 2, D-055 R2): rename the Architect's `ai-task`/`repo-oracle` to `arch-task`/`arch-oracle`; collision guard → sync error in multi-role workspaces; add the missing `context:` key to `seo_engineer.md`.
- **E-218** (Tier 2, D-055 R4): Git Lane stamp waiver only from the verified session record.
- **E-219** (Tier 3, D-056 R1): `patch-mcp` / `propose-patch-mcp` fail-closed server-side role derivation (T-PATCHMCP-001).
- **E-220** (Tier 2, D-056 R2): manifest-scoped pruning in `ai sync` (`_SYNC_MANIFEST.json`; delete only in-manifest + unmodified + gone-from-source; `--prune-known` for rename leftovers). Sync stays additive for anything it did not write.
- **E-221** (Tier 3, D-057 §1): pending patches bound to `project_root` + relative path; every check re-run at `confirm_patch` (T-PROPOSEPATCH-001).
- **E-222** (Tier 2, D-057 §2): `run_review` PATH_TRAVERSAL becomes context-aware — script-relative anchors are P1 advisory, runtime path handling stays P0.
- **E-223** (Tier 3, D-057 §3): install-first helper resolver; dev tree only inside the framework clone; replaces every `git rev-parse` locator chain in `src/bin/ai` and the six hooks.
- **E-224** (Tier 2, D-058 §3): executable-markdown classifier; `run_review` grades markdown by executability.
- **E-225** (Tier 3, D-058 §2): skills half of T-LOCATOR-001 — four SKILL.md chains through the installed resolver + standards rule (uses the E-224 classifier).
- **E-226** (Tier 2, D-058 §4): read-only patch tools project-bound (T-PROPOSEPATCH-002).
