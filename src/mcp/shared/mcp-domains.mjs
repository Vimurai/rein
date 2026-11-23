/**
 * mcp-domains.js — Curated domain → MCP-server mapping.
 *
 * Consumed by scripts/generate_mcp_docs.mjs (E-52), which groups the servers in
 * .ai/blueprints/mcp.md by domain. (The E-40 router that also read it was retired by
 * E-277 / D-075.)
 *
 * Update this map whenever a new server is added to src/config/registry.json.
 * The CI test tests/suites/rein_sync_test.sh fails if mcp.md falls out of
 * sync with the generator output, so any change here must be paired with a
 * regenerated mcp.md commit.
 */

export const DOMAINS = {
  State: {
    description: "The task ledger — state.sqlite, the generated views, stamps (D-170 r4).",
    servers: ["task-synchronizer-mcp"],
  },
  Safety: {
    description: "The pre-execution command gate (held until E-463).",
    servers: ["safe-exec-mcp"],
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
