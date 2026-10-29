#!/usr/bin/env node
/**
 * orchestrator-mcp — Rein Deterministic Workflow Execution
 * Replaces LLM-interpreted multi-step workflows with programmatic execution.
 *
 * Tools:
 *   run_handover({ task_id })     → marks task DONE, appends LOG, triggers digest prompt
 *   run_review({ tier })          → tier-aware review: T1 skip, T2 aligner, T3 deterministic checks + agent dispatch
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { instrument } from "../../shared/mcp-telemetry.mjs";
// E-320: run_handover and the git/date helpers it shares with run_review live beside this file.
import { runHandover, getDiff, today } from "./run-handover.mjs";
// E-237 (D-061 §5): the traversal POLICY is loaded per request, not once at spawn.
// This server lives for the whole session and ESM caches a module by URL forever, so a
// policy refreshed by `ai sync` never reached the running process. Throughout the
// 2026-09-09 sprint this reported a P0 PATH_TRAVERSAL on a line the on-disk module graded
// P1 — every review had to be adjudicated by hand. A gate that cries wolf is worse than
// one that is merely wrong, because people learn to wave it through.
import { loadPolicy } from "../shared/load-policy.mjs";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import { getDbSeeded, readState } from "../shared/state-db.js";
import { createLogger } from "../shared/logger.js";

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
const logger = createLogger("orchestrator-mcp");

// ── Helpers ───────────────────────────────────────────────────────────────────
function readSafe(p) {
  try { return existsSync(p) ? readFileSync(p, "utf8") : ""; } catch { return ""; }
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "orchestrator-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "run_handover",
      description:
        "Marks an E-## task as DONE in TASKS.md, appends a LOG entry, and returns a digest " +
        "regeneration prompt. Call this after completing an implementation task.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: {
            type: "string",
            description: "The task ID to mark complete (e.g. 'E-65')",
          },
          summary: {
            type: "string",
            description: "One-line summary of what was implemented",
          },
        },
        required: ["task_id"],
      },
    },
    {
      name: "run_intent_cleanup",
      description:
        "DEPRECATED (E-147): UPDATE.md has been removed from Rein. Intent is now provided via conversation context. " +
        "This tool is a no-op and returns a deprecation notice. Use `/compact` to manage session context instead.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "run_review",
      description:
        "Executes a tier-aware code review. Tier 1: skips. Tier 2: runs blueprint-aligner " +
        "checks. Tier 3: runs deterministic security/test/architecture checks and returns " +
        "which critic agents need to be spawned for LLM-level review.",
      inputSchema: {
        type: "object",
        properties: {
          tier: {
            type: "number",
            description: "Risk tier (1, 2, or 3)",
            enum: [1, 2, 3],
          },
        },
        required: ["tier"],
      },
    },
    {
      name: "run_dispatch",
      description:
        "E-92 (ecc-integrations.md §Components 4): DAG-aware dispatch planner. Reads task " +
        "readiness from the depends_on graph (E-91) and returns the dispatch frontier — OPEN " +
        "tasks whose dependencies are all DONE — plus tasks still blocked (with their unmet " +
        "deps) and a recommended dispatch_mode: 'parallel' when several independent tasks are " +
        "ready, 'sequential' for one, 'idle' for none. Read-only; performs no state writes. " +
        "Optionally filter by owner substring.",
      inputSchema: {
        type: "object",
        properties: {
          owner: {
            type: "string",
            description: "Optional owner substring filter (e.g. 'architect', 'engineer', 'tester')",
          },
        },
      },
    },
  ],
}));

instrument(server, "orchestrator-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const cwd = process.cwd();
  const ai = resolve(cwd, ".ai");

  switch (name) {
    // ── run_handover ──────────────────────────────────────────────────────────
    case "run_handover":
      return runHandover(cwd, args);

    // ── run_review ────────────────────────────────────────────────────────────
    case "run_review": {
      const tier = args.tier;

      if (![1, 2, 3].includes(tier)) {
        return {
          content: [{ type: "text", text: "✗ Invalid tier. Must be 1, 2, or 3." }],
          isError: true,
        };
      }

      const diff = getDiff(cwd);
      const date = today();

      // ── Tier 1: Skip ────────────────────────────────────────────────────
      if (tier === 1) {
        return {
          content: [{
            type: "text",
            text: `## Review — Tier 1 (${date})\n\n` +
              `Verdict: SKIP\n` +
              `CSS/docs/typos only. No critic agents needed.\n` +
              `Commit with: \`git commit -m "[TIER_1] <description>"\``,
          }],
        };
      }

      // ── Shared deterministic checks ──────────────────────────────────────
      const checks = [];

      // Check 1: Hardcoded secrets in diff
      const secretPattern = /^\+[^+].*\b(password|passwd|api.?key|secret|token|private.?key)\s*=\s*["'][^"']{4,}/gim;
      const secretMatches = [...diff.matchAll(secretPattern)].map(m => m[0].trim().slice(0, 60));
      if (secretMatches.length > 0) {
        checks.push({ id: "HARDCODED_SECRET", severity: "P0", status: "FAIL", detail: secretMatches[0] });
      }

      // Check 2: Path traversal — context-aware since E-222 (D-057 §2), and applied
      // only to EXECUTABLE lines since E-224 (D-058 §3).
      //
      // E-222 made the check anchor-aware. E-224 makes it file-aware, because grading
      // prose as code blocked the Architect's own D-057 text: it QUOTES
      // `join(req.path, "../")` as the example of what must stay blocking, and the gate
      // dutifully blocked the document describing the gate.
      //
      // The obvious fix — skip `.md` — is the dangerous one: skill files carry
      // `!`-prefixed lines the harness AUTO-EXECUTES at session start, and one of them
      // resolves a helper cwd-relative (T-LOCATOR-001). Skipping markdown would blind the
      // gate to the only markdown that actually runs. So `src/shared/markdown-exec.mjs`
      // decides per line, and non-markdown files are graded in full as before.
      const strictTraversal = process.env.REIN_REVIEW_STRICT_TRAVERSAL === "1";
      const { classifyDiffTraversal } = await loadPolicy("traversal-policy");
      const { traversal, proseExec } = classifyDiffTraversal(diff, {
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
      if (proseExec.length > 0) {
        checks.push({
          id: "EXECUTABLE_IN_PROSE",
          severity: "P0",
          status: "FAIL",
          detail: `auto-executed '!' line in documentation: ${proseExec.slice(0, 3).join(", ")}`,
        });
      }

      // Check 3: Blueprint alignment — architect-owned files & the blueprint tree (E-169).
      // Exact architect-owned files PLUS everything under .ai/blueprints/ are sovereign:
      // the Engineer must not author them (anti-drift §35). Directory entries are matched
      // as path prefixes so any file beneath .ai/blueprints/ trips the gate.
      const sovereignExact = [".ai/architect.md", ".ai/BRIEF.md"];
      const sovereignDirs = [".ai/blueprints/"];
      const sovereigntyViolations = [
        ...sovereignExact.filter(f => diff.includes(`a/${f}`) || diff.includes(`b/${f}`)),
        ...sovereignDirs.filter(d => diff.includes(`a/${d}`) || diff.includes(`b/${d}`)),
      ];
      if (sovereigntyViolations.length > 0) {
        checks.push({ id: "SOVEREIGNTY_VIOLATION", severity: "P0", status: "FAIL", detail: sovereigntyViolations.join(", ") });
      }

      // Check 4: New deps without DECISIONS.md
      const pkgPattern = /^\+\s+"[a-z@][a-z0-9\-@/.]+"\s*:/gm;
      const newDeps = [...diff.matchAll(pkgPattern)].map(m => m[0].trim());
      if (newDeps.length > 0 && !diff.includes("DECISIONS.md")) {
        checks.push({ id: "UNAPPROVED_DEP", severity: "P1", status: "WARN", detail: newDeps.slice(0, 3).join(", ") });
      }

      // Check 5: LOG.md update check
      const hasSrcChanges = diff.includes("a/src/") || diff.includes("b/src/");
      const hasLogUpdate = diff.includes(".ai/LOG.md");
      if (hasSrcChanges && !hasLogUpdate) {
        checks.push({ id: "NO_LOG_UPDATE", severity: "P1", status: "WARN", detail: "src/ changed but LOG.md not updated" });
      }

      // Check 6: Test file existence for modified src/ files
      const changedSrcFiles = [...diff.matchAll(/^\+\+\+ b\/(src\/[^\n]+)$/gm)].map(m => m[1]);
      const missingTests = [];
      for (const f of changedSrcFiles) {
        if (f.endsWith(".md")) continue; // Skip markdown
        if (f.includes("/agents/") || f.includes("/skills/")) continue; // Skip agent/skill docs
        // Check if a test suite likely covers this
        const testsDir = resolve(cwd, "tests/suites");
        if (existsSync(testsDir)) {
          const base = f.split("/").pop().replace(/\.[^.]+$/, "").replace(/-/g, "_");
          const hasTest = existsSync(resolve(testsDir, `${base}_test.sh`));
          // Also check by parent dir name
          const parentDir = f.split("/").slice(-2, -1)[0];
          const hasParentTest = existsSync(resolve(testsDir, `${parentDir}_test.sh`))
            || existsSync(resolve(testsDir, `${parentDir}_integration_test.sh`));
          if (!hasTest && !hasParentTest) {
            missingTests.push(f);
          }
        }
      }

      const p0Failures = checks.filter(c => c.severity === "P0");
      const hasP0 = p0Failures.length > 0;

      // ── Tier 2: Deterministic checks + aligner ──────────────────────────
      if (tier === 2) {
        const lines = [
          `## Review — Tier 2 (${date})`,
          ``,
          `### Deterministic Checks`,
        ];

        if (checks.length === 0) {
          lines.push("✓ All automated checks passed.");
        } else {
          for (const c of checks) {
            lines.push(`- [${c.id}] ${c.severity} ${c.status}: ${c.detail}`);
          }
        }

        lines.push("");
        lines.push("### Blueprint Alignment");
        lines.push("Run `align_diff()` via blueprint-aligner-mcp to complete Tier 2 review.");
        lines.push("");

        if (hasP0) {
          lines.push(`Verdict: **BLOCKED** — ${p0Failures.length} P0 failure(s) found.`);
        } else {
          lines.push("Verdict: Automated checks passed. Awaiting blueprint-aligner result.");
          // E-329: a CRITIC_STAMP is bound to the HEAD it is written on; REVIEWS.md is a view.
          lines.push("After aligner passes, record both stamps (they bind to the current HEAD — pre-commit Gate 2 needs a CRITIC_STAMP for the commit's parent):");
          lines.push("```");
          lines.push(`add_stamp({ type: "ALIGN_PASS", summary: "[TIER_2] Blueprint aligned" })`);
          lines.push(`add_stamp({ type: "CRITIC_STAMP", summary: "[TIER_2] Blueprint aligned" })`);
          lines.push("```");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── Tier 3: Full analysis + agent dispatch instructions ─────────────
      const lines = [
        `## Review — Tier 3 (${date})`,
        ``,
        `### Phase 1: Deterministic Checks (automated)`,
      ];

      if (checks.length === 0 && missingTests.length === 0) {
        lines.push("✓ All automated security/architecture/dependency checks passed.");
      } else {
        for (const c of checks) {
          lines.push(`- [${c.id}] ${c.severity} ${c.status}: ${c.detail}`);
        }
        if (missingTests.length > 0) {
          lines.push(`- [COVERAGE_GAP] P1 WARN: ${missingTests.length} modified src/ file(s) with no matching test suite: ${missingTests.slice(0, 3).join(", ")}`);
        }
      }

      lines.push("");
      lines.push("### Phase 2: Agent Dispatch (spawn these in parallel)");
      lines.push("");

      if (hasP0) {
        lines.push(`⚠ **${p0Failures.length} P0 failure(s) detected in automated checks.**`);
        lines.push("Fix these BEFORE spawning critic agents.");
        lines.push("");
        for (const f of p0Failures) {
          lines.push(`- **${f.id}**: ${f.detail}`);
        }
      } else {
        lines.push("All automated checks passed. Now spawn the critic team:");
        lines.push("");
        lines.push("```");
        lines.push('Agent("Run the critic_arch agent to audit the codebase and append its stamp to .ai/REVIEWS.md")');
        lines.push('Agent("Run the critic_security agent to audit the codebase and append its stamp to .ai/REVIEWS.md")');
        lines.push('Agent("Run the critic_tests agent to audit the codebase and append its stamp to .ai/REVIEWS.md")');
        lines.push('Agent("Run blueprint-aligner-mcp align_diff(). Append [ALIGN_PASS] or [ALIGN_FAIL] to .ai/REVIEWS.md")');
        lines.push('Agent("Run the security_engineer agent. Append [SEC_CLEARED] to .ai/LOG.md if clear")');
        lines.push("```");
        lines.push("");
        lines.push("### Phase 3: After all agents complete");
        lines.push("Invoke `skill: 'review_synthesizer'` to aggregate stamps and write [CRITIC_STAMP].");
      }

      lines.push("");
      lines.push(`Files in diff: ${changedSrcFiles.length} src/ files, ${[...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].length} total`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // ── run_dispatch (E-92) ─────────────────────────────────────────────────────
    case "run_dispatch": {
      const dbPath = resolve(ai, "state.sqlite");
      if (!existsSync(dbPath)) {
        return { content: [{ type: "text", text: JSON.stringify({
          dispatch_mode: "idle", ready: [], blocked: [],
          counts: { ready: 0, blocked: 0 },
          recommendation: "No state.sqlite found — nothing to dispatch.",
        }, null, 2) }] };
      }

      const ownerFilter = (args && args.owner) ? String(args.owner).toLowerCase() : null;
      const matchOwner  = (t) => !ownerFilter || (t.owner || "").toLowerCase().includes(ownerFilter);
      const slim        = (t) => ({ id: t.id, owner: t.owner, tier: t.tier ?? null, depends_on: t.depends_on || [] });

      // readState (state-db.js) enriches each task with E-91 readiness fields:
      // `ready` (all depends_on are DONE) and `blocked_by` (unmet dep ids).
      const state = readState(getDbSeeded(ai));
      const ready = state.tasks
        .filter(t => t.status === "OPEN" && t.ready && matchOwner(t))
        .map(slim);
      // Anything not DONE and not in the ready frontier is waiting on the DAG.
      const blocked = state.tasks
        .filter(t => t.status !== "DONE" && !(t.status === "OPEN" && t.ready) && matchOwner(t))
        .map(t => ({ ...slim(t), status: t.status, blocked_by: t.blocked_by || [] }));

      const dispatch_mode = ready.length === 0 ? "idle" : ready.length === 1 ? "sequential" : "parallel";
      let recommendation;
      if (dispatch_mode === "idle") {
        recommendation = blocked.length
          ? `No ready tasks — ${blocked.length} task(s) blocked on unmet dependencies. Complete their depends_on first.`
          : "No OPEN tasks ready for dispatch — backlog is empty or fully DONE.";
      } else if (dispatch_mode === "sequential") {
        recommendation = `1 task ready: dispatch ${ready[0].id} (${ready[0].owner}).`;
      } else {
        recommendation = `${ready.length} independent tasks ready — dispatch in PARALLEL: ${ready.map(r => r.id).join(", ")}. All dependencies satisfied.`;
      }

      return { content: [{ type: "text", text: JSON.stringify({
        dispatch_mode, ready, blocked,
        counts: { ready: ready.length, blocked: blocked.length },
        recommendation,
      }, null, 2) }] };
    }

    // ── run_intent_cleanup (DEPRECATED E-147) ─────────────────────────────────
    case "run_intent_cleanup":
      return {
        content: [{
          type: "text",
          text: "⚠ DEPRECATED (E-147): run_intent_cleanup is a no-op. UPDATE.md has been removed from Rein.\n" +
                "Intent is provided via conversation context. Use `/compact` to manage session context instead.",
        }],
      };

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
});

if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
