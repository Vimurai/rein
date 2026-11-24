# The role sandbox

The boundary between the Architect and the Engineer is a Claude Code settings file per role,
with Claude Code's sandbox on. The model cannot talk its way past it: a write outside the lane
fails with a read-only file system error, whatever the command looks like. The rulings are
D-169 r3 and D-170 r10; the measurements behind them are in
[`plans/e-458-sandbox-measurement.md`](../plans/e-458-sandbox-measurement.md).

## What each role may do

| | Architect | Engineer |
| :--- | :--- | :--- |
| File tools (`Write`, `Edit`) | `.ai/**` and `plans/**` only (`dontAsk` plus two allow rules) | the project |
| Bash writes | `.ai/`, `plans/` and `.git` (to commit); every other top-level entry is denied | the project; not `~/.rein` (but its CI logs), not the project's `.claude/` |
| Branch | commits on the current branch; `.git/HEAD` is denied, so it cannot switch | free |
| Network | none | `github.com`, `api.github.com`, `*.githubusercontent.com`, `registry.npmjs.org` |
| MCP | the state server only (`--strict-mcp-config`) | the project's `.mcp.json` |

Both roles: the sandbox is required (`failIfUnavailable`), a command never retries outside it
(`allowUnsandboxedCommands: false`), and bypass and auto modes are disabled.

## Where the files are

`rein init`, `rein pane` and `rein start` write the files under
`~/.rein/roles/<project>-<hash>/`: `settings.architect.json`, `settings.engineer.json` and
`mcp.architect.json`. They are regenerated on every launch, so the Architect's deny list always
names the top-level entries that exist when the pane starts. Neither role can edit them: the
Engineer's sandbox denies `~/.rein`, and it is outside the Architect's write list.

`rein pane <role>` passes the file to `claude --settings`. It refuses to start a role session
when the sandbox is unavailable (`[SANDBOX_MISSING]`); `rein start` warns up front.

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
- **macOS**: the built-in `sandbox-exec`. The lanes were measured on Linux and WSL2.
- Native Windows is not a target; use WSL2.

## Known limits

- **A new top-level entry.** Claude Code keeps the working directory writable, so the Architect's
  Bash can create a file or directory that did not exist at launch. The pre-push lane check
  refuses a commit that adds one, but an uncommitted file the Architect creates can ride along in
  the Engineer's `git add -A`. Review what you stage.
- **The command gate still runs.** The older PreToolUse gate (`hooks/pre-tool-use.sh`, with its
  operator escape `rein gate off`) is still installed and checks every tool call in both panes.
  Its removal is task E-463, held until the operator runs the sandbox escape suite; until then
  both apply.
- The Engineer cannot write the project's `.claude/`, so run `rein sync` from your own terminal,
  not from the Engineer pane.

The escape suite, `tests/suites/sandbox_escape_test.sh`, runs real sessions against these files
and checks each guarantee.
