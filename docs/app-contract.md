# The app contract

What Rein guarantees to an app that installs and drives it (rein-app, or any second installer),
and what it asks of one. The normative text is
[`.ai/blueprints/release-artifact.md`](../.ai/blueprints/release-artifact.md) and the rulings
D-153, D-155 and D-156 in [`.ai/DECISIONS.md`](../.ai/DECISIONS.md); this page is that text for
a reader. The machine-checkable parts are published beside it:

| File | What it pins |
| :--- | :--- |
| [`contract/release-key.pub`](contract/release-key.pub) | The minisign public key every release is signed with (key id `5C9C75A7C8FA8056`) |
| [`contract/manifest.schema.json`](contract/manifest.schema.json) | `manifest.json`, schema 1 |
| [`contract/doctor.schema.json`](contract/doctor.schema.json) | `rein doctor --json`, schema 1 |
| [`contract/accounts.schema.json`](contract/accounts.schema.json) | `~/.rein/accounts.json` — see [Accounts](accounts.md) |
| [`../tests/fixtures/release/`](../tests/fixtures/release/) | Shared fixtures: `layout-v1.json`, `operator-owned-cases.json`, `profile-settings-cases.json`, `cli-surface.json`, `doctor-sample.json` |

Each schema is pinned by a test that validates a real output against it, so a schema that
drifts from what Rein produces fails Rein's own CI first.

## 1. The release

Every tag `vX.Y.Z` publishes three files on the GitHub release:

| File | Content |
| :--- | :--- |
| `rein-X.Y.Z.tar.gz` | `manifest.json` first, then every file the manifest lists; regular files only |
| `rein-X.Y.Z.tar.gz.minisig` | the minisign signature of the tarball, prehashed form |
| `manifest.json` | a byte-identical copy of the tarball's first member — **untrusted**, for display only |

The trust chain is: the public key baked into the app → the tarball's signature → the
`manifest.json` inside the tarball → each file's sha256. The manifest beside the tarball and the
release notes are never inputs to a decision. `manifest.version` inside the tarball is what an
installer compares with the version it asked for, so a correctly signed older tarball served
under a newer name fails.

The tarball is a plain ustar archive: `manifest.json` first, then the files in manifest order;
regular members only (no directory entries, no links, no pax or GNU extension records); names
relative with no leading `./`; uid and gid 0; mtime `SOURCE_DATE_EPOCH` or 0; gzip level 9. A
reader may refuse anything else, and should: a member the manifest does not list, an absolute
name, a `..` segment or any link type is a refusal of the whole artifact, before the first byte
is written.

### Verifying a release by hand

```bash
V=0.5.0
gh release download "v$V" --repo Vimurai/rein --pattern "rein-$V.tar.gz*"
minisign -V -p docs/contract/release-key.pub -m "rein-$V.tar.gz"   # "Signature and comment signature verified"
rein release verify "rein-$V.tar.gz"                                 # every member against the manifest inside
```

Without a Rein checkout, the member check by hand: `tar -xOzf rein-$V.tar.gz manifest.json`
gives the manifest; unpack into an empty directory and compare each file's `sha256sum`, size and
mode with its `files` entry.

### manifest.json, schema 1

```json
{ "schema": 1, "version": "0.5.0", "min_node": "22.5.0", "key_id": "5C9C75A7C8FA8056",
  "layout": { "mirrored": ["bin", "hooks", "mcp", "shared", "claude", "contracts", "templates", "copilot", "scripts", "config"],
              "operator_owned": ["accounts.json", "…"] },
  "files": [ { "path": "bin/rein", "sha256": "<64 hex>", "size": 250112, "mode": "0755" } ] }
```

Canonical form: two-space indent, keys in this order, `files` sorted by path bytewise, one
trailing newline. `mode` is `"0755"` or `"0644"` and nothing else. `key_id` is the minisign key
id; an app holding an older key reads it to say which app version it needs instead of failing
with a bare signature error. The full shape is
[`contract/manifest.schema.json`](contract/manifest.schema.json).

**Path rules.** Every `files` path is relative, `/`-separated, printable ASCII (0x20–0x7E), with
no `.` or `..` segment, no backslash, and short enough for a ustar header. No two paths — counting
every directory prefix of each — are equal after lowering `A`–`Z` (they would be one name on a
case-insensitive volume such as default macOS). The generator refuses a tree that breaks any of
these, so a reader never sees one.

## 2. The layout and the installer rule

The Rein home (`$HOME/.rein`) holds the ten `layout.mirrored` directories, `manifest.json` and
`VERSION`. An installer:

1. Writes only inside the mirrored directories, plus `manifest.json` and `VERSION` at the top.
   Every other top-level entry is left alone, listed or not.
2. Inside a mirrored directory: writes each path in `files` (temporary file and rename, never a
   directory swap); deletes each path not in `files` unless it matches `layout.operator_owned`.
3. **A shipped path wins over a pattern.** `mcp/orchestrator-mcp/package-lock.json` is shipped
   and also matches `mcp/*/package-lock.json`; it is written. The patterns protect from deletion.
4. Writes `hooks/` last, and `VERSION` (one line, `manifest.version`) after everything, so a
   failed copy never advertises a version.
5. Runs `rein install`, then `rein doctor`.

`operator_owned` patterns: a literal path; a trailing `/` for a directory and everything under
it; `*` within one path segment; `**` across segments. No negation, no character classes. The
conformance cases are [`operator-owned-cases.json`](../tests/fixtures/release/operator-owned-cases.json);
the pinned layout object is [`layout-v1.json`](../tests/fixtures/release/layout-v1.json).

`rein install` recognises an unpacked artifact by `manifest.json` (a clone install removes it)
and finishes it itself: it checks every listed file against the manifest
(`[INSTALL_TREE_MISMATCH]`, exit 3, nothing else done), refuses a `manifest.json` that disagrees
with `VERSION` (`[INSTALL_INCOMPLETE]`, exit 3), checks the Node floor, probes `/bin/bash -p`,
pins the hook toolchain, writes the install stamp (`source: "artifact"`, with `key_id`), adds the
shell profile lines, and removes retired MCP server mirrors. The app never reimplements these.

### The layout version rule

A layout change is: adding, removing or renaming a mirrored directory; removing an
`operator_owned` entry; moving `bin/rein`, `shared/locate.sh`, any `hooks/*.sh` a settings entry
names, `accounts.json`, `VERSION` or `manifest.json`. It needs a **major** version — and while
the version is `0.y.z`, the **minor** is the breaking position (`0.5.x` → `0.6.0`). Adding an
`operator_owned` entry is compatible. Separately, `schema` rises with any change to the shape
of `manifest.json` or the doctor document, and an app refuses a schema it does not know.

## 3. Settings an app may write

In a Claude profile's `<config_dir>/settings.json` an app may add, change or remove exactly
three keys: `enabledPlugins`, `extraKnownMarketplaces`, `attribution`. Every other key comes out
byte-for-byte as it went in. Never `autoMode`, `permissions` or `defaultMode` (the operator's
safety rules), and never `hooks`.

**Where the gate's hooks really live**: not in a profile. They are in each project's
`.claude/settings.json`, generated by `rein init` and `rein sync` with this machine's absolute
paths. An app writes no file inside a project. The accept/refuse cases are
[`profile-settings-cases.json`](../tests/fixtures/release/profile-settings-cases.json).

## 4. Headless entry points

These eight stay stable. Flags may be added, never removed, inside a major version (the minor,
before 1.0.0). The flags each one documents today are pinned in
[`cli-surface.json`](../tests/fixtures/release/cli-surface.json), and Rein's CI fails when one
disappears from `rein help`.

| Command | Use |
| :--- | :--- |
| `rein install` | After writing a release: finish the install (above) |
| `rein sync` | Re-provision a project (`--github`, `--prune-providers`) |
| `rein init` | Create or upgrade a project's `.ai/` (`--check` for a dry run) |
| `rein doctor` | Health, as text or `--json` (below) |
| `rein start` | Build or reattach a project's tmux Triad |
| `rein pane <architect\|engineer>` | Bind a pane to a role — the only way a role is bound; an app never mints a role token |
| `rein account list\|add\|remove\|sync` | The Claude account registry ([Accounts](accounts.md)) |
| `rein gate on\|status` | The safe-exec gate override's state (`off` is the operator's, in their own terminal) |

## 5. The doctor document

`rein doctor --json` prints one JSON document and a newline on stdout, nothing else:

```json
{ "schema": 1, "version": "0.5.0", "status": "fail",
  "checks": [ { "id": "gate_registered", "subject": null, "status": "fail",
                "line": "✗ [GATE_UNREGISTERED] no PreToolUse entry runs … — run: rein sync",
                "fix": "rein sync" } ] }
```

- Exit 0 or 1 means stdout is a document (1 = a check that means the gate cannot run here
  failed, exactly as in text mode). Any other exit means stdout is not a document.
- `id` is snake_case, fixed at the place the check is made, never derived from the text. A check
  that repeats per server, account, role or file keeps one `id` and names the item in `subject`;
  `(id, subject)` is unique within a document.
- `status` is `ok`, `warn` or `fail` (`✓` and `○` ok, `⚠` and `!` warn, `✗` fail). The
  document's `status` is `fail` if any check fails, else `warn` if any warns, else `ok`.
- `line` is what text mode prints, leading indentation removed, glyph kept; a multi-line message
  is one record joined with `\n`. `fix` is the command the line names after `run: `, or `null`.
- `--json` runs the default doctor only; with `--repair`, `--env` or `--compliance` it is a usage
  error, exit 2.

The shape is [`contract/doctor.schema.json`](contract/doctor.schema.json); a recorded document
from a fixture project is [`doctor-sample.json`](../tests/fixtures/release/doctor-sample.json).

**Doctor is not a polling probe.** It runs every check, some of them slow, and is meant for an
install, an upgrade, or a person asking. An app that wants to
watch state polls `rein state health --short`, which is cheap; it renders both and never
re-implements a check.
