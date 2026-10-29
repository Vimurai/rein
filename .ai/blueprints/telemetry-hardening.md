# Telemetry Hardening Blueprint

## Goal & Architecture
Resolves the structural blindness in meta-cognition telemetry where only `mcp-router::proxy_call` was instrumented. Extends telemetry interception globally across all MCP calls (or at the transport layer) so that the error dimension and task-velocity are accurately captured without developers needing to manually instrument each server.

## Core Concept
A centralized, transport-level or orchestrator-level telemetry interceptor that wraps every MCP tool execution to record inputs, outputs, errors, latency, and token usage, writing to `telemetry.sqlite`.

## Components
1. **Global Telemetry Interceptor**: Wraps the MCP server's execution context or is injected at the `task-synchronizer` level to ensure 100% coverage of tool invocations.
2. **Error State Recorder**: Extracts failure reasons, stack traces (sanitized), and exit codes from MCP tool execution to populate the previously empty `ERROR` dimension in `telemetry.sqlite`.
3. **Task Velocity Aggregator**: Enhances the existing `task_velocity` writer to trigger reliably upon task completion or sprint boundaries, accurately measuring token spend and turn count.

## Data Model
Updates to `telemetry.sqlite` schema or write payloads:
- `tool_executions` table: Ensure `status` enum explicitly captures `SUCCESS`, `ERROR`, `TIMEOUT`.
- `task_velocity` table: `task_id`, `turn_count`, `total_tokens`, `duration_ms`.

## API / Interface Contracts
- `recordToolExecution(toolName, args, status, latencyMs)`
- `recordTaskVelocity(taskId, turns, tokens)`

## Security
No secrets or PII are logged. Tool arguments are sanitized before insertion into SQLite to prevent SQL injection or secret leakage. The DB remains local to the user (`~/.ai-os/telemetry.sqlite`).

## Execution Constraints
Telemetry writes must be non-blocking and low-latency (<5ms added per tool execution) to prevent slowing down the JIT context and agent operations.

## Rollback Plan
If the global interceptor causes instability or breaks existing MCPs, the user can set `AI_TELEMETRY_DISABLE=1` to bypass the interception entirely and fall back to the uninstrumented mode.

## E-## Task Breakdown
- **E-153**: Implement the Global Telemetry Interceptor and wire it into the MCP transport layer.
- **E-154**: Refactor error capturing to properly log the `ERROR` state into `telemetry.sqlite`.
- **E-155**: Fix the `task_velocity` aggregator so it reliably records metrics at task completion.

## Booted-Build Staleness (D-067 §3; ratified as shipped by D-071 §1–§2; E-249, 2026-09-13)
This is the hand-authored specification E-249's task text pointed at `mcp.md` for. `mcp.md` is
AUTO-GENERATED from `src/config/registry.json` on every `ai sync` and cannot hold it (D-071 §2:
a generated blueprint never receives a hand-authored section). It lives here because the
`instrument()` interceptor this blueprint owns is what records the stamp.

**Problem**: ESM caches modules for the life of a process. A server started before
`bash install-ai-os.sh` keeps serving the build it booted with; `update_task_status` regenerated
`TASKS.md` through a pre-E-245 projector and silently dropped the archive pointer — twice.

**Stamp** — `src/shared/build-stamp.mjs` (named in `architect.md §4`): a short CONTENT hash over
a server's entry file plus every file in its `mcp/shared/` sibling, keyed by basename, and the
newest mtime. Content rather than mtime because the installer's atomic copy (E-229) rewrites
byte-identical files; basenames so the same build under `~/.ai-os` and under a checkout does not
read as permanently stale.

**Recording** — the shared `instrument()` interceptor computes the stamp once at startup (one
change covers all servers), writes `~/.ai-os/run/build-<server>.json` (pid, hash, booted
timestamp) and attaches `_meta.booted_build` to every tool result. Only a bare `node <entry>`
boot writes a record: `safe-exec-mcp --check` runs on EVERY Bash call through the PreToolUse
hook and must not put a file write on that path. Records for dead pids are reaped on scan.

**Consumers** — `verify_markdown_sync`, `run_preflight`, `ai doctor`, `ai sync` (an E-247
fail-open step) and `install-ai-os.sh` each compare the live records with the mirror and emit
`[STALE_SERVER] <name> booted <ts>, mirror changed <ts> — restart required`.

**Completion gate (D-071 §1)** — enforced in `update_task_status(DONE)`, the only place a
refusal takes effect (a markdown skill cannot refuse). Evidence is STATE, not prose: the gate
refuses when (a) the install mirror differs from `src/` under `src/mcp/**` or `src/bin/**`
(install not run), or (b) any running server serves a build no longer on disk (not restarted).
Lockfiles are excluded — `ai mcp-setup` runs `npm install` inside the mirror, so they differ by
design and a gate that can never be satisfied is one the operator turns off. Repos that are not
the framework clone are exempt. If nothing under those roots changed the gate is silent, which
is the answer a perfect per-task diff would give without having to reconstruct one (a task id
does not determine a diff: the changes may be uncommitted, on a branch, or merged). The
restart half cannot be self-satisfied by an agent whose MCP servers were spawned at session
start; the gate tells the operator what to do.

**Refusal** — `state-db` and the projectors are NEVER hot-reloaded (E-237's set is the four
policy modules only); a suite assertion pins this because the tempting fix for everything
here is to hot-reload the lot.

**Rollback** `AI_OS_BUILD_STAMP=0` suppresses the meta, the scan and the gate.
**Tests** `tests/unit/build-stamp.test.mjs` (the scan's own logic); `tests/suites/booted_build_test.sh`
(the wiring, with a LIVE layer that holds one server open across a source rewrite — every other
MCP assertion spawns a fresh server per call, which is exactly the condition under which this
defect cannot occur).
