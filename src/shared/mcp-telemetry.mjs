// mcp-telemetry.mjs — Global Telemetry Interceptor (E-153, telemetry-hardening.md §Components 1).
//
// PROBLEM (surfaced by the 2026-06-09 INSIGHTS report): telemetry recorded a row for a
// tool ONLY when it was (a) a harness built-in observed by post-tool-use.sh, or (b) routed
// through the since-retired MCP router (E-277). Direct `mcp__<server>__<tool>` calls that a server
// handles itself, and server-side EXCEPTIONS, were invisible — so the `ERROR` dimension was
// empty (11487/11487 rows were SUCCESS) and Aggregate A (error hotspots) was permanently blind.
//
// FIX: a transport-level wrapper applied at every MCP server's CallTool handler so EVERY
// invocation records exactly one row with an accurate SUCCESS / ERROR (E-154: TIMEOUT) status
// — independent of whether the harness hook saw it. To avoid double-counting, post-tool-use.sh
// skips `mcp__*` tools (the server-side interceptor owns them) while still recording built-ins.
//
// CONSTRAINTS (blueprint §Execution Constraints): non-blocking, <5ms added per call. The actual
// SQLite write is already deferred by recordToolExecution() via setImmediate; this wrapper only
// stamps t0 + classifies status. Telemetry failure must NEVER break or delay the wrapped tool.

import { recordToolExecution } from "./telemetry.mjs";
import { bootedBuild, buildStampEnabled } from "./build-stamp.mjs";

// Status the wrapper can emit: SUCCESS / ERROR / TIMEOUT, plus REJECTED (E-180) for an EXPECTED
// rejection flagged via _meta.expected_rejection. The telemetry.sqlite CHECK accepts all four
// (E-154 added TIMEOUT, E-180 added REJECTED); callers may also pass a pre-classified TIMEOUT
// via the handler result.
export const TELEMETRY_STATUS = { SUCCESS: "SUCCESS", ERROR: "ERROR", TIMEOUT: "TIMEOUT", REJECTED: "REJECTED" };

// Build the canonical `mcp__<server>__<tool>` name — identical to the harness/MCP convention so
// server-side rows line up with how the agent and post-tool-use.sh name the same tool.
export function toolNameFor(serverName, request) {
  const tool = request?.params?.name;
  return `mcp__${serverName}__${typeof tool === "string" && tool ? tool : "unknown"}`;
}

// E-179/E-180: marker key a handler sets on `result._meta` to flag an `isError` result as an
// EXPECTED rejection (input validation, not-found, schema-fail, a domain-negative result
// like sandboxed code exiting non-zero) — the tool worked correctly, the caller/precondition
// was the problem. The meta-cognition INSIGHTS deprecation aggregate (E-85) counts ERROR rows
// to find BROKEN tools; conflating expected rejections with malfunctions polluted it (the 7
// "high-failure" tools audited in E-179 were ~all expected rejections, not defects). E-179 first
// folded these into SUCCESS to de-pollute ERROR; E-180 (D-049) instead books them as a distinct
// REJECTED status so the friction signal stays VISIBLE to the meta_analyst without inflating
// ERROR. `_meta` is a spec-sanctioned passthrough field, so the result the model receives is unchanged.
export const EXPECTED_REJECTION_META = "expected_rejection";

// E-249 (D-067 §3): the key under which every tool result carries the build this SERVER
// PROCESS booted with. It rides on `_meta` for the same reason expected_rejection does —
// a spec-sanctioned passthrough leaves the result the model receives unchanged — and it
// is attached here, in the one interceptor all 23 servers already call, rather than in 23
// handlers that would drift apart. A caller comparing it against the build on disk learns
// whether the answer it just received came from the code currently installed.
export const BOOTED_BUILD_META = "booted_build";

// Attach the booted-build stamp to a result. Never throws, never replaces a result, and
// never overwrites an existing `_meta` key: telemetry and its neighbours are side-effects
// on the response path, and a stamping bug must not surface as a tool failure.
export function stampBootedBuild(result, serverName) {
  if (!result || typeof result !== "object") return result;
  if (!buildStampEnabled()) return result;
  try {
    const stamp = bootedBuild(serverName);
    if (!stamp) return result;
    result._meta = {
      ...(result._meta || {}),
      [BOOTED_BUILD_META]: { hash: stamp.hash, mtime_iso: stamp.mtime_iso, entry: stamp.entry },
    };
  } catch { /* a stamp is never worth a failed tool call */ }
  return result;
}

// Classify an MCP CallTool result. A handler that returns `{ isError: true }` is normally a
// tool-level failure (E-154); a non-object/undefined return is MALFORMED — the SDK validates
// the result against CallToolResultSchema after we run and rejects it with an McpError, so we
// book it ERROR too rather than a false SUCCESS (Tier-3 review). A thrown exception is
// classified ERROR by the catch in withTelemetry. E-180 (D-049): an `isError` result
// explicitly marked `_meta.expected_rejection === true` is the tool working as designed and
// books REJECTED — a distinct usage-friction status (NOT SUCCESS, which E-179 used; NOT ERROR,
// which would re-pollute the broken-tool aggregate). Genuine handled errors stay UNMARKED and
// therefore still book ERROR.
export function statusForResult(result) {
  if (!result || typeof result !== "object") return TELEMETRY_STATUS.ERROR;
  if (!result.isError) return TELEMETRY_STATUS.SUCCESS;
  if (result._meta && result._meta[EXPECTED_REJECTION_META] === true) {
    return TELEMETRY_STATUS.REJECTED;
  }
  return TELEMETRY_STATUS.ERROR;
}

// E-179 helper — build an `isError` result already flagged as an EXPECTED rejection. Use for
// single-text validation/not-found/schema-fail returns. The model still sees `isError: true`
// (so it reacts to the bad input); telemetry books it REJECTED (the tool is healthy; the input
// or precondition was the problem). Do NOT use this for genuine internal failures — leave those
// as a plain `{ isError: true }` so they remain ERROR in the deprecation aggregate.
export function rejection(text) {
  return {
    content: [{ type: "text", text }],
    isError: true,
    _meta: { [EXPECTED_REJECTION_META]: true },
  };
}

// E-179 helper — stamp the expected-rejection marker onto an already-built result (e.g. a
// multi-content payload) without rebuilding it. Returns the same object for inline use.
export function markRejection(result) {
  if (result && typeof result === "object") {
    result._meta = { ...(result._meta || {}), [EXPECTED_REJECTION_META]: true };
  }
  return result;
}

/**
 * Wrap a server's CallTool handler so each invocation records one telemetry row.
 * @param {string} serverName  e.g. "task-synchronizer-mcp"
 * @param {(request:any)=>Promise<any>} handler  the existing CallTool handler
 * @param {{ record?: (payload:object)=>void }} [opts]  inject a recorder (tests); defaults to
 *        the shared recordToolExecution (itself fire-and-forget via setImmediate).
 * @returns {(request:any)=>Promise<any>} an instrumented handler with identical semantics
 */
export function withTelemetry(serverName, handler, opts = {}) {
  const record = opts.record || recordToolExecution;
  // Forward ALL handler args (Tier-3 review): the MCP SDK invokes handlers as
  // `handler(request, extra)` where `extra` carries cancellation `signal`, progress
  // `sendNotification`/`sendRequest`, `sessionId`, `requestId`, `authInfo`. Dropping it would
  // silently strip those from every wrapped handler. Telemetry derives only from `request`.
  return async (request, extra) => {
    const t0 = Date.now();
    let status = TELEMETRY_STATUS.SUCCESS;
    try {
      const result = await handler(request, extra);
      // Classify BEFORE stamping. statusForResult reads `_meta.expected_rejection`, and
      // stamping rebuilds `_meta`; ordering it the other way would work today and break
      // the first time either function grew an opinion about the other's key.
      status = statusForResult(result);
      return stampBootedBuild(result, serverName);
    } catch (e) {
      status = TELEMETRY_STATUS.ERROR;
      throw e; // never swallow the tool's own error — telemetry is a side-effect
    } finally {
      // Side-effect only; recordToolExecution is itself fire-and-forget (setImmediate) and
      // swallows its own errors, but we belt-and-suspenders guard so a telemetry bug can
      // never surface as a tool failure or add latency to the response path.
      try {
        record({
          tool_name: toolNameFor(serverName, request),
          execution_time_ms: Date.now() - t0,
          status,
          source: "interceptor", // E-261: latency is compared like with like
          project_root: process.cwd(),
          session_id: process.env.CLAUDE_CODE_SESSION_ID || process.env.REIN_SESSION_ID || "",
        });
      } catch { /* telemetry must never break a tool */ }
    }
  };
}

/**
 * Monkeypatch a server's setRequestHandler so EVERY CallTool handler it registers is
 * automatically wrapped with withTelemetry(). This is the rollout mechanism across all
 * MCP servers — one call per server, BEFORE it registers its handler.
 *
 * SDK-FREE BY DESIGN: the caller injects the `callToolSchema` it already imports. The
 * @modelcontextprotocol/sdk package is vendored per-server (each src/mcp/<srv>/node_modules)
 * and is NOT resolvable from this shared module, so importing it here would throw
 * MODULE_NOT_FOUND. Injection keeps the interceptor server-agnostic and dependency-free.
 *
 * @param {object} server  an MCP SDK Server instance (its setRequestHandler is patched)
 * @param {string} serverName  e.g. "orchestrator-mcp" — used for the mcp__<server>__<tool> row
 * @param {object} callToolSchema  the server's imported CallToolRequestSchema (the discriminator)
 * @param {{ record?: (payload:object)=>void }} [opts]  inject a recorder (tests)
 * @returns {object} the same server, for chaining
 */
export function instrument(server, serverName, callToolSchema, opts = {}) {
  // E-249: record the booted build NOW, at startup, not on the first tool call. A server
  // that is never called still needs to appear in `rein doctor`'s stale list — a stale
  // server nobody has invoked yet is exactly the one about to serve a wrong answer.
  try { bootedBuild(serverName); } catch { /* startup must survive a read-only HOME */ }

  const orig = server.setRequestHandler.bind(server);
  server.setRequestHandler = (schema, handler) =>
    orig(schema, schema === callToolSchema ? withTelemetry(serverName, handler, opts) : handler);
  return server;
}
