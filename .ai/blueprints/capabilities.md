# Domain Blueprint: Capabilities & Execution Settings

> [!IMPORTANT]
> This document specifies the native 2026 API capabilities injected into the AI-OS Triad, mapping Adaptive Thinking and Computer Use boundaries.

## 1. Adaptive Thinking (`think: "max"`)
The "Adaptive Thinking" parameter (or "Deep Think" equivalent) must be strategically injected into the API payload based on the active role in the Triad.

### Architect (Agy)
- **Role Requirement**: The Architect must map out complex system edge cases, write exhaustive domain blueprints, and prevent "plan drift" before execution begins.
- **Setting**: `think: "max"` (or `thinking_effort: "high"` depending on the SDK).
- **Injection Point**: This is configured provider-relative (agy reads `.agents/mcp_config.json`) and passed via the Context Invoker during the `enter_plan_mode` or initial session boot.

### Engineer (Claude)
- **Role Requirement**: The Engineer relies on rapid, iterative execution (Fuzzy Patching, writing code, running tests). Deep thinking is too slow and expensive for iterative file editing.
- **Setting**: Standard execution speed (`think` disabled or `low`).
- **Injection Point**: Configured in `.claude/settings.json`.

## 2. Native Computer Use (Project Mariner)
We are augmenting/replacing the Playwright-based `vibe-check-mcp` with native OS-level "Computer Use" capabilities to provide the agents with actual visual and interactive context of the running application.

### Implementation Strategy
- **New MCP Server**: `computer-use-mcp`.
- **Purpose**: Allows TestSprite and Vibe Sentinel to capture screen states, coordinate clicks, and input text natively into running Desktop or Web applications, rather than relying on DOM scraping.
- **Security Boundary**: The `computer-use-mcp` must operate in a strictly isolated, headless X11/Wayland buffer (or equivalent sandboxed environment) to prevent the agent from escaping the project context and interacting with the host machine's sensitive applications.

### Integration with TestSprite
When `ai test --vibe` is run, the Triad triggers `TestSprite` via `computer-use-mcp` to visually assert that the UI matches the intent defined in the architect's blueprint.
