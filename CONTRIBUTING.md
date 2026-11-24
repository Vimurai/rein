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


## Development setup

### Prerequisites

- **Node.js 22.5+**: the ledger uses `node:sqlite`.
- **Python 3.10+**, the **sqlite3** CLI, **git** and **tmux**.
- On Linux and WSL2, **bubblewrap** and **socat** for Claude Code's sandbox
  ([The role sandbox](docs/role-sandbox.md)).

### Install from source

```bash
git clone https://github.com/Vimurai/rein.git && cd rein
npm ci                  # the clone's own dependencies: inside this repository the hooks run from src/
bash install-rein.sh    # copies src/ to ~/.rein, builds the rein plugin, adds rein to PATH
exec "$SHELL"
rein sync               # in this repository, from your own terminal
rein doctor             # every ✗ names its fix
```

The installer refuses uncommitted changes under the paths it installs and names them;
`--allow-dirty` overrides it and records the install as dirty. A role pane's sandbox
cannot write `~/.rein`, so run `bash install-rein.sh` from your own terminal.

### Work in the two panes

Run **`rein start`** in the repository: it builds the two-pane tmux layout and binds each pane
to its role from `.ai/roles.json` (Architect on `fable`, Engineer on `opus`), idempotently.
`rein start --status` shows what runs, `rein start --kill` tears it down. Without tmux, see the
manual layout in the [install guide](docs/install.md#6-your-first-project).

### Run the tests

```bash
bash tests/run.sh                    # every suite
bash tests/run.sh --tier fast        # the unit layer and the contract tables (about a minute)
bash tests/suites/<name>_test.sh     # one suite
node --test tests/unit/<name>.test.mjs
```

### Local CI (`rein ci`) — what "green" means

`rein ci run` tests a **committed** sha in a detached worktree under a throwaway `HOME`, with
Rein installed from that commit, and records the outcome in `.ai/state.sqlite`:

```bash
rein ci run              # 0 PASS / 1 FAIL / 2 ERROR
rein ci status --short   # the recorded verdict for HEAD
rein ci log --failed     # the failing suites of the last run — read this BEFORE theorising
```

A working-tree run is not evidence about a commit. Every pull request needs a non-dirty PASS
row for its head commit; the `pre-push` hook refuses without one, and so does `rein done` once
the project has run CI. A commit that only adds `.ai/` bookkeeping above a tested commit is
accepted. To bypass one push, `REIN_CI_SKIP=1 REIN_CI_SKIP_REASON="<why>" git push`, recorded
as a `SKIPPED` run; a skip without a reason is refused. The hosted pipeline: [CI](docs/ci.md).

---

## Project structure

```
src/
  bin/            # rein (the CLI), rein-account.sh, rein-exec
  mcp/            # task-synchronizer-mcp (the ledger), shared/ (incl. seatbelt.mjs, advice)
  shared/         # the helpers the CLI and hooks use; skills/ shared by both roles
  claude/         # agents/, skills/, plugin/ (the plugin manifest templates)
  config/         # registry.json (the MCP server, the roles)
  templates/      # ENGINEER.md, ARCHITECT.md, CLAUDE.md, roles.json and the .ai/ seeds
  contracts/      # capability and security contracts
  copilot/        # GitHub Copilot CLI config
hooks/            # session-start and waiting-signal (the plugin); pre-commit, pre-push,
                  # post-commit, state-import (git); pre-tool-use (the seatbelt, advice)
tests/
  run.sh          # the runner
  suites/         # one bash suite per process boundary
  unit/           # node:test unit layer (*.test.mjs)
  fixtures/       # contract tables (*-cases.json)
  lib/            # shared helpers (assert.sh, toolchain-fixture)
.ai/              # Rein's own record: tasks, blueprints, decisions
```

---

## Agents and skills

They ship in the `rein` plugin, which `rein install` builds from `src/claude/agents/`,
`src/claude/skills/` and `src/shared/skills/`; see [Agents and skills](docs/agents-and-skills.md).
The plugin build refuses two units with the same name.

A skill is `SKILL.md` with YAML frontmatter:

```yaml
---
name: my-skill
description: One line that says when to trigger it and what it does.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, Grep
---
```

`allowed-tools` (a skill) and `tools` (an agent) may name only tools that exist: built-ins
(`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`, `WebSearch`, `WebFetch`, `Agent`) or
`mcp__<server>__<tool>` of a server Rein ships. `rein doctor --compliance` audits it.

D-170 keeps Rein to 4 agents and at most 6 skills. A new one is a decision for the Architect;
removed units belong to a plugin marketplace, not to this repository.

---

## Git workflow

- One branch per task or batch; `main` is protected and takes pull requests only.
- Commit subject: `[TIER_N] <type>(<scope>): <summary>`, with the task id in the summary or body.
  Types: `feat`, `fix`, `refactor`, `test`, `chore`, `docs`.
- Sign off every commit (`git commit -s`).
- Do not use `--no-verify`: fix what the hook names.

The pre-commit hook checks machine-local files, the privacy scan, record parity in a team
project, and the Architect's lane. It asks for no review stamp. Review is by tier and is checked
when the task closes:

1. `rein review <tier>` and the agents it prints (skill `rein-review` in a pane).
2. `rein done <id> --summary <text>`: refused without the stamps the tier needs.
3. `rein ci run` on the commit, then push.

See [Review by tier](docs/gates-and-review.md).

---

## Adding tests

A test is a claim about one behaviour, at the cheapest layer that can observe it (D-088):

- a pure function: `tests/unit/<name>.test.mjs` under `node --test`;
- several inputs to one rule: rows of a contract table, `tests/fixtures/<family>-cases.json`;
- a process boundary (a hook, git, tmux, the installer): a bash suite in
  `tests/suites/<behaviour>_test.sh` that sources `tests/lib/assert.sh`.

```bash
#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

echo "── Suite: my_behaviour ──"

assert_status 0 "E-##.01: description" <command>
assert_contains "E-##.02: description" "expected" "$actual"

assert_summary
```

The runner discovers every `*_test.sh` in `tests/suites/`. Name a suite for the behaviour it
observes, never for a task id.
