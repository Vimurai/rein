// review-checks.mjs — `rein review <tier>` (E-464, D-169 r8, D-170 r5; lean-core.md §Component 5).
//
// The deterministic half of a review, moved out of orchestrator-mcp's run_review: a few checks a
// machine can make on the diff, then the agents to dispatch for the tier. The judgment half is
// the agents' (reviewer, critic_acceptance, security_engineer), and whether they ran is checked
// when the task closes (completion-gates.mjs), not at commit.
//
//   node review-checks.mjs <1|2|3> [--base <ref>] [--cwd <dir>]
//     exit 0 — no P0; the dispatch list is printed
//     exit 1 — a P0 finding; nothing is dispatched until it is fixed
//     exit 2 — bad arguments
//
// E-480 (D-176, acceptance-replay.md §Component 3): Tier 2 and 3 also run `rein recheck` (the
// recorded acceptance checks of DONE tasks) and print its lines. A broken check is a P0: the
// DONE gate ([CHECK_GATE]) would refuse anyway, so no agent is dispatched until it is fixed or
// retired. The replay runs here, in the caller's shell — never in an MCP server.
//
// The diff: `--base <ref>` diffs <ref> against the working tree; otherwise the staged diff, else
// the unstaged one, else the last commit (`git diff HEAD~1`) — the batch commits each task.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { classifyDiffTraversal } from "./traversal-policy.mjs";
import { PLUGIN_NAME } from "./plugin-build.mjs";
import { isMainModule } from "../mcp/shared/is-main.mjs";
import { runRecheck } from "./recheck.mjs";
import { findAiDir } from "./cli-add-task.mjs";

/** The agents a tier dispatches, in order (lean-core.md §Component 5). */
export const TIER_DISPATCH = Object.freeze({
  1: [],
  2: ["reviewer", "critic_acceptance"],
  3: ["reviewer", "critic_acceptance", "security_engineer"],
});

/** The stamp each agent records; the DONE gate asks for the PASS form (completion-gates.mjs). */
export const AGENT_STAMP = Object.freeze({
  reviewer: "REVIEW_PASS or REVIEW_FAIL",
  critic_acceptance: "ACCEPT_PASS or ACCEPT_FAIL",
  security_engineer: "SEC_CLEARED or SEC_BLOCKED",
});

function _git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
  return r.error || r.status !== 0 ? "" : (r.stdout || "");
}

/** The diff under review (see the header). A base that is not a ref yields "" (no option injection). */
export function reviewDiff(cwd, base = null) {
  if (base) return /^[A-Za-z0-9._\/~^@{}-]+$/.test(base) && !base.startsWith("-") ? _git(["diff", base, "--"], cwd) : "";
  for (const args of [["diff", "--staged"], ["diff", "HEAD"], ["diff", "HEAD~1", "HEAD"]]) {
    const d = _git(args, cwd);
    if (d.trim()) return d;
  }
  return "";
}

/** The deterministic checks over a unified diff → [{ id, severity, status, detail }]. */
export function reviewChecks(diff, { cwd = process.cwd(), env = process.env } = {}) {
  const checks = [];

  // Hardcoded secrets in an added line.
  const secretPattern = /^\+[^+].*\b(password|passwd|api.?key|secret|token|private.?key)\s*=\s*["'][^"']{4,}/gim;
  const secretMatches = [...diff.matchAll(secretPattern)].map((m) => m[0].trim().slice(0, 60));
  if (secretMatches.length > 0) checks.push({ id: "HARDCODED_SECRET", severity: "P0", status: "FAIL", detail: secretMatches[0] });

  // Path traversal — context-aware (E-222, D-057 §2) and graded on EXECUTABLE lines only (E-224,
  // D-058 §3): src/shared/markdown-exec.mjs decides per markdown line, because skill files carry
  // `!` lines the harness auto-executes. REIN_REVIEW_STRICT_TRAVERSAL=1 restores the flat regex.
  const strictTraversal = env.REIN_REVIEW_STRICT_TRAVERSAL === "1";
  const { traversal, proseExec, suppressed = [] } = classifyDiffTraversal(diff, {
    strict: strictTraversal,
    readFile: (f) => readFileSync(resolve(cwd, f), "utf8"),
  });
  if (traversal) {
    checks.push({
      id: "PATH_TRAVERSAL",
      severity: traversal.severity,
      status: traversal.severity === "P0" ? "FAIL" : "WARN",
      detail: traversal.anchor
        ? `${traversal.file}:${traversal.line} ${traversal.detail}  (anchored to ${traversal.anchor} — advisory)`
        : `${traversal.file}:${traversal.line} ${traversal.detail}`,
    });
  }
  // E-428: a reasoned `rein:allow PATH_TRAVERSAL` marker lifts the block, never the report.
  if (suppressed.length > 0) {
    checks.push({
      id: "TRAVERSAL_SUPPRESSED",
      severity: "P2",
      status: "INFO",
      detail: suppressed.map((s) => `${s.file}:${s.line} (${s.reason})`).join("; "),
    });
  }
  if (proseExec.length > 0) {
    checks.push({ id: "EXECUTABLE_IN_PROSE", severity: "P0", status: "FAIL",
      detail: `auto-executed '!' line in documentation: ${proseExec.slice(0, 3).join(", ")}` });
  }

  // Architect-owned files (§35, E-169): the exact files plus everything under .ai/blueprints/.
  const sovereignExact = [".ai/architect.md", ".ai/BRIEF.md"];
  const sovereignDirs = [".ai/blueprints/"];
  const sovereigntyViolations = [
    ...sovereignExact.filter((f) => diff.includes(`a/${f}`) || diff.includes(`b/${f}`)),
    ...sovereignDirs.filter((d) => diff.includes(`a/${d}`) || diff.includes(`b/${d}`)),
  ];
  if (sovereigntyViolations.length > 0) {
    checks.push({ id: "SOVEREIGNTY_VIOLATION", severity: "P0", status: "FAIL", detail: sovereigntyViolations.join(", ") });
  }

  // A new dependency with no decision in the same diff.
  const newDeps = [...diff.matchAll(/^\+\s+"[a-z@][a-z0-9\-@/.]+"\s*:/gm)].map((m) => m[0].trim());
  if (newDeps.length > 0 && !diff.includes("DECISIONS.md")) {
    checks.push({ id: "UNAPPROVED_DEP", severity: "P1", status: "WARN", detail: newDeps.slice(0, 3).join(", ") });
  }
  return checks;
}

/**
 * The report `rein review <tier>` prints. → { text, p0 }
 * `opts.recheck` — the result of runRecheck ({ code, out }) for Tier 2 and 3; its lines are printed.
 */
export function reviewReport(tier, diff, opts = {}) {
  const checks = reviewChecks(diff, opts);
  const p0 = checks.filter((c) => c.severity === "P0");
  const replay = opts.recheck || null;
  if (replay && replay.code !== 0) p0.push({ id: "CHECKS_FAIL" });
  const files = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].length;
  const lines = [`rein review — Tier ${tier} (${files} file(s) in the diff)`, "", "Deterministic checks:"];
  if (checks.length === 0) lines.push("  ✓ no finding");
  for (const c of checks) lines.push(`  [${c.id}] ${c.severity} ${c.status}: ${c.detail}`);
  if (replay) lines.push("", "Recorded checks (rein recheck):", ...replay.out.split("\n").map((l) => `  ${l}`));
  lines.push("", "Dispatch:");
  if (p0.length > 0) {
    lines.push(`  none yet — fix the ${p0.length} P0 finding(s) above${replay && replay.code !== 0 ? " (a broken check: fix the code, or retire it with rein recheck --retire)" : ""}, then run rein review ${tier} again`);
  } else if (TIER_DISPATCH[tier].length === 0) {
    lines.push("  none — Tier 1 needs no review and no stamp");
  } else {
    // E-469: the agents are the rein plugin's, so the Agent tool's subagent_type is plugin-scoped.
    TIER_DISPATCH[tier].forEach((a, i) => lines.push(`  ${i + 1}. ${PLUGIN_NAME}:${a} on <task id> → ${AGENT_STAMP[a]}`));
    lines.push("", "The task is refused DONE until each PASS stamp stands for HEAD ([REVIEW_GATE], [ACCEPT_GATE]" +
      `${tier === 3 ? ", [SEC_GATE]" : ""}, [CHECK_GATE]).`);
  }
  return { text: lines.join("\n"), p0: p0.length };
}

/** The replay for Tier 2/3: none outside a Rein project (never create an .ai/ there); an error is one line. */
async function _replay(cwd) {
  const aiDir = findAiDir(cwd);
  if (!["state.sqlite", "state.json", "project.json"].some((f) => existsSync(join(aiDir, f)))) return null;
  try { return await runRecheck(aiDir); } catch (e) { return { code: 1, out: `✗ [CHECKS_FAIL] rein recheck failed: ${e.message}` }; }
}

if (isMainModule(import.meta.url)) {
  const argv = process.argv.slice(2);
  const tier = Number(argv[0]);
  const opt = (k) => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : null; };
  if (![1, 2, 3].includes(tier) || argv.length % 2 !== 1) {
    process.stderr.write("usage: rein review <1|2|3> [--base <ref>]\n");
    process.exitCode = 2;
  } else {
    const cwd = resolve(opt("--cwd") || process.cwd());
    const recheck = tier >= 2 ? await _replay(cwd) : null;
    const { text, p0 } = reviewReport(tier, reviewDiff(cwd, opt("--base")), { cwd, recheck });
    process.stdout.write(`${text}\n`);
    process.exitCode = p0 > 0 ? 1 : 0;
  }
}
