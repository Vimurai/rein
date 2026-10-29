# Goal & Architecture
Fix a fatal path resolution bug in the `scripts/standards.mjs` CLI that causes pre-commit hooks to fail in installed AI-OS environments. The script currently uses a static import path that is valid within the repository but broken when the framework is installed globally at `~/.ai-os/`.

# Core Concept
Replace the static `import { ... } from "../src/shared/standards-checker.mjs"` statement with a dynamic, locator-aware `await import()` chain. This mirrors the proven pattern used in `scripts/generate_mcp_docs.mjs` (E-52), allowing the script to find its dependency whether it's executing in the local development repo or from the global installation directory.

# Components
1. **Dynamic Locator Chain:** A robust array of candidate paths that cover in-tree development, relative installed mode, and absolute fallback.
2. **Top-Level Await:** Leveraging Node 22+ to dynamically import the module and destructure the required exports.
3. **Fail-Closed Guard:** Explicitly halting execution with a clear error message on stderr if the dependency cannot be located, preventing opaque "module not found" stack traces.

# Data Model
The script relies on destructuring the following from the loaded module:
- `loadStandards`
- `validateStaged`
- `validateFiles`
- `validateFile`
- `reportDrift`
- `DEFAULT_STANDARDS_PATH`

# API / Interface Contracts
- **Input:** Standard CLI arguments passed to `scripts/standards.mjs`.
- **Output:** Identical stdout/stderr output as before. The CLI contract remains entirely unchanged.
- **Errors:** If resolution fails, exit code 1 with message `[standards] ERROR: standards-checker.mjs not found in any candidate paths.`

# Security
- The dynamic import relies on hardcoded, relative paths and a fallback to the user's home directory. It does not accept user-supplied strings for module resolution, mitigating path traversal or arbitrary code execution risks.
- Maintains compliance with the project's strict dependency bounds by exclusively using `node:*` built-ins (`fs`, `path`, `url`, `os`).

# Execution Constraints
- Must remain performant; the overhead of `existsSync` and dynamic `import()` is negligible and well within the 200ms budget defined for the standards checker.
- Requires Node 14.8+ for top-level await, but AI-OS mandates Node 22+ per system-hardening-phase3.md, so compatibility is guaranteed.

# Rollback Plan
If the dynamic import introduces unforeseen regressions, the change can be reverted by running `git checkout HEAD~1 scripts/standards.mjs`. In the interim, users can bypass the hook using `AI_OS_SKIP_STANDARDS=1`.

# E-## Task Breakdown
- **E-XX1:** Refactor `scripts/standards.mjs` to replace the static import of `standards-checker.mjs` with a dynamic locator chain, ensuring compatibility with both in-repo and installed execution environments. Add tests to `tests/suites/standards_checker_test.sh` if necessary to assert the locator behavior.