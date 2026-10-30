---
name: review_synthesizer
description: Trigger after all Tier 3 audit agents complete (chaos_monkey, vibe_sentinel, security_engineer, critic_arch/security/tests). Aggregates all stamps from REVIEWS.md and LOG.md into a Release Readiness Report and writes [RELEASE_READY] or [RELEASE_BLOCKED] to LOG.md.
type: skill
disable-model-invocation: false
user-invocable: false
allowed-tools: Read, Write, Grep
context: default
---

ROLE: REVIEW_SYNTHESIZER
Target: .ai/REVIEWS.md (append), .ai/LOG.md (stamp)

## Preflight (token-saver)
1. Read .ai/REVIEWS.md — extract all audit stamps (distributed + legacy).
2. Read .ai/LOG.md (last 80 lines) — extract security/vibe/chaos stamps.
3. Read .ai/TASKS.md — identify which E-## task this release covers.

## Stamp Extraction

Scan both files for these stamps and their dates:

### Distributed Stamps (Tier 3 — written by individual critics)
| Stamp | Source | Written By |
|-------|--------|-----------|
| `[ARCH_PASS]` / `[ARCH_FAIL]` | REVIEWS.md | critic_arch sub-agent |
| `[SEC_PASS]` / `[SEC_FAIL]` | REVIEWS.md | critic_security sub-agent |
| `[TESTS_PASS]` / `[TESTS_FAIL]` | REVIEWS.md | critic_tests sub-agent |
| `[ALIGN_PASS]` / `[ALIGN_FAIL]` | REVIEWS.md | blueprint-aligner-mcp |

### Aggregated Stamps (written by agents / review_synthesizer)
| Stamp | Source | Required For |
|-------|--------|-------------|
| `[CRITIC_STAMP]` | REVIEWS.md | Tier 2 + Tier 3 — **written by review_synthesizer for Tier 3** |
| `[SEC_CLEARED]` | LOG.md | Tier 3 |
| `[VIBE_CLEARED]` | REVIEWS.md | Tier 3 |
| `[CHAOS_CLEARED]` | REVIEWS.md | Tier 3 |
| `[PII_CLEARED]` | LOG.md | Tier 3 (if PII involved) |
| `[UACS_VERIFIED]` | LOG.md | Tier 3 |

All stamps must be dated within the current sprint (≤ 7 days).

## Phase 1 — Write [CRITIC_STAMP] from Distributed Stamps

For Tier 3 reviews, the `[CRITIC_STAMP]` is NOT written by the caller — it is written here.

Check for all four distributed stamps:
- `[ARCH_PASS]` present (no `[ARCH_FAIL]` newer than it)
- `[SEC_PASS]` present (no `[SEC_FAIL]` newer than it)
- `[TESTS_PASS]` present (no `[TESTS_FAIL]` newer than it)
- `[ALIGN_PASS]` present (no `[ALIGN_FAIL]` newer than it)

Record it with `mcp__task-synchronizer-mcp__add_stamp({ type: "CRITIC_STAMP", agent: "review_synthesizer", summary })`
while HEAD is the commit the reviewed diff sits on — the stamp records that sha, and pre-commit
Gate 2 accepts only a CRITIC_STAMP for the commit's parent (E-329). A line typed into
REVIEWS.md carries no sha and unlocks nothing; REVIEWS.md is generated.

**If all four pass stamps present**, summary:
```
[TIER_3] All critics passed — [ARCH_PASS] [SEC_PASS] [TESTS_PASS] [ALIGN_PASS]
```

**If any FAIL stamp present**, do NOT write a CRITIC_STAMP; report:
```
[TIER_3] BLOCKED — <list of FAIL stamps and their summaries>
```

Also append to `.ai/LOG.md` if all clear:
```
[UACS_VERIFIED] YYYY-MM-DD | Tier 3 review complete — all distributed stamps passed
```

## Phase 2 — Severity Aggregation

Collect all P0/P1/P2 findings from REVIEWS.md entries:
- **P0**: Blocking — must be resolved before release
- **P1**: High — must have a tracked mitigation task (E-##)
- **P2**: Medium — document and accept or schedule

## Phase 3 — Release Readiness Decision

**RELEASE_READY** if ALL of:
- All distributed stamps present and passing (Tier 3) or `[ALIGN_PASS]` (Tier 2)
- `[CRITIC_STAMP]` written (Phase 1 complete)
- All required aggregated stamps present and within 7 days
- Zero P0 findings
- All P1 findings have a tracking E-## task in TASKS.md

**RELEASE_BLOCKED** if ANY of:
- Any FAIL stamp present in the current batch
- Missing required distributed stamp
- Missing required aggregated stamp
- Any P0 finding unresolved
- P1 finding with no tracking task

## Output

Append to `.ai/REVIEWS.md`:
```
---
[RELEASE_VERDICT] YYYY-MM-DD | <READY|BLOCKED>
Stamps: [ARCH_PASS ✓/✗] [SEC_PASS ✓/✗] [TESTS_PASS ✓/✗] [ALIGN_PASS ✓/✗] [SEC_CLEARED ✓/✗] [VIBE_CLEARED ✓/✗] [CHAOS_CLEARED ✓/✗]
P0: <count> | P1: <count> | P2: <count>
Summary: <one sentence — "All gates passed" or "Blocked by: <issue>">
---
```

Then append to `.ai/LOG.md`:
- If ready:  `[RELEASE_READY] YYYY-MM-DD | All Tier 3 gates passed — safe to commit`
- If blocked: `[RELEASE_BLOCKED] YYYY-MM-DD | Blocked: <specific reason>`

## Rules
- Never mark RELEASE_READY if any P0 is open.
- Never mark RELEASE_READY if any FAIL stamp exists in the current batch.
- Never write `[CRITIC_STAMP]` without first verifying all required distributed stamps.
- Never skip PII_CLEARED check if the diff touches user data, auth tokens, or logging.
- If stamps are older than 7 days, treat as MISSING — re-run the relevant audit.
- For Tier 2: `[CRITIC_STAMP]` is written by the caller (rein-review), not by review_synthesizer.
