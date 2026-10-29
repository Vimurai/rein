# Rein documentation

Start with the [README](../README.md) for the 60-second quickstart. These pages go deeper, one
topic each.

| Page | Read it when |
| :--- | :--- |
| [Getting started](getting-started.md) | Installing, the tmux layout, a second Claude account, upgrading, uninstalling. |
| [How it works](how-it-works.md) | You want the model: roles, the `.ai/` memory, handoffs, a task's life. |
| [Gates and review](gates-and-review.md) | A gate refused something, or you want to know what the critics check. |
| [Local CI](local-ci.md) | Running `rein ci`, the test budget, machine-specific environment, hosted CI. |
| [Team mode](team-mode.md) | More than one developer works on the repository. |
| [Agents and skills](agents-and-skills.md) | What each subagent and skill does, and when it runs. |
| [MCP servers](mcp-servers.md) | What each local MCP server provides. |
| [Configuration](configuration.md) | Every config file and environment variable. |
| [Troubleshooting and FAQ](troubleshooting.md) | Something is off, or you have a question. |

The design itself is not copied here: Rein is developed with Rein, so the system blueprint
([`.ai/architect.md`](../.ai/architect.md)), the per-domain blueprints
([`.ai/blueprints/`](../.ai/blueprints/)) and every decision
([`.ai/DECISIONS.md`](../.ai/DECISIONS.md)) live in the same `.ai/` memory the agents read.

`docs/audits/` holds point-in-time audit reports kept for reference.
