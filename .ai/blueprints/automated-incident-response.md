# Automated Incident Response (SRE) Architecture

## Core Concept
To close the loop on unpredictable system events logged to `incidents.ndjson`, the `sre_responder` agent and `ai-triage` skill act as an automated on-call responder.

## Components
1. **`sre_responder` (Agent)**: Analyzes logs, groups recurring crashes, drafts post-mortems, and proposes remediation tasks.
2. **`ai-triage` (Skill)**: Runs daily or when `incidents.ndjson` crosses a size threshold.
3. **`incident-aggregator` (Job)**: Parses `incidents.ndjson` to extract stack traces and frequency counts.

## Data Model
- **Source**: `~/.ai-os/incidents.ndjson`
- **Output**: `POSTMORTEM.md` reports and new `E-##` tasks appended to `.ai/TASKS.md`.

## API Contracts
- `activate_skill({ skill_name: "ai-triage" })`
- `sre_responder` utilizes `task-synchronizer-mcp::add_task` to queue fixes directly into the Engineer's workflow.

## Security
- The `sre_responder` is strictly read-only over incident logs. It may not execute code changes itself; it only plans remediation tasks to maintain separation of concerns.

## Rollback Plan
- If a generated task is deemed a false positive, the Engineer can use the `handoff_control` API to reject the task back to the Architect.
