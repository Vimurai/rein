# Audit: Claude Code native framework vs Rein (2026-09-28)

> Architect assessment, not a ruling. Proposes D-075 ("Native-first: retire what the harness
> now does itself"). Inputs: official Claude Code docs (code.claude.com/docs, verified live
> 2026-09-28) and a repo inventory of Rein v3.1.0 (`src/` 21.3k LOC, 22 custom MCP servers,
> 50 skills, 21 agents, 8 hooks, `rein` CLI 5.0k LOC, 143 bash suites / 5043 assertions).

## 1. What each thing IS

| | Claude Code (native) | Rein |
|---|---|---|
| Unit of work | one interactive session (+ forked subagents, background agents, experimental agent teams) | a **Triad** of long-lived roles in separate panes, plus headless subagents |
| Memory | CLAUDE.md hierarchy, `.claude/rules/` (path-scoped), auto-memory dir, `/memory` | `.ai/` as primary memory: blueprints, DECISIONS, DIGEST, generated TASKS/REVIEWS views |
| State | per-session transcript; agent-teams shared task list is ephemeral, ~7x tokens | `state.sqlite` (ACID, WAL, DAG depth cap, deltas, stamps, ci_runs) shared across sessions |
| Roles | `permissionMode`, `tools:` per subagent, `--settings` per launch. Advisory to the model | **Enforced** sovereignty: HMAC role token minted at SessionStart, 3-layer fail-closed write gate |
| Safety | permission allow/deny/ask, auto-mode NL classifier, sandbox | safe-exec PASS/WARN/BLOCK, TSRT tiers, approval-mcp, propose-patch HITL |
| Git gates | none native (`/code-review`, `/security-review` are on-demand) | pre-commit needs a ≤7-day `[CRITIC_STAMP]`; pre-push needs a green local CI row |
| CI | worktrees exist, no CI runner | `rein ci run` in a detached worktree + throwaway HOME (D-072) |
| Cross-session wake | `SendMessage` to other local sessions (unverified as a wake primitive) | `ai handoff` → `signal.json` → `ai-watch` idle-detect + `tmux send-keys` |
| Observability | `/usage`, `/insights`, `/skill-doctor`, OTEL export (all per-session / per-user) | cross-project `telemetry.sqlite` → `meta_analyst` → INSIGHTS.md → proposed skills (HITL) |
| Orchestration | Workflow tool (JS scripts, `parallel`/`pipeline`), agent hooks | orchestrator-mcp scripted workflows, critic agents dispatched by `rein-review` |

**The one-sentence diff:** Claude Code gives a single agent excellent primitives. Rein is a
governance layer for **several agents sharing one repo over weeks**: enforced roles, durable
task state, commit gates and a feedback loop. None of those four exist natively.

## 2. Where Rein is genuinely better (KEEP — this is the product)

1. **Enforced role sovereignty.** Native `permissionMode`/`tools:` rely on the orchestrating
   model honouring them. Rein blocks at the hook, fail-closed, keyed on a verified token —
   it blocked `python3 -c` and `node -e` from the Architect twice during this very audit.
2. **Durable ACID task state with DAG validation and generated views.** Agent teams' shared
   list dies with the session and costs ~7x tokens. `verify_markdown_sync` catches drift.
3. **Git-hook gates tied to reviewer stamps and a green CI row.** Nothing native stops a
   commit without a review or a push without CI.
4. **Local CI in an isolated layout** (worktree + throwaway HOME + leak detection + SKIP as a
   third outcome). Native worktrees are checkouts, not a harness.
5. **Cross-project telemetry → insights → proposed skills with a human gate.** `/insights`
   and `/skill-doctor` are per-session and have no proposal step.
6. **The interactive two-pane bridge.** No native way to make an idle interactive session
   act on another's output. (See §4 item 9 — `SendMessage` may change this.)
7. **`.ai/` as vendor-neutral memory.** Blueprints, decisions and digests outlive any one
   harness release; auto-memory is a private per-machine directory.

## 3. What was built for a reason that no longer exists

D-069 removed the `agy`/`gemini` providers but **kept the scaffolding built to work around
them**. Each item below has a native equivalent that Claude Code already ships, and its
original justification was either Antigravity's missing tools or a Claude Code gap that has
since closed.

| Remove / retire | LOC | Built because | Native replacement now | Evidence |
|---|---|---|---|---|
| `mcp-router` (list_domains, activate_domain, proxy_call) | 568 | "23+ tool schema bloat" (E-40) | Deferred tools + `ToolSearch` — every Rein MCP tool is *already* deferred in this session | `activate_domain` is the top genuine ERROR source, 20% (E-260) |
| `context-invoker-mcp` (activate_skill/agent) | 323 | agy did not expose Skill/Agent tools | Skill tool + Agent tool, always present under Claude | rulefile "ladder" Steps 2–3 exist only for this |
| `orchestrator-mcp::run_preflight` (keep the other 4) | ~120 | MCP fallback for agy | `rein-preflight` skill with `!`-injection is the native path | ENGINEER/ARCHITECT.md Step 2 |
| `lsp-mcp` (TS only) | 339 | no code intelligence | Code Intelligence plugins (LSP, auto-diagnostics post-edit) | — |
| `github-bridge-mcp` | 386 | wrap `gh` | `gh` via Bash + `Bash(gh pr *)` allow rule; keep `create_intent_from_issues` as a `rein` subcommand | — |
| `computer-use-mcp` (display :99) | 458 | visual QA of native windows | native computer use (desktop app) + claude-in-chrome; `vibe-check-mcp` stays for Playwright | — |
| `code-execution-mcp` | 397 | sandboxed REPL | nobody has Docker: REJECTED 935/935 (E-258); native Bash + auto-mode sandbox | E-258 is currently funded to *improve the error message* — retire instead |
| `ai-compact` skill | — | agy had no `/compact` | `/compact` + auto-compact; keep only SESSION.md archival if wanted | skill says "Equivalent to running /compact" |
| 6 single-tool wrapper skills (`ai-analyze`, `ai-cluster`, `ai-context-check`, `ai-dispatch`, `ai-sync-verify`, `ai-topic`) | — | E-178 "high-frequency tools" | the MCP tool is directly callable; each wrapper costs description tokens at **every** session start | run `/skill-doctor` once for never-invoked list |
| Rulefile MCP fallback ladders (§Session Start Steps 2–3, §36 rule 2) | prose | agy | Skill tool / Agent tool only | D-069 §Component 4 already says "§36 becomes Skill tool for skills, Agent tool for agents" |
| third-party `@modelcontextprotocol/server-memory` | dep | knowledge graph | auto-memory + subagent `memory: project`; **verify usage first** (zero skill/agent references found) | grep = 0 |

Rough total: ~2.5k LOC of MCP code (about 20% of the MCP tree), 7 skills, 2 rulefile
sections. 9 skill/agent files reference the removal candidates and need edits.

## 4. What to TAKE from native

1. **`.claude/rules/` with `paths:` frontmatter.** Move path-specific rules out of the
   bootloaders and the 25.8k-char SessionStart blob: engineering-standards → `paths: [src/**]`,
   test-harness rules → `paths: [tests/**]`, MCP stdout purity → `paths: [src/mcp/**]`. They
   load only when a matching file is touched. Direct token saving every session.
2. **Fix the context blob.** `cache-manager-mcp` injects `registry.json` (12.5k chars of
   prose and allow-lists) into every session and is over its own 20k cap (25,812 measured).
   Agents never need the registry; drop it, inject `architect.md` + fresh blueprints only.
   Native prompt caching is applied regardless, so the "cache" server is really a context
   assembler — rename or fold into the hook.
3. **Skill frontmatter we are not using:** `context: fork` + `agent:` (run `arch-review`,
   `rein-review` critics without polluting the caller), `hooks:` scoped to a skill (the AQG
   test-on-edit hook could be scoped to `rein-task` instead of firing on every PostToolUse),
   `arguments:` (named args for `rein-task E-256`), `paths:` (skills that only make sense in
   `tests/**`), `${CLAUDE_SESSION_ID}` substitution.
4. **Hook types `agent` / `mcp` / `prompt` and the `PermissionRequest` / `PermissionDenied`
   events.** An `mcp` hook can call `task-synchronizer` directly instead of shelling to node;
   `PermissionDenied` gives the REJECTED telemetry signal for built-in tools for free;
   an `agent`-type Stop hook could run `digest_updater` without a shell script.
5. **Subagent frontmatter:** `mcpServers` scoping (critics get only `add_stamp`; this is what
   `verification-mcp` "ghost tools" tries to police after the fact), `maxTurns` for critics,
   `memory: project` for `meta_analyst`, `background: true` for `memory_curator`.
6. **`claude plugin eval`.** Rein has 5k assertions on its *code* and zero on whether its
   50 skills produce the right behaviour. Package Rein as a plugin (it has been one before)
   and write evals for `rein-preflight`, `rein-task`, `rein-handoff`, `task-planner`. Graders
   `tool_used`/`tool_order` map directly onto our "never skip gates" rules.
7. **`/skill-doctor` once, then prune.** Descriptions of all 50 skills load at every session
   start. The report lists 7-day tokens/uses and never-invoked skills — that is the prune list.
8. **Auto-mode classifier as the Engineer's shell gate.** Keep `safe-exec` for the
   deterministic Architect write gate (irreplaceable). For the Engineer, `autoMode.hard_deny`
   /`soft_deny`/`allow` in settings can carry the destructive-command rules, and the
   classifier already runs. Reduces the 17.3k `analyze_command` calls and the over-block
   friction (this audit hit `ARCH_INLINE_INTERPRETER` on a read-only `python3 -c` JSON parse;
   D-056 says the over-block ratio governs — log it as a data point, not a widening).
9. **`SendMessage` to other local sessions.** If it delivers to an *idle interactive* pane as
   a prompt, it replaces `ai-watch`'s 1,047-line idle-detect + `send-keys` loop with one call.
   Needs a spike: does it wake the Engineer, is delivery durable, does it survive `/clear`?
   `signal.json` stays as the audit record either way.
10. **`--bare` and `--json-schema`** for headless child invocations (`advisor-mcp`'s
    `claude -p`, future `rein ci` Tester runs): faster startup, typed output.
11. **Workflow tool** for `rein-review` Tier 3 (`parallel()` critics with `schema`). Low
    priority: requires user opt-in per run.

## 5. What NOT to touch

- The write gate's three layers (D-056 froze widening; fixtures are the contract).
- `state-db.js`, `task-synchronizer-mcp`, `safe-exec-mcp`, `propose-patch`/`approval`
  (Tier 3 HITL has no native equivalent that leaves an audit row), local CI, telemetry.
- `.ai/` layout and the generated views.

## 6. Proposed sequencing (if ratified as D-075)

1. Zero-risk token wins first: fix the blob (§4.2), `.claude/rules/` migration (§4.1),
   `/skill-doctor` + prune wrappers (§4.7, §3).
2. Retire the agy-era fallbacks: `context-invoker`, `run_preflight`, rulefile ladders,
   `mcp-router` (§3). Reconcile E-260 (currently funds fixing `activate_domain` errors) and
   E-258 (funds a better Docker error) — both become deletions.
3. Retire `lsp`, `github-bridge`, `computer-use`, `code-execution` after a usage check in
   telemetry (SUCCESS rows in the last 90 days).
4. Spikes: `SendMessage` as the bridge (§4.9), `claude plugin eval` for the top-4 skills (§4.6).
5. Fold into the v4.0.0 BREAKING list (E-263) so the removals ship with the provider removal.

Open questions for the operator before D-075 is written:
- Is `server-memory` (knowledge graph) used by anyone outside this repo? Grep says no here.
- Keep `token-budget-mcp` (budget enforcement) or rely on OTEL + `/usage`? E-259 depends on it.
- Ship the retirements inside v4.0.0 or as v4.1?
