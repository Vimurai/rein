# Team mode

By default a project has one operator: one Architect pane, one Engineer pane, one task list.
Team mode lets several developers — each with their own pair of panes — work on one repository
without two people taking the same task or minting the same task id.

Team mode is on when `.ai/team.json` exists.

## Set it up

```bash
rein state migrate --team          # one tracked record file per task and stamp (no merge conflicts on state.json)
rein team add dev-a@example.com --range E:1000-1999
rein team add dev-b@example.com --range E:2000-2999
rein team show
```

Each developer mints task ids only from their own range, so ids never collide across branches.

`.ai/team.json` also holds:

| Key | Meaning |
| :--- | :--- |
| `trunk` | The branch claims are recorded on. Default: `origin/HEAD`, else whichever of `main`/`master` the remote has. `rein trunk` prints it. |
| `claim_ttl_days` | How long a claim holds before a teammate may take it over. |
| `shared_log` | When true, preflight shows every developer's recent log entries, not just yours. |

## Claims

Before writing source for a task, claim it:

```bash
rein task claim E-1042
```

The claim is a small bookkeeping commit pushed to the trunk, so everyone sees it on their next
fetch. On a branch named `engineer/e1042-…`, the tool-call gate refuses source writes until E-1042
is claimed by you.

| Message | Meaning |
| :--- | :--- |
| `[CLAIM_HELD] E-## by <email> since <date>` | Someone else has it. Pick another task, or ask them. |
| `[CLAIM_LOST]` | Another push won the race. |
| `[OFFLINE]` | Nothing was published; the gate stays closed. Claim again when online. |
| `[NO_TRUNK]` | The trunk cannot be resolved; set `"trunk"` in `.ai/team.json`. |

`rein task release E-1042 --reason "…"` gives a task back. Marking it done releases it
automatically. `rein task claims` lists who holds what.

## Keeping machines in step

Each machine keeps a local index (`.ai/state.sqlite`) of what git tracks. After a pull,
`rein state import` brings it up to date losslessly; `rein doctor` and preflight warn when the index
is behind. `rein state migrate --legacy` folds the record files back into one `state.json` if you
leave team mode.
