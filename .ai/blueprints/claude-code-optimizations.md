# Blueprint: Claude Code Optimizations

## Goal & Architecture
To solidify the AI-OS v2 Triad by resolving terminal workflow friction, guaranteeing MCP JSON-RPC stream purity, and ensuring perfect audit traceability across sessions.

## Core Concept
1. **MCP Stream Purity:** A static enforcement boundary ensuring `src/mcp/` servers never leak non-protocol data (like `console.log`) to stdout, capitalizing on Claude Code's recent leak fix.
2. **Session Tracing:** Utilizing the new `CLAUDE_CODE_SESSION_ID` environment variable to cryptographically link `.ai/LOG.md` entries and `approval-mcp` database records to the exact execution session.
3. **Terminal Emancipation:** Injecting `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` into the bootloader to restore native terminal scrollback for tmux users.

## Components
1. **MCP Purity Gate (CI/CD & Pre-commit)**
   - **Responsibility:** Scans `src/mcp/**` for forbidden stdout writes (`console.log`, `console.info`, `process.stdout.write` outside of protocol). Forces all logging to `stderr`.
2. **Session Audit Enhancer (`LOG.md` & `approval-mcp`)**
   - **Responsibility:** Captures `CLAUDE_CODE_SESSION_ID` from the environment. `ai-log` appends it to `LOG.md` entries. `approval-mcp` logs it as a new column in `approvals.sqlite`.
3. **Bootloader Configurator (`bin/ai`)**
   - **Responsibility:** Injects `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` into the Claude subprocess environment to disable the TUI alternate screen.

## Data Model
```json
// approval-mcp SQLite Schema Update
{
  "table": "approvals",
  "new_column": "session_id TEXT" // Captures CLAUDE_CODE_SESSION_ID
}
```

## API / Interface Contracts
- **Bootloader (`bin/ai`):** Exports `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` before invoking Claude.
- **`approval-mcp`:** Modifies `INSERT INTO approvals` to include `process.env.CLAUDE_CODE_SESSION_ID`.

## Security
- **Trust Boundaries:** The `CLAUDE_CODE_SESSION_ID` must be treated as untrusted input from the environment. It must be sanitized (alphanumeric only, bounded length) before being written to SQLite to prevent injection attacks.
- **Threat Surface:** MCP servers leaking data to stdout can silently break the Triad. The Purity Gate is a defense-in-depth measure to prevent execution stall.

## Execution Constraints
- **Performance:** The MCP Purity Gate should be a fast regex or AST scan (e.g., ESLint rule) that runs in milliseconds during pre-commit.
- **Concurrency:** No changes to concurrency.

## Rollback Plan
- If `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` causes terminal rendering bugs on specific OSes, revert the environment variable injection.

## E-## Task Breakdown
- **E-48:** Implement MCP Stdout Purity Gate: Add a pre-commit lint rule to ban `console.log` and `console.info` in `src/mcp/**` per `claude-code-optimizations.md`. | Tier: 2
- **E-49:** Implement Session Traceability: Update `approval-mcp` SQLite schema and `ai-log` to capture and record `CLAUDE_CODE_SESSION_ID` per `claude-code-optimizations.md`. | Tier: 2
- **E-50:** Terminal Optimization: Inject `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` into `bin/ai` and `install-ai-os.sh` per `claude-code-optimizations.md`. | Tier: 1