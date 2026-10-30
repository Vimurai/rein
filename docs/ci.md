# CI — local and hosted

Two layers test the same thing. `rein ci run` tests a commit on your machine, and the pre-push
hook requires it. The hosted pipeline repeats that on every pull request, on more operating
systems and Node versions, and protects `main`.

## Local CI

CI runs on your machine. `rein ci run` tests a **committed** sha: it creates a detached
`git worktree`, sets a throwaway `HOME`, installs the framework from that commit, and runs the
test suites, the unit tests and a secrets check. Nothing from your working tree or your real
`~/.rein` leaks in — which is the point: a suite that passes in your working tree says nothing
about the commit.

```bash
rein ci run                      # test HEAD (about 10 minutes for Rein itself)
rein ci run --ref <sha>          # test another commit
rein ci run --dirty              # include uncommitted changes — never certifies a commit
rein ci run --suite-only         # or --unit-only
rein ci run --keep               # keep the worktree for inspection
rein ci status [--ref <sha>] [--short]
rein ci list [-n 10]
rein ci log [<sha>] [--failed]
rein ci budget
```

Exit codes: `0` PASS, `1` FAIL, `2` ERROR (the run itself could not complete). Verdicts are rows
in `.ai/state.sqlite`; logs are in `~/.rein/ci/logs/`. `rein doctor` prints the verdict for HEAD.

### What reads the verdict

"CI green" means a non-dirty PASS for that exact commit.

- **Closing a task.** `rein-task` (and `rein task done`) refuse until HEAD — or an ancestor that
  differs only in `.ai/` — is green. `REIN_CI_GATE=0` disables this; say so when you use it.
- **Pushing.** The `pre-push` hook refuses an untested tip.

### Skipping once

```bash
REIN_CI_SKIP=1 REIN_CI_SKIP_REASON="prod outage hotfix" git push
```

The skip is recorded as a `SKIPPED` run with its reason. There is no silent bypass.

### Machine-specific environment

A local service on another port, or a URL only your machine has, goes in the gitignored
`.ai/ci.local.json`:

```json
{ "env": ["DATABASE_PORT=5433", "DATABASE_URL"] }
```

`NAME=value` sets a literal; a bare `NAME` passes your shell's value through (never written to the
file or the log; unset means skipped, with a note). Variables the run depends on — `PATH`, `HOME`,
`TMPDIR`, `SHELL`, `CI`, `REIN_*`, `npm_config_*` and the like — are refused with
`[CI_ENV_RESERVED]`. The secrets step fails a project whose `.gitignore` does not cover the file;
`rein sync` adds the line.

### The test budget

Every green run records:

| Field | Ratchet |
| :--- | :--- |
| `suites` | may not grow (+0) |
| `test_lines` | +2 % slack |
| `fast_tier_seconds` | +10 % slack |
| `full_seconds`, `peak_rss_mb`, `peak_sum_rss_mb` | recorded, not ratcheted (host load makes them noisy) |

The best (lowest) value since the last ruling is the budget; a run that exceeds it plus its slack
fails with `[BUDGET_REGRESSION]`, naming the field. No flag lifts it. To raise a budget, record a
decision and write it into the record:

```bash
rein ci budget set --ruling D-042 test_lines=41000
```

## Hosted CI

`rein ci hosted` renders the hosted check for your project's provider. The provider comes from
the argument, then `.ai/team.json`, then the origin host. GitHub is supported; Azure Pipelines,
GitLab and Bitbucket are planned. The rendered workflow has exactly two steps: bootstrap Rein,
then `rein ci run` on the merge result. So the hosted verdict is the same command as the local
one, on a fresh machine.

```bash
rein ci hosted               # write .github/workflows/ci.yml for this project
rein ci hosted --check       # exit 1 when the file is not the current rendering
rein ci hosted --required    # the check names the branch protection must require
```

Projects whose test runner has a fast tier (`tests/run.sh --tier fast`) get a `fast` job first.
It runs the unit layer without the installer, so a broken change fails in about a minute. The
full run is then split into shards (`--shard i/N`; four by default, `ci.shards` in
`.ai/team.json`).

### Rein's own pipeline

Rein's repository uses the public profile of the same renderer, plus a few hand-written
workflows:

| Workflow | When | What |
| :--- | :--- | :--- |
| `main CI` (`ci.yml`) | every pull request and push to `main` | `fast`, then `rein ci run` in four shards on Ubuntu × Node 22, Ubuntu × Node 24 and macOS × Node 22 |
| `privacy` | every pull request and push | the publish scan: no personal data, no private paths in the tree |
| `CodeQL` | every pull request and push, and weekly | static analysis of the JavaScript |
| `Dependency review` | every pull request | new dependencies with known vulnerabilities or disallowed licences |
| `Nightly` | 03:00 UTC daily | the full matrix plus macOS × Node 24 and one unsharded leg, and `npm audit` |
| `Release` | a `v*` tag | the full matrix, then the GitHub release, once the required checks are green on the tag |
| `Scorecard` | push to `main`, weekly | the OpenSSF supply-chain score |

### Required checks

`main` accepts a pull request only when these checks are green. The `rein ci run` names are
exactly what `rein ci hosted --required` prints; branch protection and the release gate both
read that list, so it has one source.

| Check | Runs |
| :--- | :--- |
| `privacy scan` | the publish scan |
| `CodeQL` | static analysis |
| `fast` | the fast tier |
| `rein ci run (ubuntu-latest, node 22, 1/4)` … `4/4` | the full run, four shards |
| `rein ci run (ubuntu-latest, node 24, 1/4)` … `4/4` | the full run on the next Node |
| `rein ci run (macos-latest, node 22, 1/4)` … `4/4` | the full run on macOS (bash 3.2, BSD tools) |

A required check is never skipped or bypassed to get green. A check that fails for a reason
outside the change (a runner stall, a network error) is rerun once, with the cause named. A
Windows (WSL2) leg is planned. It will be informative at first, and required after three green
runs in a row on `main`.
