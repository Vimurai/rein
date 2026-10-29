# Token Saver Mode — Global

Goal: minimize tokens without losing correctness by leveraging the Tripartite Engine (Architect/Engineer/Tester).

## 1. Tripartite Workflow Integration
1) **Plan with the Architect:** The Architect pane does all research, requirement gathering, and architectural planning.
   - Result: A concise blueprint plus tasks in `TASKS.md` that the Engineer can follow.
   - Benefit: the Architect handles high-context ingestion; the Engineer only receives the plan.
2) **Build with the Engineer:** The Engineer implements based on the blueprint.
   - Rule: the Engineer must NOT re-research what the Architect already covered.
3) **Test with the Tester:** Run `skill: ai-test` — the project's real test command, or `--generate` to dispatch the headless `test_engineer` agent.
   - Rule: If tests fail, the Tester's output becomes the "Plan" for the next Engineer iteration.

## 2. Reading & Ingestion
1) Read order: see .ai/SEED.md (canonical). Batch all 4 preflight reads in one parallel tool call.
2) Never re-read a file you already read this session.
3) Prefer grep/find + targeted excerpt over full-file ingestion for files > 100 lines.
4) **Architect Ingestion:** Large files/repo-maps are digested by the Architect first; its blueprint summary is the context for the Engineer.

## 3. Maintenance
1) DIGEST as cache: after each run, the Stop hook auto-appends a short update.
2) Archive old LOG/COMM/REVIEWS entries when they exceed 200 lines (run `ai archive`).

## 4. Model selection (Auto-Switching)
- **Haiku:** Preflight, command execution, log updates, simple edits.
- **Sonnet:** Complex implementation, refactoring, tool-use loops.
- **Opus (Extended Thinking):** Critical architecture, multi-dependency debugging.
- CLI/shell command generation → delegate to /copilot (zero Claude tokens).

## 5. Skip-read signal
If DIGEST contains "stable since YYYY-MM-DD" and the current task does not touch those domains, skip REPO / INTERFACES / ENV / CAPABILITIES without reading.
