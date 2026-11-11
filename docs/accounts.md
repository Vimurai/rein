# Accounts

Rein can run a project on a second Claude subscription: each **account** is a Claude Code config
directory (it holds that login), and a project names the account it uses. The names live in one
registry, `~/.rein/accounts.json`. This page is its contract for anything outside Rein that reads
it (rein-app). The rulings are D-095, D-153 r4 and D-153 addendum 2; the schema is
[`contract/accounts.schema.json`](contract/accounts.schema.json).

## The shape

```json
{ "accounts": { "work": { "config_dir": "/home/you/.claude-work", "added": "2026-11-10" } } }
```

- **Closed**: the root holds only `accounts`; an account row holds only `config_dir` and
  `added`. Nothing else, at either level.
- **Name**: `^[a-z][a-z0-9-]{0,23}$`.
- **`default` is never a row.** It means the default config directory (`~/.claude`, or the
  inherited `CLAUDE_CONFIG_DIR`) and is resolved, not stored.
- **`config_dir`**: an absolute directory strictly under `$HOME`, not inside `~/.claude`,
  `~/.rein` or a git working tree, owned by you and not group- or world-writable. Its
  `settings.json` is a gate configuration, so the directory is validated before anything
  exports it.
- **`added`**: `YYYY-MM-DD`. Always written; a reader must not rely on it being present.
- A missing file is an empty registry.

## Who writes it

**Only Rein** — `src/shared/accounts.py`, through `rein account add` and `rein account remove`.
An app never writes `accounts.json`; to add or remove an account it runs those commands.

The file is refused whole if it is not exactly this shape. **An extra key anywhere makes
`rein account`, `rein pane`, `rein start` and `rein doctor` refuse for every account**, not just
the row that carries it. That is deliberate: the registry decides which settings file a Claude
session loads, and it is never half-read.

## What a reader may rely on

- `accounts.<name>.config_dir` — the only guaranteed field.
- A reader **ignores a row key it does not know**. Rein may add a row field later; that is a
  change to `accounts.schema.json`, announced to rein-app before it ships, and a reader that
  already ignores unknown keys keeps working.

Commands: `rein account list | add <name> [--dir <path>] | remove <name> | sync <name>`; a
project binds an account with `rein start --account <name>` (stored by name in
`.ai/start.json`, never as a path).
