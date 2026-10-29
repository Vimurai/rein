# Blueprint — Public CI on GitHub Actions (D-133)

## Goal & Architecture
`Vimurai/rein` is public, so GitHub Actions costs nothing on the standard hosted runners. The
single Ubuntu job of the private era becomes a layered CI: a fast signal for every push, a
cross-platform matrix as the merge gate, a nightly on `main` that catches drift, security
scanners that the ecosystem expects of an open-source project, and a release workflow that
turns a tag into a GitHub release. Users: contributors (fast feedback on a PR), the Triad
(the merge gate replaces the operator's eyes), the operator (badges, nightly issue). In one
sentence: everything free that makes `main` trustworthy, nothing paid.

## Core Concept
Two kinds of workflow files. **Rendered**: `ci.yml`, produced by `ai ci hosted github`
(D-103) from a `public` profile, so the hand-edit guard `--check` and the team-project
rendering keep working. **Hand-written**: the scanners, the nightly, the release and the
Dependabot config, which are plain files with no renderer. Both kinds pin actions to commit
SHAs and declare minimal `permissions` per job.

## Components

### Component 1 — The `public` rendering profile (`src/shared/hosted-ci.mjs`)
- Selected when `.ai/publish.json` exists in the root (the privacy gate's marker).
- Jobs (amended by D-135, `.ai/blueprints/ci-throughput.md` §Component 4 is the contract):
  - `fast`: `ubuntu-latest`, Node 22, no installer; `bash tests/run.sh --tier fast` on pull
    requests and trunk pushes alike (D-135 addendum r1: suites beyond the fast tier need the
    installed mirror); `timeout-minutes: 10`; the first check to report. Rendered in every
    profile, not only the public one (D-135 r4).
  - `ai ci run (${os}, node ${v}, ${i}/${N})`: on a pull request `ubuntu-latest × {22, 24}`
    and `macos-latest × 22`, each in N shards (`team.json` `ci.shards`, default 4), `fail-fast:
    false`; checkout with full history; the cache keyed on the lockfiles; install from the
    checked-out commit; `ai ci run --shard ${i}/${N}` (no `--lanes`: a hosted run defaults
    to every core, D-135 r1); `timeout-minutes: 60`; artefacts (log + `.ai/ci/*.json`) kept
    14 days on failure and success. `macos-latest × 24` and one unsharded `ubuntu-latest × 22`
    leg run in the nightly only (D-135 r5).
- Triggers: `pull_request` into the trunk, `push` to the trunk ignoring `.ai/**`.
- Concurrency group per PR with cancel-in-progress; the trunk push group never cancels.
- The private/team rendering (no marker) gains the same `fast` job and shards on one OS and
  Node line; everything else in it is unchanged.

### Component 2 — Hand-written workflows (`.github/workflows/`)
| File | Trigger | Job |
|---|---|---|
| `codeql.yml` | PR, push to trunk, weekly | CodeQL `javascript-typescript`, `security-events: write` |
| `scorecard.yml` | weekly, push to trunk | OpenSSF Scorecard, results published to the security tab |
| `dependency-review.yml` | PR | `actions/dependency-review-action`, fail on high severity or a non-allowed licence |
| `nightly.yml` | 03:00 UTC on trunk, manual | full matrix (reuses Component 1's job via `workflow_call`), `npm audit --audit-level=high`, the D-118 r1 drift line as a job summary; on failure create-or-update ONE issue labelled `nightly` |
| `release.yml` | tag `v*` | the full matrix on the tag; then a GitHub release from the CHANGELOG section for that version with the sha256 of `install-rein.sh` (`install-rein.sh` until E-383) in the notes |
| `privacy.yml` (E-378) | PR, push | unchanged |
- `.github/dependabot.yml`: npm for the root and `src/mcp/*` (weekly, grouped minor+patch),
  `github-actions` (weekly). Dependabot PRs run the full CI like any PR.

### Component 3 — Branch policy and badges
- Required checks on `main`: `privacy`, `fast`, every pull-request `ai ci run (…, i/N)` leg
  (twelve with four shards; the nightly-only legs are not required), `CodeQL` (D-135 r7).
  Until E-388 closes, the four macOS × 22 legs run but are not required (D-135 addendum 2
  r3); `dependency-review` joins once the repository's Dependency graph is enabled (r5).
  Linear history, no force-push, PRs required, conversation resolution not required.
- README badge row: CI (`ci.yml`), privacy, CodeQL, Scorecard, licence, version (latest tag
  via shields `github/v/tag`), sponsors. The hard-coded version badge is replaced.
- `.ai/DEVOPS.md` records the workflows, the required set and the rollback (`ci_gate` skill).

### Component 4 — Rename interplay (D-132, D-132 addendum 2 r9)
E-384 lands before E-383. The renderer's cache path and install command name the old
directory and script until E-383 renames them; the rename PR is the first change checked on
macOS and both Node lines, which is the point of the ordering. E-391 renames the job
(`ai-ci-run` → `rein-ci-run`, display `rein ci run (…)`) and so the required-check names:
the merge step updates the list on `main` with one `gh api` call (new names in, old names
out) immediately before the merge, recorded in `.ai/DEVOPS.md`; `requiredChecks()` is the
source of the strings.

### Component 5 — Windows (WSL2) leg (E-392, D-132 addendum 2 r10)
- Matrix: `windows-latest × node 22 × 4 shards`, in the public profile only, after the tag.
  Informative (not in the required set; `continue-on-error` is NOT used — the leg is simply
  not required, so a red stays visible) until three consecutive green runs on `main`, then
  required by the same `gh api` step and a `.ai/DEVOPS.md` entry; the README's "planned"
  parenthesis goes at that moment.
- Steps: checkout (as the other legs); setup-wsl action pinned to a full commit SHA with the
  version in a trailing comment (D-133), distribution Ubuntu 24.04, WSL 2 where the hosted
  `windows-2022` image can start it (the action documents WSL 2 there); if the first run shows
  the runner cannot, the leg runs WSL 1 and its display name and the README say "WSL" — WSL 1
  and 2 share the userland Rein runs in, so the claim is weaker and true. Inside the
  distribution, before anything else: copy the checkout to the Linux filesystem (`~/src`) —
  the `/mnt/c` mount drops exec bits and symlinks and is slow; then install node 22 (NodeSource
  or nvm, pinned major), git, sqlite3, python3, tmux; `bash install-rein.sh`; `rein doctor`;
  `rein ci run --shard i/4` with lanes defaulting by host as on Ubuntu.
- Records: `rein ci status` ingests the leg like any other (`host=` carries `windows-wsl2` or
  `windows-wsl1`); `tests/census-baseline.tsv` is not re-seeded from it.
- Timeout 60 minutes as the other legs; Windows minutes are free for a public repository.

## Data Model
```
.ai/publish.json present            → renderer profile = "public"
.github/workflows/{ci,privacy,codeql,scorecard,dependency-review,nightly,release}.yml
.github/dependabot.yml
Required checks: ["privacy", "fast", "CodeQL",
                  "ai ci run (ubuntu-latest, node 22, i/4)", "ai ci run (ubuntu-latest, node 24, i/4)",
                  "ai ci run (macos-latest, node 22, i/4)"]           for i in 1..4   (D-135 r5, r7)
Nightly-only legs: "ai ci run (macos-latest, node 24, i/4)", "ai ci run (ubuntu-latest, node 22)" (unsharded)
Nightly issue: label "nightly", title "Nightly failed on <date>", body = run link + summary; updated, never duplicated
```

## API / Interface Contracts
- `ai ci hosted github` — renders the public profile when the marker exists; `--check` exit 1
  on mismatch as today; `ai doctor` line `[HOSTED_CI_OK] github (public)` / `[WRAPPER_DIFFERS]`.
- `tests/run.sh --tier fast` — exit code is the fast job's verdict; budget 60 s remains.
- `ai ci run --shard i/N` — the matrix leg's command; lanes default to every core on a hosted
  runner (D-135 r1, `.ai/blueprints/ci-throughput.md`); `--lanes` is not passed.
- `release.yml` inputs: the tag; outputs: the release URL in the job summary.

## Security
- Every action pinned to a full commit SHA with the version in a trailing comment; Dependabot
  keeps them current. `permissions: contents: read` at the top of each file; a job raises only
  what it needs (`security-events: write` for CodeQL and Scorecard, `contents: write` for the
  release job, `issues: write` for the nightly).
- `persist-credentials: false` on every checkout; no secrets are needed by any workflow
  (`GITHUB_TOKEN` only). Fork PRs get the read-only token by default; no `pull_request_target`.
- The privacy job stays separate (D-129 addendum r4) so a CI edit can never drop it.
- `ci_gate` skill before the change; `.ai/DEVOPS.md` updated.

## Execution Constraints
- Standard runners only; `timeout-minutes` on every job; artefacts 14 days; caches keyed on
  `package-lock.json` and `src/mcp/*/package.json`.
- The fast job reports in under 2 minutes on a pull request; a sharded leg under 5 minutes
  with four shards and four lanes (D-135: the hosted run was 15.5 minutes on two lanes plus
  a serial tail of 13 suites). Measured, not promised: `ai ci status` reports the values.
- PR concurrency cancels superseded runs; nightly and release never cancel.
- The one-commit-checkout skips (D-129 addendum r5) apply to the first weeks' runs and shrink
  as history grows; the nightly summary lists the skip count.

## Rollback Plan
Delete the hand-written workflows and `dependabot.yml`; set the renderer back to the single
job (the profile switch is one condition); shrink the required-check set to `privacy` and
`ai ci run`. No state outside `.github/` and the branch policy is touched.

## E-## Task Breakdown
| Task | Tier | Scope | Depends on |
|---|---|---|---|
| E-384 | 2 | Components 1–3: the public renderer profile (fast job with `--changed`, shard matrix, required names per D-135), the six hand-written files, Dependabot, badges, required checks, DEVOPS.md | E-382, E-386 |
| E-386 | 2 | `.ai/blueprints/ci-throughput.md` §Components 1–3, 5: lane default by host, census baseline, `--shard`, `exclusive_seconds` | E-382 |
| E-387 | 2 | `.ai/blueprints/ci-throughput.md` §Component 5: Rein's exclusive tail under 25 % | E-386 |
| E-392 | 2 | Component 5: the Windows (WSL2) leg, informative then required; README wording; DEVOPS.md | E-391 (after `v0.4.0`) |
