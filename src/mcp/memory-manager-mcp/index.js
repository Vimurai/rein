#!/usr/bin/env node
/**
 * memory-manager-mcp — Rein §31 Cross-Project Memory Palace (E-106)
 *
 * Stores and queries high-level project architectural signatures in a global
 * JSON store at ~/.rein/memory/signatures.json.
 *
 * Security: Signatures must NOT contain secrets, PII, or internal logic.
 *           Only high-level "Lore" and "Patterns" are stored.
 * Error handling: Silent failure — project-local context is always prioritized.
 *
 * Tools:
 *   export_signature({ summary, tags }) → appends/updates project signature
 *   query_signatures({ tags })          → returns matching signatures
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { instrument } from "../../shared/mcp-telemetry.mjs";
import { readFileSync, writeFileSync, existsSync, mkdirSync, openSync, readSync, closeSync } from "fs";
import { resolve, join } from "path";
import { createLogger } from "../shared/logger.js";
import { redact } from "../../shared/publish-scan.mjs";

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
const logger = createLogger("memory-manager-mcp");

const STORE_DIR  = resolve(process.env.HOME || "~", ".rein", "memory");
const STORE_FILE = join(STORE_DIR, "signatures.json");

// ── Helpers ───────────────────────────────────────────────────────────────────

function readHead(filePath, headBytes = 4096) {
  const fd = openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(headBytes);
    const bytesRead = readSync(fd, buf, 0, headBytes, 0);
    return buf.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function readStore() {
  try {
    if (!existsSync(STORE_FILE)) return [];
    const raw = readFileSync(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeStore(sigs) {
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    writeFileSync(STORE_FILE, JSON.stringify(sigs, null, 2) + "\n", "utf8");
    return true;
  } catch {
    return false;
  }
}

function sanitize(str, maxLen = 300) {
  if (typeof str !== "string") return "";
  // Strip anything that looks like a secret (basic heuristic)
  const cleaned = str
    .replace(/\b(password|passwd|api[_-]?key|secret|token|private[_-]?key)\s*[=:]\s*\S+/gi, "[REDACTED]")
    .replace(/\b[A-Za-z0-9+/]{40,}\b/g, "[REDACTED_BLOB]"); // long base64-like strings
  // E-379 (D-130): then the shared redactor (credentials, addresses, home paths, session ids).
  return redact(cleaned, { file: "memory/signatures.json", count: false }).slice(0, maxLen);
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "memory-manager-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "export_signature",
      description:
        "Exports the current project's architectural signature to the global memory store (~/.rein/memory/signatures.json). " +
        "Called automatically by `rein archive`. Signatures contain ONLY high-level lore/patterns — no secrets, PII, or internal logic.",
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "High-level project summary (max 300 chars). No secrets or PII.",
          },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Searchable tags (e.g. ['react', 'api', 'auth-service'])",
          },
          project_name: {
            type: "string",
            description: "Project name override. Defaults to cwd basename.",
          },
        },
        required: ["summary"],
      },
    },
    {
      name: "query_signatures",
      description:
        "Queries the global memory store for project signatures matching the given tags. " +
        "Useful during `rein init` to find similar architectural patterns from past projects.",
      inputSchema: {
        type: "object",
        properties: {
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Tags to match (OR logic — any match returns the signature)",
          },
          limit: {
            type: "number",
            description: "Max results to return (default: 5)",
            default: 5,
          },
        },
        required: ["tags"],
      },
    },
  ],
}));

instrument(server, "memory-manager-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    // ── export_signature ─────────────────────────────────────────────────────
    case "export_signature": {
      const projectName = sanitize(args.project_name || process.cwd().split("/").pop(), 100);
      const summary     = sanitize(args.summary || "", 300);
      const tags        = (args.tags || []).map(t => sanitize(String(t), 50)).filter(Boolean);

      if (!summary) {
        return { content: [{ type: "text", text: "✗ summary is required and must be non-empty" }], isError: true };
      }

      const sig = {
        project_name: projectName,
        tags,
        summary,
        architect_v: "unknown",
        timestamp: new Date().toISOString(),
      };

      // Try to read architect_v from .ai/architect.md
      try {
        const archPath = resolve(process.cwd(), ".ai", "architect.md");
        if (existsSync(archPath)) {
          const firstLine = readHead(archPath).split("\n")[0] || "";
          if (firstLine.startsWith("# ")) sig.architect_v = sanitize(firstLine.slice(2).trim(), 100);
        }
      } catch { /* silent */ }

      const sigs = readStore();
      const deduplicated = sigs.filter(s => s.project_name !== projectName);
      deduplicated.push(sig);

      const ok = writeStore(deduplicated);
      const msg = ok
        ? `✓ Signature exported for '${projectName}' → ${STORE_FILE} (${deduplicated.length} total)`
        : `⚠ Could not write to ${STORE_FILE} — store may be inaccessible (silent failure per §31)`;

      return { content: [{ type: "text", text: msg }] };
    }

    // ── query_signatures ──────────────────────────────────────────────────────
    case "query_signatures": {
      const queryTags = (args.tags || []).map(t => String(t).toLowerCase());
      const limit     = Math.min(args.limit ?? 5, 20);

      if (queryTags.length === 0) {
        return { content: [{ type: "text", text: "✗ At least one tag is required" }], isError: true };
      }

      const sigs = readStore();
      if (sigs.length === 0) {
        return { content: [{ type: "text", text: "Memory store is empty — no signatures found." }] };
      }

      // OR match: return signatures where any tag matches
      const matched = sigs.filter(s => {
        const sigTags = (s.tags || []).map(t => String(t).toLowerCase());
        return queryTags.some(qt => sigTags.some(st => st.includes(qt)));
      });

      const results = matched.slice(0, limit);
      if (results.length === 0) {
        return { content: [{ type: "text", text: `No signatures matched tags: ${queryTags.join(", ")}` }] };
      }

      const lines = [`## Matching Signatures (${results.length}/${sigs.length} total)\n`];
      for (const s of results) {
        lines.push(`### ${s.project_name}`);
        lines.push(`- **Tags**: ${(s.tags || []).join(", ") || "(none)"}`);
        lines.push(`- **Summary**: ${s.summary}`);
        lines.push(`- **Architect**: ${s.architect_v}`);
        lines.push(`- **Exported**: ${s.timestamp?.split("T")[0] ?? "unknown"}`);
        lines.push("");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
});

if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
