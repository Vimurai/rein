// mcp-result.mjs — what every MCP tool result carries on `_meta` (E-249, E-179/E-180; E-473).
//
// Two passthrough keys ride on `result._meta`, a spec-sanctioned field the model never sees
// as content:
//   - booted_build: the build this SERVER PROCESS booted with (D-067 §3). `rein doctor`
//     compares it with the build on disk to name a stale server.
//   - expected_rejection: an `isError` result that is the tool working as designed (bad
//     input, not found), not a malfunction.
//
// E-473 (D-170 r5, D-172 r28) removed the recording half that used to live here.

import { bootedBuild, buildStampEnabled } from "./build-stamp.mjs";

export const EXPECTED_REJECTION_META = "expected_rejection";
export const BOOTED_BUILD_META = "booted_build";

// Attach the booted-build stamp to a result. Never throws, never replaces a result, and
// never overwrites another `_meta` key: a stamping bug must not surface as a tool failure.
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

// An `isError` result flagged as an EXPECTED rejection. The model still sees `isError: true`.
export function rejection(text) {
  return {
    content: [{ type: "text", text }],
    isError: true,
    _meta: { [EXPECTED_REJECTION_META]: true },
  };
}

// Mark an already-built result as an expected rejection. Returns the same object.
export function markRejection(result) {
  if (result && typeof result === "object") {
    result._meta = { ...(result._meta || {}), [EXPECTED_REJECTION_META]: true };
  }
  return result;
}

// Wrap a CallTool handler so each result carries the booted-build stamp. All handler args
// are forwarded (the SDK passes `extra` with the cancellation signal and progress senders);
// a thrown error passes through unchanged.
export function withBuildStamp(serverName, handler) {
  return async (request, extra) => stampBootedBuild(await handler(request, extra), serverName);
}

/**
 * Patch a server's setRequestHandler so every CallTool handler it registers is wrapped with
 * withBuildStamp(). Call once per server, before it registers its handler. The caller
 * injects its own CallToolRequestSchema: the SDK is vendored per server and is not
 * resolvable from this shared module.
 */
export function instrument(server, serverName, callToolSchema) {
  // Record the booted build at startup, not on the first call: a server nobody has called
  // yet still belongs in `rein doctor`'s stale list.
  try { bootedBuild(serverName); } catch { /* startup must survive a read-only HOME */ }

  const orig = server.setRequestHandler.bind(server);
  server.setRequestHandler = (schema, handler) =>
    orig(schema, schema === callToolSchema ? withBuildStamp(serverName, handler) : handler);
  return server;
}
