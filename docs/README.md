# Rein documentation

Start with the [README](../README.md), or [Getting started](getting-started.md) for the four
steps from install to a closed task. These pages go deeper, one topic each.

| Page | Read it when |
| :--- | :--- |
| [How it works](how-it-works.md) | You want to know what Rein adds to Claude Code: the ledger, observed acceptance, the decision record, two roles with lanes. |
| [Getting started](getting-started.md) | Install to one closed task, in four steps. |
| [Install](install.md) | From an empty machine: prerequisites per OS, tmux, Claude Code, Rein, the first project, upgrading, uninstalling. |
| [Commands](commands.md) | What each `rein` command does. |
| [Review by tier](gates-and-review.md) | A task was refused DONE, or you want to know what each tier needs; the hooks. |
| [The role sandbox](role-sandbox.md) | What each role may write and reach, and how that is enforced. |
| [Troubleshooting and FAQ](troubleshooting.md) | Something is off, or you have a question. |
| [Agents and skills](agents-and-skills.md) | The 4 agents and 5 skills of the `rein` plugin. |
| [MCP server](mcp-servers.md) | The ledger's server. |
| [Configuration](configuration.md) | Every config file and environment variable. |
| [CI](ci.md) | Running `rein ci`, the test budget, the hosted pipeline. |
| [Team mode](team-mode.md) | More than one developer works on the repository. |
| [App contract](app-contract.md) | You build an installer or app on Rein: the signed release, the layout, the headless commands, `rein doctor --json`, the pane options. |
| [Accounts](accounts.md) | You read `~/.rein/accounts.json` from outside Rein. |

The design itself is not copied here: Rein is developed with Rein, so the system blueprint
([`.ai/architect.md`](../.ai/architect.md)), the per-domain blueprints
([`.ai/blueprints/`](../.ai/blueprints/)) and every decision
([`.ai/DECISIONS.md`](../.ai/DECISIONS.md)) live in the same `.ai/` memory the agents read. The
lean core is [`.ai/blueprints/lean-core.md`](../.ai/blueprints/lean-core.md).

`docs/audits/` holds point-in-time audit reports kept for reference; they describe Rein as it was
when they were written.
