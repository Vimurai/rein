# Upgrading

## From AI-OS to Rein (0.4.x)  <!-- rename:legacy-fallback -->

Rein was called AI-OS before 0.4.0. The command is still `ai` and a project's state still  <!-- rename:legacy-fallback -->
lives in `.ai/`; everything else that carried the old name now says `rein`. One upgrade is
enough:

```bash
bash install-rein.sh   # from the new clone
ai sync                # in each project
ai doctor              # the "Rename to Rein" section should end with "nothing carries the old name"
```

What the upgrade does for you:

| Before | After | Done by |
|---|---|---|
| `~/.ai-os/` | `~/.rein/` (the old path stays as a symlink) | `install-rein.sh`, once |  <!-- rename:legacy-fallback -->
| `AI_OS_<X>` environment variables | `REIN_<X>` (the old name is read when the new one is unset) | `ai`, at startup |  <!-- rename:legacy-fallback -->
| hook paths and env keys in `.claude/settings.json` | regenerated under `~/.rein/hooks/` | `ai sync` |
| `aios-record` merge driver (`.ai/.gitattributes`, `.git/config`) | `rein-record` | `ai sync` |  <!-- rename:legacy-fallback -->
| `project.aios_version`, `ci.aios_source` | `project.rein_version`, `ci.rein_source` | `ai sync` |  <!-- rename:legacy-fallback -->
| `install-ai-os.sh` | `install-rein.sh` (the old name forwards) | — |  <!-- rename:legacy-fallback -->

`ai doctor` lists what is left: `[LEGACY_HOME_LINK]` for the symlink, `[LEGACY_ENV]` for each
old variable in your environment, `[RENAME_PENDING] <file>` for a project file `ai sync` has
not rewritten yet.

Two cases the installer will not decide for you:

- **Both `~/.ai-os/` and `~/.rein/` are real directories** (for example, a newer `ai` ran  <!-- rename:legacy-fallback -->
  before the installer did). It stops with `[LEGACY_HOME_CONFLICT]` and exit 2. Keep
  `~/.ai-os/` (it holds your installed state), move anything you need from `~/.rein/` into  <!-- rename:legacy-fallback -->
  it, remove `~/.rein/`, and run the installer again.
- **A trust-bearing old variable** (`AI_OS_CALLER_ROLE`, `AI_OS_PANE_ROLE`, `AI_OS_TC_*`,  <!-- rename:legacy-fallback -->
  `AI_OS_LOCATE_*`) is never read under the new name, and hooks drop every `AI_OS_*`  <!-- rename:legacy-fallback -->
  variable. Rename these by hand if you set them.

### Removed in 0.5

The 0.5 installer deletes the `~/.ai-os` symlink, and the old environment names, keys and  <!-- rename:legacy-fallback -->
`install-ai-os.sh` stop working. Run `ai doctor` before you upgrade to 0.5: every line  <!-- rename:legacy-fallback -->
in its rename section should be gone.
