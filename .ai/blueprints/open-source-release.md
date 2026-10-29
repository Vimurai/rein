# Open-Source Release — Apache-2.0, Donations Only, Clean Public Repo (D-123, 2026-10-28)

## Goal & Architecture
AI-OS becomes open source under Apache-2.0, funded by donations and sponsorships only. There
is no commercial licence, no licence key, no heartbeat, no server, no tiers, no fingerprint
(D-123 supersedes D-114, D-115, D-117 to D-122). The product is published to a NEW public
repository `Vimurai/rein` (the product is Rein, D-125 addendum) as one squashed commit per release from a filtered, scanned export
of this private working repository (`Vimurai/ai-os-dev`, which keeps the Triad bookkeeping and
the full history and is never made public). The copyright holder in every public file is the
handle `Vimurai`; the operator's real name, mail addresses, home paths, session ids, socket
paths and client project names never leave — that is enforced by a fail-closed scan on every
publish, not by an audit. The README becomes the front door: a top-quality document that lets a
newcomer install, understand the Architect/Engineer triad and run their first task in minutes,
with depth in `docs/`.

Who uses it: anyone (users), contributors (DCO), sponsors (GitHub Sponsors and the existing
Polar account converted to sponsorship tiers), and the operator (`ai publish`).

## Core Concept
One command, `ai publish`, turns a release tag of the private repo into one clean commit on
the public repo: export → copy design docs into `docs/design/` → scan (five classes, fail
closed) → prove the export installs → squash-commit as `Vimurai <noreply>` → push tag. The
public repo has no history but releases; the private repo has all of it. Privacy is a property
of the pipeline, tested on every run.

## Components

### Component 1 — Licence and legal text (E-370)
- `LICENSE`: Apache License 2.0, verbatim from apache.org. `NOTICE` (Apache convention):
  `AI-OS` / `Copyright 2026 <the D-124 copyright holder>` (D-124 — the operator's real name is the
  copyright holder; D-123's "Vimurai" line is replaced) / the tree-sitter grammars' MIT
  notice (the E-365 L3 obligation moves here) and any other third-party notice the lockfile
  scan finds. Contact (D-124 r2): `the D-124 contact` in `SECURITY.md`, the root
  `package.json` `author` (`<the D-124 copyright holder> <the D-124 contact>`) and the README's
  maintainer line — nowhere else. Publish commits stay the noreply identity (D-124 r3).
- Delete `legal/COMMERCIAL-LICENSE.md`, `legal/TIERS.md`, `legal/CLA.md` and the `legal/`
  directory. Contributions use the Developer Certificate of Origin: `CONTRIBUTING.md` gains
  the DCO text and the `git commit -s` instruction; the CLA paragraph goes.
- `package.json` × 18: `"license": "Apache-2.0"`. The E-358 test inverts: assert the LICENSE
  starts with the Apache-2.0 title, every package.json says `Apache-2.0`, no file in the
  export says "All rights reserved", "PolyForm", "Noncommercial", "commercial licence" or
  "licence key". README licensing section rewritten (one paragraph + badge).
- Source file headers: none required by Apache-2.0; none added (the repo has 500+ files and a
  header churn commit buys nothing).

### Component 2 — Remove the licensing code (E-371, Tier 3)
Everything E-354 and E-355 added goes: `src/shared/license.mjs`, the issuer module,
`cli-license`, `src/shared/license-keys.json`, `tests/fixtures/license-cases.json` and its
runner, the `ai license *` dispatch, the `[LICENSE_*]` doctor lines, the ledger, the licence
schema in `src/contracts/`, the licensing paragraphs in `docs/` and the contracts. KEEP the
`secret-rule.mjs` guards for PKCS8/Ed25519 PEM headers (generic hygiene, D-080). Acceptance:
`git grep -i "license\.mjs\|LICENSE_\|lic_id\|heartbeat\|license-cases"` over `src/ hooks/
tests/ docs/` is empty (the words "license" in LICENSE/NOTICE/package.json are the only hits);
CI green; the E-301/E-303 budgets drop (the ratchet records the fall). Tier 3 because removal
of a security component must be shown complete, and `secret-rule.mjs` is touched.

### Component 3 — Privacy scan, five classes, fail closed (E-372; replaces E-369)
`src/shared/publish-scan.mjs` (E-364/E-365) is kept and extended:
- Classes: `personal_email`, `home_path`, `session_socket`, `client_name`, `operator_name`.
  `operator_name` reads `operator_names` from the gitignored `.ai/publish-scan.local.json`
  (the operator's real name in every form they use, and the two mail addresses). D-124: the
  real name and the contact address are ALLOWED only in `LICENSE`, `NOTICE`,
  `SECURITY.md`, the root `package.json` and `README.md`; a hit in any other file refuses.
  The former-employer address is refused everywhere (it is in the list without an
  allow-list entry; the local file carries `allow: {"<value>": [paths]}` per value). The
  handle `Vimurai` is not scanned (public by definition). Absent or empty list →
  `[SCAN_LIST_MISSING]`, refuse.
- Beyond file content: the export commit's author and committer must equal the configured
  public identity (`Vimurai <<id>+vimurai@users.noreply.github.com>`, from
  `.ai/publish.json`, see Data Model); `package-lock.json` `resolved` URLs must all be
  `https://registry.npmjs.org/`; `.claude/settings*.json` and `.mcp.json` templates must hold
  no absolute path; the export must contain no `.git/`, no `.env*`, no `*.local.json`.
- `ai doctor`: `[PUBLISH_SCAN_OK] classes=5 lists=client:N,operator:N` or the missing line.
- Contract rows extend the existing publish-scan cases (no new suite).

### Component 4 — `ai publish` (E-373; replaces E-360)
- `ai publish [--dry-run] [--tag vX.Y.Z]`, extending the release-manager flow:
  1. Export the tag's tree by the include list (below) into a temp dir.
  2. Copy `.ai/architect.md` → `docs/design/ARCHITECTURE.md` and `.ai/blueprints/*.md` →
     `docs/design/blueprints/` EXCEPT names listed in `.ai/publish.json` `exclude_blueprints`
     (seeded with `licensing.md`); rewrite `.ai/blueprints/` links to the new paths. The
     private repo stays the single source; nothing is duplicated by hand.
  3. Write `.ai/` in the export as the TEMPLATE only (what `ai init` creates), never the
     working bookkeeping.
  4. Run the Component 3 scan over the export; refuse on any hit.
  5. Prove it installs: `bash install-ai-os.sh && ai sync && ai doctor` from the export in a
     temporary HOME (D-118 r3 kept).
  6. In a clone of the public repo: replace the tree with the export, ONE commit
     `release: vX.Y.Z` as the public identity, tag, push (`--dry-run` stops before push and
     prints the file list, the scan summary and the commit metadata).
- First publication (D-126): the Engineer runs `ai publish --dry-run`, hands the output to the Architect, waits for the "publish" line, then
  `ai publish`, verifies the public clone and protects `main`. Every later release is the same command (E-375).
- Include list: `src/`, `hooks/`, `tests/`, `scripts/`, `docs/`, `.claude/`, `.github/`
  (a public CI workflow that runs `tests/run.sh` on push and PR — new, not the private one),
  `install-ai-os.sh`, `package.json`, `package-lock.json`, `.gitignore`, `LICENSE`,
  `NOTICE`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md` (public
  vulnerability-reporting policy, E-374), `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1).
  Excluded: everything under `.ai/` except the template; `.mcp.json`; `plans/`;
  `.ai/AUDIT-PUBLIC.md`; anything gitignored.

### Component 5 — README and docs (E-374)
- Rename scope (D-125): the product name changes in prose, README, repository and package only; `ai`, `~/.ai-os`, `AI_OS_*`, `.ai/` and the hook tags stay. The name is **Rein** (D-125 addendum): README title `Rein`, public repository `Vimurai/rein`, NOTICE first line `Rein`, tagline direction "Rein in your agents".
- README "Where this comes from" section (D-129 r6): Rein is the successor of a private repository with 678 commits of development; the history stays private because it carries the author's personal data; decisions in `.ai/DECISIONS.md`, blueprints in `.ai/blueprints/` — the same memory the Triad reads. No `docs/design/` copy.
- README (no size target, top quality): one-paragraph pitch; badges (licence, CI, sponsors);
  a 60-second quickstart (install, `ai init`, `ai pane architect`, first task); a diagram of
  the Architect/Engineer triad and the `.ai/` memory (ASCII or SVG in `docs/`); feature tour
  (roles, gates, critics, skills, MCP servers, CI ratchet, team mode); install and uninstall;
  the command reference as a table (`ai …`); how the gates, critics and CI budgets work;
  configuration; FAQ and troubleshooting; contributing (DCO); licence; sponsoring.
  Deep detail moves to `docs/` (one page per topic; the README links them). `docs/design/`
  holds the exported design docs (Component 4).
- `.github/FUNDING.yml` (`github: Vimurai`, `polar: Vimurai`, others as the operator adds in
  P-48). `SECURITY.md` (how to report, response time), `CODE_OF_CONDUCT.md`.
- Sponsorship tiers (gold/platinum names may stay) are described on the sponsor pages, not in
  the repo; the README links them.

### Component 6 — Private-repo bookkeeping (Architect, this ruling)
`.ai/blueprints/licensing.md` carries a SUPERSEDED banner (kept as history, excluded from
export). D-123 supersedes the licensing decisions. The cancelled tasks are marked in state
when the build gate allows (`[BUILD_STALE]` blocks status changes mid-flight).

### Component 7 — Maintenance loop (D-127, SUPERSEDED by D-128 after the first release)
- **Outbound, automatic**: `.github/workflows/publish.yml` in the PRIVATE repo runs `ai publish --tag <tag>` on every `v*` tag with the deploy key secret `REIN_DEPLOY_KEY` (write access to `Vimurai/rein` only). Scan, install proof and identity check run in the job; any hit fails it and nothing is pushed. The release-manager skill's tag is the only release action.
- **Inbound, imported**: `ai publish --import <pr-number>` fetches a public PR's commits and applies them with `git am` onto the private branch (author and Signed-off-by preserved; DCO check is the gate). After the next tag publishes, the workflow comments on the PR with the tag and closes it; CHANGELOG credits the author. The README's contributing section explains the two sentences.
- **Issues** on the public repo only; the Architect turns accepted ones into E-## tasks.
- **Deploy key**: generated by E-376, private half only in the Actions secret, public half as a write deploy key on `Vimurai/rein`; never in a tree.

### Component 8 — Migration: development moves into the public repository (D-128, E-377)
After the first release: clone `Vimurai/rein`; carry the Triad bookkeeping over scrubbed (stamps and any `.ai/` file rewritten to the noreply identity; `COMM.md`/`LOG.md` from D-123 onward only; `DECISIONS.md` whole; `ai state import`; open tasks keep their ids); repo-local git identity = the noreply identity, enforced by a pre-commit check; the five-class scan as a pre-commit hook over staged files AND a required CI job over the tree; branch protection on `main` (PRs + CI + DCO required, no force-push); remove `ai publish`'s squash-and-push (keep the export scan and the install proof as CI jobs); archive `ai-os-dev` after one full Triad ping-pong in the public clone passes. No deploy key, no workflow, no import tool: PRs merge normally.

### Component 9 — Bootstrap: public development from day one (D-129, E-378; supersedes Components 4, 7 and 8)
No `ai publish`, no mirror, no migration later. `Vimurai/rein` is created once from a scrubbed, squashed snapshot of the working branch and is the development repository from its first commit. Snapshot = every tracked file EXCEPT `.ai/AUDIT-PUBLIC.md`, `.ai/blueprints/licensing.md` and the pre-D-123 parts of `.ai/COMM.md`/`.ai/LOG.md`; stamps and every `.ai/` file rewritten to the noreply identity; `.ai/DECISIONS.md` whole; blueprints stay in `.ai/blueprints/` (the live Triad memory; D-123 r5's `docs/design/` copy is withdrawn). Verification before the push: five-class scan = 0 hits, install proof from the snapshot in a temporary HOME, noreply author and committer, no `.git`/`.env*`/`*.local.json`; the Engineer hands the listing to the Architect and waits for the "publish" line. First commit message: `Rein — successor of the private ai-os repository (678 commits, 2025-2026)`. Then: repo-local noreply identity with a pre-commit identity check, the scan as a pre-commit hook and a required CI job, DCO required, `main` protected; the Triad switches clones; `ai-os-dev` is archived after one passing ping-pong. README "Where this comes from" section: successor of a private repository with 678 commits; the history stays private because it carries the author's personal data; decisions and blueprints are in `.ai/`, the same memory the Triad reads.

**As built (E-378 a97e8b7, c8a0a12 — D-129 addendum):** `.ai/publish.json` is the pre-commit gate's on/off marker (present in work tree, index or HEAD; deleting it is refused); the `[PUBLISH_IDENTITY]` rule runs only where `.ai/publish-scan.local.json` exists; a sixth class `secret` (high-precision subset of D-080, `tests/fixtures/**` exempt, `privacy:allow-fake-token` line marker); the privacy job is its own workflow `.github/workflows/privacy.yml` (SHA-pinned, a separate required check), `ci.yml` re-rendered for `main` after the push; the 25 history-pinned suites are recorded skips in a one-commit checkout; the builder rewrites `.ai/` only (stamp authors to the noreply identity, name and address to `<the D-124 copyright holder>` / `<the D-124 contact address>`, quoted test addresses to `someone@example.com`, home paths and the login to `dev`), and the README says so in one sentence. The snapshot is rebuilt from the HEAD that carries D-125 to D-130 before the push; `.ai/start.json` is gitignored. Rehearsed: one commit + tag `v4.0.0`, author/committer/tagger noreply in UTC, `ai ci run` PASS 6921/0/25 with the install step.

**Published (E-378 step 7, 2026-10-29):** `https://github.com/Vimurai/rein`, first commit e04bb83 (noreply identity), privacy run 40851190644 green. GitHub push protection refused the first attempt over a synthetic Stripe-shaped fixture value; the operator chose the rewrite (108b5e7: fake vendor keys are assembled at runtime, never whole in a tracked file — a standing rule). The tag `v4.0.0` was deleted minutes later at the operator's request: the public line starts at `v0.4.0` (D-131) and the first tag follows the rename (D-132, `.ai/blueprints/rein-rename.md`). Sequence from here: step 8 (ci.yml for `main`; protection: privacy + `ai ci run` + DCO required, no force-push) → step 9 (clone switch; the operator installs from the public clone) → E-382 (version) → E-383 (rename, tag `v0.4.0`) → archive `ai-os-dev` after E-382 merges (the one passing ping-pong).

### Component 10 — Privacy by construction for automated writers (D-130, E-379)
One `redact(text, {lists})` in `src/shared/publish-scan.mjs` (five classes + `secret` via the D-080 detector; NFC + format-character normalisation; no env disable switch — D-130 addendum) wraps the 12 writers into the tracked tree (as built, E-379; incident-append and memory-manager keep their stricter rules with redact() layered after; stamp `author` and CI `runner` are identity metadata handled by the noreply identity, not redaction): task-synchronizer stamps/tasks/deltas, orchestrator review and handover output, blueprint-aligner reports, `ai digest`, `generate_map`, CI records and evidence, hosted-ci summaries, the instinct stager's proposed skills, the incident aggregator's block, team logs, the stop hook. Redact-and-log (`[PRIVACY_REDACTED] <class> <file>`), never refuse at write time; the pre-commit hook and the CI job refuse what slips through. On a clone without `.ai/publish-scan.local.json` the structural classes still apply and the doctor prints a warning, not a refusal. Telemetry, incidents, insights and the memory palace stay under `~/.ai-os`. Contract table `tests/fixtures/privacy-cases.json`, one row per wrapped writer. `ai doctor`: `[PRIVACY_OK] writers=N redacted_today=K`.

## Data Model
```
.ai/publish.json                (tracked; no personal data)
{ "public_repo": "git@github.com:Vimurai/rein.git",
  "author": { "name": "Vimurai", "email": "<id>+vimurai@users.noreply.github.com" },
  "exclude_blueprints": ["licensing.md"],
  "design_docs_dir": "docs/design" }

.ai/publish-scan.local.json     (gitignored; operator-written)
{ "client_names": [...], "operator_names": [...],
  "allow": { "<name or address>": ["LICENSE", "NOTICE", "SECURITY.md", "package.json", "README.md"] } }
                                 (D-124: only the real name and the contact address have entries)

.github/FUNDING.yml             github: Vimurai / polar: Vimurai / custom: [...]
```

## API / Interface Contracts
| Call | Input | Output | Errors |
|---|---|---|---|
| `ai publish --dry-run [--tag v]` | tag (default: latest) | file list, scan summary, commit metadata; no push | `[SCAN_LIST_MISSING]`, `[PUBLISH_SCAN_HIT] class file:line`, `[PUBLISH_INSTALL_FAILED]`, `[PUBLISH_IDENTITY]` (author not the public identity) |
| `ai publish [--tag v]` | tag | one commit + tag on the public repo | as above, plus `[PUBLISH_PUSH_FAILED]` |
| `ai doctor` | — | `[PUBLISH_SCAN_OK] …` line | `[SCAN_LIST_MISSING]` |

## Security
- The public repo never receives history: squash-commit per release, always, no exception.
- The scan fails closed on a missing list, on any hit, on a wrong commit identity, on a
  non-registry lockfile URL, on an absolute path in a template.
- No secrets exist for this pipeline beyond the operator's own git push credentials; nothing
  is signed by the project (tags may be signed by the operator's key — optional).
- `secret-rule.mjs` keeps every D-080 guard; the removal in E-371 must not weaken it.

## Execution Constraints
- `ai publish` under 3 minutes on a laptop (export + scan + install proof); the install proof
  is the slow part and is skipped only by an explicit `--skip-install-proof` that prints a
  warning (never the default).
- One release at a time; the public repo's default branch is `main`, protected after the
  first push (operator).

## Rollback Plan
- Before the first publish: nothing public exists; delete the branch work.
- After: a bad release is fixed by the next `ai publish` (the public repo's history is a list
  of releases; a `git revert` there is one commit). A privacy hit found after publication:
  rewrite the public repo (it has no history worth keeping — force-push the next clean
  export), then add the pattern to the scan so it cannot recur.

## E-## Task Breakdown
| Task | Tier | Scope | Depends on |
|---|---|---|---|
| E-370 | 2 | Component 1: Apache-2.0 LICENSE + NOTICE (copyright the D-124 copyright holder, D-124), delete `legal/`, DCO in CONTRIBUTING, 18 package.json fields + root `author`, inverted E-358 test, README licence paragraph | — |
| E-371 | 3 | Component 2: remove the licensing code completely; keep the PEM guards | E-370 |
| E-372 | 2 | Component 3: `operator_name` class with the D-124 per-value allow-list, identity/lockfile/template checks, doctor line | — |
| E-373 (CANCELLED, D-129) | 2 | `ai publish` — not built | — |
| E-374 | 2 | Component 5: README rewrite, `docs/` restructure, FUNDING.yml, SECURITY.md, CODE_OF_CONDUCT.md, public CI workflow | E-370 |
| E-375 (CANCELLED, D-129) | 3 | folded into E-378 | — |
| E-376 (CANCELLED, D-128) | 3 | Component 7 loop — not built | — |
| E-377 (CANCELLED, D-129) | 3 | folded into E-378 | — |
| E-378 | 3 | Component 9: bootstrap `Vimurai/rein` from the scrubbed snapshot after the Architect check; hooks, CI, protection; switch clones; archive `ai-os-dev` (D-129) | E-372, E-374 |
| E-379 | 3 | Component 10: `redact()` + `secret` class, replace the nine sanitisers, wrap every automated writer, privacy-cases.json, doctor line, structural-only mode on clones without the list (D-130) | E-372 |
| E-380 | 2 | Component 10 residuals (D-130 addendum): confusable homoglyphs in names; Windows, URL-encoded and full-width paths and addresses; URL-userinfo addresses; hosted-ci warns instead of redacting | E-379 |
| P-48 | 2 | Architect: record the operator's public-repo creation, the noreply identity, sponsor accounts and FUNDING entries, the first published tag | — |

Cancelled by D-123: E-356, E-357, E-359, E-360, E-361, E-367, E-368, E-369 (folded into
E-372), P-46. Done and kept: E-354, E-355 (their code is removed by E-371 — the work is not
wasted knowledge, the ruling changed), E-358 (its files are replaced by E-370), E-362, E-364,
E-365 (the privacy baseline), P-47. Order: E-370 → E-371; E-372 and E-374 any free lane;
E-373 last; then the operator runs the first `ai publish --dry-run`.
