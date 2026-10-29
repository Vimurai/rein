// claim-gate.mjs — the Engineer claim gate (E-331, D-102 §Component 4).
//
// In a team project (.ai/team.json) an Engineer on a branch named engineer/e<N>-* may not write
// outside .ai/ until E-<N> is claimed by them (task-claims.mjs claimGate: origin/<trunk> as last
// fetched; E-341 resolves the trunk, and an unresolved one keeps the gate closed, saying why). It runs on the two gate paths the Architect write gate uses —
// --check-path (Write/Edit) and --check (Bash) — and REUSES that gate's classification of a
// write: architectPathVerdict for a path, analyzeArchitectWrites for a command. So "a write" is
// the same set of operations for both roles, and plans/ counts as bookkeeping like .ai/.
// The Architect's classifier is called, never changed (D-056).
//
// Cost when inactive: one existsSync. task-claims.mjs (and the sqlite it pulls in) is
// imported only when team.json exists.
//
// REIN_CLAIM_GATE=0 lifts it with one telemetry BYPASS row (the task text, D-102 §4). This
// is an environment switch on a gate, which hooks-contract forbids for the SAFETY gates; the
// claim gate is a coordination gate, and the residual is named for the Architect.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { architectPathVerdict, analyzeArchitectWrites, findProjectRootFrom } from "./architect-writes.mjs";

/**
 * @param {{path?: string, command?: string, tokens?: string[], env?: object}} call
 * @returns {Promise<null | {code: string, message: string}>} null = allow
 */
export async function claimGateFor({ path = null, command = null, tokens = [], env = process.env } = {}) {
  const root = findProjectRootFrom(process.cwd());
  if (!existsSync(resolve(root, ".ai", "team.json"))) return null;
  if (path !== null) {
    if (!architectPathVerdict(path, root).blocked) return null;
  } else if (analyzeArchitectWrites(tokens, String(command ?? "")).length === 0) {
    return null;
  }
  const { claimGate } = await import("../shared/task-claims.mjs");
  const verdict = claimGate(root);
  if (!verdict) return null;
  if (env.REIN_CLAIM_GATE === "0") {
    try {
      const { recordToolExecution } = await import("../../shared/telemetry.mjs");
      recordToolExecution({ tool_name: "claim_gate", execution_time_ms: 0, status: "BYPASS", source: "hook" }, { sync: true });
    } catch { /* telemetry never decides a gate */ }
    return null;
  }
  return verdict;
}

export function claimReport(verdict, what) {
  return (
    "## safe-exec-mcp Claim Gate\nVerdict: ✗ BLOCK\n\n" +
    `### BLOCKED — ${verdict.code}\n` +
    `${what}\n${verdict.message}\n\n` +
    "In a team project an Engineer claims a task before writing source for it, so two people " +
    "never build the same E-## (D-102 §4). Writes under .ai/ and plans/ stay open.\n"
  );
}
