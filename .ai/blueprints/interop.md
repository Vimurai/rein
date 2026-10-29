# Domain Blueprint: Interoperability & Security Gates

> [!IMPORTANT]
> This document specifies the Agent-to-Agent (A2A) Bridge and Human-in-the-Loop (HITL) Security Gates required to bring AI-OS v2 into the 2026 multi-agent orchestration paradigm.

## 1. The Advisor/Executor Pattern (A2A Bridge)
To eliminate the bottleneck of "stuck agents" waiting for human mediation, AI-OS implements an Agent-to-Agent (A2A) Bridge, allowing the Engineer (Claude) to dynamically query the Architect (Agy).

### Architecture (`advisor-mcp`)
- **MCP Server**: `advisor-mcp`.
- **Purpose**: Provides a synchronous RPC bridge where the Executor (Claude) can send a query string to the Advisor (Gemini) mid-execution without dropping the current task or session.
- **Workflow**:
  1. Claude hits an ambiguity in `.ai/architect.md` while implementing an `E-##` task.
  2. Claude calls `advisor-mcp::ask_architect({ query: "Does the auth middleware need JWT validation or just session cookies?" })`.
  3. `advisor-mcp` spins up a lightweight, headless Gemini sub-agent instance pre-loaded with the `architect.md` context.
  4. The Gemini sub-agent processes the query, applying `think: "max"` (Adaptive Thinking) to resolve the ambiguity.
  5. Gemini returns a definitive architectural ruling back to Claude through the MCP response.
  6. Claude continues execution based on the ruling.

### Constraints
- The A2A Bridge is **strictly read-only for the Architect**. The headless Gemini instance invoked via `advisor-mcp` is forbidden from writing to files or mutating state. Its sole purpose is semantic clarification.
- Claude must log all A2A queries and responses in `.ai/LOG.md` as `[A2A_RULING]` for auditability.

## 2. Human-in-the-Loop (HITL) Security Gates
While AI-OS aims for autonomous execution, Tier 3 operations (e.g., executing structural database migrations, deploying to production) require explicit human consent.

### Architecture (`approval-mcp`)
- **MCP Server**: `approval-mcp`.
- **Purpose**: Formalizes the execution pause. When a high-risk operation is detected, this tool surfaces a blocking CLI prompt to the human user before allowing the process to continue.
- **Workflow**:
  1. The `trigger-audit` skill or `safe-exec-mcp` flags a command as `[TIER_3_RISK]`.
  2. Claude calls `approval-mcp::request_approval({ action: "Run prisma migrate deploy", reason: "Modifies production schema." })`.
  3. `approval-mcp` halts the MCP transport execution thread and triggers an interactive Y/N prompt in the host terminal.
  4. If the user selects 'Y', the MCP tool returns a `{ status: "APPROVED" }` payload to Claude.
  5. If the user selects 'N', the MCP tool returns a `{ status: "REJECTED" }` payload, and Claude must abort the current `E-##` task and mark it `BLOCKED`.

### Security Constraints
- **Bypass Resistance**: Real bypass-resistance is enforced by asserting `stdin.isTTY` (preventing headless non-interactive approvals) and utilizing a hardcoded database path (`~/.ai-os/approvals.sqlite`).
- **Audit Trail**: All approvals and rejections are permanently recorded in `~/.ai-os/approvals.sqlite` with a timestamp and the exact `CLAUDE_CODE_SESSION_ID` for perfect OASF compliance.
