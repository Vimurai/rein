# The role sandbox

The boundary between the Architect and the Engineer is a Claude Code settings file per role,
with Claude Code's sandbox on. The model cannot talk its way past it: a write outside the lane
fails with a read-only file system error, whatever the command looks like. The rulings are
D-169 r3, D-170 r10 and D-172 r2; the measurements behind them are in
[`plans/e-458-sandbox-measurement.md`](../plans/e-458-sandbox-measurement.md).

**Measured on Linux and WSL2 only** (Claude Code 2.1.331, bubblewrap 0.11.1, WSL2 kernel 6.18).
macOS is not measured: Claude Code's macOS sandbox is a different mechanism, and no claim on
this page has been checked there.

## What each role may do

| | Architect | Engineer |
| :--- | :--- | :--- |
| File tools (`Write`, `Edit`) | `.ai/**` and `plans/**` only (`dontAsk` plus two allow rules) | the project |
| Working directory | `<project>/.ai` | the project root |
| Bash writes | `.ai/`, `plans/` and `.git` (to commit); nothing else, the project root included | the project; not `~/.rein` (but its CI logs), not the project's `.claude/` |
| Branch | commits on the current branch; `.git/HEAD` is denied, so it cannot switch | free |
| Network | none | `github.com`, `api.github.com`, `*.githubusercontent.com`, `registry.npmjs.org` |
| MCP | the state server only (`--strict-mcp-config`) | the project's `.mcp.json` |

Both roles: the sandbox is required (`failIfUnavailable`), a command never retries outside it
(`allowUnsandboxedCommands: false`), and bypass and auto modes are disabled.

**Why the Architect starts in `.ai/`** (D-172 r2). Claude Code's sandbox always makes the
working directory writable. Started at the project root, the Architect's Bash could create a new
top-level file — an `.npmrc`, a `conftest.py`, a `.pnpmfile.cjs` — that the Engineer's tools then
load and run with the Engineer's rights (the lean-core security round, F3). Started in `.ai/`,
the working directory is its own lane, the project root is read-only to it with no deny list, and
such a file cannot be made. A session started there reads no project `.claude/settings.json`, so
the Architect's role file carries what it needs from it: the command gate's hook (until E-463)
and the session env; `rein pane` loads the rein plugin with `--plugin-dir`, and the state server
and the session hook find the project root one level up. In Bash the Architect gives paths
absolute, or `cd ..` first in the same command.

## Where the files are

`rein init`, `rein pane` and `rein start` write the files under
`~/.rein/roles/<project>-<hash>/`: `settings.architect.json`, `settings.engineer.json` and
`mcp.architect.json`. They are regenerated on every launch. Neither role can edit them: the
Engineer's sandbox denies `~/.rein`, and it is outside the Architect's write list.

`rein pane <role>` passes the file to `claude --settings`. `rein pane` and `rein start` both
refuse to start when the sandbox is unavailable (`[SANDBOX_MISSING]`, exit 2).

## What git checks as well

The sandbox stops writes, but git plumbing can record a path without writing it. Two hooks check
the content of a commit:

- **pre-commit** refuses an Architect commit outside its lane.
- **pre-push** refuses a pushed commit that changes a path outside `.ai/` and `plans/` unless the
  Engineer's lane ledger recorded it (the post-commit hook writes the ledger). There is no skip
  variable.

## Requirements

- **Linux and WSL2**: `bubblewrap` and `socat`, and user namespaces that work.
  `rein doctor` prints `✓ sandbox available` or `✗ [SANDBOX_MISSING]` with the install line for
  your distribution (for example `sudo apt-get install -y bubblewrap socat`).
- **macOS**: not measured. Claude Code uses the built-in `sandbox-exec` there, and `rein doctor`
  does not check it; nothing on this page has been observed on macOS.
- Native Windows is not a target; use WSL2.

## Known limits

- **`plans/` is the Architect's.** A tool that loads code from a subdirectory it walks (a test
  runner that collects `plans/`) would run what the Architect wrote there. Keep tool roots out of
  `plans/`.
- **The command gate still runs.** The older PreToolUse gate (`hooks/pre-tool-use.sh`, with its
  operator escape `rein gate off`) is still installed and checks every tool call in both panes.
  Its removal is task E-463, held until the operator runs the sandbox escape suite; until then
  both apply.
- The Engineer cannot write the project's `.claude/`, so run `rein sync` from your own terminal,
  not from the Engineer pane.

The escape suite, `tests/suites/sandbox_escape_test.sh`, runs real sessions against these files
and checks each guarantee.
