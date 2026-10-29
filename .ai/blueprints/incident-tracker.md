# Domain Blueprint: Incident Tracker

## Goal & Architecture
Provides a continuous background mechanism for tracking, aggregating, and responding to recurrent errors in the AI-OS environment by autonomously drafting architectural P-## tasks for Gemini based on high-frequency error logs.

## Core Concept
A Just-In-Time (JIT) aggregation system. An `ai-incident` skill logs structured error events (NDJSON) to `~/.ai-os/incidents.ndjson`. When the developer runs `ai preflight` or `ai sync`, a hook aggregates these incidents, identifies patterns, and proactively prompts the Architect (Agy) to create resolving P-## tasks if error thresholds are exceeded.

## Components
1. **ai-incident skill**: A specialized tool triggered by Claude or Gemini upon encountering unresolvable environment errors, test suite crashes, or MCP failures. Appends to `~/.ai-os/incidents.ndjson`.
2. **JIT Aggregator (Preflight Hook)**: A step in `ai-preflight` that parses `incidents.ndjson`, groups events by signature/stack trace, and counts recurrences.
3. **Drafting Prompter (Advisor Bridge)**: If an incident reaches the threshold (e.g., >3 occurrences), the aggregator formats the incident data and leverages `advisor-mcp` or `ask_user` to present the issue to the Architect for P-## task generation.

## Data Model
```json
{
  "timestamp": "2026-05-10T12:00:00Z",
  "incident_type": "MCP_CRASH",
  "source_agent": "Claude",
  "message": "Error: SQLITE_BUSY: database is locked",
  "stack_signature": "task-synchronizer-mcp/index.js:45"
}
```

## API / Interface Contracts
- **`ai-incident` skill**: Accepts `incident_type`, `message`, and `stack_signature`.
- **Preflight aggregation**: Reads `~/.ai-os/incidents.ndjson`, outputs a console prompt or injects `[INCIDENT_THRESHOLD_REACHED]` into the preflight context.
- **Limits**: `incidents.ndjson` rotated monthly to prevent infinite bloat, max 500 lines per file.

## Security
Incident logs must not contain PII, authorization tokens, or sensitive user workspace data. The `ai-incident` skill must sanitize payloads before appending to the global log.

## Execution Constraints
Reading and parsing `incidents.ndjson` during `ai preflight` must complete in <50ms. Use Node.js streaming or strict line limits to prevent slow boot times.

## Rollback Plan
If the aggregator causes preflight timeouts, it can be disabled by toggling an `AI_INCIDENT_TRACKER_DISABLE=1` env variable. If the file bloats, manual deletion is safe and stateless.

## E-## Task Breakdown
- E-##: Create `ai-incident` skill and NDJSON append logic with PII sanitization.
- E-##: Implement JIT Aggregator logic inside the `ai-preflight` execution chain.
- E-##: Wire `ai-preflight` to prompt the Architect (Agy) via context injection when an incident threshold is exceeded.