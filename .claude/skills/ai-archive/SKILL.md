---
name: ai-archive
description: Use this skill ONLY when the user explicitly requests an archive operation. DESTRUCTIVE — moves LOG.md, COMM.md, REVIEWS.md, SESSION.md to .ai/archive/YYYY-MM/ with timestamps and re-initializes from templates. Never invoke autonomously.
disable-model-invocation: true
user-invocable: true
allowed-tools: Read, Bash
context: default
agent: default
---

# AI-OS Archive (User-Triggered Only)

⚠️ **DESTRUCTIVE OPERATION** — `disable-model-invocation: true`
This skill can only be triggered explicitly by the user. The agent cannot invoke it autonomously.

## Dynamic Context Injection
Current .ai/ file sizes: !wc -l .ai/LOG.md .ai/REVIEWS.md .ai/SESSION.md .ai/COMM.md 2>/dev/null || echo "(files not found)"
Open tasks (guardian check): !grep -c "^- \[ \]" .ai/TASKS.md 2>/dev/null || echo "0"

## Pre-Archive Guard (context-guardian-mcp)

Before archiving, run:
```
check_workspace()
```

**Block archive if**:
- Any open `[ ]` tasks remain in `TASKS.md` (DIRTY workspace)
- Any `[UACS_VERIFIED]` pending in current sprint

If workspace is DIRTY: resolve all open tasks first. Do NOT archive.

## Pre-Archive: Instinct Extraction (E-145 self-learning-arc, W5-T2)

The session history (LOG.md, REVIEWS.md) is the learning substrate — capture recurring
successful patterns as PROPOSED skills BEFORE archiving moves it away. This is the
**capture** stage of the self-learning loop (the activation stage is human-gated, below).

1. Invoke the meta_analyst's off-band Instinct-Extraction mode:
   ```
   the Agent tool (subagent_type: "meta_analyst")   ← runs extract_instincts over .ai/LOG.md + .ai/REVIEWS.md
   ```
2. meta_analyst clusters recurring successful tool/workflow patterns and stages each via
   `stageInstincts(...)` (`src/shared/instinct-stager.mjs`) into
   `.claude/skills/proposed/<slug>/SKILL.md` — **inert** by construction
   (`disable-model-invocation: true`, `user-invocable: false`, `status: proposed`;
   dangerous-content statically rejected; confidence ≥ 0.7).
3. Staged skills do NOTHING until a human approves them via
   `skill: ai-review-proposed-skills` (HITL, `approval-mcp`-gated). Auto-**staging** is safe;
   auto-**activation** never happens here.

Best-effort: if `meta_analyst` is unavailable or telemetry/logs are empty, SKIP silently —
instinct extraction must NEVER block or fail the archive.

## Archive Steps

This skill performs the archive operation directly (the previous `ai archive`
shell command was removed in E-34). Steps:

1. Scan `.ai/` for non-empty content files: `LOG.md`, `COMM.md`, `REVIEWS.md`, `SESSION.md`
2. **SESSION.md only — distill before moving** (the carry-over step of the retired
   compaction skill, folded in here — E-283 / D-075). Read it and write a compact Active Context of at most 30 lines:
   ```markdown
   ## Active Context (archived: YYYY-MM-DD)
   ### Completed this session
   - E-##: <one-line summary>
   ### Current focus
   <one sentence>
   ### Open decisions / blockers
   - <one per line>
   ```
   No raw tool output, no secrets or PII. (Conversation context itself is compacted by
   Claude Code's `/compact` and auto-compact — this step only keeps SESSION.md's
   carry-over.)
3. Move each file to `.ai/archive/YYYY-MM/<name>.YYYYMMDD_HHMM.md`
4. Re-create files from `~/.ai-os/templates/` (or with a header if no template exists);
   the new SESSION.md gets the Active Context from step 2 under its header, with the
   comment `<!-- Raw log archived to .ai/archive/YYYY-MM/SESSION.<ts>.md -->`.
5. `COMM.md` is tracked (D-104 r5): commit the re-created file in the same breath — git
   history keeps every rotated entry (`git log -p -- .ai/COMM.md`):
   ```
   git commit --only .ai/COMM.md -m "chore(.ai): rotate COMM.md (<YYYY-MM>)"
   ```

## After Archiving

1. Run `skill: ai-digest` to regenerate `DIGEST.md` from the clean state.
2. Verify `.ai/LOG.md` now contains only the new header.
3. Note the archive in the new `LOG.md`:
   ```
   YYYY-MM-DD | <actor> | Archive | Moved LOG/REVIEWS/SESSION to .ai/archive/YYYY-MM/
   ```

## Rules
- **Never archive** if open tasks or unverified Tier 3 changes exist.
- **Never delete** archive files — they are the permanent audit trail.
- **Never overwrite** existing archive files — timestamps ensure uniqueness.
