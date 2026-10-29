#!/usr/bin/env node
/**
 * archive-manager-mcp — Rein Auto-Pilot MCP Server
 * Monitors .ai/ context health and orchestrates autonomous archive operations.
 *
 * Tools:
 *   check_context_health()   → line + token health report; needs_archive: boolean
 *   execute_archive()        → SQLite-aware state rotation (DONE tasks + stamps);
 *                              points to `skill: ai-archive` for log-file rotation
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { instrument } from "../../shared/mcp-telemetry.mjs";
import { createReadStream, readFileSync, existsSync } from "fs";
import { createInterface } from "readline";
import { resolve } from "path";
import { createLogger } from "../shared/logger.js";
// E-111: archive rotation is owned by the shared state-db layer (single source,
// SQLite-aware, ACID view regeneration) — no more state.json view writes here.
import { getDbSeeded, archiveDoneTasks, archiveStamps, DONE_ARCHIVE_THRESHOLD, STAMP_ARCHIVE_THRESHOLD } from "../shared/state-db.js";

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
const logger = createLogger("archive-manager-mcp");

// Stream-based line/word counter — avoids loading full file into memory (E-153)
function countFileStats(fpath) {
  return new Promise((res, rej) => {
    let lines = 0;
    let words = 0;
    const rl = createInterface({ input: createReadStream(fpath, { encoding: "utf8" }), crlfDelay: Infinity });
    rl.on("line", (line) => { lines++; words += line.split(/\s+/).filter(Boolean).length; });
    rl.on("close", () => res({ lines, words }));
    rl.on("error", rej);
  });
}

// E-111: the previous archiveStateDoneTasks() wrote .ai/state.json directly — a
// regenerated view of state.sqlite — so its prune was clobbered on the next
// regenerateViews and SQLite was never trimmed. Removed. State rotation now goes
// through the SQLite-aware shared archiveDoneTasks()/archiveStamps() in
// execute_archive (ACID, single source).

// ── Thresholds (P-27 blueprint §23) ──────────────────────────────────────────
const AUTO_ARCHIVE_LINES  = 200;
const AUTO_ARCHIVE_TOKENS = 10000;

// Files that accumulate over time and should be health-checked
const MONITORED_FILES = ["LOG.md", "COMM.md", "REVIEWS.md", "SESSION.md"];

const server = new Server(
  { name: "archive-manager-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "check_context_health",
      description:
        "Calculates line counts and estimates token usage for .ai/ log files. " +
        "Returns a JSON health report including needs_archive: boolean. " +
        "Use this before calling execute_archive to decide if archiving is warranted.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "execute_archive",
      description:
        "Rotates SQLite state out of the hot path: archives old DONE tasks and audit " +
        "stamps to .ai/archive/*.json (ACID-safe, via the shared state-db owner) and " +
        "returns { archived_tasks, archived_stamps }. For destructive log-file rotation " +
        "(LOG.md/COMM.md/SESSION.md) run `skill: ai-archive`. " +
        "Call after check_context_health returns needs_archive: true.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

instrument(server, "archive-manager-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;

  // ── check_context_health ──────────────────────────────────────────────────
  if (name === "check_context_health") {
    const cwd = process.cwd();
    const aiDir = resolve(cwd, ".ai");

    if (!existsSync(aiDir)) {
      return {
        content: [{ type: "text", text: JSON.stringify({ error: "No .ai/ directory found. Run: rein init", needs_archive: false }) }],
        isError: true,
      };
    }

    const files = [];
    let totalLines  = 0;
    let totalTokens = 0;

    for (const fname of MONITORED_FILES) {
      const fpath = resolve(aiDir, fname);
      if (!existsSync(fpath)) continue;

      let stats;
      try { stats = await countFileStats(fpath); } catch { continue; }

      const lineCount = stats.lines;
      // Token estimate: word count × 1.3 (empirical for markdown prose)
      const tokenEstimate = Math.round(stats.words * 1.3);

      files.push({ file: fname, lines: lineCount, tokens: tokenEstimate });
      totalLines  += lineCount;
      totalTokens += tokenEstimate;
    }

    // Check state.json DONE task count
    const statePath = resolve(aiDir, "state.json");
    let doneTaskCount = 0;
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        doneTaskCount = (state.tasks || []).filter(t => t.status === "DONE").length;
      } catch {}
    }
    const stateNeedsArchive = doneTaskCount > DONE_ARCHIVE_THRESHOLD;
    const needsArchive = totalLines >= AUTO_ARCHIVE_LINES || totalTokens >= AUTO_ARCHIVE_TOKENS || stateNeedsArchive;

    const report = {
      needs_archive:    needsArchive,
      state_done_tasks: doneTaskCount,
      state_done_threshold: DONE_ARCHIVE_THRESHOLD,
      total_lines:      totalLines,
      total_tokens:     totalTokens,
      thresholds:       { lines: AUTO_ARCHIVE_LINES, tokens: AUTO_ARCHIVE_TOKENS },
      files,
      recommendation:   needsArchive
        ? `Context health critical: ${totalLines} lines / ~${totalTokens} tokens exceeds thresholds. Run execute_archive.`
        : `Context health OK: ${totalLines} lines / ~${totalTokens} tokens within thresholds.`,
    };

    return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
  }

  // ── execute_archive ───────────────────────────────────────────────────────
  if (name === "execute_archive") {
    const cwd = process.cwd();
    const aiDir = resolve(cwd, ".ai");

    if (!existsSync(aiDir)) {
      return { content: [{ type: "text", text: "✗ No .ai/ directory found. Run: rein init" }], isError: true };
    }

    // E-111: rotate SQLite state (DONE tasks + audit stamps) through the shared,
    // ACID-safe owner. Previously this shelled the removed `rein archive` verb
    // (always exit 1) and wrote the regenerated state.json view (clobbered).
    let taskResult = null;
    let stampResult = null;
    let dbError = null;
    try {
      const db = getDbSeeded(aiDir);
      taskResult  = archiveDoneTasks(aiDir, db);
      stampResult = archiveStamps(aiDir, db);
    } catch (e) {
      dbError = e.message;
    }
    if (dbError) {
      return { content: [{ type: "text", text: `✗ execute_archive failed: ${dbError}` }], isError: true };
    }

    const archived_tasks  = taskResult  ? taskResult.archived  : 0;
    const archived_stamps = stampResult ? stampResult.archived : 0;

    const lines = ["✓ [STATE-ARCHIVE]"];
    if (taskResult)  lines.push(`  ${taskResult.archived} DONE tasks → ${taskResult.archivePath} (${taskResult.kept} recent kept)`);
    if (stampResult) lines.push(`  ${stampResult.archived} stamps → ${stampResult.archivePath} (${stampResult.kept} recent kept)`);
    if (!taskResult && !stampResult) {
      lines.push(`  No state rotation needed (DONE-task threshold ${DONE_ARCHIVE_THRESHOLD}, stamp threshold ${STAMP_ARCHIVE_THRESHOLD}).`);
    }
    lines.push(`  ${JSON.stringify({ archived_tasks, archived_stamps })}`);
    // Log-file rotation (LOG.md/COMM.md/SESSION.md → .ai/archive/) is a
    // destructive, HITL-gated operation owned by the ai-archive skill — a bash
    // MCP cannot invoke a skill, so we point the operator to it rather than
    // shelling the removed `rein archive` verb.
    lines.push("  For log-file rotation (LOG.md/COMM.md/SESSION.md) run: skill: ai-archive");

    return { content: [{ type: "text", text: lines.join("\n") }] };
  }

  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
});

if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
