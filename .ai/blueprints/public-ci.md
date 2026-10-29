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
- Jobs:
  - `fast`: `ubuntu-latest`, Node 22, `bash tests/run.sh --tier fast` without the installer;
    `timeout-minutes: 10`; the first check to report.
  - `ai ci run (${os}, node ${v})`: matrix `os: [ubuntu-latest, macos-latest]`,
    `node: [22, 24]`, `fail-fast: false`; checkout with full history; the cache keyed on the
    lockfiles; install from the checked-out commit; `ai ci run --lanes $(nproc || sysctl -n hw.ncpu)`;
    `timeout-minutes: 60`; artefacts (log + `.ai/ci/*.json`) kept 14 days on failure and
    success.
- Triggers: `pull_request` into the trunk, `push` to the trunk ignoring `.ai/**`.
- Concurrency group per PR with cancel-in-progress; the trunk push group never cancels.
- The private/team rendering (no marker) is byte-identical to today's.

### Component 2 — Hand-written workflows (`.github/workflows/`)
| File | Trigger | Job |
|---|---|---|
| `codeql.yml` | PR, push to trunk, weekly | CodeQL `javascript-typescript`, `security-events: write` |
| `scorecard.yml` | weekly, push to trunk | OpenSSF Scorecard, results published to the security tab |
| `dependency-review.yml` | PR | `actions/dependency-review-action`, fail on high severity or a non-allowed licence |
| `nightly.yml` | 03:00 UTC on trunk, manual | full matrix (reuses Component 1's job via `workflow_call`), `npm audit --audit-level=high`, the D-118 r1 drift line as a job summary; on failure create-or-update ONE issue labelled `nightly` |
| `release.yml` | tag `v*` | the full matrix on the tag; then a GitHub release from the CHANGELOG section for that version with the sha256 of `install-rein.sh` (`install-ai-os.sh` until E-383) in the notes |
| `privacy.yml` (E-378) | PR, push | unchanged |
- `.github/dependabot.yml`: npm for the root and `src/mcp/*` (weekly, grouped minor+patch),
  `github-actions` (weekly). Dependabot PRs run the full CI like any PR.

### Component 3 — Branch policy and badges
- Required checks on `main`: `privacy`, `fast`, every `ai ci run (…)` leg, `CodeQL`.
  Linear history, no force-push, PRs required, conversation resolution not required.
- README badge row: CI (`ci.yml`), privacy, CodeQL, Scorecard, licence, version (latest tag
  via shields `github/v/tag`), sponsors. The hard-coded version badge is replaced.
- `.ai/DEVOPS.md` records the workflows, the required set and the rollback (`ci_gate` skill).

### Component 4 — Rename interplay (D-132)
E-384 lands before E-383. The renderer's cache path and install command name the old
directory and script until E-383 renames them; the rename PR is the first change checked on
macOS and both Node lines, which is the point of the ordering.

## Data Model
```
.ai/publish.json present            → renderer profile = "public"
.github/workflows/{ci,privacy,codeql,scorecard,dependency-review,nightly,release}.yml
.github/dependabot.yml
Required checks: ["privacy", "fast", "ai ci run (ubuntu-latest, node 22)", "ai ci run (ubuntu-latest, node 24)",
                  "ai ci run (macos-latest, node 22)", "ai ci run (macos-latest, node 24)", "CodeQL"]
Nightly issue: label "nightly", title "Nightly failed on <date>", body = run link + summary; updated, never duplicated
```

## API / Interface Contracts
- `ai ci hosted github` — renders the public profile when the marker exists; `--check` exit 1
  on mismatch as today; `ai doctor` line `[HOSTED_CI_OK] github (public)` / `[WRAPPER_DIFFERS]`.
- `tests/run.sh --tier fast` — exit code is the fast job's verdict; budget 60 s remains.
- `ai ci run --lanes N` — unchanged; the matrix passes the runner's core count.
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
- The fast job reports in under 3 minutes on a cold cache; a full leg under 20 minutes
  (the local run is 12–13 minutes serial; lanes bring it down).
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
| E-384 | 2 | Components 1–3: the public renderer profile, the six hand-written files, Dependabot, badges, required checks, DEVOPS.md | E-382 |
