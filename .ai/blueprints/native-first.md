# Blueprint: Native-First (D-075)

> Ratified 2026-09-28 (D-075). Audit: `plans/native-vs-rein-audit.md`. Ships inside v4.0.0 (E-263).

## Goal & Architecture
Remove every Rein component whose only justification was a Claude Code gap that has since
closed or an Antigravity limitation that D-069 already removed, and adopt the native surface
Claude Code now documents (path-scoped rules, subagent/skill frontmatter, hook events, plugin
evals, the auto-mode classifier). Used by the Engineer (deletions and adoptions) and by both
roles at every session start (smaller context, fewer tool schemas). One sentence: **keep the
governance layer, delete the shims, use the harness.**

## Core Concept
Rein is a governance layer over Claude Code, not a replacement for it. A component earns its
place only if the harness cannot do it: enforced role sovereignty, ACID shared task state, git
gates on stamps and CI, isolated local CI, cross-project telemetry → proposed skills, the
two-pane bridge. Everything else is a shim, and a shim is deleted the release after the gap
closes. The test for "native does it" is a documented, generally-available feature — not an
experimental one.

## Components

1. **Context blob cap (cache-manager-mcp)** — `assembleContext()` stops injecting
   `registry.json` and the SQL schema (no agent reads them); injects `architect.md` plus
   blueprints modified within 7 days; enforces `CACHE_CHAR_LIMIT` by dropping the oldest
   blueprint first and printing the omitted names; gains `--measure`. Today: 25,812 chars vs a
   20,000 cap.
2. **Path-scoped rules (`.claude/rules/`)** — rules that only matter for a path leave the
   bootloaders and the injected blueprints: `engineering-standards` → `src/**`,
   test-harness isolation/SKIP/leak rules → `tests/**`, MCP stdout purity + build-stamp →
   `src/mcp/**`, the hooks contract → `hooks/**`. Canonical in `src/claude/rules/`, mirrored by
   `ai sync` under the E-220 sync manifest, absent from the SessionStart blob.
3. **Retirements** — each deletes the server or skill, its `registry.json`/`.mcp.json`/settings
   allow/`mcp-domains.mjs` entries, every skill/agent/rulefile reference, and adds a D-074
   legacy-registry entry so `ai clean` removes the mirrors:
   - `context-invoker-mcp` + `orchestrator::run_preflight` + the rulefile "fallback to MCP"
     ladders (Skill tool / Agent tool are always present under Claude).
   - `mcp-router` (native tool-schema deferral; supersedes E-260).
   - `code-execution-mcp` (Docker REJECTED 935/935; supersedes E-258) + `lsp-mcp` (code
     intelligence plugins).
   - `github-bridge-mcp` (plain `gh` + allow rule; `create_intent_from_issues` becomes a
     direct `gh issue list --json` call inside `ai sync --github`), `computer-use-mcp` (native
     computer use / claude-in-chrome; `vibe-check-mcp` stays), `server-memory` only if the
     repo grep AND a 90-day telemetry SUCCESS count are both zero.
   - Skills: `ai-compact` (`/compact`), `ai-analyze`, `ai-cluster`, `ai-context-check`,
     `ai-dispatch`, `ai-sync-verify`, `ai-topic` (single-tool wrappers whose descriptions load
     every session).
   Kept on purpose: `token-budget-mcp` (E-259), `approval`/`propose-patch` (Tier 3 HITL with
   an audit row), `safe-exec` (the Architect gate), `verification-mcp` (ghost tools, now
   checked against the scoped `mcpServers` list).
4. **Skill prune** — see Component 3 skills; `role-manifest.mjs`, `_SKILLS_INDEX.md`, the sync
   manifest and every `skill: ai-…` reference updated; `ai-preflight` calls
   `verify_markdown_sync` directly.
5. **Native frontmatter and hook adoption** — critics and `test_engineer` get `mcpServers:`
   scoped to task-synchronizer and `maxTurns`; `meta_analyst` gets `memory: project`;
   `memory_curator` gets `background: true`; a `PermissionDenied` hook records REJECTED
   telemetry for built-in tools (the interceptor already covers `mcp__*`); skills use
   `${CLAUDE_SESSION_ID}`; `arch-review`/`ai-review` critic dispatch runs with `context: fork`.
   **Correction (D-084, E-295)**: subagents have no `allowed-tools` field — the 21 agents'
   limits were never enforced. `tools` is the ALLOWLIST (accepts `mcp__<server>`);
   `mcpServers` only connects; `disallowedTools` is applied first and a tool matched by
   both is removed, so `disallowedTools: mcp__*` is NOT scoping. Scoped agents carry a
   `tools` list of the built-ins they need plus `mcp__task-synchronizer-mcp`; critics add
   `disallowedTools: Write, Edit, NotebookEdit`. `verify_compliance` enforces: no
   `allowed-tools`; `tools` present on scoped agents; every `mcp__` entry in `tools`
   backed by `mcpServers` or the parent config; `disallowedTools` never names a server
   `tools` needs.
6. **Engineer shell gate → auto-mode classifier** — **CANCELLED (D-080, 2026-10-01).** The
   classifier reads `autoMode` only from `~/.claude/settings.json`, managed settings and
   inline `--settings` JSON, never from project files, so the `hard_deny` an `ai pane`
   overlay would carry cannot be shown to reach it, and no test we own can prove it was
   applied. `safe-exec` keeps running in every permission mode for both roles; the classifier
   is an additive second gate. No `REIN_SAFE_EXEC_ENGINEER` variable. The Architect write
   gate is untouched (D-056; `tests/fixtures/arch-write-cases.json` is the contract).
7. **`SendMessage` spike** — measure whether a local-session `SendMessage` wakes an idle
   interactive pane (idle, mid-turn, after `/clear`, after `/compact`, both directions) and
   write the recommendation to `.ai/COMM.md`. `ai-watch` is not changed by the spike.
   **Outcome (E-281, D-099)**: delivered in every case with the target `claude` running
   (idle 7–13 s, starts a turn; after `/clear` and `/compact` the same; mid-turn drains into
   the running turn after its tool call). A send to a down session fails at once with "not
   reachable" and is NOT queued; the name rebinds on relaunch. Ruled in Component 9.
8. **Skill evals (`claude plugin eval`)** — a plugin manifest for the provisioned skill set and
   `evals/` cases for `ai-preflight`, `ai-task`, `ai-handoff`, `task-planner`, run by a suite
   that SKIPs without an authenticated `claude` on PATH; report attached to `ai ci run`.
9. **`SendMessage` is the only Triad wake path (D-099; E-321, E-322, E-323)** — the operator
   ruled on 2026-10-14 that a wake lost to a down pane is acceptable and the watcher goes.
   - **Wake (E-321)**: `ai-handoff`, `ai-task` Step 4, `arch-task` Step 4, `task-planner`
     Step 7 and `ai-triage` call `SendMessage` to the other role's session name as
     `ListAgents` lists it — `<project dir basename> · <Role>` (`@vimurai/rein · Engineer`) — as
     the LAST action of the turn, after `.ai/COMM.md` is written. `SendMessage` is deferred:
     the skill text loads it with `ToolSearch select:SendMessage` first. First line of the
     message = the handoff line (what shipped or what was planned, then "execute the OPEN
     queue" / "review and plan next"); the body points at the COMM.md entry, never repeats it.
     Down target: the skill ALWAYS calls `SendMessage`; a send that returns "not reachable"
     is the down signal (**D-100**: no `ListAgents` pre-check — under the first wording the
     model listed, found no row and skipped the mandatory send, which the eval caught). Then
     print ONE line to the user naming the target and the undelivered handoff line and end
     the turn — no retry, no queue, no fallback. Busy target: the message drains into the running turn (spike b);
     accepted. The E-119 rule reads "never end the turn without calling `SendMessage`".
     `evals/ai-handoff` graders assert the `SendMessage` call to the target, not a signal
     entry. `ai-watch` is untouched in this task; the skills simply stop calling `ai handoff`
     and `handoff_control`.
   - **Removal (E-322, Tier 3)**: delete `src/bin/ai-watch`, `src/shared/signal-handoff.mjs`,
     the `ai watch` and `ai handoff` subcommands, and from `ai start` the watcher pane, the
     `.ai/.ai-watch.lock` directory, the E-229 restart backstop and `--no-watch` — `ai start`
     still creates the window, binds each pane's role (`@ai_os_role`) and account
     (`CLAUDE_CONFIG_DIR`) and launches `claude` in each. Delete `handoff_control` from
     `task-synchronizer-mcp` (`index.js`, `tool-schemas.mjs`) and its `load-policy.mjs` entry;
     strip the references in `cli-add-task.mjs`, `classifier-backstop.py`,
     `legacy-registry.mjs`, `install-rein.sh`, `ai doctor`/`ai status` watcher lines. Add
     the `ai-watch` script, `<project>/.ai/signal.json` and `<project>/.ai/.ai-watch.lock` to
     `src/config/legacy-artefacts.json` (class `safe`) so `ai sync` prunes them (D-074).
     Delete `ai_watch_test`, `watcher_reexec_test`, `held_handoff_test`, `handoff_cli_test`,
     `handoff_control_test` — one LOG line each (`handoff_enforcement_test` went with E-321,
     D-100 ruling 2; covered by `tests/unit/skill-wake.test.mjs`).
   - **Docs (E-323)**: README (11 mentions), `src/templates/ARCHITECT.md`, `ARCHITECT.md`
     §Handing Off, `ENGINEER.md`, CHANGELOG `Unreleased` with a BREAKING list (`ai watch`,
     `ai handoff`, `handoff_control`, `.ai/signal.json`), DIGEST via `ai-digest`. E-263 ships
     after E-323 so the 4.0.0 BREAKING list carries the removals.
   - **Accepted risk (D-099 ruling 6)**: delivery is over Claude Code's local session sockets
     and is model-independent; the wake depends on the model calling a deferred tool;
     cross-session messaging under a non-Anthropic base URL is unverified.

## Data Model
- `src/config/legacy-registry.json` (D-074): one entry per retired server/skill —
  `{ path, class: "safe", rule: "<hash|glob>", since: "4.0.0", reason: "D-075" }`.
- `src/claude/rules/<name>.md`: frontmatter `paths: ["glob", …]` + body; listed in the sync
  manifest with `kind: rule`.
- `.claude-plugin/plugin.json` + `evals/<case>/{prompt.md, graders/*.md}` (native eval layout).
- Telemetry: new `source = hook` rows with `status = REJECTED` from the `PermissionDenied`
  event; no schema change (D-070 §5 already adds `source`).
- ~~Generated `settings.<role>.json` gains `autoMode.hard_deny` (Engineer only).~~ Struck with
  Component 6 (D-080): the classifier never reads a project file's `autoMode`.

## API / Interface Contracts
- `cache-manager-mcp --emit-context` / `--measure`: stdout = the blob / its size in chars;
  never exceeds `CACHE_CHAR_LIMIT`; prints `Omitted: <names>` on stderr.
- `ai sync`: provisions `.claude/rules/` from `src/claude/rules/`; prunes retired mirrors
  through the manifest; `ai clean` removes what the legacy registry names.
- `hooks/pre-tool-use.sh`: input = Claude Code PreToolUse JSON (`tool_name`, `tool_input`,
  `permission_mode`, session id); output unchanged (exit 2 = block). New branch documented in
  the header comment.
- `hooks/permission-denied.sh`: input = PermissionDenied JSON; output none; writes one
  telemetry row; fail-open.
- `ai sync --github`: `gh issue list --assignee @me --json number,title,body` → intents (same
  output as `create_intent_from_issues`).
- Errors: a missing `claude` binary → suite SKIP (E-236); a missing legacy-registry entry for a
  retired path → the loader refuses (D-074).

## Security
- The Architect write gate is not modified; `arch-write-cases.json` must pass byte-identical.
- ~~E-280 is Tier 3: `security_engineer` dispatched; fixtures cover 6 permission modes × 2 roles;
  the denylist is asserted equal between `safe-exec` and `autoMode.hard_deny`.~~ Cancelled
  (D-080); `safe-exec` runs in all modes.
- Removing `computer-use-mcp` and `code-execution-mcp` shrinks the threat surface
  (`THREAT_MODEL.md` entries retired, not deleted — marked CLOSED with the task id).
- `gh` runs under an explicit allow rule, never a wildcard `Bash(gh *)`.
- `.claude/rules/` files are provisioned only through the sync manifest; user-authored rules
  outside the manifest are never overwritten (E-220).

## Execution Constraints
- Each retirement is one PR with a green `ai ci run`; grep-based acceptance names the
  expected residue (`.ai/archive/**`, `CHANGELOG.md`).
- Rule-scanning tests assert corpus size, not only findings (DIGEST "fifth variety").
- Blob assembly stays under 50 ms; the `PermissionDenied` hook under 20 ms (fail-open).
- Order: Components 3–4 before E-256 (docs); 1, 2, 5–8 before E-263 (release).

## Rollback Plan
`ai clean --restore <date>` returns any removed mirror for 30 days; each task is a single
revertable PR; `REIN_DISABLE_CACHE=1` bypasses the blob; retired blueprints (`mcp-router.md`,
`code-execution.md`) move to `.ai/archive/` with a pointer line.

## E-## Task Breakdown
| Task | Component | Depends on | Tier |
|---|---|---|---|
| E-275 | 1 Context blob cap | — | 2 |
| E-276 | 3 agy-era fallbacks (`context-invoker`, `run_preflight`, ladders) | — | 2 |
| E-277 | 3 `mcp-router` (supersedes E-260) | — | 2 |
| E-278 | 3 `code-execution` + `lsp` (supersedes E-258) | — | 2 |
| E-279 | 3 `github-bridge` + `computer-use` + `server-memory` | — | 2 |
| E-280 | 6 Engineer gate → classifier | — | CANCELLED (D-080) |
| E-281 | 7 `SendMessage` spike | — | 2 |
| E-282 | 2 `.claude/rules/` | E-275 | 2 |
| E-283 | 4 Skill prune | E-276 | 2 |
| E-284 | 5 Native frontmatter + `PermissionDenied` | E-277 | 2 |
| E-285 | 8 Skill evals | E-283 | 2 |
| E-295 | 5 Agent frontmatter correction (`tools`, `disallowedTools`) — D-084 | — | 2 |
| E-321 | 9 Skills + evals wake by `SendMessage` — D-099 | — | 2 |
| E-322 | 9 Delete `ai-watch`, `signal-handoff`, `ai handoff`, `handoff_control`, tests — D-099 | E-321 | 3 |
| E-323 | 9 README, templates, rulefiles, CHANGELOG, DIGEST — D-099 | E-322 | 2 |
| E-324 | 9 Classifier rule text v4 (drop `ai watch`) + pin swap — D-101 r1 | E-322 | 3 |

**D-101 (E-322 packet)**: the E-322 acceptance grep returns only the pruning entries
(`legacy-artefacts.json`, `legacy-registry.mjs`), their tests, the RETIRED regex in
`skill-wake.test.mjs` and `src/templates/ARCHITECT.md` until E-323; `start.json` `watch` and
`sizes.top` stay accepted-and-ignored, documented deprecated by E-323; BREAKING: `ai add-task`
no longer auto-wakes the other role (E-204 removed, `REIN_NO_AUTO_HANDOFF` gone).

E-256 (docs) additionally depends on E-276..E-279 and E-283. E-263 (release) depends on
E-280, E-281, E-282, E-284, E-285 instead of E-258/E-260. E-258 and E-260 are closed as
SUPERSEDED by the Engineer after its next `install-rein.sh` (the D-067 §3 build gate blocks
a DONE while `state-db.js` differs from the mirror).
