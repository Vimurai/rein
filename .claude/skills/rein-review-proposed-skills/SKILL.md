---
name: rein-review-proposed-skills
description: Use this skill to review and promote PROPOSED self-learned skills. Lists the inert proposals staged by the meta_analyst (instinct extraction), shows each for human review, and promotes only the ones the operator APPROVES via approval-mcp. This is the human-in-the-loop activation stage of the self-learning loop (E-145).
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash
context: default
agent: default
---

# Rein — Review Proposed Skills (HITL promotion)

The **activation** half of the self-learning loop (E-145, ecc-integrations.md §Components 2).
The `meta_analyst` stages recurring successful patterns as **inert** proposals under
`.claude/skills/proposed/<slug>/SKILL.md` (capture stage — see `skill: rein-archive`). Nothing
runs until a human approves it here. Promotion is gated by `approval-mcp` and re-scanned for
dangerous content by the promoter; auto-activation NEVER happens.

## Dynamic Context Injection
Proposed skills awaiting review: !ls -1 .claude/skills/proposed 2>/dev/null || echo "(none staged)"

## Locate the promoter (locator chain — mirrors E-58/E-65/E-75)
```bash
# E-225: install-first via the shared locator, never the visited project's own copy.
REIN_LOCATE_UNTRUSTED_ENV=1
# `declare -f` inside locate.sh's own fallback asks whether a NAME is defined, and bash
# imports EXPORTED functions from the environment at startup — so without this unset an
# inherited `rein_locate` is the resolver whenever locate.sh is unreachable. The hooks
# carry this guard (E-223 F13); the first cut of E-225 ported the pattern and not the
# guard, and a decoy executed at session start. Sourcing is gated on the FILE so a missing
# resolver fails CLOSED — skills may, unlike the hooks, simply report "unavailable".
unset -f rein_locate rein_locate_enable_dev_tree rein_is_framework_clone 2>/dev/null
[ -f "${HOME}/.rein/shared/locate.sh" ] && . "${HOME}/.rein/shared/locate.sh"
PROMOTER="$(rein_locate shared/skill-promoter.mjs 2>/dev/null)"
[ -z "$PROMOTER" ] && { echo "skill-promoter.mjs not found — run: rein install"; exit 1; }
```

## Step 1 — Enumerate proposals
```bash
node --input-type=module -e "
import { listProposedSkills } from 'file://${PROMOTER}';
import { resolve } from 'node:path';
const list = listProposedSkills(resolve('.claude/skills/proposed'));
process.stdout.write(JSON.stringify(list, null, 2) + '\n');
"
```
If the list is empty, report "No proposed skills awaiting review." and stop.

## Step 2 — Review each proposal (HUMAN-IN-THE-LOOP)
For EACH proposed `<slug>`:
1. `Read` `.claude/skills/proposed/<slug>/SKILL.md` and show the operator its body + the
   `pattern_id` / `confidence_score` from its provenance block.
2. Request an explicit human decision via **approval-mcp** (it blocks on a terminal y/N; it is the
   only sanctioned gate — never self-approve):
   ```
   mcp__approval-mcp__request_approval({
     action: "Promote self-learned skill '<slug>' to active",
     reason: "<one-line: what pattern it automates + its confidence score>"
   })
   ```
   The tool returns `{ status: "APPROVED" | "REJECTED", id, ... }`.

## Step 3 — Promote ONLY on APPROVED
Pass the approval-mcp decision straight through to the promoter (it independently re-verifies
`status === "APPROVED"`, re-scans the body for dangerous content, and refuses to overwrite an
already-active skill):
```bash
DECISION='{"status":"APPROVED","id":"<approval-id-from-step-2>"}'   # use the REAL decision object
node --input-type=module -e "
import { promoteSkill } from 'file://${PROMOTER}';
import { resolve } from 'node:path';
const decision = JSON.parse(process.env.DECISION);
const r = promoteSkill('<slug>', {
  proposedDir: resolve('.claude/skills/proposed'),
  activeDir:   resolve('.claude/skills'),
  decision,
});
process.stdout.write(JSON.stringify(r) + '\n');
"
```
On `REJECTED`, do NOT promote. Optionally leave the proposal staged (re-reviewable later) or note
the rejection. The promoter removes the proposal from staging only when it successfully promotes.

## Step 4 — Report + log
Summarize: `<N> proposed, <A> approved+promoted, <R> rejected, <S> skipped (reason)`. Then
`skill: rein-log` an entry so the activation decision is auditable.

## Rules
- NEVER promote without an explicit `approval-mcp` APPROVED decision — no self-approval, no
  auto-promotion. This is the §35 / autonomy boundary the whole HITL gate exists to enforce.
- NEVER hand-edit a proposal to bypass the dangerous-content scan — the promoter re-scans at
  promote time (defence in depth) and will reject it.
- NEVER promote over an already-active skill of the same name (the promoter refuses; resolve the
  name collision first).
