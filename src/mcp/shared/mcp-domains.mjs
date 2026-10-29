/**
 * mcp-domains.js — Curated domain → MCP-server mapping.
 *
 * Consumed by scripts/generate_mcp_docs.mjs (E-52), which groups the servers in
 * .ai/blueprints/mcp.md by domain. (The E-40 router that also read it was retired by
 * E-277 / D-075.)
 *
 * Update this map whenever a new server is added to src/config/registry.json.
 * The CI test tests/suites/ai_sync_test.sh fails if mcp.md falls out of
 * sync with the generator output, so any change here must be paired with a
 * regenerated mcp.md commit.
 */

export const DOMAINS = {
  State: {
    description: "State and task management — TASKS.md, state.json, archives, semantic memory.",
    servers: [
      "task-synchronizer-mcp",
      "orchestrator-mcp",
      "archive-manager-mcp",
      "memory",
      "memory-manager-mcp",
    ],
  },
  Code: {
    description: "Code intelligence and editing — filesystem, LSP, atomic patching.",
    servers: ["filesystem", "patch-mcp", "propose-patch-mcp"],
  },
  Safety: {
    description: "Pre-execution safety gates — command analysis, scope checks, risk classification, agent verification.",
    servers: [
      "safe-exec-mcp",
      "context-guardian-mcp",
      "risk-analyzer-mcp",
      "verification-mcp",
    ],
  },
  Intelligence: {
    description: "Blueprint alignment and token budgeting.",
    servers: [
      "blueprint-aligner-mcp",
      "token-budget-mcp",
    ],
  },
  Quality: {
    description: "Visual audit (tests run headless via skill: ai-test, E-255).",
    servers: ["vibe-check-mcp"],
  },
  Interop: {
    description: "A2A bridge to the Architect and HITL approval gate.",
    servers: ["advisor-mcp", "approval-mcp"],
  },
  Caching: {
    description: "Explicit Context Cache for blueprint-heavy prompts.",
    servers: ["cache-manager-mcp"],
  },
};

// E-52: classify a server by domain. Servers not in any DOMAINS list are
// reported under "Routing & Misc" by the doc generator.
export function domainForServer(serverName) {
  for (const [domain, def] of Object.entries(DOMAINS)) {
    if (def.servers.includes(serverName)) return domain;
  }
  return null;
}
