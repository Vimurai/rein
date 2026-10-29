# Local CI

CI runs on your machine. `ai ci run` tests a **committed** sha: it creates a detached
`git worktree`, sets a throwaway `HOME`, installs the framework from that commit, and runs the
test suites, the unit tests and a secrets check. Nothing from your working tree or your real
`~/.ai-os` leaks in — which is the point: a suite that passes in your working tree says nothing
about the commit.

```bash
ai ci run                      # test HEAD (about 10 minutes for Rein itself)
ai ci run --ref <sha>          # test another commit
ai ci run --dirty              # include uncommitted changes — never certifies a commit
ai ci run --suite-only         # or --unit-only
ai ci run --keep               # keep the worktree for inspection
ai ci status [--ref <sha>] [--short]
ai ci list [-n 10]
ai ci log [<sha>] [--failed]
ai ci budget
```

Exit codes: `0` PASS, `1` FAIL, `2` ERROR (the run itself could not complete). Verdicts are rows
in `.ai/state.sqlite`; logs are in `~/.ai-os/ci/logs/`. `ai doctor` prints the verdict for HEAD.

## What reads the verdict

"CI green" means a non-dirty PASS for that exact commit.

- **Closing a task.** `ai-task` (and `ai task done`) refuse until HEAD — or an ancestor that
  differs only in `.ai/` — is green. `AI_OS_CI_GATE=0` disables this; say so when you use it.
- **Pushing.** The `pre-push` hook refuses an untested tip.

## Skipping once

```bash
AI_OS_CI_SKIP=1 AI_OS_CI_SKIP_REASON="prod outage hotfix" git push
```

The skip is recorded as a `SKIPPED` run with its reason. There is no silent bypass.

## Machine-specific environment

A local service on another port, or a URL only your machine has, goes in the gitignored
`.ai/ci.local.json`:

```json
{ "env": ["DATABASE_PORT=5433", "DATABASE_URL"] }
```

`NAME=value` sets a literal; a bare `NAME` passes your shell's value through (never written to the
file or the log; unset means skipped, with a note). Variables the run depends on — `PATH`, `HOME`,
`TMPDIR`, `SHELL`, `CI`, `AI_OS_*`, `npm_config_*` and the like — are refused with
`[CI_ENV_RESERVED]`. The secrets step fails a project whose `.gitignore` does not cover the file;
`ai sync` adds the line.

## The test budget

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
ai ci budget set --ruling D-042 test_lines=41000
```

## Hosted CI

Projects that also want a hosted pipeline get templates in `~/.ai-os/templates/ci/`
(GitHub Actions and Azure Pipelines). Rein's own public repository runs `tests/run.sh` on every
push and pull request.
