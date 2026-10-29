/**
 * logger.js — Shared structured JSON logger for AI-OS MCP servers.
 *
 * Emits one NDJSON line per call to stderr. Stdout is reserved for the
 * MCP JSON-RPC protocol and must never be polluted.
 *
 * Usage:
 *   import { createLogger } from "../shared/logger.js";
 *   const log = createLogger("advisor-mcp");
 *   log.info("ask_architect", "query received", { length: 42 });
 *   log.error("ask_architect", "architect unavailable", { code: "ENOENT" });
 *
 * Schema (per line):
 *   { timestamp, level, service, tool?, message, ...extras }
 */

function emit(service, level, tool, message, extras) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service,
    ...(tool ? { tool } : {}),
    message,
    ...(extras && typeof extras === "object" ? extras : {}),
  };
  process.stderr.write(JSON.stringify(entry) + "\n");
}

export function createLogger(service) {
  if (!service || typeof service !== "string") {
    throw new Error("createLogger: service name (string) required");
  }
  return {
    debug: (tool, message, extras) => emit(service, "debug", tool, message, extras),
    info:  (tool, message, extras) => emit(service, "info",  tool, message, extras),
    warn:  (tool, message, extras) => emit(service, "warn",  tool, message, extras),
    error: (tool, message, extras) => emit(service, "error", tool, message, extras),
    log:   (level, tool, message, extras) => emit(service, level, tool, message, extras),
  };
}
