#!/usr/bin/env bash
# E-285 (D-075, native-first.md §8): the fixture Rein project every skill eval starts in.
# `claude plugin eval --scaffold` runs this in the case's empty workspace. It writes a small,
# self-consistent .ai/ (DIGEST, TASKS, architect.md, COMM, DECISIONS, state.json) and one git
# commit, so the skills' own reads and `!`-lines see a real project.
set -euo pipefail

# This checkout: the script lives at <repo>/evals/fixtures/.
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="${here%/*/*}"

mkdir -p .ai

cat > .ai/DIGEST.md <<'MD'
# DIGEST — fixture-app (Updated: 2026-10-14)

## Product
- fixture-app: a tiny greeting CLI used to exercise Rein skills.

## Current Focus
- E-900 (Tier 1): add a --name flag to the greeter. E-901 (Tier 2): add i18n.
MD

cat > .ai/TASKS.md <<'MD'
# TASKS

## Engineer (Claude)
- [ ] E-900: Add a --name flag to src/greet.js per .ai/architect.md §2. | Tier: 1
- [ ] E-901: Add i18n message catalogs per .ai/architect.md §3. Acceptance: en + nb catalogs load. | Tier: 2

## Architect
- [x] P-10: Plan the greeter CLI. | Tier: 1
MD

cat > .ai/architect.md <<'MD'
# ARCHITECT — fixture-app
## 2. CLI flags
## 3. i18n
MD

cat > .ai/COMM.md <<'MD'
# COMM
---
## Handoff — 2026-10-13 09:00 UTC
**From**: Architect → Engineer
### Next action needed
- implement E-900, E-901
---
MD

cat > .ai/DECISIONS.md <<'MD'
# DECISIONS
## D-001: Plain Node CLI, no framework (2026-10-13)
MD

cat > .ai/state.json <<'JSON'
{"project":{"focus":"E-900","last_id_E":"901","last_id_P":"10"},
 "tasks":[{"id":"E-900","status":"OPEN","tier":1},{"id":"E-901","status":"OPEN","tier":2}],
 "deltas":[{"task_id":"E-899","summary":"Added greeting helper","read":false}],
 "stamps":[]}
JSON

mkdir -p src
printf 'export const greet = (n = "world") => `hello ${n}`;\n' > src/greet.js

git init -q
git -c user.name=eval -c user.email=eval@example.invalid add -A
git -c user.name=eval -c user.email=eval@example.invalid commit -qm "fixture: greeter"

# E-461: the --e900-done and --queue-done states were the rein-task and rein-handoff cases'
# starting points; both cases went with their skills.
