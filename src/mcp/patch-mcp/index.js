#!/usr/bin/env node
/**
 * patch-mcp — AI-OS Staleness-Aware File Patching (E-137, §25)
 *
 * Prevents race conditions where a linter or human edits a file while the
 * agent is "thinking." Instead of blindly overwriting, patch_file verifies
 * the expected MD5 before writing — blocking the operation if the file has
 * drifted since the last read_file call.
 *
 * Tools:
 *   patch_file(path, old_content, new_content, expected_md5?, caller_role?)
 *     → Replaces old_content with new_content only if file matches expected_md5.
 *       If expected_md5 is omitted, falls back to old_content exact-match check.
 *       The role is derived server-side (E-219): verified session record, then this
 *       server's launch env, then `architect` when there is no evidence. A supplied
 *       caller_role may only ADD restriction.
 *
 * Security:
 *   - Path must be within cwd (no traversal outside project root).
 *   - expected_md5 acts as an optimistic lock — stale writes are rejected.
 *   - Role-aware RBAC: Architect writes blocked outside .ai/ and plans/ (E-143, §35).
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { instrument } from "../../shared/mcp-telemetry.mjs";
import { readFileSync, writeFileSync, existsSync, statSync } from "fs";
import { resolve, relative } from "path";
import { createHash } from "crypto";
import { createLogger } from "../shared/logger.js";
import { architectScopeGuard as _staticScopeGuard } from "../shared/caller-role.mjs";
import { loadPolicy } from "../shared/load-policy.mjs";

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
const logger = createLogger("patch-mcp");

// ── Helpers ───────────────────────────────────────────────────────────────────

function md5(content) {
  return createHash("md5").update(content).digest("hex");
}

/**
 * Block path traversal — filePath must resolve within cwd.
 * Returns the resolved absolute path, or null if traversal detected.
 */
function safePath(filePath, cwd) {
  const abs = resolve(cwd, filePath);
  const rel = relative(cwd, abs);
  if (rel.startsWith("..")) return null;
  return abs;
}

/**
 * Role-Aware RBAC guard (E-143 §35; role derivation moved SERVER-SIDE in E-219/D-056 R1).
 *
 * The old signature took the caller's own `caller_role` and returned "allow" whenever it
 * was absent — a self-declared guard, and the only barrier left in a session started
 * without the settings overlay. It now delegates to the shared resolver, which derives
 * the role from the HMAC-verified session record, then this server's launch env, and
 * falls back to `architect` (the RESTRICTED role) when there is no evidence.
 * The argument survives as advisory: it may add restriction, never lift it.
 */

// ── E-237 (D-061 §5): per-request policy refresh ─────────────────────────────
// The policy modules are re-read at the TOP of each request rather than awaited at every
// call site. The guards below are small SYNCHRONOUS helpers used from many places in a
// security-critical path; making them async would ripple through the whole file, and a
// security gate is the wrong place for a wide mechanical refactor.
//
// The static import stays as the initial value and as the fail-safe: if a reload ever
// throws, the previous good policy keeps deciding rather than the guard becoming
// undefined. A gate that disappears is far worse than a gate that is one version behind.
let _rolePolicy = { architectScopeGuard: _staticScopeGuard };
async function refreshPolicies() {
  try {
    _rolePolicy = await loadPolicy("caller-role");
  } catch {
    /* keep the last good policy — never leave the guard undefined */
  }
}

function roleGuard(callerRole, absPath, cwd) {
  return _rolePolicy.architectScopeGuard(callerRole, absPath, cwd);
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "patch-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "patch_file",
      description:
        "Atomically replaces `old_content` with `new_content` in the target file. " +
        "If `expected_md5` is provided, the write is blocked if the current file MD5 " +
        "does not match — preventing stale overwrites from race conditions. " +
        "If `expected_md5` is omitted, falls back to exact old_content match. " +
        "Returns the new file MD5 on success so callers can chain patches safely.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative or absolute path to the file to patch.",
          },
          old_content: {
            type: "string",
            description: "Exact string to find and replace in the file.",
          },
          new_content: {
            type: "string",
            description: "Replacement string.",
          },
          expected_md5: {
            type: "string",
            description:
              "MD5 hash of the file content at the time of last read. " +
              "If the current file MD5 differs, the patch is rejected. " +
              "Obtain via the `md5` field returned by a previous patch_file call, " +
              "or compute manually: md5(file_content).",
          },
          caller_role: {
            type: "string",
            enum: ["engineer", "architect"],
            description:
              "Role of the calling agent. If 'architect', writes outside .ai/ and plans/ " +
              "are blocked with [ANTI_DRIFT_VIOLATION]. Advisory only (E-219): the role is derived server-side from the verified session record, then this server's launch environment, defaulting to 'architect' when neither is available. Supplying a role can only ADD restriction — pass 'architect' to sandbox yourself; passing 'engineer' does nothing.",
          },
        },
        required: ["path", "old_content", "new_content"],
      },
    },
    {
      name: "get_file_md5",
      description:
        "Returns the current MD5 hash of a file. Use this before patch_file to " +
        "obtain the expected_md5 for optimistic-lock verification.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative or absolute path to the file.",
          },
        },
        required: ["path"],
      },
    },
  ],
}));

instrument(server, "patch-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  await refreshPolicies();   // E-237: pick up a policy `ai sync` refreshed under us
  const { name, arguments: args } = request.params;
  const cwd = process.cwd();

  switch (name) {
    // ── patch_file ────────────────────────────────────────────────────────────
    case "patch_file": {
      const abs = safePath(args.path, cwd);
      if (!abs) {
        return {
          content: [{ type: "text", text: `✗ Path traversal blocked: '${args.path}' is outside project root.` }],
          isError: true,
        };
      }

      const roleBlock = roleGuard(args.caller_role, abs, cwd);
      if (roleBlock) return roleBlock;

      if (!existsSync(abs)) {
        return {
          content: [{ type: "text", text: `✗ File not found: ${abs}` }],
          isError: true,
        };
      }

      const fileSize = statSync(abs).size;
      if (fileSize > 5 * 1024 * 1024) {
        return {
          content: [{ type: "text", text: `[FILE_TOO_LARGE] File exceeds 5MB limit (${(fileSize / 1024 / 1024).toFixed(1)}MB): ${abs}\nUse a different tool or strategy for large files.` }],
          isError: true,
        };
      }

      let current;
      try {
        current = readFileSync(abs, "utf8");
      } catch (e) {
        return {
          content: [{ type: "text", text: `✗ Could not read file: ${e.message}` }],
          isError: true,
        };
      }

      const currentMd5 = md5(current);

      // ── Staleness check ──
      if (args.expected_md5) {
        if (currentMd5 !== args.expected_md5) {
          // Fuzzy fallback (E-157): if old_content is still present exactly once,
          // the drift happened elsewhere — apply the patch and warn.
          const first  = current.indexOf(args.old_content);
          const second = first !== -1 ? current.indexOf(args.old_content, first + 1) : -1;

          if (first !== -1 && second === -1) {
            // Exactly one occurrence — safe to apply despite MD5 mismatch.
            const patched =
              current.slice(0, first) +
              args.new_content +
              current.slice(first + args.old_content.length);

            try {
              writeFileSync(abs, patched, "utf8");
            } catch (e) {
              return {
                content: [{ type: "text", text: `✗ Write failed: ${e.message}` }],
                isError: true,
              };
            }

            const newMd5 = md5(patched);
            return {
              content: [{
                type: "text",
                text:
                  `[PATCH_APPLIED_WITH_DRIFT] Patch applied despite MD5 mismatch — file drifted elsewhere.\n` +
                  `  path:        ${abs}\n` +
                  `  expected MD5: ${args.expected_md5}\n` +
                  `  actual   MD5: ${currentMd5}\n` +
                  `  new      MD5: ${newMd5}\n\n` +
                  `old_content was found exactly once; replacement applied safely.\n` +
                  `Use new MD5 as expected_md5 for any follow-up patches.`,
              }],
              metadata: { md5: newMd5, path: abs },
            };
          }

          // old_content not found, or found ambiguously — hard reject.
          const reason = first === -1
            ? "old_content not found in file"
            : "old_content found multiple times (ambiguous replacement)";
          return {
            content: [{
              type: "text",
              text:
                `✗ [MD5_MISMATCH] File has changed and patch cannot be applied safely.\n` +
                `  expected MD5: ${args.expected_md5}\n` +
                `  current  MD5: ${currentMd5}\n` +
                `  reason: ${reason}\n` +
                `  path: ${abs}\n\n` +
                `Re-read the file and reconstruct the patch before retrying.`,
            }],
            isError: true,
          };
        }
      } else {
        // Fallback: verify old_content is present exactly
        if (!current.includes(args.old_content)) {
          return {
            content: [{
              type: "text",
              text:
                `✗ PATCH MISMATCH — old_content not found in file.\n` +
                `  path: ${abs}\n\n` +
                `The file may have been modified. Re-read and reconstruct the patch.`,
            }],
            isError: true,
          };
        }
      }

      // ── Apply patch ──
      const occurrence = current.indexOf(args.old_content);
      if (occurrence === -1) {
        return {
          content: [{
            type: "text",
            text: `✗ old_content not found in file — patch cannot be applied.\n  path: ${abs}`,
          }],
          isError: true,
        };
      }

      const patched =
        current.slice(0, occurrence) +
        args.new_content +
        current.slice(occurrence + args.old_content.length);

      try {
        writeFileSync(abs, patched, "utf8");
      } catch (e) {
        return {
          content: [{ type: "text", text: `✗ Write failed: ${e.message}` }],
          isError: true,
        };
      }

      const newMd5 = md5(patched);
      return {
        content: [{
          type: "text",
          text:
            `✓ Patch applied successfully.\n` +
            `  path:    ${abs}\n` +
            `  old MD5: ${currentMd5}\n` +
            `  new MD5: ${newMd5}\n\n` +
            `Use new MD5 as expected_md5 for any follow-up patches.`,
        }],
        metadata: { md5: newMd5, path: abs },
      };
    }

    // ── get_file_md5 ─────────────────────────────────────────────────────────
    case "get_file_md5": {
      const abs = safePath(args.path, cwd);
      if (!abs) {
        return {
          content: [{ type: "text", text: `✗ Path traversal blocked: '${args.path}' is outside project root.` }],
          isError: true,
        };
      }

      if (!existsSync(abs)) {
        return {
          content: [{ type: "text", text: `✗ File not found: ${abs}` }],
          isError: true,
        };
      }

      let content;
      try { content = readFileSync(abs, "utf8"); }
      catch (e) {
        return { content: [{ type: "text", text: `✗ Could not read file: ${e.message}` }], isError: true };
      }

      const hash = md5(content);
      return {
        content: [{ type: "text", text: `MD5: ${hash}\npath: ${abs}` }],
        metadata: { md5: hash, path: abs },
      };
    }

    default:
      return { content: [{ type: "text", text: `✗ Unknown tool: ${name}` }], isError: true };
  }
});

if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
