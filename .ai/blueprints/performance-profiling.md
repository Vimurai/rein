# Performance & Profiling Architecture

## Core Concept
A dedicated pipeline for backend/memory performance. The `performance_engineer` agent and `ai-profile` skill will focus on identifying memory leaks, analyzing Node.js flamegraphs, evaluating rendering bottlenecks, and optimizing bundle sizes.

## Components
1. **`performance_engineer` (Agent)**: An autonomous persona specializing in scaling, V8 profiling, and Web Vitals analysis.
2. **`ai-profile` (Skill)**: An in-context workflow that initiates profiling on a target module or application route.
3. **`performance-mcp` (Server)**: A new MCP server capable of running `node --prof`, parsing flamegraphs, and generating `OPTIMIZATION_REPORT.md`.

## Data Model
- **Input**: A target command or route to profile.
- **Output**: `OPTIMIZATION_REPORT.md` written to the workspace root, containing a structural breakdown of CPU ticks, memory allocations, and actionable remediations.

## API Contracts
- `activate_skill({ skill_name: "ai-profile", arguments: { target: "src/index.js" } })`
- `performance-mcp::generate_flamegraph(target)`

## Security
- The profiling MCP must run strictly within the `code-execution-mcp` Docker sandbox to prevent host-level denial of service via memory exhaustion.

## Rollback Plan
- If the `performance_engineer` produces non-viable code changes, the `critic_tests` gate will block the commit. The state will be reverted to the pre-profile git SHA.
