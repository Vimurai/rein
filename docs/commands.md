# Commands

The `rein` CLI owns the ledger and the bookkeeping; planning and building happen inside the two
Claude Code panes. `rein help` prints every command with its flags.

## Set up and keep healthy

| Command | What it does |
| :--- | :--- |
| `rein install` | Install the Claude Code configuration, build the `rein` plugin and add its marketplace. `bash install-rein.sh` runs it for you. |
| `rein init [--check]` | Create `.ai/` in a project or upgrade it; enable the plugin there; write the role settings files. `--check` is a dry run. |
| `rein sync` | Refresh the rulefiles, `.mcp.json`, `.claude/settings.json`, the rules and the git hooks; enable the plugin. |
| `rein doctor [--json] [--repair] [--env] [--compliance]` | Diagnose the install and the project; every `✗` names its fix. |
| `rein doctor --fitness [--json]` | The lean-core scorecard: one row per measure with its value, target and PASS, FAIL or UNKNOWN. |

## Run the two panes

| Command | What it does |
| :--- | :--- |
| `rein start [--status\|--kill\|--detach\|--dry-run\|--account <name>]` | Build or reattach the project's tmux session: Engineer left, Architect right. Idempotent. |
| `rein pane <architect\|engineer>` | Launch Claude Code in this pane, bound to the role and its sandbox. |

## Keep the books

| Command | What it does |
| :--- | :--- |
| `rein add-task [--tier N] [--prefix E\|P] <description>` | Add a task from the shell. The description needs an `Acceptance:` clause. |
| `rein done <id> --summary <text>` | Close a task through the completion gates; write the LOG line; rebuild the digest. Exit 1 names the missing stamp. |
| `rein handoff --to architect\|engineer --file <entry>` | Write the `## Handoff — <time> UTC` heading and `**From**` line, append the entry to `.ai/COMM.md`, run `rein archive`, commit the `.ai/` changes, print the wake line. An entry with its own `## Handoff` line is refused (`[HANDOFF_HEADING]`). |
| `rein decide --file <entry>` | Number the entry `D-###` and append it to `.ai/DECISIONS.md`. |
| `rein review <1\|2\|3> [--base <ref>]` | The deterministic checks on the diff and the agents to dispatch for the tier ([Review by tier](gates-and-review.md)). |
| `rein task show <id>` | Print one task, open or closed. |
| `rein archive [--logs]` | Move old handoffs and dated sections to `.ai/archive/`; `--logs` also moves `LOG.md` and `SESSION.md`. |
| `rein digest build\|check` | Rebuild `.ai/DIGEST.md`, or exit 1 with `[DIGEST_STALE]` when it is out of date. |
| `rein state import [--dry-run]` | Bring this machine's index up to what git tracks. |

## Test

| Command | What it does |
| :--- | :--- |
| `rein ci run [--ref <sha>]` | Test a committed sha in a clean worktree under a throwaway `HOME`; exit 0 PASS, 1 FAIL, 2 ERROR. |
| `rein ci status\|list\|log` | Read the recorded runs. See [CI](ci.md). |

## Outside the lean core

These are left as they were (D-170 r7) and are not part of the lean-core keep list:

| Command | What it does |
| :--- | :--- |
| `rein task claim\|release\|claims`, `rein team add\|show`, `rein trunk`, `rein state migrate` | Team mode: [Team mode](team-mode.md). |
| `rein ci hosted\|budget` | The hosted check and the test budget: [CI](ci.md). |
| `rein release stage\|manifest\|sign\|verify` | Building and verifying a signed release: [App contract](app-contract.md). |
| `rein account list\|add\|remove\|sync` | Extra Claude Code accounts: [Accounts](accounts.md). |
| `rein clean [--apply] [--restore <date>]` | List, then move to a dated trash, what older versions left behind. |
| `rein task done <id>` | The older form of `rein done`, through the same gates. |
| `rein uninstall`, `rein version` | Remove `~/.rein`; print the version. |
