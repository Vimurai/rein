# Troubleshooting and FAQ

Start with `rein doctor`. Every ✗ line names its fix. `rein doctor --env` goes deeper (Node,
binaries, permissions, live MCP connectivity); `rein doctor --repair` fixes what it can.

## Troubleshooting

| Symptom | First check | Then |
| :--- | :--- | :--- |
| `ai: command not found` | Is `~/.rein/bin` on `PATH`? | Open a new shell; `rein doctor` prints the export line. |
| MCP servers fail to start | `node --version` is 22.5 or later? | `rein mcp-setup`, then `rein doctor --env`. |
| Servers answer with old behaviour after an upgrade | Preflight's "stale MCP servers" line | Restart both Claude Code panes. |
| A pane opens and fails at the first keystroke | `rein doctor`: is `claude` on PATH, are the roles mapped? | `rein start --status`; relaunch with `rein start`. |
| The other pane never wakes | Is it open? A closed pane gets "not reachable". | Relaunch it; the handoff note is in `.ai/COMM.md`. |
| Commit refused: no review stamp | Was the change reviewed? | `skill: ai-review` in the Engineer pane. |
| Commit refused: ghost tool | `rein doctor --compliance` | Fix `allowed-tools`/`tools` in the named agent or skill. |
| Push refused | `rein ci status --short` | `rein ci run`; `rein ci log --failed`; fix and push again. |
| `[BUDGET_REGRESSION]` | Which field? `rein ci budget` | Make the tests cheaper, or record a decision and `rein ci budget set`. |
| Task will not close: `[CI_GATE]` | `rein ci status --short` | Wait for or run `rein ci run` on HEAD. |
| Tasks differ between machines | `rein doctor` state health | `rein state import` (lossless). Avoid `rein migrate-state`: it rebuilds from `TASKS.md` and drops summaries. |
| A command was refused by the gate | The refusal names the rule | Rephrase, or — for you, in your terminal — `rein gate off --minutes 15 --reason "…"`. |
| `DIGEST.md` feels stale | Its first line has the date | `skill: ai-digest`. |
| Pre-commit hook missing | `.git/hooks/pre-commit` exists? | `rein init` reinstalls it. |

## FAQ

**Does my code leave my machine?**
Only through Claude Code itself, exactly as when you use it alone. Rein has no server and sends
nothing anywhere. Telemetry is a local SQLite file; `AI_TELEMETRY_DISABLE=1` turns it off.

**Do I need two Claude subscriptions?**
No. Both panes run on your one Claude Code login. `rein account` exists for keeping a project on a
different subscription, not because two are needed.

**Which models does it use?**
By default the Architect runs on `fable`, the Engineer on `opus`, the Tester and the critics on
`sonnet`. Change the panes in `.ai/roles.json`.

**Does it work on an existing codebase?**
Yes. `rein init` never overwrites your files. Ask the Architect to reverse-engineer the codebase
into the digest, brief and blueprint before planning.

**Can I use only the Engineer?**
Yes: you get memory, gates, critics and CI, and you do the planning yourself. Add tasks with
`rein add-task`.

**Is it only for JavaScript?**
No. The framework runs on Node, but your project can be anything. `skill: ai-test` runs your
project's own test command; the code map understands JavaScript and TypeScript best.

**Why so many rules?**
Each replaced a failure that actually happened: a red main branch nobody noticed for two days, a
role overwriting the other's plan, a secret pasted into a command. They are hooks, so they cost
nothing until they catch something.

**Can an agent turn the gates off?**
No. `rein gate off` must be run in your own terminal, is time-boxed, still blocks catastrophic
commands, and announces every call it lets through.

**Why is the install directory called `~/.rein`?**
The project was called Rein before it was renamed Rein. Commands, paths and environment
variables kept their names so existing installs, scripts and hooks keep working.

**How do I report a security problem?**
Privately — see [SECURITY.md](../SECURITY.md).
