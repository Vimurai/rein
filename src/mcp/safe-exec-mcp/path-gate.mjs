// path-gate.mjs — the --check-path decision and the gate's role lookup.
// Moved out of index.js by E-442 (D-164 r8): a pure move, no verdict changed; index.js re-exports
// pathAnalysis under its old name.

import { architectPathVerdict, findProjectRootFrom } from "./architect-writes.mjs";
import { isUnderRein } from "./gate-guard.mjs";
import { ARCHITECT, verifyToken } from "./role-token.mjs";

// ── E-294 (D-087, sovereignty-hardening.md Components 8d–8f): the role on the gate path ────
// The role comes ONLY from the HMAC-verified v2 session token (role-token.mjs), which is bound
// to its session process and minted from the launch-record walk. No environment input: the
// REIN_CALLER_ROLE fallback is gone (D-087 r3). No verified token → the UNION: every role's
// blocks apply (today the Architect rule set — the Engineer has none at the hook), with
// ROLE_UNVERIFIED_LINE naming the fix.
//
// Flags are scanned AFTER the fixed positional (<command> or <path>), so a command or a target
// path literally named "--session" cannot hijack the parse (E-208 audit). A positional role
// word left by an older hook is ignored.
function _gateFlags(fromIdx) {
  const val = (flag) => {
    const i = process.argv.indexOf(flag, fromIdx);
    return i !== -1 ? String(process.argv[i + 1] || "") : "";
  };
  return { sid: val("--session"), sessionPid: val("--session-pid") };
}

/**
 * E-301 (D-088): the --check-path decision as a function of (target, role) — the CLI below and
 * the role-verdict contract table call this one function. `role` is the gate's: the token's,
 * or ARCHITECT for the union. Throws on an analyzer fault; the caller fails closed. The claim
 * gate (team projects, E-331) stays in the CLI: it reads process state, not the path.
 *   → { blocked: false } | { blocked: true, id: "GATE_SELF_DISABLE" | "ARCH_WRITE_OUTSIDE_SCOPE", reason }
 */
export function pathAnalysis(target, role, { projectRoot = findProjectRootFrom(process.cwd()), home } = {}) {
  // E-291 (D-083 r6): ~/.rein/** (hooks, gate, secrets, the override file) is protected
  // for EVERY role — the Write/Edit tools are the other way an agent could disable the gate.
  let underRein = false;
  try { underRein = isUnderRein(target, home); } catch { underRein = true; }   // fail closed
  if (underRein) return { blocked: true, id: "GATE_SELF_DISABLE", reason: "inside ~/.rein/" };
  if (role !== ARCHITECT) return { blocked: false };
  const v = architectPathVerdict(target, projectRoot);
  return v.blocked ? { blocked: true, id: "ARCH_WRITE_OUTSIDE_SCOPE", reason: v.reason } : { blocked: false };
}

/** {role, verified}: the token's role, or the union stand-in ("architect") when unverified. */
export function gateRole(fromIdx) {
  const { sid, sessionPid } = _gateFlags(fromIdx);
  const role = sid ? verifyToken(sid, { sessionPid: sessionPid || null }) : null;
  return role ? { role, verified: true } : { role: ARCHITECT, verified: false };
}
