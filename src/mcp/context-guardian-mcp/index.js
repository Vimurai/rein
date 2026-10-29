#!/usr/bin/env node
/**
 * context-guardian-mcp — Rein UACS MCP Server
 * Guards ai archive and git commit by detecting unresolved markers in the workspace.
 *
 * Tools:
 *   check_workspace(strict?) → scans TASKS.md + architect.md + src/ for Pending/TODO/FIXME
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { instrument } from "../../shared/mcp-telemetry.mjs";
import { readFileSync, existsSync } from "fs";
import { resolve, relative, extname } from "path";
import { spawnSync } from "child_process";
import { getDbSeeded } from "../shared/state-db.js";
import { createLogger } from "../shared/logger.js";

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
const logger = createLogger("context-guardian-mcp");

const server = new Server(
  { name: "context-guardian-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "check_role_access",
      description:
        "Pre-flight RBAC check (E-143, §35 ANTI-DRIFT). " +
        "Validates whether a given role is allowed to write to the specified path. " +
        "The Architect may only write to .ai/ and plans/. " +
        "Returns ALLOWED or [ANTI_DRIFT_VIOLATION] without performing any write.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative or absolute path the agent intends to write.",
          },
          caller_role: {
            type: "string",
            enum: ["engineer", "architect"],
            description: "Role of the calling agent.",
          },
        },
        required: ["path", "caller_role"],
      },
    },
    {
      name: "check_workspace",
      description: "Scans .ai/TASKS.md, .ai/architect.md, and src/ for unresolved markers (T-O-D-O, F-I-X-M-E, Pending, [ ] tasks). Returns CLEAN or DIRTY status with a list of open items.",
      inputSchema: {
        type: "object",
        properties: {
          strict: {
            type: "boolean",
            description: "If true, also check src/ files for TODO/FIXME comments (default: false)",
            default: false,
          },
        },
      },
    },
  ],
}));

instrument(server, "context-guardian-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === "check_role_access") {
    const cwd = process.cwd();
    const abs = resolve(cwd, args.path);
    const rel = relative(cwd, abs).replace(/\\/g, "/");

    if (rel.startsWith("..")) {
      return {
        content: [{ type: "text", text: `✗ Path traversal blocked: '${args.path}' is outside project root.` }],
        isError: true,
      };
    }

    if (args.caller_role?.toLowerCase() === "architect") {
      const allowed = rel === ".ai" || rel.startsWith(".ai/") ||
                      rel === "plans" || rel.startsWith("plans/");
      if (!allowed) {
        return {
          content: [{
            type: "text",
            text:
              `[ANTI_DRIFT_VIOLATION] BLOCKED — Architect may not write to this path.\n` +
              `  path:    ${abs}\n` +
              `  role:    ${args.caller_role}\n` +
              `  allowed: .ai/, plans/\n\n` +
              `The Architect may only modify .ai/ and plans/.\n` +
              `To modify src/, switch to the Engineer.`,
          }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: `ALLOWED — architect write to '${rel}' is within scope (.ai/ or plans/).` }],
      };
    }

    return {
      content: [{ type: "text", text: `ALLOWED — engineer has unrestricted write access within project root.` }],
    };
  }

  if (name !== "check_workspace") {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }

  const strict = args.strict ?? false;
  const cwd = process.cwd();
  const aiDir = resolve(cwd, ".ai");

  if (!existsSync(aiDir)) {
    return {
      content: [{ type: "text", text: "✗ No .ai/ directory found. Run: ai init" }],
      isError: true,
    };
  }

  const issues = [];

  // ── Check SQLite for open tasks (P-29 — no TASKS.md parsing) ─────────────
  const dbPath = resolve(aiDir, "state.sqlite");
  if (existsSync(dbPath)) {
    try {
      const db = getDbSeeded(aiDir);
      const openTasks = db.prepare(
        "SELECT id, description FROM tasks WHERE status='OPEN' ORDER BY rowid"
      ).all();

      if (openTasks.length > 0) {
        issues.push({
          source: "state.sqlite",
          type: "OPEN_TASKS",
          severity: "DIRTY",
          items: openTasks.slice(0, 10).map(t => `- [ ] ${t.id}: ${t.description?.slice(0, 80)}`),
          message: `${openTasks.length} uncompleted task(s) in state`,
        });
      }
    } catch (e) {
      logger.warn("check_workspace", "SQLite read failed", { error: e.message });
    }
  }

  // ── Check architect.md for T-B-D/T-O-D-O markers ────────────────────────────────
  const archPath = resolve(aiDir, "architect.md");
  if (existsSync(archPath)) {
    const content = readFileSync(archPath, "utf8");
    const rawLines = content.split("\n");

    // Skip lines inside fenced code blocks and inline code to avoid false
    // positives from regex patterns / documentation examples (E-62).
    let inCodeFence = false;
    const tbdLines = [];
    rawLines.forEach((l, i) => {
      if (/^\s*```/.test(l)) { inCodeFence = !inCodeFence; return; }
      if (inCodeFence) return;
      // Strip inline code spans before testing so T-O-D-O inside backticks is ignored
      const stripped = l.replace(/`[^`]*`/g, "``");
      if (/\b(TBD|TODO|FIXME|PLACEHOLDER|MISSING|UNRESOLVED)\b/.test(stripped)) {
        tbdLines.push(`L${i + 1}: ${l.trim()}`);
      }
    });

    if (tbdLines.length > 0) {
      issues.push({
        source: ".ai/architect.md",
        type: "UNRESOLVED_BLUEPRINT",
        severity: "WARN",
        items: tbdLines.slice(0, 5),
        message: `${tbdLines.length} unresolved marker(s) in architect.md`,
      });
    }

    // Check for open architectural questions (outside code fences)
    inCodeFence = false;
    const questionLines = [];
    rawLines.forEach((l) => {
      if (/^\s*```/.test(l)) { inCodeFence = !inCodeFence; return; }
      if (inCodeFence) return;
      if (/\?\s*$/.test(l.trim()) && l.trim().length > 10) questionLines.push(l.trim());
    });

    if (questionLines.length > 0) {
      issues.push({
        source: ".ai/architect.md",
        type: "OPEN_QUESTIONS",
        severity: "WARN",
        items: questionLines.slice(0, 3),
        message: `${questionLines.length} open question(s) in architect.md`,
      });
    }
  }

  // ── Strict mode: scan src/ for TODO/FIXME via git grep (E-155) ──────────────
  if (strict) {
    const srcDir = resolve(cwd, "src");
    if (existsSync(srcDir)) {
      const srcIssues = [];
      const EXTS = new Set([".js", ".ts", ".sh", ".py", ".go"]);
      // git grep avoids loading every source file into Node memory
      const grepResult = spawnSync(
        "git", ["grep", "-n", "-E", "\\b(TODO|FIXME|HACK|XXX)\\b", "--", "src/"],
        { cwd, encoding: "utf8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 }
      );
      if (!grepResult.error && grepResult.stdout) {
        // Iterative regex avoids allocating a full split array on large stdout (P-16)
        const lineRe = /^[^\n]+/gm;
        let lm;
        let lineCount = 0;
        while ((lm = lineRe.exec(grepResult.stdout)) !== null && lineCount < 100) {
          const line = lm[0];
          lineCount++;
          const colon1 = line.indexOf(":");
          const colon2 = line.indexOf(":", colon1 + 1);
          if (colon1 === -1 || colon2 === -1) continue;
          const filePath = line.slice(0, colon1);
          const lineNum  = line.slice(colon1 + 1, colon2);
          const content  = line.slice(colon2 + 1);
          if (!EXTS.has(extname(filePath))) continue;
          if (filePath.includes("context-guardian-mcp/index.js")) continue;
          // Skip regex literal false positives (E-62)
          const isRegexLiteral = /\/[^/]*\b(TODO|FIXME|HACK|XXX)\b[^/]*\//.test(content);
          if (!isRegexLiteral) {
            srcIssues.push(`${filePath}:${lineNum}: ${content.trim().slice(0, 80)}`);
          }
        }
      }
      if (srcIssues.length > 0) {
        issues.push({
          source: "src/**",
          type: "CODE_TODO",
          severity: "WARN",
          items: srcIssues.slice(0, 10),
          message: `${srcIssues.length} TODO/FIXME comment(s) in src/`,
        });
      }
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const hasDirty = issues.some((i) => i.severity === "DIRTY");
  const status = hasDirty ? "DIRTY" : issues.length > 0 ? "WARN" : "CLEAN";
  const date = new Date().toISOString().split("T")[0];

  const lines = [
    `## context-guardian-mcp Report — ${date}`,
    `Status: ${status === "CLEAN" ? "✓ CLEAN" : status === "WARN" ? "⚠ WARN" : "✗ DIRTY"}`,
    ``,
  ];

  if (issues.length === 0) {
    lines.push("Workspace is clean. Safe to archive or commit.");
  } else {
    for (const issue of issues) {
      lines.push(`### ${issue.type} (${issue.severity}) — ${issue.source}`);
      lines.push(issue.message);
      issue.items.forEach((item) => lines.push(`  ${item}`));
      lines.push("");
    }

    if (hasDirty) {
      lines.push("✗ DIRTY workspace — ai archive and git commit are BLOCKED.");
      lines.push("Resolve open tasks before archiving or committing.");
    } else {
      lines.push("⚠ Warnings found — review before proceeding.");
    }
  }

  return { content: [{ type: "text", text: lines.join("\n") }] };
});


if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
