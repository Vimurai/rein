#!/usr/bin/env bash
# E-285 (D-075, native-first.md §8): the fixture Rein project every skill eval starts in.
# `claude plugin eval --scaffold` runs this in the case's empty workspace. It writes a small,
# self-consistent .ai/ (DIGEST, TASKS, architect.md, COMM, DECISIONS, state.json) and one git
# commit, so the skills' own reads and `!`-lines see a real project. architect.md carries a
# sentinel the rein-preflight case asserts is never read.
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
ARCHITECT_SENTINEL_7f3a — the preflight eval fails if this file is read.
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

# --e900-done: the rein-task case's starting point. E-900's work is COMMITTED with its test, and
# HEAD carries a PASS ci_runs row recorded by the repo's own ci-record.mjs — so the skill's
# CI step sees a green HEAD, and a refusal would be a real finding, not a fixture gap.
if [[ " $* " == *" --e900-done "* ]]; then
  cat > src/greet.js <<'JS'
export const greet = (n = "world") => `hello ${n}`;
const i = process.argv.indexOf("--name");
if (i > 0) console.log(greet(process.argv[i + 1]));
JS
  printf 'import assert from "node:assert/strict";\nimport { greet } from "./greet.js";\nassert.equal(greet("ada"), "hello ada");\n' > src/greet.test.mjs
  git -c user.name=eval -c user.email=eval@example.invalid add -A
  git -c user.name=eval -c user.email=eval@example.invalid commit -qm "E-900: --name flag + test"
  sha="$(git rev-parse HEAD)"; now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  log=".ai/ci-fixture.log"
  printf '%s\n' "[ci] sha=${sha} ref=HEAD dirty=0 started_at=${now}" \
    "[ci] step=suite status=PASS 1 passed, 0 failed, 0 skipped, leaked 0" \
    "[ci] step=unit status=PASS node:test" \
    "[ci] result status=PASS suite=PASS pass=1 fail=0 skip=0 leaked=0 unit=PASS secrets=PASS" \
    "[ci] finished status=PASS duration_ms=1000 finished_at=${now}" > "$log"
  node --no-warnings "${repo}/src/shared/ci-record.mjs" record --ai-dir .ai --log "$log" >/dev/null
  # The log stays inside the workspace: `rein ci log` reads it, and a missing log reads as pruned.
fi

# --queue-done: the rein-handoff case's starting point. Both Engineer tasks are DONE — the code
# for each is committed — and E-901's delta is unread, so "the queue is exhausted" is TRUE in
# every file and commit the skill reads.
if [[ " $* " == *" --queue-done "* ]]; then
  sed -i.orig 's/^- \[ \] E-90/- [x] E-90/' .ai/TASKS.md && rm -f .ai/TASKS.md.orig
  cat > .ai/state.json <<'JSON'
{"project":{"focus":"queue exhausted","last_id_E":"901","last_id_P":"10"},
 "tasks":[{"id":"E-900","status":"DONE","tier":1},{"id":"E-901","status":"DONE","tier":2}],
 "deltas":[{"task_id":"E-901","summary":"i18n catalogs (en, nb) in src/i18n/","read":false}],
 "stamps":[]}
JSON
  cat > src/greet.js <<'JS'
import { readFileSync } from "node:fs";
const lang = process.env.LANG?.startsWith("nb") ? "nb" : "en";
const msg = JSON.parse(readFileSync(new URL(`./i18n/${lang}.json`, import.meta.url), "utf8"));
export const greet = (n = "world") => `${msg.hello} ${n}`;
const i = process.argv.indexOf("--name");
if (i > 0) console.log(greet(process.argv[i + 1]));
JS
  mkdir -p src/i18n
  printf '{"hello":"hello"}\n' > src/i18n/en.json
  printf '{"hello":"hei"}\n' > src/i18n/nb.json
  git -c user.name=eval -c user.email=eval@example.invalid add -A
  git -c user.name=eval -c user.email=eval@example.invalid commit -qm "E-900 --name flag; E-901 en + nb catalogs"
fi
