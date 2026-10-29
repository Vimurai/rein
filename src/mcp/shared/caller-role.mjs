// caller-role.mjs — derive the calling Triad role SERVER-SIDE, and enforce the
// Architect's write scope from it.
//
// WHY THIS EXISTS (E-219, D-056 R1, THREAT_MODEL T-PATCHMCP-001):
//   patch-mcp and propose-patch-mcp each carried their own `roleGuard(callerRole, …)`
//   that returned "allow" whenever the CALLER simply omitted `caller_role`. The guard
//   was self-declared: a client that never mentions its role was treated as unrestricted
//   and could write anywhere. That was the only barrier left in any session started
//   without the `.claude/settings.<role>.json` overlay — and an overlay is settings-file
//   config, so it is precisely the layer most likely to be absent (a fresh clone before
//   `ai sync`, a different host, a session launched without `ai pane`).
//
//   The E-216 deny list closes the named route (`mcp__patch-mcp__patch_file`), but a
//   deny list matches TOOL NAMES; it cannot help when the overlay is not loaded at all.
//   So the server must decide for itself.
//
// RESOLUTION ORDER (D-056 R1, amended E-294 / D-087 r3):
//   1. The HMAC-verified session token, via `safe-exec --verify-role` on the session id
//      the harness exports. Authoritative — the same token the Bash, Write and Git-Lane
//      gates use, so all four agree by construction. The token verifies only when its
//      session process (the claude process) is an ANCESTOR of this server, so the session
//      id is a selector, not an authority.
//   2. NO VERIFIED TOKEN → `architect`. This is the fail-closed default and it is
//      deliberately the RESTRICTED role. Every session that ran its SessionStart hook holds
//      a token — a plain launch included (`engineer`, unverified launch) — so this is reached
//      only when the mint failed or the token was tampered with.
//   The server's spawn environment (REIN_CALLER_ROLE) is NOT evidence any more: a project's
//   settings `env` reaches it (D-087 r3).
//
// A SELF-REPORTED `caller_role` MAY ONLY ADD RESTRICTION, NEVER LIFT IT. Claiming
// `architect` when the record says `engineer` is honoured (more restrictive); claiming
// `engineer` when the record says `architect` is ignored. That keeps the argument useful
// for a caller that wants to sandbox itself, without making it a bypass.
//
// No environment rollback (D-084 r1, D-087 r3): the operator's lift is the time-boxed override.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative } from "node:path";
import { architectPathVerdict, findProjectRootFrom } from "../safe-exec-mcp/architect-writes.mjs";
import { fileURLToPath } from "node:url";

const ARCHITECT = "architect";
const ENGINEER = "engineer";

// Resolved once per process: an MCP server is long-lived and its session id and spawn
// env are fixed for its lifetime, so re-deriving per call would spawn node per request.
let _cached = null;

// Resolved relative to THIS MODULE, never the cwd. These servers are installed under
// ~/.rein and run inside ARBITRARY user projects, so a cwd-relative candidate meant any
// project containing src/mcp/safe-exec-mcp/index.js got that file EXECUTED by node — and
// its stdout is trusted to name a role, so a hostile clone bought both code execution in
// the server process and a guard bypass (it need only print "engineer"). safe-exec sits
// beside this module in both the repo and the install, so import.meta.url finds it in
// both without consulting anything the caller controls.
function _locateSafeExec() {
  try {
    const here = new URL("../safe-exec-mcp/index.js", import.meta.url);
    const p = fileURLToPath(here);
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** The role proved by the HMAC-verified session record, or null. */
function _roleFromRecord() {
  const sid = process.env.CLAUDE_CODE_SESSION_ID || "";
  if (!sid) return null;
  const se = _locateSafeExec();
  if (!se) return null;
  try {
    // process.execPath, never PATH (critic_security P2-3, E-294): the same decoy-interpreter
    // class role-token.mjs's _python() guards against.
    const out = execFileSync(process.execPath, ["--no-warnings", se, "--verify-role", sid], {
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === ARCHITECT || out === ENGINEER ? out : null;
  } catch (e) {
    // Distinguish "no record for this session" (exit 1, expected) from "the verifier
    // itself failed" (anything else). Both fall through to the next evidence source —
    // failing closed is still correct — but a broken verifier was previously completely
    // silent, so a machine that had lost safe-exec would degrade with no signal at all.
    if (e && e.status !== 1) {
      process.stderr.write(
        `[caller-role] safe-exec --verify-role failed (${e.status ?? e.code ?? "unknown"}); ` +
        "falling back to the restricted default.\n"
      );
    }
    return null;
  }
}

/**
 * Derive the calling role for this server process.
 *
 * Cached for the process lifetime: an MCP server is long-lived and both its session id
 * and its launch environment are frozen at spawn, so re-deriving would spawn node per
 * request for an answer that cannot change. NOTE the `cwd` argument is therefore only
 * honoured on the FIRST call; every current call site passes process.cwd().
 * @returns {{role: string, source: "record"|"default"}}
 */
export function resolveCallerRole(cwd = process.cwd()) {
  if (_cached) return _cached;

  const fromRecord = _roleFromRecord();
  if (fromRecord) {
    _cached = { role: fromRecord, source: "record" };
    return _cached;
  }

  // Fail closed: no evidence means the restricted role.
  _cached = { role: ARCHITECT, source: "default" };
  return _cached;
}

/** Test seam — an MCP server process caches its role for life. */
export function _resetCallerRoleCache() {
  _cached = null;
}

/**
 * Effective role for a request: the derived role, unless the caller volunteered a
 * MORE restrictive one. Never less restrictive.
 */
export function effectiveRequestRole(volunteered, cwd = process.cwd()) {
  const derived = resolveCallerRole(cwd);
  const claimed = String(volunteered || "").trim().toLowerCase();
  if (derived.role === ENGINEER && claimed === ARCHITECT) {
    return { role: ARCHITECT, source: `${derived.source}+self-restricted` };
  }
  return derived;
}

/**
 * True when `absPath` is inside the Architect's writable scope.
 *
 * Delegates to architectPathVerdict — the SAME predicate the Write/Edit gate and the
 * shell gate use. The first cut of this module hand-rolled a prefix test, which
 * reintroduced exactly the normalise-only check E-216 spent seven audit rounds
 * replacing: `.ai/note.md -> ../src/bin/ai` is a symlink the Architect may legitimately
 * create inside its own scope, and a prefix test happily allows a write straight through
 * it. Hardlinks likewise (`ln src/app.js .ai/h`), which no path resolution can see and
 * which architectPathVerdict handles with an nlink check.
 *
 * One rule, one implementation. Two implementations of one rule is the specific mistake
 * that produced the E-216 traversal split, and asking "do I need the real one?" was the
 * wrong question — reusing it costs nothing.
 */
export function inArchitectScope(absPath, cwd) {
  try {
    // findProjectRootFrom, not the raw cwd: safe-exec resolves the root the same way,
    // and this project has a documented MCP rooting trap where a .claude/-launched
    // server's cwd is not the project root. Passing the raw cwd would let the two gates
    // disagree about WHERE the root is while agreeing on the rule.
    return !architectPathVerdict(absPath, findProjectRootFrom(cwd)).blocked;
  } catch {
    // Fail closed, matching safe-exec's --check-path wrapper: a crash in the predicate
    // must never read as "allowed". Nothing on this path throws today; the precedent
    // exists precisely so that stays true when someone extends it.
    return false;
  }
}

/**
 * Architect write-scope guard. Returns an MCP error result when blocked, else null.
 * @param {string|undefined} volunteeredRole  the request's own `caller_role`, advisory only
 */
export function architectScopeGuard(volunteeredRole, absPath, cwd) {
  {
    const { role, source } = effectiveRequestRole(volunteeredRole, cwd);
    if (role !== ARCHITECT) return null;
    if (inArchitectScope(absPath, cwd)) return null;
    return {
      content: [{
        type: "text",
        text:
          "[ANTI_DRIFT_VIOLATION] Architect attempted to write outside the allowed scope.\n" +
          `  path:        ${absPath}\n` +
          `  role:        ${role} (derived from: ${source})\n` +
          "  allowed:     .ai/, plans/\n\n" +
          "The role is derived SERVER-SIDE (E-219, E-294): the HMAC-verified session token,\n" +
          "and `architect` when there is none — so an unidentified caller is confined rather\n" +
          "than trusted. A `caller_role` argument may only ADD restriction, never lift it.\n\n" +
          "To modify src/, use the Engineer pane (`ai pane engineer`).",
      }],
      isError: true,
    };
  }
}
