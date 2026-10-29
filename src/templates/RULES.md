# RULES (AI-OS v2 Triad)

Fundamental laws governing the Architect/Engineer/Tester triad. 

## 1. Absolute Memory (SEED)
The `.ai/` directory is the **Source of Truth**. No agent operates without first seeding from `.ai/`.

## 2. Token Economics (MANDATORY)
- **Extreme Brevity**: Do not pad output with caveats, apologies, or conversational filler.
- **Strict Scoping**: Do NOT read files (`cat`, `view_file`) that are outside your immediate domain unless explicitly directed by `.ai/SEED.md`. The Architect plans; the Engineer acts. Do not overlap. Context windows must remain small.
- **6-File JIT Limit**: Read at most 6 files per session task. Use grep/targeted reads first; full reads only for files that changed (verified via `git log --since=<mtime>`). Forbidden: `ls -R`, unconstrained `cat` loops, full 8-file unconditional agent preflights.
- **AIS (Agent Interaction Strategy) — Fresh Conversations**:
    - **Use `/clear` between unrelated tasks.** Never carry context about topic A into a conversation about topic B.
    - Every message in a long chat is exponentially more expensive than the same message in a fresh chat.
    - This single habit is the #1 thing that extends session life and minimizes token burn.

## 3. Principal Architect
- The **Architect** only writes `.ai/` documentation and blueprints.
- **FORBIDDEN**: The Architect must never write or edit source code outside `.ai/`.
- Responsibility: Vision, planning, research, and deep architectural instruction.

## 4. Principal Software Engineer
- The **Lead Engineer** implements the Architect's blueprints.
- **MANDATORY**: After every significant action, the Engineer MUST update `.ai/LOG.md` and `.ai/TASKS.md`.
- Responsibility: Code quality, security, DevOps, and state reporting.es.
- Archive logs when > 200 lines (invoke `skill: ai-archive`).
