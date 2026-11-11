# Blueprint — The release artifact and the app contract (D-150, D-153, D-155; P-50)

## Goal & Architecture
`rein-app` (Rust) installs, updates and displays Rein without containing a line of Rein logic
(D-150). For that, this repo owes it four things, listed in `plans/rein-ecosystem-contract.md`
§2: a signed artifact per tag, an install layout that does not move, a statement of which
settings keys the app may write, and health it can read without parsing prose. Users: the
`rein-app` fetcher, layout writer and status view; the release workflow; an operator who wants
to check a download by hand. In one sentence: a tag becomes three files anyone can verify
offline, and an unpacked artifact plus `rein install` equals what `install-rein.sh` produces.

Nothing here changes what a clone install does. The artifact path is additive (D-150 rollback).

## Core Concept
**One layout, one implementation, two front doors.** `install-rein.sh` already stages the
whole tree, verifies that it parses, and only then writes it live (E-304). The artifact is
that staged tree, frozen: `install-rein.sh --stage <dir>` stops after the verification, and
`rein release manifest` hashes what it finds there. The installer stays the only code that
knows which source directory becomes which installed directory, so the tarball cannot drift
from a clone install.

The other half is what the installer does *after* the copy (toolchain pin, install stamp,
shell profile lines, the hook-interpreter probe). Those steps move into one shared file that
both `install-rein.sh` and `rein install` call. An app that unpacks the artifact and runs
`rein install` therefore reaches the same end state, and never reimplements a step.

Trust: minisign, public key baked into the app (D-153 r1). The signature covers the tarball;
the manifest inside the tarball covers every file; the manifest beside the tarball is a
convenience copy that nothing trusts.

## Components

### Component 1 — Stage mode: `install-rein.sh --stage <dir>` (E-417)
- Runs steps 0 and 1 of the installer up to and including `_verify_stage`, with the stage
  directory being `<dir>` (must not exist or be empty; refused otherwise), then exits 0.
  It writes nothing under `$HOME`: no `mkdir ~/.rein`, no live sync, no `VERSION`, no profile
  lines, no `rein install`.
- The stage holds the ten mirrored directories (`_REIN_TREES` plus `scripts` and `hooks`).
  `hooks/` is always staged: the hook-interpreter probe (`[HOOK_BASH_MISSING]`) is a property
  of the installing host, not of the artifact, so it does not run in stage mode.
- Excluded from the stage, in this mode and in the live path alike: `node_modules/`,
  `__pycache__/`. In stage mode additionally any file `git` does not track when the source is
  a work tree (an untracked `package-lock.json` from a local `npm install` never reaches an
  artifact). The dirty-tree refusal (`[INSTALL_DIRTY_TREE]`, `--allow-dirty`) applies unchanged.
- `rein release stage <dir>` is the CLI spelling: it resolves the clone the running `rein`
  belongs to and calls the installer there; from an installed mirror with no clone it refuses
  with one line (`rein release stage: needs a checkout`), exit 2.

### Component 2 — Manifest and tarball: `rein release manifest <tree> [--out <dir>] --pubkey <file>` (E-418)
- `src/shared/release-manifest.mjs`, no dependency beyond `node:` modules, runnable from a
  checkout (`node src/shared/release-manifest.mjs …` is what `rein release manifest` execs).
- Input: a staged tree from Component 1. Output in `<dir>` (default: the current directory):
  `manifest.json` and `rein-<version>.tar.gz`. `--no-tarball` writes the manifest only.
- Refuses, naming the path, exit 3: a symlink, a hard link pair, a device or any non-regular
  file in the tree; a top-level entry that is not one of `layout.mirrored`; a path with a `..`
  segment, a backslash, a control character or a name longer than ustar's 100+155 split
  holds; a path under a mirrored directory that equals `config/rein-workspace.txt`,
  `config/install-stamp.json` or `shared/toolchain.sh` (install-generated, never shipped);
  a path with a byte outside printable ASCII (0x20–0x7E); two paths, or a path and a
  directory prefix of another, that differ in bytes and are equal once `A`–`Z` is lowered
  (`shared/b.mjs` beside `shared/B.mjs`; `shared/Lib` beside `shared/lib/x.mjs`) — both
  names are printed, `[RELEASE_CASE_COLLISION]` (D-155 addendum 3, built in E-422); a
  path that matches a `layout.operator_owned` pattern once `A`–`Z` is lowered in both and
  does not match it exactly (`shared/Toolchain.sh`, `mcp/x/Package-Lock.json`) — same tag,
  path and pattern printed (addendum 3 r8). An exact match is unchanged.
- The tarball is written by the same module (a ustar writer, about sixty lines), not by the
  host's `tar`, so GNU and BSD hosts produce the same archive members: `manifest.json` first,
  then every `files` entry in manifest order; regular files only (typeflag `0`), no directory
  entries; names relative, no leading `./`; uid, gid 0; uname, gname empty; mtime
  `SOURCE_DATE_EPOCH` or 0; mode from the manifest. gzip level 9. The promise is identical
  *members* across hosts; byte-identical gzip output is promised only for one Node major on
  one platform, which is all the release runner needs.
- The writer never emits a pax or GNU extension record (`x`, `g`, `L`, `K`), a directory
  entry or a link; a path that would need one is refused at generation. Readers may reject
  all of them, and rein-app's does. Lifting this is a `schema` change with a notice to
  rein-app first (D-155 addendum r4).
- `rein release verify <tarball> [--pubkey <file>]` (same module): reads the tarball with the
  matching reader, which accepts only what the writer emits; checks that the first member is
  `manifest.json`, that the member set equals `files` exactly, and each size, sha256 and
  mode. With `--pubkey` it first runs `minisign -V` on `<tarball>.minisig`; without it prints
  `signature not checked`. Exit 0 match, 3 mismatch (first five paths named), 2 usage.

### Component 3 — Signing and the release workflow (E-419, Tier 3)
- `rein release sign <tarball>`: wraps the `minisign` binary. The secret key comes from the
  environment variable `REIN_RELEASE_KEY` (the key file's two lines); it is written to a
  `0600` file in a fresh `mktemp -d` directory, used once, and removed in a trap. No key, no
  `minisign` on PATH, or a signature that does not verify against `--pubkey` immediately
  afterwards: refuse, exit 3, nothing left beside the tarball. Trusted comment:
  `file:rein-<version>.tar.gz version:<version>`. Only the prehashed form (`ED`, minisign
  0.10 and later) is produced.
- `.github/workflows/release.yml` (hand-written, `ci_gate` first): after "Required checks are
  green" and before "Publish the release", in a job bound to the GitHub environment `release`:
  `rein release stage` → `rein release manifest --pubkey docs/contract/release-key.pub` →
  assert `v<manifest.version>` equals the tag → `rein release sign` → `rein release verify
  --pubkey …` → `gh release create` with the three assets (the assertion precedes signing, so
  a mismatched tag never receives a signature: D-155 addendum 4 r8; the secret-presence check
  is the job's first step). The release notes gain the tarball's
  sha256 and the `key_id` under the existing installer line. A missing secret fails the job
  before anything is published: from the tag after E-419 merges, a release without a
  signature does not exist.
- `minisign` on hosted CI (D-155 addendum 4). The rendered `ci.yml` is not changed: rows that
  need the binary `skip_unless_cmd minisign`, counted and host-named, and run in the local
  gate. `release.yml` gains a second job, `workflow_dispatch` only, not bound to the
  `release` environment, no secret, `contents: read`: apt-install `minisign`, bootstrap Rein,
  stage → manifest → sign → verify with the throwaway pair, print the sha256 and `minisign
  -v`; nothing published or uploaded. The release job carries an explicit `if:` for a `v*`
  tag push, so a dispatch never reaches the real key. After E-419 merges the dry run is
  dispatched on `main`; its green run is a precondition of E-424.
- The public key is committed as `docs/contract/release-key.pub` by the Engineer from the file
  the operator hands over; the manifest's `key_id` is read from it. The throwaway pair for
  tests lives in `tests/fixtures/release/` (`throwaway.pub`, `throwaway.key`, generated with
  `-W`, first line of each says THROWAWAY) and is never the key any app bakes in.

### Component 4 — `rein install` finishes an unpacked artifact (E-420, Tier 3)
- New file `src/shared/install-finalize.sh` holds, as functions, what `install-rein.sh` does
  between the copy and its `rein install` call: the hook-interpreter probe (§0b), the
  toolchain pin (§2b), the install stamp, the PATH and `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`
  profile lines (§3). `install-rein.sh` sources it from the clone and calls the same
  functions in the same order; its output and exit codes do not change.
- **Artifact mode** is detected by `rein install`, never passed as a flag: `~/.rein/manifest.json`
  exists. A clone install removes that file, so its presence always means the tree came from
  an artifact. Present but unreadable, not schema 1, or with a `version` that differs from
  `~/.rein/VERSION` (or no `VERSION`) is a refusal, not a fallback to the clone path
  (D-155 addendum r2): `[INSTALL_INCOMPLETE] manifest.json says <a>, VERSION says <b> — the
  release was not fully unpacked; reinstall it`, exit 3, nothing else done. This is also what a
  second `rein install` meets while an installer is between its last two renames; during the
  file sync itself it meets the tree check below. Both windows fail closed, so schema 1 needs
  no lock shared with the installer. In artifact mode, before the existing `install_global` body:
  1. Tree check: every `files` entry exists under `~/.rein` with the manifest's size and
     sha256, and its mode is applied (`chmod`) if it differs. A missing or different file:
     `[INSTALL_TREE_MISMATCH] <n> file(s) differ from the manifest — reinstall the release`,
     first five named, exit 3, nothing else done.
  2. Node floor (the shared `node-version.sh` comparison): below it, exit 1 with the
     installer's own two lines.
  3. Hook-interpreter probe. On failure the install continues and exits 1 at the end with
     `[HOOK_BASH_MISSING]`, as the installer does; `hooks/` is left in place.
  4. Toolchain pin, roots being the git toplevel of the current directory and the current
     directory when it holds `.ai/` (there is no clone to add).
  5. Install stamp: `{"source":"artifact","version":…,"key_id":…,"commit":null,"dirty":false,"installed_at":…}`,
     tmp and rename. `config/rein-workspace.txt` is removed: this tree did not come from a
     clone, and a record left by an earlier clone install would point `rein sync` and the
     task router at a tree that is no longer what is installed.
  6. Profile lines.
- **No `rein` command writes a path listed in `manifest.files`** (D-158 r1–r6, E-426). The
  tree check exempts nothing. The dependency step of `install_global` therefore treats a
  server whose `package-lock.json` is shipped differently: `npm ci` (installs exactly the
  lock, never writes it) instead of `npm install`. "Shipped" is one function with two
  sources: the manifest's `files` in artifact mode, the clone's tracked files in a clone
  install, so both leave the same lock. After a successful `npm ci` the lock's sha256 is
  written to `mcp/<server>/node_modules/.rein-lock.sha256`; `rein install` skips `npm ci`
  when that marker equals the current lock's sha256, so a second run fetches nothing.
  Servers without a shipped lock keep `npm install`. A failure prints `✗ <server>: npm ci
  failed` and the install continues, as the `npm install` line does. Row (extends the
  artifact-install rows): `rein install` twice then `rein doctor` — both exit 0, the second
  runs no `npm ci`, the install line is `✓`, the lock's bytes equal the manifest's.
- **Removals beyond the mirror rule** (D-155 addendum r1), after the six steps, artifact mode
  only. The installer's `purge_retired_mcp_mirrors` and its legacy-mirror loop move into
  `install-finalize.sh` as one function each, taking the set of live server names as
  arguments: the installer passes the directory names of `src/mcp`, artifact mode passes the
  distinct `mcp/<name>/` prefixes of the manifest's `files`. A directory `~/.rein/mcp/<name>`
  with no shipped file beneath it is a retired server and is removed whole, `node_modules`
  included; the top-level `gemini/` and `agents/` mirrors of v3 are removed. Guards, as today
  and one more: nothing is removed when the name set holds no server with an `index.js`; an
  entry that is a symlink is unlinked, never followed. The mirror rule itself does not change:
  an installer leaves a retired server's `node_modules` in place (it matches `operator_owned`)
  and `rein install` removes it, so a layout comparison between an artifact install and a
  clone install is taken after `rein install` on both sides.
- **A stamp never contradicts the tree** (D-155 addendum r3). In any mode, when
  `config/install-stamp.json` names a `version` other than `VERSION`, or says `artifact` while
  no `manifest.json` exists, `rein install` rewrites it as `{"source":"restored","version":<VERSION>,
  "commit":null,"dirty":false,"installed_at":…}`. That is the state a rollback to a snapshot
  taken from a clone install leaves. `rein doctor` prints `○ install: restored tree, origin not
  recorded — reinstall from a clone or a release to record it`. The clone record
  (`config/rein-workspace.txt`) is not recreated; only `bash install-rein.sh` writes it.
- A clone install removes `~/.rein/manifest.json` after its live sync, so a later `rein install`
  is not mistaken for artifact mode.
- `rein doctor` gains two lines from the same data: `✓ install: artifact <version> (key <key_id>),
  <n> files match the manifest` or the mismatch as `✗`; and `_install_report` prints
  `artifact <version>` instead of a clone path when the stamp says so.
- Fix lines in `src/bin/rein` that name the installer go through one helper: `bash install-rein.sh`
  when the stamp's source is a clone, `reinstall the Rein release with the tool that installed it`
  when it is `artifact`. The hooks' own messages are not changed in this arc (gate code; see
  Security).

### Component 5 — `rein doctor --json` (E-421)
- One reporting function replaces the direct `echo` of every check line in `doctor()` and the
  `_doctor_*` / `_report_*` helpers it calls: `_dr <id> <status> <line> [<fix>] [<subject>]`.
  Text mode prints `<line>` exactly as today. JSON mode appends one record to a file in a
  `mktemp -d` directory (a file, so a check running in a subshell or a pipeline still reports:
  D-064 §2) and prints nothing; at the end one `node` call renders the document.
- Lines that come from a helper program (`mcp-paths.mjs doctor`, `hosted-ci.mjs --doctor`,
  `cli-state.mjs trunk --doctor`, `publish-scan.mjs`, `rein-clean.mjs doctor`, the Python
  reports) pass through `_dr_lines <id>`: status from the leading glyph, `fix` = the text
  after the first `run: ` when the line has one, an indented line without a glyph is joined to
  the record before it with `\n`.
- Glyph to status: `✓` ok, `⚠` and `!` warn, `✗` fail, `○` ok (a note; it never changed the
  verdict). Section headers and blank lines are not records.
- `--json` runs the default doctor only. With `--repair`, `--env` or `--compliance` it is a
  usage error, exit 2, one line on stderr.
- Acceptance is a byte comparison: text-mode output before and after the change is identical
  on every doctor row the suites already run, and a new row asserts that the set of
  `checks[].line` values in JSON mode equals the glyph-carrying lines of the text run in the
  same fixture.
- **Scopes** (D-158 r8–r11, E-427). Every check has a scope, `install`, `host` or `project`,
  taken from ONE table keyed by check `id`, `src/shared/doctor-scopes.json`, never from the
  call site. `install`: judges only files under the Rein home and what the gate needs to run
  from it (tree against the manifest, stamp, `VERSION`, hook files and form, hook toolchain,
  gate dependencies and pins, server dependencies and builds, Node floor, `rein` on PATH).
  `host`: the machine outside the Rein home and outside any project (`~/.claude`, `gh`,
  Copilot, tmux, browsers, accounts). `project`: reads the current directory or its git
  toplevel. Guard row: an id emitted by any doctor fixture and missing from the table fails,
  and so does a table id no call site has.
- The document's check records gain `scope`. `schema` stays 1 (no release has carried a doctor
  document; after v0.5.0 such a field raises it).
- `rein doctor --scope install [--json]`: runs and reports only install-scope checks, reads
  nothing relative to the current directory, needs no project; `status` is computed over
  those records; the exit code keeps doctor's rule applied to those records. `--scope` takes
  `install` only; another value is a usage error, exit 2. Without `--scope` doctor is
  unchanged apart from the field.
- An installer, after install, update or rollback, runs `rein install` then `rein doctor
  --scope install --json` from any directory and judges by `status`: `fail` is a failed
  install. Host and project checks are never an install failure. `docs/app-contract.md` §2
  rule 5 and §5 say so.

### Component 6 — The published contract: documents, schemas, shared fixtures (E-422)
- `docs/app-contract.md`: the layout and its version rule, the upgrade rule, the settings
  allow-list, the headless entry points, the three release files and how to verify them by
  hand. `docs/accounts.md`: the registry (D-153 r4 as corrected by D-153 addendum 2): the
  shape is closed (`{"accounts": {"<name>": {"config_dir", "added"?}}}`, nothing else at
  either level), `accounts.py` is its only writer, an app reads `config_dir` and changes the
  registry through `rein account add|remove` only. `accounts.schema.json` has
  `additionalProperties: false` at both levels and `added` optional.
- `docs/contract/manifest.schema.json`, `doctor.schema.json`, `accounts.schema.json` (JSON
  Schema 2020-12). Each is pinned by a row that validates a real output against it: the
  manifest from a stage of the checkout, the doctor document from a fixture project, a
  registry written by `accounts.py add`.
- Fixtures other repos test against, under `tests/fixtures/release/`:
  `operator-owned-cases.json` (path, shipped yes/no, expected: kept / replaced / deleted; it
  describes the mirror step only, so a retired server's `node_modules` is `kept` there),
  `profile-settings-cases.json` (settings before, the write the app attempts, accept / refuse),
  `layout-v1.json` (the pinned `layout` object), `cli-surface.json` (the eight entry points of
  contract §2.6 with every flag `rein help` documents for them today), `doctor-sample.json`
  (one recorded document, for rein-app's snapshot tests).
- Two guard rows: the `layout` a stage produces equals `layout-v1.json` (message on failure:
  `a layout change is a breaking version — contract §2.2`); every command and flag in
  `cli-surface.json` still appears in `rein help`.

## Data Model

**The three release files** (assets of the GitHub release `vX.Y.Z`):

| File | Content |
|---|---|
| `rein-X.Y.Z.tar.gz` | `manifest.json` + every `files` path; regular files only |
| `rein-X.Y.Z.tar.gz.minisig` | minisign signature of the tarball, prehashed form |
| `manifest.json` | byte-identical copy of the tarball's first member; untrusted |

**manifest.json, schema 1** (D-153 r2; canonical form: two-space indent, keys in this order,
`files` sorted by path bytewise, one trailing newline):

```
{ "schema": 1, "version": "0.5.0", "min_node": "22.5.0", "key_id": "<16 hex, as minisign prints it>",
  "layout": { "mirrored": ["bin","hooks","mcp","shared","claude","contracts","templates","copilot","scripts","config"],
              "operator_owned": [ …the list below… ] },
  "files": [ { "path": "bin/rein", "sha256": "<64 hex>", "size": 250112, "mode": "0755" } ] }
```
- `version` from `package.json`; `min_node` from `REIN_NODE_FLOOR` padded to three parts.
- `mode` is `"0755"` when the staged file has the owner-execute bit, or is `bin/rein`, or
  matches `hooks/*.sh`; otherwise `"0644"`. No other value exists in schema 1.
- `operator_owned`, schema 1 (D-153 addendum r2 plus one entry, D-155 r2): `accounts.json`,
  `gate-override.json`, `secrets/`, `run/`, `memory/`, `incidents.ndjson`, `telemetry.sqlite`,
  `INSIGHTS.md`, `memory-palace.md`, `config/rein-workspace.txt`, `config/install-stamp.json`,
  `shared/toolchain.sh`, `mcp/*/node_modules/`, `mcp/*/package-lock.json`.

**What an installer does with it** (the rule `install-rein.sh` follows today, stated for a
second implementation):
1. It writes only inside the `mirrored` directories, plus `manifest.json` and `VERSION` at the
   top of the Rein home. Every other top-level entry is left alone, listed or not (`ci/`,
   `trash/` and whatever a later version adds are covered by this sentence, not by the list).
2. Inside a mirrored directory: a path in `files` is written (tmp and rename per file, never
   a directory swap); a path not in `files` is deleted unless it matches `operator_owned`.
3. **A shipped path wins over a pattern.** `mcp/orchestrator-mcp/package-lock.json` is tracked
   and shipped, and also matches `mcp/*/package-lock.json`; it is written. The patterns
   protect from deletion, exactly as the installer's `P` filters do.
4. `hooks/` is written last; `VERSION` (one line, `manifest.version`) after everything, tmp
   and rename, so a failed copy never advertises a version.
5. Then `rein install`, then `rein doctor`.

**Install stamp** `config/install-stamp.json`: existing keys `source`, `commit`, `dirty`,
`version`, `installed_at`; `source` is a clone path or the literal `artifact`; `key_id` is
present only for `artifact`.

**Doctor document** (D-153 r3 plus the additive fields of D-155 r5):

```
{ "schema": 1, "version": "0.5.0", "status": "ok|warn|fail",
  "checks": [ { "id": "gate_registered", "subject": null, "status": "fail",
                "line": "✗ [GATE_UNREGISTERED] no PreToolUse entry runs … — run: rein sync",
                "fix": "rein sync" } ] }
```
- `id`: snake_case, assigned at the call site, never derived from the text. A check that
  repeats per item (server, account, role, file) keeps one `id` and names the item in
  `subject`; `(id, subject)` is unique within a document. `checks` is in print order.
- `line`: what text mode prints, leading indentation removed, glyph kept.
- `status` of the document: `fail` if any check fails, else `warn` if any warns, else `ok`.

**Layout version rule.** A layout change is: adding, removing or renaming a `mirrored`
directory; removing an `operator_owned` entry; moving `bin/rein`, `shared/locate.sh`, any
`hooks/*.sh` a settings entry names, `accounts.json`, `VERSION` or `manifest.json`. It needs a
major version; while the version is `0.y.z` the minor is the breaking position. Adding an
`operator_owned` entry is compatible. Whatever changes, `schema` rises with any change to the
manifest's shape, and an app refuses a schema it does not know (D-153 rollback).

**Settings a profile's `settings.json` may receive from the app** (corrects contract §2.3,
D-155 r3): `enabledPlugins`, `extraKnownMarketplaces`, `attribution`. Nothing else, and never
`autoMode`, `permissions`, `defaultMode` (D-132) or `hooks`. The gate's hook entries are not in
a profile at all: they are in each project's `.claude/settings.json`, generated by `rein init`
and `rein sync` with this machine's absolute paths, and the app writes no file inside a project.

## API / Interface Contracts

| Command | Input | Output | Exit |
|---|---|---|---|
| `bash install-rein.sh --stage <dir>` | a checkout | staged tree in `<dir>` | 0; 2 dirty tree; 3 stage invalid or `<dir>` not empty |
| `rein release stage <dir>` | — | same | same; 2 without a checkout |
| `rein release manifest <tree> [--out <dir>] [--no-tarball] --pubkey <file>` | staged tree | `manifest.json`, tarball | 0; 2 usage; 3 refused path (named) |
| `rein release sign <tarball> --pubkey <file>` | `REIN_RELEASE_KEY` | `<tarball>.minisig` | 0; 3 no key, no `minisign`, or self-check failed |
| `rein release verify <tarball> [--pubkey <file>]` | tarball, `.minisig` | one line per finding | 0; 2 usage; 3 mismatch or bad signature |
| `rein install` (artifact mode) | `~/.rein/manifest.json` | the installer's lines | 0; 1 Node floor or `[HOOK_BASH_MISSING]`; 3 `[INSTALL_INCOMPLETE]`, `[INSTALL_TREE_MISMATCH]` or a gate dependency off its pin (E-305, unchanged) |
| `rein doctor --json` | cwd | one JSON document and a newline on stdout; nothing else on stdout | 0 or 1 (1 = a check that means the gate cannot run here failed, as in text mode); any other status means stdout is not a document |
| `rein doctor --scope install [--json]` | the Rein home; cwd is not read | install-scope checks only | as `rein doctor`, over those checks; 2 for another `--scope` value |

`rein help` lists `rein release stage|manifest|sign|verify` and `rein doctor [--json]`.
`rein release` with no key material configured is usable for everything except `sign`.

## Security
- **Trust chain**: app-baked public key → tarball signature → manifest inside the tarball →
  per-file sha256. The manifest beside the tarball and the release notes are never inputs to
  a decision. `manifest.version` inside the tarball is what an installer compares with the
  version it asked for; a correctly signed older tarball served under a newer name fails that
  comparison.
- **Outside the signature**: the npm dependencies `rein install` fetches. They are covered
  only by the E-305 gate pins (a gate dependency off its pin refuses the install). Shipping
  `node_modules` inside the artifact is not decided here; it belongs with the app's bundled
  Node (rein-app phase 2) and needs its own ruling.
- **Key custody**: generated by the operator on their own machine (`minisign -G`), never by an
  agent. The secret key exists in two places: the operator's offline copy and the GitHub
  environment secret `REIN_RELEASE_KEY`, readable only by the `release` environment's job on
  a `v*` tag. Rotation: commit the new public key, release the app with it, then tag `rein`;
  `key_id` in the manifest lets an older app say which app version it needs.
- **Signing step**: key material never appears in an argument, a log line or the stage; the
  key file lives in a private temp directory and is removed in a trap; the workflow passes
  the tag and the secret as environment variables, never interpolated into the script.
- **Unpacking** (rules for the reference reader and for the app): regular files only; a
  member the manifest does not list, an absolute name, a `..` segment or any link type is a
  refusal of the whole artifact, before the first byte is written to the Rein home.
- **Artifact mode cannot be forged into weakening the gate**: it is entered only by files
  under `~/.rein`, which every role's gate already refuses to write (`[GATE_SELF_DISABLE]`).
  The tree check runs before the toolchain pin, so a tampered `hooks/` is refused, not pinned.
- **Reviews**: E-419 and E-420 are Tier 3. Each needs the `security_engineer` report and a
  `[SEC_CLEARED]` line in `.ai/LOG.md` before merge; E-419 runs `ci_gate` first. The committed
  throwaway key is exempted from the secret rule by file name in `standards.json` with a
  one-line reason (D-065), if the rule fires on it at all.
- **Not changed**: hook messages that say `run: bash install-rein.sh`. On an app install that
  text names a script the machine does not have. Changing hook output is gate work and is left
  as a named risk for the next arc rather than folded into this one.

## Execution Constraints
- Stage plus manifest plus tarball for today's tree (248 tracked files under the shipped
  directories): under 5 s on the release runner; the generator streams each file once.
- `rein install` in artifact mode adds one hashing pass over the installed files (under 1 s)
  to what the installer already costs; `npm install` remains the slow part and needs network.
- `rein doctor --json` costs one `node` start more than the text run and has no bound of its
  own. It is not a polling probe: `rein state health --short` is the cheap one, and the app
  contract document says so.
- No new npm dependency. One new host tool, `minisign`, needed only by `sign` and by
  `verify --pubkey`; rows that need it skip with a counted skip when it is absent and run on
  the hosted Linux leg, which installs it.
- Tests (D-088): each new row names the row it extends; no suite is named after a task. The
  rows this blueprint orders trace to D-155. If `[BUDGET_REGRESSION] test_lines` appears, the
  Engineer reports the measured value and the Architect rules the number, as in D-149.
- `src/shared/release-manifest.mjs` stays under the 500-line warning; the tar reader and
  writer may be a second file beside it if not.

## Rollback Plan
- **Artifact**: delete the three assets from a release (`gh release delete-asset`); the
  release and a clone install are unaffected. Revert the `release.yml` step to return to
  notes-only releases.
- **Stage mode, `rein release`**: additive; remove the verb and the flag. Nothing reads them
  outside the workflow and the tests.
- **Artifact mode in `rein install`**: remove `~/.rein/manifest.json` and run
  `bash install-rein.sh` from a clone; the machine is a clone install again.
  `install-finalize.sh` can be inlined back into the installer without a behaviour change,
  which is what its "output and exit codes do not change" acceptance guarantees.
- **`rein doctor --json`**: remove the flag; `_dr` in text mode is `echo`.
- **A leaked or lost key**: new key pair, app release with the new public key, re-tag. Schema
  1 has no revocation list; an app that still carries the old key keeps trusting artifacts
  signed with it, so the app release is the revocation.

## E-## Task Breakdown

| Task | Tier | Scope | Depends on |
|---|---|---|---|
| E-417 | 2 | Component 1: `--stage`, `rein release stage` | — |
| E-418 | 2 | Component 2: manifest, tarball writer and reader, `verify` without a key | E-417 |
| E-419 | 3 | Component 3: `sign`, `verify --pubkey`, throwaway pair, `release.yml`. The workflow half waits for the operator's public key | E-418 |
| E-420 | 3 | Component 4: `install-finalize.sh`, artifact mode, stamp, doctor install line, fix-line helper | E-418 |
| E-421 | 2 | Component 5: `_dr`, `rein doctor --json` | — |
| E-422 | 2 | Component 6: documents, schemas, fixtures, the two guard rows | E-418, E-420, E-421 |
| E-423 | 1 | Publish `docs/contract/release-key.pub` on `main` (committed in `a1c3af0`) and mark it `-text` | — |
| E-424 | 2 | Release v0.5.0, the first signed artifact; the operator creates the tag | E-417..E-423, E-426, E-427 |
| E-426 | 3 | Component 4, D-158 r1–r6: `npm ci` for a server with a shipped lock, the marker, the twice-installed row | E-420 |
| E-427 | 2 | Component 5, D-158 r8–r11: `doctor-scopes.json`, `scope` field, `rein doctor --scope install`, contract text | E-421, E-422 |

**Build order (D-156 r4):** E-423 now, then E-417 → E-418 → E-420 → E-421 → E-422 → E-419 →
E-424. E-420 precedes E-419 because rein-app's layout-equality test waits on E-417, E-418 and
E-420, and nothing needs a signature before a tag exists. The handoffs after E-420 and after
E-422 merge name the merge commit for `rein-app · Architect`. D-158 r12 inserts E-426 → E-427
after E-425 and before E-419 → E-424: rein-app cannot install a release cleanly without them.
The handoff after each of the two merges names the merge commit for `rein-app · Architect`.

**Release v0.5.0 (D-156 r5–r6, E-424).** The Engineer bumps the version, writes the CHANGELOG
section and merges; the operator creates the `v0.5.0` tag on that merge commit, which starts
the workflow of Component 3 in the `release` environment. The Engineer then downloads
`rein-0.5.0.tar.gz`, its `.minisig` and `manifest.json` from the release and runs
`rein release verify --pubkey docs/contract/release-key.pub`. v0.4.0 gets no assets.

**The key (D-156 r1–r3).** The operator generated the pair on 2026-11-10 (key id
`5C9C75A7C8FA8056`). The public key is committed in `a1c3af0`, sha256
`8e0c6bd7df27c8bfbc74b81b8f3f188fbb5707a9046946cceea1b383289c9166`, identical to rein-app's
copy. E-419 Part B no longer commits it and no longer waits for it.

Operator inputs still outstanding, none of which an agent may perform: create the GitHub
environment `release` with the secret `REIN_RELEASE_KEY`; restrict who may push `v*` tags;
create the `v0.5.0` tag.
