#!/usr/bin/env node
/**
 * orchestrator-mcp — Rein Deterministic Workflow Execution
 * Replaces LLM-interpreted multi-step workflows with programmatic execution.
 *
 * Tools:
 *   run_handover({ task_id })     → marks task DONE, appends LOG, triggers digest prompt
 *   run_review({ tier })          → a pointer to `rein review <tier>` (E-464: the review moved to the CLI)
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { instrument } from "../../shared/mcp-telemetry.mjs";
// E-320: run_handover lives beside this file.
import { runHandover } from "./run-handover.mjs";
import { existsSync } from "fs";
import { resolve } from "path";
import { getDbSeeded, readState } from "../shared/state-db.js";
import { createLogger } from "../shared/logger.js";

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
const logger = createLogger("orchestrator-mcp");

// ── Server ────────────────────────────────────────────────────────────────────

// E-464 (D-169 r8, D-170 r5): the review moved to the CLI. `rein review <tier>` runs the
// deterministic checks (src/shared/review-checks.mjs) and prints the agents to dispatch; the
// DONE gate (completion-gates.mjs) checks their stamps. run_review stays listed as a pointer.
const REVIEW_POINTER = "run_review moved to the CLI (E-464). Run: rein review <tier>  — it runs the deterministic checks " +
  "and prints the agents to dispatch (Tier 1: none; Tier 2: reviewer, then critic_acceptance; Tier 3: those and " +
  "security_engineer). A Tier 2/3 task is refused DONE without [REVIEW_PASS] and [ACCEPT_PASS] (Tier 3: and [SEC_CLEARED]).";
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
        "DEPRECATED (E-464): returns a pointer to `rein review <tier>`, which runs the deterministic " +
        "checks and prints the agents to dispatch for the tier.",
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
    case "run_review":
      return { content: [{ type: "text", text: REVIEW_POINTER }] };

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
