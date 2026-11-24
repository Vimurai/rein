# Troubleshooting and FAQ

Start with `rein doctor`; every ✗ line names its fix, and the five commonest failures on a new
machine are in [Install, step 8](install.md#8-if-something-is-off). `rein doctor --env` goes
deeper (Node, binaries, permissions, a live MCP connection); `rein doctor --repair` fixes what it
can.

## Troubleshooting

| Symptom | First check | Then |
| :--- | :--- | :--- |
| `rein: command not found` | Is `~/.rein/bin` on `PATH`? | Open a new shell; `rein doctor` prints the export line. |
| `rein pane` refuses: `[SANDBOX_MISSING]` | `rein doctor` names what is missing. | Install bubblewrap and socat, or enable user namespaces ([The role sandbox](role-sandbox.md#requirements)). |
| The agents or skills are missing in a pane | `rein doctor`: `[PLUGIN_NOT_ENABLED]`? | `rein sync` in your own terminal, then restart the pane. |
| `rein sync` fails inside the Engineer pane | The Engineer's sandbox cannot write `.claude/`. | Run it in your own terminal. |
| A write fails with "read-only file system" | Which pane? The Architect writes only `.ai/` and `plans/`. | Hand the work to the other role. |
| The MCP server fails to start | `node --version` is 22 or later? | `rein mcp-setup`, then `rein doctor --env`. |
| The server answers with old behaviour after an upgrade | Was the pane started before the upgrade? | Restart both panes. |
| The other pane never wakes | Is it open? A closed pane gets "not reachable". | Relaunch it; the handoff note is in `.ai/COMM.md`. |
| `rein done` refuses: `[REVIEW_GATE]` / `[ACCEPT_GATE]` / `[SEC_GATE]` | `.ai/REVIEWS.md`: is there a PASS for HEAD? | `rein review <tier>` and dispatch the agents it prints; a source commit after a stamp needs it again. |
| `rein done` refuses: `[CI_GATE]` | `rein ci status --short` | `rein ci run` on HEAD. |
| `add_task` refuses a task | The message names the missing part. | Add a tier, start with an imperative verb, end with `Acceptance:` naming a command, a file or a count. |
| Push refused | Lane ledger or CI? The message says which. | `rein ci run`; `rein ci log --failed`. An Architect commit outside its lane is not pushed. |
| A command was refused by the command gate | The refusal names the rule. | Rephrase. For you, in your own terminal: `rein gate off --minutes 15 --reason "…"`. The gate leaves with E-463. |
| Tasks differ between machines | `rein doctor` state health | `rein state import` (lossless). Avoid `rein migrate-state`: it rebuilds from `TASKS.md` and drops summaries. |
| A closed task is missing from `TASKS.md` | `TASKS.md` lists open tasks only. | `rein task show <id>`. |
| `DIGEST.md` looks stale | `rein digest check` | `rein digest build` (session start and `rein done` run it too). |
| A hook says `[GATE_INTERNAL_ERROR]` | `rein doctor` | Rerun `bash install-rein.sh`, then `rein sync`. |

## FAQ

**Does my code leave my machine?**
Only through Claude Code itself, exactly as when you use it alone. Rein has no server and sends
nothing anywhere.

**Do I need two Claude subscriptions?**
No. Both panes run on your one Claude Code login. `rein account` exists for keeping a project on
a different subscription.

**Which models does it use?**
By default the Architect runs on `fable`, the Engineer on `opus`, the Tester on `sonnet`; the
reviewer and the acceptance evaluator inherit the session's model. Change the panes in
`.ai/roles.json`.

**Can I use only one pane?**
Rein is built for two (D-171 r1): the independent planner and the enforced lane are what it
adds. The ledger commands work from any shell, so you can add and close tasks yourself.

**Does it work on an existing codebase?**
Yes. `rein init` never overwrites your files. Ask the Architect to reverse-engineer the codebase
into `.ai/BRIEF.md` and `.ai/architect.md` before planning.

**Is it only for JavaScript?**
No. Rein runs on Node, but your project can be anything: `skill: rein-test` runs your project's
own test command.

**Where did the other agents, skills and servers go?**
D-170 cut Rein to what Claude Code does not have. Tag `v0.5.0` holds everything removed; see
[CHANGELOG.md](../CHANGELOG.md).

**How do I report a security problem?**
Privately — see [SECURITY.md](../SECURITY.md).
