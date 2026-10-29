# Domain Blueprint: Post-Audit Followups

## Goal & Architecture
**Goal:** Address minor documentation drifts, clarify targets, and add telemetry checks following the June 2026 architectural audit.
**Architecture:** Relies on the existing Node.js 22+ runtime, sqlite3 state store, and Antigravity plugin-builder.

## Core Concept
Ensure documentation matching for the `ux_reviewer` agent, run the plugin generator to synchronize Antigravity manifestations, prune deprecated references, and introduce verification checks to prevent silent database issues.

## Components
1. **UX Reviewer Markdown & Plugin**: Updates `src/gemini/agents/ux_reviewer.md` and its mirror `.gemini/agents/ux_reviewer.md` to specify stamping via `add_stamp` (D-040 compliance). Re-generates `agent.json` via the plugin builder.
2. **Telemetry Connection Validation**: Adds startup preflight verification in `src/shared/telemetry.mjs` to ensure the database path (file itself or its parent directory if the file does not exist yet) is writable.
3. **Deprecated References Purge**: Removes references to the legacy `prd_writer` agent from `.ai/DIGEST.md` and related documentation.

## Data Model
No schema changes. Telemetry and state structures are preserved.

## API / Interface Contracts
`telemetry.mjs` will exit with warning logs on write failures during preflight but will fail-open (exit 0) so user operations are not blocked.

## Security
No authentication or secrets changes. Preserves fail-closed invariants for role checking.

## Execution Constraints
Preflight telemetry checks must run in `< 50ms` to preserve fast CLI responsiveness.

## Rollback Plan
Revert changes using standard `git checkout` or `git revert`.

## E-## Task Breakdown
- **E-172**: Update `src/gemini/agents/ux_reviewer.md` and its mirror `.gemini/agents/ux_reviewer.md` to specify that visual audit verdicts are recorded via the `add_stamp` tool (D-040 compliance), and rebuild the Antigravity plugin using the plugin builder. | Tier: 1
- **E-173**: Add a writable check for `telemetry.sqlite` in `src/shared/telemetry.mjs` preflight that logs warning messages on failure but fails open. | Tier: 2
- **E-174**: Remove deprecated references to `prd_writer` from `.ai/DIGEST.md` to keep documentation accurate. | Tier: 1
