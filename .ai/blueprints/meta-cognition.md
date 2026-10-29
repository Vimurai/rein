# Meta-Cognition Pipeline (Second Brain)

## Goal & Architecture
To create a self-learning loop for Rein that analyzes global tool usage, task efficiency, and failure rates across all projects, proactively recommending CLI automations, tool deprecations, and workflow improvements.

## Core Concept
The "Second Brain" operates on a telemetry-to-insight pipeline: local project routers asynchronously stream usage data to a global SQLite database. A specialized `meta_analyst` agent periodically analyzes this data against the `memory-palace.md` to generate an actionable `INSIGHTS.md` report, which is prompted to the user via preflight staleness checks.

## Components
1. **Global Telemetry Store (`~/.rein/telemetry.sqlite`)**: A centralized SQLite database that records tool invocations, token consumption, task completion times, and agent handoff counts from all local Rein projects.
2. **The `meta_analyst` Agent**: A specialized Gemini agent (`.gemini/agents/meta_analyst.md`) whose sole mandate is reading telemetry and historical data to generate optimization suggestions. It does not write source code.
3. **Insight Generator (`ai insights`)**: A new CLI command that triggers the `meta_analyst` to read the telemetry database and output its findings to `~/.rein/INSIGHTS.md`.
4. **Preflight Stale Check (`ai-preflight` integration)**: A mechanism within the session bootloader that checks the age of `INSIGHTS.md` and the volume of unanalyzed telemetry, emitting a CLI warning to the user if a new analysis is recommended.

## Data Model
**Table: `tool_executions`**
- `id` (UUID)
- `project_hash` (String, anonymized)
- `session_id` (String)
- `tool_name` (String)
- `execution_time_ms` (Integer)
- `status` (String: SUCCESS/ERROR/TIMEOUT/REJECTED)
- `timestamp` (DateTime)

**Table: `task_velocity`**
- `task_id` (String)
- `turn_count` (Integer)
- `tokens_consumed` (Integer)
- `timestamp` (DateTime)

## API / Interface Contracts
- **Write:** MCP routers push to `telemetry.sqlite` in a fire-and-forget background thread to avoid blocking the main chat loop.
- **Read:** `ai insights` triggers a scoped agent run that executes SQL queries against `telemetry.sqlite` via `code-execution-mcp` (or a dedicated MCP tool) to extract aggregation metrics.

## Security
- **Privacy:** `telemetry.sqlite` must be rigorously stripped of project-specific source code, secrets, and file paths. It tracks *metadata* (tool names, turn counts, durations) only.
- **Isolation:** The `meta_analyst` agent runs with a restricted toolset; it has read-only access to the telemetry DB and write-only access to `INSIGHTS.md`.

## Execution Constraints
- **Performance:** Writing to telemetry must be asynchronous (`is_background: true`).
- **Token Limits:** The `meta_analyst` agent must rely on SQL aggregates (averages, counts) rather than reading raw logs to stay within token budgets.

## Rollback Plan
- Revert the `ai-preflight` notification check.
- Drop the `telemetry.sqlite` file and remove the async hook from the MCP router.

## E-## Task Breakdown
- **E-##:** Implement `telemetry.sqlite` schema and background writing hook in the MCP router.
- **E-##:** Create the `meta_analyst` agent definition and the `ai-insights` skill.
- **E-##:** Update `ai-preflight` skill to check `INSIGHTS.md` staleness and emit warnings.

## Telemetry Provenance and Isolation (D-070 Amendment, 2026-09-11)
- **Isolation**: the test suite must never write to the operator's telemetry store — see
  `test-harness-isolation.md §The Sixth Variety`. `AI_TELEMETRY_DB_PATH` is the per-run seam.
- **One tool, one name**: (**corrected 2026-09-29, E-261**: the dotted rows were written by
  the since-retired `mcp-router` proxy, NOT by the hook — the Architect misattributed them;
  the 149 ms is proxy round-trip time. The ruling below stands, the attribution does not.)
  The dotted path records `safe-exec-mcp.analyze_command` (151 rows,
  avg 149 ms) while the interceptor records `mcp__safe-exec-mcp__analyze_command` (7,502 rows,
  avg 2 ms). Aggregates split one tool in two and the timings are not comparable. Normalise
  `tool_name` to the `mcp__<server>__<tool>` form at WRITE time in both emitters, and record
  the emitting path in a new `source` column (`hook` | `interceptor`) so latency is compared
  like with like. Timestamps are ISO-8601 `T` form everywhere (the `datetime()` space form
  drifted the 30-day window boundary by up to a day). No back-migration of old rows: the
  store is reset under E-257.
- **Staleness probe**: `insights-staleness.mjs` reported 132,436 total rows against 128,677 in
  `tool_executions`; it sums both tables. Count `tool_executions` only.
- **task_velocity is unwired**: 1,729 rows, every `turn_count` and `tokens_consumed` zero,
  since the first report. **The original E-259 remedy is WITHDRAWN (D-077)** — it named a
  source that is empty (`usage.sqlite`: nothing calls `report_cost`, last write 2026-04-03)
  and a tool that is unrelated (`report_performance` is the SEO cluster-page tool). See
  §Task Velocity from the Transcript below.
- **Reading a report**: every table separates REAL traffic (hashes seen on non-test days or
  with ≥ 2 sessions) from fixture traffic until E-257 lands; after it, the split is a
  regression alarm — any single-use hash is a leak.

## Task Velocity from the Transcript (D-077, 2026-09-29 — E-259)

### Goal & Core Concept
Measure what a task cost without asking the model to report it. The Claude Code transcript
already records `message.usage` on every assistant message; the harness hands its path to
every hook. **The transcript is the meter, the hook is the reader, `task_velocity` is the
ledger.** Nothing self-reports, so nothing can forget to.

### Components
1. **Reader — `src/shared/task-usage.mjs`** (new): `measureTaskWindow(transcriptPath, taskId)`
   stream-reads the JSONL and returns the counters for the task's window, or `null`.
2. **Trigger — `hooks/post-tool-use.sh`** (existing, matcher `.*`): one new branch. When
   `tool_name` is `mcp__task-synchronizer-mcp__update_task_status`, `tool_input.status` is
   `DONE` and the tool response is not a rejection (`[CI_GATE]`, `[TASK_LOCKED]`, build
   gate, `isError`), it calls the reader with the payload's `transcript_path` and writes
   the row. No new hook registration.
3. **Writer — `telemetry.mjs::recordTaskVelocity`**: the ONLY writer. The E-155 call in
   `task-synchronizer-mcp` (`recordTaskVelocityForTask`, which reads `usage.sqlite`) is
   deleted together with the function. A payload whose counters are all zero is NOT written.
4. **Consumer — `meta_analyst` Aggregate "Task Velocity"**: reads `source = 'transcript'`
   rows only and reports the measured-task count beside the totals.

### Window and counting rules
- **Window**: from the line after the previous successful `update_task_status(DONE)`
  tool_use in the SAME transcript (or the transcript's first line) up to the current one.
  The cursor is derived from the transcript itself — no cursor file, no state.
- **The closing line arrives AFTER the hook (D-078, found on the first live DONE)**: Claude
  Code appends the assistant message holding a `tool_use` only after the tool and its
  PostToolUse hooks have run. The window therefore ends at the task's DONE line **once it
  is written**: the detached reader re-reads with a bounded backoff (0 / 0.5 / 1 / 1.5 / 2 /
  2.5 s, hard exit at 15 s) and measures on the first read that finds it. This ordering is
  OBSERVED, not a documented contract — the first read is at 0 s so the reader is correct
  under either ordering. The window ends AT that line, never at end-of-file: a late read
  must not absorb the next task's first messages. Line never appears → no row.
- **Dedupe by `message.id`**: one assistant message spans several JSONL lines (observed: up
  to 7) and each repeats the same `usage`. Count each id once.
- `turn_count` = distinct assistant `message.id` in the window.
- `tokens_consumed` = Σ (`input_tokens` + `cache_creation_input_tokens` + `output_tokens`).
  `cache_read_input_tokens` is summed separately: it re-counts the whole context on every
  call and would swamp the figure (one observed message: 25,743 read vs 301 output).
- Sidechain lines (`isSidechain: true`) inside the same file are included. Subagent
  transcripts stored in separate files are NOT read; this is a known undercount.
- A task worked across `/clear` or several sessions is measured for the closing session
  only. `partial` is not inferred; the row records the `session_id` so a reader can tell.
- Missing/unreadable transcript, or no usage in the window → **no row**. Absence means
  "unmeasured"; a zero row means nothing and is never written again.

### Data Model
`task_velocity` gains, via `skill: ai-migration` (same retrying, race-safe ALTER pattern as
E-261's `source` column; down-migration drops them):
`output_tokens INTEGER`, `cache_read_tokens INTEGER`, `source TEXT` (`transcript`),
`session_id TEXT`. Existing columns keep their meaning as defined above. The 1,729 zero
rows are not migrated; E-257's reset already moved them to the backup.

### API / Interface Contracts
- `measureTaskWindow(path, taskId)` → `{turn_count, tokens_consumed, output_tokens,
  cache_read_tokens, session_id}` | `null`. Never throws.
- CLI form for the hook (D-078, as built): `node task-usage.mjs --record` with ONE JSON
  object on stdin — `{transcript_path, task_id, tool_response}`, 1 MiB cap. Never argv:
  argv is visible in `ps`. The reader validates the task id, the success of the response
  and the path itself, then writes the row; prints nothing; exit 0 always.
- `report_performance` is untouched. `token-budget-mcp` is untouched by this task.

### Security
- The transcript holds the whole conversation. The reader extracts ONLY `type`,
  `isSidechain`, `sessionId`, `message.id`, `message.usage.*` and tool_use `name`/`input.id`
  /`input.status` for the task-synchronizer tool, plus ONE field beyond that list (D-078):
  the `tool_result` of a previous `update_task_status(DONE)`, read only to decide whether
  that DONE succeeded and reduced at once to a boolean — its text is never kept. No message
  text is copied, logged or
  written to telemetry — asserted by a test that plants a marker string in a fixture
  transcript and greps the store and stderr for it.
- `transcript_path` is taken from the hook payload only, never from env or argv of a
  caller, and must resolve (`realpath`) under the Claude config dir's `projects/` tree;
  anything else is skipped.
- Honour `AI_TELEMETRY_DISABLE=1` and the `AI_TELEMETRY_DB_PATH` seam (E-257).

### Execution Constraints
- Fail-open: any error → no row, hook exit 0. A telemetry failure never blocks a DONE.
- Runs only on the DONE branch; every other tool call pays one string comparison.
- Streamed line by line (transcripts reach tens of MB); budget 500 ms on a 50 MB fixture
  via `assert_perf` (host-relative, E-239); lines that are not JSON are skipped.

### Rollback
`REIN_TASK_USAGE=0` disables the branch. Reverting the PR restores the E-155 path; the
added columns are nullable and harmless if left.

### E-## Task Breakdown
- **E-259** (Tier 2, re-scoped by D-077): components 1–4 and the migration. Acceptance:
  fixture transcripts cover dedupe (one id on 5 lines counted once), the window cursor
  (two DONEs → two disjoint rows), a rejected DONE writing nothing, a missing transcript
  writing nothing, a path outside `projects/` skipped, the privacy marker test; the
  migration up/down; `meta_analyst` shows non-zero rows on a fixture DB; grep for
  `recordTaskVelocityForTask` and `usage.sqlite` in `src/shared/telemetry.mjs` and
  `task-synchronizer-mcp` returns nothing; full `ai ci run` green; `bash install-rein.sh`
  + server restart.