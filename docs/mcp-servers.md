# MCP servers

Rein ships 16 local MCP servers and wires two third-party ones. `rein sync` writes them into the
project's `.mcp.json` from `~/.rein/config/registry.json`; servers you add yourself are kept.
They run as local processes over stdio — nothing listens on a port.

## State and orchestration

| Server | Provides |
| :--- | :--- |
| `task-synchronizer-mcp` | The ACID task store: tasks, stamps, deltas, claims, CI verdicts; regenerates `TASKS.md` and `REVIEWS.md`. |
| `orchestrator-mcp` | Handover, tier-aware review dispatch, task-graph dispatch. |
| `archive-manager-mcp` | Context health, LOG/COMM/REVIEWS rotation. |
| `token-budget-mcp` | Per-session token spend and budgets. |
| `cache-manager-mcp` | An explicit context cache, invalidated by file mtime. |

## Code and files

| Server | Provides |
| :--- | :--- |
| `patch-mcp` | Edits with MD5 optimistic locking and a fuzzy fallback. |
| `propose-patch-mcp` | Staged patches: preview, then confirm or reject. |
| `filesystem` (third party) | Sandboxed reads and writes within allowed paths. |

## Safety, compliance and review

| Server | Provides |
| :--- | :--- |
| `safe-exec-mcp` | Command analysis behind the tool-call gate: destructive operations, secrets in arguments, operand scope. |
| `risk-analyzer-mcp` | The risk tier (1–3) of a change and the critics it requires. |
| `context-guardian-mcp` | Role-based access checks for the workspace. |
| `verification-mcp` | Frontmatter and ghost-tool audits. |
| `blueprint-aligner-mcp` | Implementation-versus-blueprint diffs; flags drift. |
| `approval-mcp` | Human-in-the-loop approval prompts. |
| `advisor-mcp` | Lets the Engineer ask the Architect a question mid-task. |

## Memory and quality

| Server | Provides |
| :--- | :--- |
| `memory` (third party) | A knowledge graph of entities, relations and observations. |
| `memory-manager-mcp` | Higher-level queries and signature export over the graph. |
| `vibe-check-mcp` | Headless Playwright: screenshots, layout shift, accessibility. |

`ast-parser-mcp` is not in the registry: `rein sync` uses it to build `.ai/REPO_MAP.md` with
tree-sitter grammars (see `NOTICE`).

Test generation has no server — the `test_engineer` subagent writes tests in the project's own
harness.

## When a server misbehaves

`rein doctor --env` checks Node, the binaries and live connectivity to each server. `rein mcp-setup`
reinstalls their npm dependencies. After upgrading Rein, restart the Claude Code panes so they
start the new server code; preflight warns when a running server is older than the installed one.
