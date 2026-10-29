---
name: digest_updater
description: Trigger this when DIGEST.md is stale (>3 days old), after a major sprint, or at session end. Regenerates .ai/DIGEST.md using JIT reads — only reads files that changed since the last DIGEST update. Also invoked automatically by the Stop hook.
type: skill
disable-model-invocation: false
user-invocable: false
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
context: default
---

ROLE: DIGEST_UPDATER
Target: .ai/DIGEST.md

## When to run manually
- DIGEST is flagged as stale.
- After a major sprint with many file changes.
- After running parallel critics (REVIEWS.md has new content).
- After archiving old LOG/COMM entries.

## Step 1 — JIT Change Detection (run first, abort if nothing changed)

```bash
# Get last DIGEST write time
DIGEST_DATE=$(date -r .ai/DIGEST.md '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo '1970-01-01 00:00:00')

# List .ai/ files changed since then
git log --since="$DIGEST_DATE" --name-only --pretty=format: -- '.ai/*.md' | sort -u
```

**If output is empty** → DIGEST is already current. Exit:
> "DIGEST up-to-date — no .ai/ files changed since last update. Skipping."

**If state.json was updated** (task status changes, new stamps) but no .ai/*.md changed, still run — check:
```bash
find .ai -name "state.json" -newer .ai/DIGEST.md 2>/dev/null
```

## Step 2 — Map Changed Files to DIGEST Sections

Only read files in the "Changed" column below. Skip all others.

| Changed File       | DIGEST Section to Update          |
|--------------------|-----------------------------------|
| .ai/TASKS.md       | Current Focus, Triad Health       |
| .ai/REVIEWS.md     | Known Risks                       |
| .ai/DECISIONS.md   | Key Decisions                     |
| .ai/BRIEF.md       | Product, Stack, Constraints       |
| .ai/LOG.md         | Recent Changes (last 10)          |
| .ai/SECURITY.md    | Known Risks                       |
| .ai/state.json     | Triad Health (last stamp times)   |
| .ai/architect.md   | **SKIP** — too large; trust cache |
| .ai/QUESTIONS.md   | **SKIP** — not surfaced in DIGEST |

## Step 3 — Targeted Reads (grep-first, full read only if needed)

Use Grep for large files to avoid full ingestion:

- **TASKS.md** — open tasks only (no full read):
  `Grep pattern="^- \[ \]" path=".ai/TASKS.md"` → top 6 results

- **REVIEWS.md** — risk lines only:
  `Grep pattern="P0|P1|\[ARCH_FAIL\]|\[SEC_FAIL\]|\[SEC_PASS\]" path=".ai/REVIEWS.md"`

- **DECISIONS.md** — decision list only:
  `Grep pattern="^- D-" path=".ai/DECISIONS.md"`

- **LOG.md** — last 10 entries only:
  `Read .ai/LOG.md offset=<last 30 lines>`

- **BRIEF.md**, **SECURITY.md** — read in full (these are short, <50 lines each)

- **state.json** — grep for last stamp timestamps:
  `Grep pattern="\"timestamp\"" path=".ai/state.json" head_limit=5`

## Step 4 — Preserve Unchanged Sections

Read the current `.ai/DIGEST.md` first. For every section whose source file did **not** appear in the Step 1 change list, copy the existing DIGEST content verbatim for that section. Only rewrite sections mapped to changed files.

## Step 5 — Produce Updated DIGEST.md

Keep it 20–60 lines. Bullets only. No prose.

Required sections (in order):
```
# DIGEST — AI-OS v2 (Updated: YYYY-MM-DD)

## Product
- <one line>

## Stack
- <one line>

## Triad Health
- Architect: <status> — last <action> <date>; <open P-## count> open
- Engineer: <status> — last completed <E-##> (<description>, <date>); <open E-## count> open
- Tester (headless, skill: ai-test): <status> — <last test result>

## Current Focus
- <E-##>: <description> [OPEN]
- <E-##>: <description> [OPEN]
- <E-##>: <description> [OPEN]

## Key Decisions
- D-###: <decision> (<status>)

## Known Risks
- <P0/P1 risk from REVIEWS.md>

## MCP Servers
- <server list, one line per server group>

## Recent Changes (last 10)
- YYYY-MM-DD: <what changed> (<file>)
```

## Step 6 — Session Stamp

After writing DIGEST.md, append to `.ai/SESSION.md`:
```
---
- Time: YYYY-MM-DD HH:MM UTC
- Actor: Claude (digest_updater)
- Files read: <list only files actually read in Step 3>
- Output: .ai/DIGEST.md regenerated
---
```
