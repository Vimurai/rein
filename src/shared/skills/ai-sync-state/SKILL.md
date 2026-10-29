---
name: ai-sync-state
description: Use this skill when handing off work between the Architect and the Engineer, or when your context may be stale after the other agent modified .ai/ files. Forces explicit re-read of TASKS.md, architect.md, and DIGEST.md from the filesystem, bypassing conversational memory cache.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read
context: default
agent: default
---

# Rein Sync State — Cross-Agent Context Synchronization

## Why This Skill Exists

The Architect and the Engineer run in separate terminal panes (separate Claude sessions). When one agent modifies `.ai/` files,
the other agent's context window becomes stale — it may be holding an outdated picture of
TASKS.md, architect.md, or DIGEST.md from earlier in the conversation.

This skill forces a **hard filesystem re-read** of all three primary memory files,
discarding any cached or conversational copy. Invoke it at every agent handoff.

## When to Invoke

- You are the Engineer and the Architect just updated `.ai/TASKS.md` or `.ai/architect.md`
- You are the Architect and the Engineer just completed an E-## task
- Either agent suspects the other modified `.ai/` files since your last read
- Before making any planning or implementation decision that depends on current task state
- At the start of every session handoff (use `/sync-state` or `skill: "ai-sync-state"`)

---

## Step 1 — Hard Re-Read (Mandatory, No Skipping)

Read each file explicitly using `read_file`. Do NOT rely on any prior context window copy.

1. Read `.ai/TASKS.md` — full file
2. Read `.ai/architect.md` — full file (or first 60 lines if > 300 lines)
3. Read `.ai/DIGEST.md` — full file

---

## Step 2 — Extract Current State

From the freshly read files, extract:

**From TASKS.md:**
- All open `- [ ]` tasks (E-##, P-##, T-##) — these are YOUR current work queue
- Last completed task (most recent `[x]` with a Status line)

**From architect.md:**
- Current blueprint version / last updated section
- Any TBD/PLACEHOLDER markers that signal incomplete blueprints

**From DIGEST.md:**
- Triad health (Architect / Engineer / Tester last known state)
- Current focus items
- Known P0 risks

---

## Step 3 — Report Sync Status

Output a compact sync confirmation:

```
[SYNC-STATE] YYYY-MM-DD HH:MM
Source: filesystem (cache bypassed)

Open tasks: <count>
  - <E-## or P-## ID>: <title> (if ≤ 5, list them; if > 5, count only)

Last completed: <E-## or P-## ID> — <one-line status>

Blueprint version: <last section heading or date in architect.md>
Digest age: <date from DIGEST.md header>

Status: CLEAN (no open tasks) | ACTIVE (<N> open tasks)
```

If any file is missing or unreadable:
```
[SYNC-STATE] WARNING — <filename> not found. Run: rein init
```

---

## Rules

- **Never** skip the read_file calls — the entire purpose of this skill is to bypass cached state.
- **Never** report state from your conversational memory — only from the files just read.
- This skill does NOT modify any files. It is read-only.
- After syncing, resume your previous task with the corrected context.
