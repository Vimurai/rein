# Contributing to Rein

## Sign your commits (Developer Certificate of Origin)

Rein is licensed under the [Apache License 2.0](LICENSE). Contributions are accepted under the
same licence, with the [Developer Certificate of Origin](https://developercertificate.org/) —
no copyright assignment and no separate agreement. Certify each commit by signing it off:

```bash
git commit -s -m "fix(hooks): ..."
```

`-s` adds a `Signed-off-by: Your Name <you@example.com>` line, which means you certify the
following:

```
Developer Certificate of Origin
Version 1.1

Copyright (C) 2004, 2006 The Linux Foundation and its contributors.

Everyone is permitted to copy and distribute verbatim copies of this
license document, but changing it is not allowed.


Developer's Certificate of Origin 1.1

By making a contribution to this project, I certify that:

(a) The contribution was created in whole or in part by me and I
    have the right to submit it under the open source license
    indicated in the file; or

(b) The contribution is based upon previous work that, to the best
    of my knowledge, is covered under an appropriate open source
    license and I have the right under that license to submit that
    work with modifications, whether created in whole or in part
    by me, under the same open source license (unless I am
    permitted to submit under a different license), as indicated
    in the file; or

(c) The contribution was provided directly to me by some other
    person who certified (a), (b) or (c) and I have not modified
    it.

(d) I understand and agree that this project and the contribution
    are public and that a record of the contribution (including all
    personal information I submit with it, including my sign-off) is
    maintained indefinitely and may be redistributed consistent with
    this project or the open source license(s) involved.
```

A pull request whose commits are not all signed off is asked to add the sign-off before merge
(`git rebase --signoff` fixes a branch in one step).

## Development Setup

### Prerequisites
- **Node.js 22.5+** — required for all MCP servers (uses `node:sqlite` / DatabaseSync)
- **Python 3.10+** — required for state fallbacks and hooks
- **sqlite3 CLI** — required for system hooks
- **Bash/Zsh** — macOS or Linux

### Install from source
```bash
git clone https://github.com/Vimurai/rein.git && cd rein
npm ci                  # the clone's own dependencies: inside this repository the gate runs from src/
bash install-rein.sh   # copies src/ to ~/.rein and adds it to PATH
exec "$SHELL"
rein install && rein sync
rein doctor               # every gate line ✓ (a ✗ safe-exec gate line here means `npm ci` was skipped)
```

### Recommended dev environment — tmux
Contributors are strongly encouraged to develop with `brew install tmux` (or apt) and then simply run **`rein start`** in the project — it builds the two-pane Triad layout, binds each pane to its role from `.ai/roles.json`, idempotently. Use `rein start --status` to see what is running and `rein start --kill` to tear it down. `rein doctor` tells you whether the launcher can work on this host (tmux present, roles mapped, providers on `PATH`). The layout it produces, and the manual fallback for hosts without tmux, are described in the [README](README.md#starting-a-session): Architect ⬌ Engineer — by default both agent panes are Claude Code (Architect on `fable`, Engineer on `opus`, D-066). The Triad is designed for concurrent agent work — tmux keeps the Architect's blueprint pane visible while the Engineer is implementing in the next pane, which makes hand-offs cheap and reduces stale-context bugs.

### Run the test suite
```bash
bash tests/run.sh         # full suite (should be 100% green)
bash tests/suites/<name>_test.sh  # single suite
```

### Local CI (`rein ci`) — what "green" means

There is no hosted pipeline (D-072). `rein ci run` tests a **committed** sha in a detached
worktree under a throwaway `HOME`, with the framework installed from that commit, and records
the outcome in `.ai/state.sqlite`:

```bash
rein ci run              # ~10-14 min; 0 PASS / 1 FAIL / 2 ERROR
rein ci status --short   # the recorded verdict for HEAD
rein ci log --failed     # the failing suites of the last run — read this BEFORE theorising
```

A working-tree run is not evidence about a commit: `rein ci run` exists to exclude the
machine's own mirror and whatever a previous run left behind. Every PR needs a non-dirty
PASS row for its head commit; `update_task_status(DONE)` and the `pre-push` hook both refuse
without one. A commit that only adds `.ai/` bookkeeping above a tested commit is accepted.
To bypass one push, `REIN_CI_SKIP=1 REIN_CI_SKIP_REASON="<why>" git push` — recorded as a
`SKIPPED` run; a skip without a reason is refused.

---

## Project Structure

```
src/
  bin/            # ai, rein-exec and rein-account.sh (the CLI and its helpers)
  mcp/            # one dir per MCP server + shared/ helpers — 16 registered in .mcp.json,
                  # plus ast-parser-mcp, which rein sync runs as a CLI to build REPO_MAP.md
  shared/         # skills/ for both roles + the shared .mjs helpers the hooks and CLI use
  claude/         # the Claude Code adapter: agents/ (subagents), skills/, the CLAUDE.md shim
  config/         # registry.json (MCP servers, roles) + legacy-artefacts.json (rein clean)
  templates/      # ENGINEER.md, ARCHITECT.md, CLAUDE.md, roles.json, state.json and the .ai/ seeds
  contracts/      # Capability and security contracts
  copilot/        # GitHub Copilot CLI config (the copilot skill)
.ai/              # Project memory (generated by rein init — do not hand-edit)
tests/
  run.sh          # Test runner
  suites/         # One .sh file per test domain
  unit/           # node:test unit layer (*.test.mjs)
  lib/assert.sh   # Shared assertion helpers
hooks/            # Git and Claude Code hooks
```

---

## Authoring Skills

Skills are Markdown files with YAML frontmatter. They live in `src/shared/skills/<name>/SKILL.md` or `src/claude/skills/<name>/SKILL.md`; `rein sync` provisions both trees into `.claude/skills/`, and both roles receive every skill (`registry.json → roles`, joined by `role-manifest.mjs`).

### Skill frontmatter

```yaml
---
name: my-skill
description: One-line description used in _SKILLS_INDEX.md — be specific about when to trigger.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, Grep
context: default
agent: default
---
```

| Field | Required | Notes |
| :--- | :--- | :--- |
| `name` | Yes | Matches directory name |
| `description` | Yes | Used by `_SKILLS_INDEX.md` — must describe trigger conditions |
| `disable-model-invocation` | Yes | Always `false` for active skills |
| `user-invocable` | Yes | `true` if user can call via `skill: "name"` |
| `allowed-tools` | Yes | Comma-separated list — only declare tools actually used |
| `context` | No | Defaults to `default` |
| `agent` | No | Defaults to `default` |

### Ghost Tools

`allowed-tools` must only list tools that actually exist. Declaring a non-existent tool is a **Ghost Tool** — caught by `verification-mcp` and blocks commit via the pre-commit hook.

Valid tool categories:
- Built-ins: `Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebSearch`, `WebFetch`, `Agent`
- MCP tools: any `mcp__<server>__<tool>` pattern (e.g. `mcp__task-synchronizer-mcp__add_task`)
- Wildcard: `*` (grants all built-ins — use sparingly)

### Register in `_SKILLS_INDEX.md`

After creating a skill, add a one-line entry to the relevant index:
```
- skill-name: <trigger description — when to invoke, what it does>
```

The `rein sync` command auto-regenerates this index from frontmatter, but manual entries give more context.

---

## Authoring MCP Servers

Each MCP server lives in `src/mcp/<server-name>/` and must have:
- `index.js` — the server implementation (ES module, Node.js 20+)
- `package.json` — with `"scripts": { "start": "node index.js" }`

Use `@modelcontextprotocol/sdk` (already in root workspace — no need to install separately).

Skeleton:
```js
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server({ name: "my-mcp", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [ /* tool definitions */ ] }));
server.setRequestHandler(CallToolRequestSchema, async (request) => { /* handler */ });

const transport = new StdioServerTransport();
await server.connect(transport);
```

After adding a server, re-run the global installer to refresh the registry:
```bash
cd ~/.rein && bash install-rein.sh
```
Then run `rein sync` in any project to regenerate `.mcp.json`. (The previous `rein mcp-setup` shell command was removed in E-34; the install script does the same npm setup plus refreshes the global registry.)

---

## Git Workflow

### Branch strategy
- Work directly on `master` for small Tier 1 fixes
- Use feature branches for Tier 2/3 tasks: `feat/E-##-description`

### Commit format (Conventional Commits)
```
<type>(<scope>): <summary> (E-##)

[Optional body — what and why, not how]
```

Types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`

Use `skill: "commit-crafter"` in Claude Code to auto-format commits correctly.

### Pre-commit hook
The pre-commit hook runs automatically and:
- Verifies all agent/skill frontmatter via `verification-mcp`
- Blocks commits with Ghost Tools or missing required fields
- Checks Tier 3 tasks for `[SEC_CLEARED]` evidence

Do **not** use `--no-verify` to bypass — fix the underlying issue.

### Before merging
1. `bash tests/run.sh` — all tests must pass
2. `skill: "rein-review"` — run tier-appropriate critic review
3. `skill: "commit-crafter"` — format the commit message

---

## Adding Tests

Test suites live in `tests/suites/<domain>_test.sh`. Each suite sources `tests/lib/assert.sh` for helpers:

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

echo "── Suite: my_test ──"

assert_status 0 "T-01: description" <command>
assert_contains "T-02: description" "expected" "$actual"
assert_exists "/path/to/file"

assert_summary
```

Add the suite to `tests/run.sh` by placing it in `tests/suites/` — the runner auto-discovers all `*_test.sh` files.
