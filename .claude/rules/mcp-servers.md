---
paths:
  - "src/mcp/**"
---

# MCP server rules (src/mcp/)

- **Stdout is the JSON-RPC channel.** Never `console.log()` / `console.info()` in `src/mcp/**`
  (`mcp_stdout_purity`); log through `src/mcp/shared/logger.js`, which writes to stderr.
- **Guard `server.connect()` with the main-module check** (`isMainModule`, D-041) so importing a
  server in a test does not block on stdin. Compare REAL paths — a symlinked `/var` →
  `/private/var` made string comparisons silently no-op (E-265).
- **SQLite goes through the shared helpers** (`src/shared/wal-flusher.mjs`,
  `src/mcp/shared/state-db.js`), not a direct `node:sqlite` import.
- **Every server is wrapped by the telemetry interceptor** (`instrument()` from
  `src/shared/mcp-telemetry.mjs`). An expected rejection of bad input is marked
  `_meta.expected_rejection`, so it books REJECTED, not ERROR (E-179/E-180).
- **A running server serves the code it booted with (E-249).** After `bash install-rein.sh`
  or a pull, running servers are stale until the session restarts; `build-stamp.mjs` announces
  it. Never hot-reload the write path — only the pure policy modules in E-237's set may reload.
- **Retiring a server** removes its `registry.json`, `.mcp.json`, settings-allow and
  `mcp-domains.mjs` entries, and adds a `src/config/legacy-artefacts.json` entry so `rein clean`
  removes the mirror (D-074).
