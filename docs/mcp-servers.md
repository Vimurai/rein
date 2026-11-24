# MCP server

Rein has one MCP server of its own, `task-synchronizer-mcp`: the ledger. `rein init` and
`rein sync` write it into the project's `.mcp.json` from `~/.rein/config/registry.json`, with
absolute paths; servers you add yourself are kept. It runs as a local process over stdio and
listens on no port.

| Tool group | Provides |
| :--- | :--- |
| Tasks | `add_task` (refuses a task with no tier, no imperative verb or no observable acceptance), `update_task_status`, `get_state`, claims for team projects. |
| Stamps | `add_stamp`, which the review agents use; `REVIEWS.md` is regenerated from them. |
| Views | Regenerates `TASKS.md` and `REVIEWS.md` after every change; `verify_markdown_sync` checks them. |
| CI | `get_ci_status`, the recorded `rein ci run` verdicts. |

The shell commands (`rein done`, `rein add-task`, `rein task show`, `rein state import`) write
through the same library, so a session that has no MCP connection can still keep the books.

The Architect's session loads this server only (`--strict-mcp-config`).

A `.mcp.json` written before E-463 may still list the old command gate's server; `rein sync` regenerates it
with the one server.

## When it misbehaves

`rein doctor --env` checks Node, the binaries and a live connection to each server.
`rein mcp-setup` reinstalls the server dependencies. After an upgrade, restart both panes so they
start the new server code.
