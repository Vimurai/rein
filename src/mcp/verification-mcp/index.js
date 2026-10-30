#!/usr/bin/env node
/**
 * verification-mcp — Rein §32 Verification Audit (E-108)
 *
 * Programmatic compliance auditing of agent/skill YAML frontmatter.
 * Checks declared `allowed-tools` against registry.json and MCP tool exports.
 * Flags "Ghost Tools" (declared but non-existent) as CRITICAL violations.
 *
 * Tools:
 *   verify_compliance({ agent_name? }) → COMPLIANCE_REPORT per agent
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { instrument } from "../../shared/mcp-telemetry.mjs";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, join } from "path";
import { createLogger } from "../shared/logger.js";

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
const logger = createLogger("verification-mcp");

// Built-in Claude Code tools that are always valid (not in registry)
const BUILTIN_TOOLS = new Set([
  "Read", "Write", "Edit", "Glob", "Grep", "Bash",
  "WebSearch", "WebFetch", "Agent", "TodoRead", "TodoWrite",
  "NotebookEdit", "ExitPlanMode", "EnterPlanMode", "Skill",
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseFrontmatter(text) {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("---", 3);
  if (end === -1) return null;
  const fm = text.slice(3, end);
  const result = {};
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/^([\w-]+):\s*(.+)$/);
    if (inline) { result[inline[1].trim()] = inline[2].trim(); continue; }
    // YAML list-form: `key:` on its own line followed by indented `- item`
    // lines. Without this, a list-form `allowed-tools` dropped to "" and zero
    // tools were audited — a Ghost-Tool bypass. Normalise to the same
    // comma-joined shape the inline form produces.
    const keyOnly = lines[i].match(/^([\w-]+):\s*$/);
    if (keyOnly) {
      const items = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(lines[j].replace(/^\s*-\s+/, "").trim());
        j++;
      }
      if (items.length) { result[keyOnly[1].trim()] = items.join(", "); i = j - 1; }
    }
  }
  return result;
}

function scanAgentFiles(baseDir) {
  const files = [];
  if (!existsSync(baseDir)) return files;
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (entry.endsWith(".md")) files.push(full);
    }
  }
  walk(baseDir);
  return files;
}

function loadRegistry(registryPath) {
  const available = new Map(); // tool → server name
  if (!existsSync(registryPath)) return available;
  try {
    const reg = JSON.parse(readFileSync(registryPath, "utf8"));
    for (const [srv, info] of Object.entries(reg.mcp_servers || {})) {
      const tools = info["allowed-tools"] || [];
      if (tools.includes("*")) {
        available.set(`${srv}:*`, srv);
      } else {
        for (const t of tools) available.set(t, srv);
      }
    }
  } catch { /* ignore */ }
  return available;
}

function isToolAvailable(tool, registry) {
  if (BUILTIN_TOOLS.has(tool)) return true;
  if (tool === "*") return true;
  if (tool.startsWith("mcp__")) return true; // MCP-prefixed tools are registry-resolved
  if (registry.has(tool)) return true;
  return false;
}

// E-295: agents that must carry an explicit `tools` allowlist (reviewers and the Tester) —
// in addition to any agent that declares an `mcpServers:` scope.
const SCOPED_AGENTS = new Set(["critic_arch", "critic_clean_code", "critic_security", "critic_tests", "test_engineer"]);

/** The parent session's MCP servers: the `mcpServers` keys of <project>/.mcp.json. */
function loadParentServers(projectRoot) {
  try {
    const cfg = JSON.parse(readFileSync(join(projectRoot, ".mcp.json"), "utf8"));
    return new Set(Object.keys(cfg.mcpServers || {}));
  } catch {
    return new Set();
  }
}

function auditAgent(mdPath, registry, parentServers = new Set()) {
  let text;
  try { text = readFileSync(mdPath, "utf8"); } catch { return null; }
  const fm = parseFrontmatter(text);
  if (!fm) return null; // no frontmatter — skip

  const agentName = fm["name"] || mdPath.split("/").pop().replace(".md", "");
  const violations = [];
  const warnings   = [];

  // Check required frontmatter fields — skills require all 5; agent personas
  // (any file under an /agents/ directory) need only name + description.
  const isAgentPath = mdPath.includes("/agents/");
  const requiredFields = isAgentPath
    ? ["name", "description"]
    : ["name", "description", "disable-model-invocation", "user-invocable", "allowed-tools"];
  for (const field of requiredFields) {
    if (!fm[field]) warnings.push(`Missing required frontmatter field: '${field}'`);
  }

  // Check the declared tools for Ghost Tools. A SKILL declares `allowed-tools`; a SUBAGENT
  // declares `tools` (E-295, D-084 r3 — subagents have no `allowed-tools` field).
  const split = (v) => String(v || "").split(",").map((t) => t.trim()).filter(Boolean);
  const tools = split(isAgentPath ? fm["tools"] : fm["allowed-tools"]);
  for (const tool of tools) {
    if (!isToolAvailable(tool, registry)) {
      violations.push(`Ghost Tool: '${tool}' declared but not found in registry.json or builtin list`);
    }
  }

  // E-295 (D-084 r3, native-first.md Component 5): the subagent frontmatter Claude Code
  // actually enforces. `allowed-tools` is silently IGNORED on a subagent — 21 agents' limits
  // were never applied — so its presence is a violation, not a warning.
  if (isAgentPath) {
    if (fm["allowed-tools"] !== undefined) {
      violations.push("'allowed-tools' is not a subagent field and is ignored — use 'tools' (the allowlist) and 'disallowedTools' (D-084 r3)");
    }
    const scoped = Boolean(fm["mcpServers"]) || SCOPED_AGENTS.has(agentName);
    if (scoped && tools.length === 0) {
      violations.push("scoped agent has no 'tools' allowlist — without one it inherits every tool (D-084 r3)");
    }
    const own = new Set(split(fm["mcpServers"]));
    for (const t of tools.filter((x) => x.startsWith("mcp__"))) {
      const srv = t.slice(5).split("__")[0].replace(/\*$/, "");
      if (!own.has(srv) && !parentServers.has(srv)) {
        violations.push(`'tools' names mcp server '${srv}', which is neither in this agent's mcpServers nor in the parent's .mcp.json`);
      }
    }
    const neededServers = new Set(tools.filter((x) => x.startsWith("mcp__")).map((t) => t.slice(5).split("__")[0]));
    for (const d of split(fm["disallowedTools"])) {
      if (!d.startsWith("mcp__")) continue;
      const dsrv = d.slice(5).split("__")[0];
      for (const need of neededServers) {
        if (dsrv === "*" || dsrv === need || (dsrv.endsWith("*") && need.startsWith(dsrv.slice(0, -1)))) {
          violations.push(`'disallowedTools' entry '${d}' removes server '${need}', which 'tools' needs (disallowedTools is applied first)`);
        }
      }
    }
  }

  // E-284 (D-075 §Component 5): an agent that declares an `mcpServers:` scope may only
  // name mcp__ tools from those servers — in its tool fields AND in its body, since a body
  // instruction to call a tool the scope does not connect is the same ghost tool as a
  // frontmatter one. NOTE: per the subagent docs `mcpServers` CONNECTS servers; it does not
  // by itself hide the inherited ones (that takes `disallowedTools`) — this check pins
  // what the agent is TOLD to use, which is the drift we have been bitten by.
  if (fm["mcpServers"]) {
    const scope = new Set(fm["mcpServers"].split(",").map((s) => s.trim()).filter(Boolean));
    const named = new Set([
      ...tools.filter((t) => t.startsWith("mcp__")),
      ...(text.match(/mcp__[A-Za-z0-9_-]+?__[A-Za-z0-9_]+/g) || []),
      ...((fm["tools"] || "").split(",").map((t) => t.trim()).filter((t) => t.startsWith("mcp__"))),
    ]);
    for (const t of named) {
      const srv = t.slice(5, t.indexOf("__", 5));
      if (!scope.has(srv)) {
        violations.push(`Scope mismatch: '${t}' is named but server '${srv}' is not in mcpServers [${[...scope].join(", ")}]`);
      }
    }
  }

  const status = violations.length > 0 ? "FAIL" : warnings.length > 0 ? "WARN" : "PASS";
  return { agent_name: agentName, file: mdPath, status, violations, warnings };
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "verification-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "verify_compliance",
      description:
        "§32: Audits agent/skill YAML frontmatter for compliance. Checks allowed-tools against " +
        "registry.json and built-in tool list. Flags Ghost Tools (declared but not authorized) as CRITICAL. " +
        "Returns a COMPLIANCE_REPORT per agent. Pass agent_name to audit a single agent, omit for full scan.",
      inputSchema: {
        type: "object",
        properties: {
          agent_name: {
            type: "string",
            description: "Specific agent/skill name to audit. Omit to scan all agents.",
          },
          paths: {
            type: "array",
            items: { type: "string" },
            description: "Override scan directories. Defaults to src/**/agents/, src/**/skills/, ~/.rein/**/agents/",
          },
        },
      },
    },
  ],
}));

instrument(server, "verification-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== "verify_compliance") {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  const cwd = process.cwd();
  const rein = resolve(process.env.HOME || "~", ".rein");
  const registryPath = join(rein, "config", "registry.json");
  const registry = loadRegistry(registryPath);
  const parentServers = loadParentServers(cwd);

  // Determine scan directories — D-009: validate caller-supplied paths against allowed prefixes
  const allowedPrefixes = [cwd, rein];
  const isAllowedPath = (p) => allowedPrefixes.some(prefix => p === prefix || p.startsWith(prefix + "/"));

  const scanDirs = args.paths
    ? args.paths.map(p => resolve(cwd, p)).filter(p => {
        if (!isAllowedPath(p)) return false; // silently drop out-of-bounds paths
        return true;
      })
    : [
        resolve(cwd, "src", "claude", "agents"),
        resolve(cwd, "src", "claude", "skills"),
        resolve(cwd, "src", "shared", "skills"),
        join(rein, "claude", "agents"),
        join(rein, "claude", "skills"),
        join(rein, "shared", "skills"),
      ];

  // Collect all .md files
  const mdFiles = scanDirs.flatMap(d => scanAgentFiles(d));

  if (mdFiles.length === 0) {
    return { content: [{ type: "text", text: "No agent/skill files found in scan directories." }] };
  }

  // Filter by agent_name if specified
  const targetName = args.agent_name?.toLowerCase();
  const toAudit = targetName
    ? mdFiles.filter(f => f.toLowerCase().includes(targetName))
    : mdFiles;

  if (toAudit.length === 0) {
    return { content: [{ type: "text", text: `No agent/skill files found matching: ${args.agent_name}` }] };
  }

  // Audit each file
  const reports = toAudit.map(f => auditAgent(f, registry, parentServers)).filter(Boolean);

  const critical = reports.filter(r => r.status === "FAIL");
  const warned   = reports.filter(r => r.status === "WARN");
  const passed   = reports.filter(r => r.status === "PASS");

  const lines = [
    `## COMPLIANCE_REPORT — ${new Date().toISOString().split("T")[0]}`,
    `Scanned: ${reports.length} agents/skills | ` +
    `PASS: ${passed.length} | WARN: ${warned.length} | FAIL: ${critical.length}`,
    "",
  ];

  for (const r of reports) {
    if (r.status === "PASS") continue; // only emit issues
    const icon = r.status === "FAIL" ? "✗" : "⚠";
    lines.push(`${icon} [${r.status}] ${r.agent_name}`);
    lines.push(`   File: ${r.file}`);
    for (const v of r.violations) lines.push(`   CRITICAL: ${v}`);
    for (const w of r.warnings)   lines.push(`   WARN: ${w}`);
    lines.push("");
  }

  if (critical.length === 0 && warned.length === 0) {
    lines.push("✓ All agents are compliant — no Ghost Tools or missing frontmatter detected.");
  } else if (critical.length > 0) {
    lines.push("ACTION REQUIRED: Remove or register Ghost Tools before next commit.");
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
});

if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
