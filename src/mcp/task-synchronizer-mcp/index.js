#!/usr/bin/env node
/**
 * task-synchronizer-mcp — Rein Exclusive State Mutator (E-156: SQLite migration)
 * Uses .ai/state.sqlite as the ACID-safe primary store.
 * Automatically migrates existing .ai/state.json on first use.
 * Regenerates state.json (backwards-compat view), TASKS.md, and REVIEWS.md
 * after every mutation. All state writes — including deltas and task transitions
 * from orchestrator-mcp — go through SQLite (P-26, P-27).
 *
 * Tools:
 *   get_state()                        → returns full state
 *   add_task(owner, description, tier)  → adds task, auto-assigns ID
 *   update_task_status(id, status)      → transitions task status
 *   add_stamp(task_id, type, agent, summary) → writes atomic audit stamp
 *   set_project_focus(text)             → updates project focus
 *   archive_done_tasks()                → moves old DONE tasks to archive
 *   verify_markdown_sync()              → checks TASKS.md / REVIEWS.md vs DB
 *   mark_deltas_read(task_ids?)         → acknowledge implementation deltas
 *   sync_tasks(update_content?)         → (DEPRECATED E-147) no-op
 *   append_tasks(tasks)                 → (legacy) appends to TASKS.md
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { getDbSeeded, readState as _readState, regenerateViews as _regenerateViews, nextId as _nextId, addTask as _addTask, nextTopicSeedId as _nextTopicSeedId, nextClusterPageId as _nextClusterPageId, validateDag as _validateDag, parseDeps as _parseDeps, archiveDoneTasks as _archiveDoneTasks, archiveStamps as _archiveStamps, completeTask as _completeTask, DONE_ARCHIVE_THRESHOLD, DONE_KEEP_RECENT, STAMP_ARCHIVE_THRESHOLD } from "../shared/state-db.js";
// E-325 (D-102): the single writer — record file first in a team project, then the row.
import { updateTask as _updateTask, insertStamp as _insertStamp, setProject as _setProject } from "../shared/record-store.mjs";
// E-326: a team project's pulled records are imported before the views are compared.
import { importRecords as _importRecords } from "../shared/record-import.mjs";
import { checkBehindHead as _checkBehindHead } from "../shared/legacy-import.mjs";
import { claimTask as _claimTask, releaseTask as _releaseTask, publishDone as _publishDone } from "../shared/task-claims.mjs";
import { buildToolSchemas } from "./tool-schemas.mjs";
// E-266 (D-072): read-only view of the local CI run record.
import { getCiStatus } from "../shared/ci-runs.js";
import { completionGates } from "../../shared/completion-gates.mjs";
import { validateNamed, loadSchemas } from "../../shared/schema-validator.js";
// E-153 (telemetry-hardening.md): global telemetry interceptor — instrument() patches
// setRequestHandler so EVERY CallTool invocation records a SUCCESS/ERROR row (closing the
// all-SUCCESS blindness the INSIGHTS report surfaced), not just the rare routed ones.
import { instrument, rejection } from "../../shared/mcp-telemetry.mjs";
// E-249 (D-067 §3): announce running servers whose booted build no longer matches disk.
import { staleServerReport } from "../../shared/build-stamp.mjs";
import { createLogger } from "../shared/logger.js";
// E-74: Managed Agents cloud sync hook. The import is unconditional (cheap —
// no side effects at module load), but every call site goes through
// syncToCloud() which short-circuits to {status:"DISABLED"} when
// AI_MANAGED_AGENTS_ENABLE is unset. Local MCP behaviour is unchanged off.
import { syncToCloud as _syncToCloud } from "../../shared/managed-agents-client.mjs";
// E-88: Multi-Variation-State-Tracker — canonical SEO Topic Cluster intents.
// Used to validate ClusterPage.intent_type and enforce the cluster-page cap
// on add_cluster_page.
import { SEO_ALL_INTENTS, SEO_PILLAR_INTENT, MAX_CLUSTER_PAGES_PER_SEED, isValidIntentType as _isValidIntentType, isClusterIntent as _isClusterIntent } from "../../shared/seo-cluster-intents.mjs";

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
const logger = createLogger("task-synchronizer-mcp");

// ── SQLite Setup (delegated to state-db.js, P-15) ────────────────────────────

// E-270: the first-run state.json → state.sqlite import moved to state-db.js
// (getDbSeeded) so `ai init`'s version stamp seeds a project exactly as this server does.
function _getDb(aiDir) {
  return getDbSeeded(aiDir, {
    warn: (msg, meta) => logger.warn("migrate", msg, meta),
    info: (msg) => logger.info("migrate", msg),
  });
}

// ── State helpers delegated to state-db.js (P-15) ────────────────────────────
// _readState, _regenerateViews, _nextId are imported as _readState/_regenerateViews/_nextId above.

// ── Archive ───────────────────────────────────────────────────────────────────
// E-111: archive rotation for DONE tasks + audit stamps (and its thresholds) now
// lives in src/mcp/shared/state-db.js so task-synchronizer-mcp and
// archive-manager-mcp share ONE implementation. _archiveDoneTasks / _archiveStamps
// and the *_THRESHOLD constants are imported above.

// E-107 (token-optimization.md §Components 1 / §Data Model): cap a DONE task's
// stored summary so state.json stays light. The full narrative lives in LOG.md
// (Engineer-managed). Rollback: set REIN_SUMMARY_CAP=2000.
const SUMMARY_CAP = Number(process.env.REIN_SUMMARY_CAP) || 200;

// E-342 (D-106 r4): the tools that write the index and then regenerate the views.
const VIEW_WRITERS = new Set(["add_task", "update_task_status", "add_stamp", "set_project_focus", "archive_done_tasks", "mark_deltas_read"]);

// ── E-74: Cloud sync hook ────────────────────────────────────────────────────
// Per .ai/blueprints/managed-agents-state-reconciliation.md §Components 2:
// trigger the (debounced, fire-and-forget) Cloud Projection sync whenever a
// task is added or transitions status. The MCP response MUST NOT block on
// network — syncToCloud() returns a structured envelope synchronously and
// schedules the actual fetch under an unref()'d timer.
//
// Wired only into add_task + update_task_status (the two mutation paths
// that change the active-task projection). add_stamp / set_project_focus /
// mark_deltas_read / archive_done_tasks do not change the OPEN+BLOCKED set
// the cloud projects, so skipping them avoids needless network chatter.
function _scheduleCloudSync(targetAiDir) {
  try {
    const dbPath  = resolve(targetAiDir, "state.sqlite");
    const result  = _syncToCloud({ dbPath });
    // Surface unexpected envelopes to ops logs but never re-throw — the
    // MCP must be transparently functional when the cloud is down.
    if (result && result.status && result.status !== "DEBOUNCED" && result.status !== "DISABLED") {
      logger.warn("cloud-sync", "syncToCloud returned non-debounced envelope", {
        status: result.status,
        reason: result.reason,
      });
    }
  } catch (e) {
    logger.warn("cloud-sync", "syncToCloud threw — swallowed", { error: e.message });
  }
}

// ── Error messages ────────────────────────────────────────────────────────────

const STATE_MISSING_ERR = "✗ state.sqlite not found — run: ai init";
const DB_ERR = "✗ state.sqlite could not be opened";

// ── E-63: Framework workspace routing (task-routing.md) ──────────────────────
// When add_task receives is_framework_task: true, redirect persistence to the
// canonical Rein clone (process.env.REIN_WORKSPACE) instead of the local
// project's .ai/. Honours REIN_WORKSPACE_DISABLE=1 as an emergency override
// (rollback-plan.md): forces local persistence when cross-workspace writes
// misbehave. Returns either a string aiDir or an error envelope ready to
// return from the request handler.
function _resolveFrameworkAiDir() {
  if (process.env.REIN_WORKSPACE_DISABLE === "1") {
    return {
      error: "[WORKSPACE_DISABLED] REIN_WORKSPACE_DISABLE=1 — cross-workspace " +
             "writes are temporarily off. Either unset the variable or omit " +
             "is_framework_task and let the task land in the local .ai/.",
    };
  }
  const ws = (process.env.REIN_WORKSPACE || "").trim();
  if (!ws) {
    return {
      error: "[WORKSPACE_NOT_FOUND] is_framework_task=true but REIN_WORKSPACE " +
             "is unset. Re-run install-rein.sh from your Rein clone or " +
             "export REIN_WORKSPACE=/path/to/@vimurai/rein manually.",
    };
  }
  // Defence-in-depth path validation (task-routing.md §Security):
  // - must be absolute (no relative-path traversal at the env layer)
  // - must contain a real .ai/ directory (the only thing we'll write to)
  if (!ws.startsWith("/")) {
    return {
      error: `[WORKSPACE_NOT_FOUND] REIN_WORKSPACE='${ws}' is not absolute. ` +
             `Cross-workspace writes require an absolute path.`,
    };
  }
  const candidate = resolve(ws, ".ai");
  if (!existsSync(candidate)) {
    return {
      error: `[WORKSPACE_NOT_FOUND] REIN_WORKSPACE='${ws}' has no .ai/ directory. ` +
             `Run 'ai init' inside the framework clone before routing framework tasks.`,
    };
  }
  return { aiDir: candidate };
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "task-synchronizer-mcp", version: "2.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: buildToolSchemas({ DONE_KEEP_RECENT, DONE_ARCHIVE_THRESHOLD }),
}));

instrument(server, "task-synchronizer-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const aiDir = resolve(process.cwd(), ".ai");

  if (!existsSync(aiDir)) {
    return { content: [{ type: "text", text: "✗ No .ai/ directory found. Run: ai init" }], isError: true };
  }

  let db;
  try {
    db = _getDb(aiDir);
  } catch (e) {
    return { content: [{ type: "text", text: `${DB_ERR}: ${e.message}` }], isError: true };
  }

  // ── Schema validation helper ─────────────────────────────────────────────
  function _assertSchema(schemaName, payload) {
    const result = validateNamed(schemaName, payload);
    if (!result.valid) {
      return {
        content: [{
          type: "text",
          text: `[SCHEMA_FAIL] '${schemaName}' validation failed:\n` +
                result.errors.map(e => `  • ${e}`).join("\n") +
                "\n\nUse validate_payload to inspect the schema before submitting.",
        }],
        isError: true,
      };
    }
    return null; // valid
  }

  // E-342 (D-106 r4): a legacy index behind HEAD:.ai/state.json must not be mutated and then
  // projected over the committed views — the pulled records would be erased from them. The
  // refusal comes before the write, so nothing in the index changes either.
  if (VIEW_WRITERS.has(name)) {
    const behind = _checkBehindHead(aiDir, db);
    if (behind) return rejection(`✗ ${behind}`);
  }

  switch (name) {
    // ── get_state ─────────────────────────────────────────────────────────────
    case "get_state": {
      if (args.summary) {
        const counts = { OPEN: 0, BLOCKED: 0, DONE: 0 };
        for (const t of db.prepare("SELECT status FROM tasks").all()) {
          counts[t.status] = (counts[t.status] || 0) + 1;
        }
        const proj  = Object.fromEntries(
          db.prepare("SELECT key, value FROM project").all().map(r => [r.key, r.value])
        );
        const stamps = db.prepare(
          "SELECT type, agent, task_id, timestamp, summary FROM stamps ORDER BY id DESC LIMIT 5"
        ).all();
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              version:     "1.0",
              project:     { current_tier: proj.current_tier ? Number(proj.current_tier) : null, focus: proj.focus },
              task_counts: counts,
              total:       Object.values(counts).reduce((a, b) => a + b, 0),
              stamps,
            }, null, 2),
          }],
        };
      }

      if (args.status || args.owner || args.tier) {
        let sql   = "SELECT * FROM tasks WHERE 1=1";
        const params = [];
        if (args.status) { sql += " AND status = ?";              params.push(args.status); }
        if (args.tier)   { sql += " AND tier = ?";                params.push(args.tier); }
        // E-91: readiness is computed against ALL tasks — a dependency may sit
        // outside the filtered subset — so build a global status map first.
        const statusAll = new Map(
          db.prepare("SELECT id, status FROM tasks").all().map(r => [r.id, r.status])
        );
        const tasks = db.prepare(sql + " ORDER BY rowid").all(...params)
          .filter(t => !args.owner || t.owner?.toLowerCase().includes(args.owner.toLowerCase()))
          .map(t => {
            const depends_on = _parseDeps(t.depends_on);
            const blocked_by = depends_on.filter(d => statusAll.get(d) !== "DONE");
            return { ...t, depends_on, ready: blocked_by.length === 0, blocked_by };
          });
        const proj = Object.fromEntries(
          db.prepare("SELECT key, value FROM project").all().map(r => [r.key, r.value])
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ project: proj, tasks, total_matched: tasks.length }, null, 2),
          }],
        };
      }

      // Full state — auto-archive if needed
      const archiveResult = _archiveDoneTasks(aiDir, db);
      const state = _readState(db);
      const note  = archiveResult
        ? `[AUTO-ARCHIVE] ${archiveResult.archived} DONE tasks archived to ${archiveResult.archivePath} — ${archiveResult.kept} recent DONE kept.\n\n`
        : "";
      return { content: [{ type: "text", text: note + JSON.stringify(state, null, 2) }] };
    }

    // ── add_task ──────────────────────────────────────────────────────────────
    case "add_task": {
      const _addTaskErr = _assertSchema("task_create", args);
      if (_addTaskErr) return _addTaskErr;

      // E-63: Resolve persistence target — local .ai/ or framework workspace
      // when is_framework_task is set. Each framework write opens its own DB
      // handle; the local `db` opened above is irrelevant in that branch.
      let targetAiDir = aiDir;
      let targetDb    = db;
      if (args.is_framework_task === true) {
        const fw = _resolveFrameworkAiDir();
        if (fw.error) {
          return { content: [{ type: "text", text: `✗ ${fw.error}` }], isError: true };
        }
        // Refuse to silently mirror a framework write back into the same .ai/
        // the request originated in — that would defeat the routing entirely
        // and we'd rather fail loudly than create the "appears to work" trap.
        if (fw.aiDir === aiDir) {
          // Same workspace — fall through with the existing handle, no-op routing.
          logger.info("add_task", "is_framework_task=true but workspace matches local .ai/", { aiDir });
        } else {
          targetAiDir = fw.aiDir;
          try {
            targetDb = _getDb(targetAiDir);
          } catch (e) {
            return {
              content: [{ type: "text", text: `✗ [WORKSPACE_NOT_FOUND] could not open framework state.sqlite at ${targetAiDir}: ${e.message}` }],
              isError: true,
            };
          }
        }
      }

      // E-198: the create sequence (nextId → DAG validate → OPEN/BLOCKED →
      // INSERT → id high-water → regenerate views) now lives in the shared
      // state-db::addTask so the shell-native `ai add-task` CLI writes through
      // the EXACT same path. Framework-workspace routing is resolved above; we
      // pass the resolved {targetAiDir, targetDb} in.
      const _res = _addTask(targetAiDir, targetDb, {
        owner:       args.owner,
        description: args.description,
        tier:        args.tier,
        prefix:      args.prefix || "E",
        depends_on:  args.depends_on,
      });
      if (!_res.ok) {
        return { content: [{ type: "text", text: `✗ [${_res.code}] ${_res.error}` }], isError: true };
      }
      const task = _res.task;

      // E-74: schedule cloud projection sync. Framework-routed tasks sync
      // the framework workspace's state.sqlite, not the local one — the
      // projection always reflects the workspace the row landed in.
      _scheduleCloudSync(targetAiDir);
      const routeSuffix = targetAiDir === aiDir ? "" : ` (routed to framework workspace ${targetAiDir})`;
      return { content: [{ type: "text", text: `✓ Added ${task.id}: ${args.description}${routeSuffix}\n${JSON.stringify(task, null, 2)}` }] };
    }

    // ── update_task_status ────────────────────────────────────────────────────
    case "update_task_status": {
      const _updateErr = _assertSchema("task_update", args);
      if (_updateErr) return _updateErr;
      const row = db.prepare("SELECT id, status FROM tasks WHERE id = ?").get(args.id);
      if (!row) {
        return { content: [{ type: "text", text: `✗ Task '${args.id}' not found.` }], isError: true };
      }

      // E-101 (sovereignty-hardening.md §Components 2): immutability lock on DONE
      // tasks. A task already in DONE status cannot be re-transitioned unless the
      // caller explicitly passes reopen:true — this prevents accidental mutation
      // of completed implementation history. No environment switch (D-084 r1, D-087 r3): reopen:true
      // is the documented way to mutate a DONE task.
      if (row.status === "DONE" && args.reopen !== true) {
        return {
          content: [{ type: "text", text: `✗ [TASK_LOCKED] '${args.id}' is DONE and cannot be mutated. Pass reopen:true to override (sovereignty-hardening.md §Components 2).` }],
          isError: true,
        };
      }

      // E-249 (D-067 §3): the completion gate. Server and CLI code only reaches a running
      // session through the install mirror, and an MCP server serves whatever it imported
      // at startup — so a task that changed src/mcp/** or src/bin/** is not finished when
      // the edit lands, it is finished when the mirror carries it and the servers have
      // been restarted. The gate refuses DONE until both are true, and reports which of
      // the two is missing. It runs BEFORE the dependency-revision write so a refusal
      // leaves no partial mutation behind. Rollback: REIN_BUILD_STAMP=0.
      // E-320 (D-098 r2): the gate list lives in src/shared/completion-gates.mjs, shared with
      // orchestrator-mcp's run_handover — E-267's CI gate runs there after the build gate.
      if (args.status === "DONE") {
        const refused = completionGates({ cwd: dirname(aiDir), db, id: args.id });
        if (refused) return refused;
      }
      // E-331 (D-102 §4): in a team project IN_PROGRESS means "claimed on origin/<trunk>" (E-341).
      if (args.status === "IN_PROGRESS" && existsSync(resolve(aiDir, "team.json"))) {
        return rejection(`✗ [CLAIM_VIA_TOOL] ${args.id}: in a team project IN_PROGRESS is set by claim_task, which publishes the claim on the trunk (origin/<trunk> — see: ai trunk).`);
      }

      // E-91: optional dependency revision — validate the new edge set
      // (existence/self-reference/cycle/depth) before persisting it.
      if (args.depends_on !== undefined) {
        const deps = [...new Set(Array.isArray(args.depends_on) ? args.depends_on : [])];
        const dag  = _validateDag(db, args.id, deps);
        if (!dag.ok) {
          return { content: [{ type: "text", text: `✗ [${dag.code}] ${dag.error}` }], isError: true };
        }
        _updateTask(aiDir, db, args.id, { depends_on: deps });
      }

      // E-107: cap the stored summary at SUMMARY_CAP chars. The full narrative
      // belongs in LOG.md (Engineer-managed); state keeps a capped reference.
      let storedSummary = args.summary ?? null;
      let summaryTruncated = false;
      if (typeof storedSummary === "string" && storedSummary.length > SUMMARY_CAP) {
        const suffix = " …[full in LOG.md]";
        storedSummary = storedSummary.slice(0, Math.max(0, SUMMARY_CAP - suffix.length)).trimEnd() + suffix;
        summaryTruncated = true;
      }

      // E-91: a DONE transition runs the DAG unblock cascade (BLOCKED tasks whose whole
      // depends_on set is now DONE become OPEN). E-325: shared with `ai task done` in
      // state-db::completeTask. E-259 (D-077): task_velocity is not written here; it comes
      // from the transcript, via hooks/post-tool-use.sh → src/shared/task-usage.mjs.
      let unblocked = [];
      if (args.status === "DONE") {
        unblocked = _completeTask(aiDir, db, args.id, storedSummary);
      } else {
        _updateTask(aiDir, db, args.id, { status: args.status });
      }

      _regenerateViews(aiDir, db);
      // E-74: schedule cloud projection sync after the status transition.
      _scheduleCloudSync(aiDir);
      const unblockNote = unblocked.length ? ` | unblocked: ${unblocked.join(", ")}` : "";
      const truncNote   = summaryTruncated ? ` | [SUMMARY_TRUNCATED] summary capped at ${SUMMARY_CAP} chars — keep the full narrative in LOG.md` : "";
      // E-331: a DONE clears this user's claim on origin/<trunk> (team projects only).
      const pub = args.status === "DONE" ? _publishDone(aiDir, args.id) : null;
      const claimNote = pub ? ` | ${pub.message}` : "";
      return { content: [{ type: "text", text: `✓ ${args.id} → ${args.status}${storedSummary ? ": " + storedSummary : ""}${unblockNote}${truncNote}${claimNote}` }] };
    }

    // ── claim_task / release_task (E-331, D-102 §4) ───────────────────────────
    // The claim lives on origin/<trunk> (task-claims.mjs); nothing in this clone's index changes
    // until the trunk is merged in, so the views are not regenerated here.
    case "claim_task":
    case "release_task": {
      if (typeof args.id !== "string" || !/^[A-Z]+-\d+$/.test(args.id)) {
        return rejection(`✗ ${name}: id must be a task id like E-331`);
      }
      const res = name === "claim_task" ? _claimTask(aiDir, args.id) : _releaseTask(aiDir, args.id, args.reason ?? null);
      if (res.ok) return { content: [{ type: "text", text: res.message }] };
      const text = res.message.startsWith("[") ? `✗ ${res.message}` : `✗ [${res.code}] ${res.message}`;
      return rejection(text);   // a held, lost or offline claim is an answer, not a fault
    }

    // ── add_stamp ─────────────────────────────────────────────────────────────
    case "add_stamp": {
      const _stampErr = _assertSchema("stamp_add", args);
      if (_stampErr) return _stampErr;
      _insertStamp(aiDir, db, {
        type: args.type, agent: args.agent ?? null, task_id: args.task_id ?? null,
        timestamp: new Date().toISOString(), summary: args.summary,
      });

      _regenerateViews(aiDir, db);
      return { content: [{ type: "text", text: `✓ Stamp [${args.type}] added by ${args.agent}` }] };
    }

    // ── set_project_focus ─────────────────────────────────────────────────────
    case "set_project_focus": {
      const _focusErr = _assertSchema("project_update", args);
      if (_focusErr) return _focusErr;
      _setProject(aiDir, db, args.current_tier
        ? { focus: args.focus, current_tier: args.current_tier }
        : { focus: args.focus });

      _regenerateViews(aiDir, db);
      return { content: [{ type: "text", text: `✓ Focus: ${args.focus}${args.current_tier ? " (Tier " + args.current_tier + ")" : ""}` }] };
    }

    // ── archive_done_tasks ────────────────────────────────────────────────────
    case "archive_done_tasks": {
      // E-108: rotate BOTH DONE tasks and audit stamps. They have independent
      // thresholds, so a run may archive one, the other, both, or neither.
      const taskResult  = _archiveDoneTasks(aiDir, db);
      const stampResult = _archiveStamps(aiDir, db);
      const archived_tasks  = taskResult  ? taskResult.archived  : 0;
      const archived_stamps = stampResult ? stampResult.archived : 0;

      if (!taskResult && !stampResult) {
        const doneCount  = db.prepare("SELECT COUNT(*) as n FROM tasks WHERE status = 'DONE'").get().n;
        const stampCount = db.prepare("SELECT COUNT(*) as n FROM stamps").get().n;
        return { content: [{ type: "text", text: `✓ No archive needed — ${doneCount} DONE tasks (threshold ${DONE_ARCHIVE_THRESHOLD}), ${stampCount} stamps (threshold ${STAMP_ARCHIVE_THRESHOLD})` }] };
      }

      const archivePath = (stampResult && stampResult.archivePath) || (taskResult && taskResult.archivePath) || null;
      const lines = ["✓ [AUTO-ARCHIVE]"];
      if (taskResult)  lines.push(`  ${taskResult.archived} DONE tasks → ${taskResult.archivePath} (${taskResult.kept} recent kept)`);
      if (stampResult) lines.push(`  ${stampResult.archived} stamps → ${stampResult.archivePath} (${stampResult.kept} recent kept)`);
      lines.push(`  ${JSON.stringify({ archived_tasks, archived_stamps, archivePath })}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // ── Legacy: sync_tasks (DEPRECATED E-147/E-149) ───────────────────────────
    case "sync_tasks": {
      const updateContent = (args.update_content || "").trim();
      if (!updateContent) {
        return {
          content: [{
            type: "text",
            text: "⚠ DEPRECATED (E-147): sync_tasks no longer reads UPDATE.md.\n" +
                  "Pass intent directly via `update_content`, or use `add_task` to create tasks directly.",
          }],
        };
      }

      const tasksPath    = resolve(aiDir, "TASKS.md");
      const tasksContent = existsSync(tasksPath) ? readFileSync(tasksPath, "utf8") : "";
      const pNums        = [...tasksContent.matchAll(/P-(\d+):/g)].map(m => parseInt(m[1], 10));
      const nextP        = (pNums.length ? Math.max(...pNums) : 0) + 1;

      const lines = updateContent.split("\n")
        .filter(l => l.match(/^[-*]\s+/) || l.match(/^##\s+/))
        .map(l => l.replace(/^[-*]\s+/, "").replace(/^##\s+/, "").trim())
        .filter(l => l.length > 5)
        .slice(0, 5);

      if (lines.length === 0) {
        return { content: [{ type: "text", text: "Could not extract actionable intent from provided content." }] };
      }

      const lower = updateContent.toLowerCase();
      const tier  = /\b(auth|oauth|secret|api.?key|deploy|production|migration|breaking)\b/.test(lower) ? "3"
        : /\b(src|logic|refactor|test|implement|algorithm|database|api)\b/.test(lower) ? "2" : "1";
      const date  = new Date().toISOString().split("T")[0];

      const proposed = lines.map((line, i) => {
        const num = String(nextP + i).padStart(2, "0");
        return `- [ ] P-${num}: Blueprint for "${line}"\n  Tier: ${tier} | Proposed: ${date}`;
      });

      return { content: [{ type: "text", text: `## Proposed P-## Tasks\n\n${proposed.join("\n\n")}\n\nTo apply: use add_task directly:\n  add_task({ prefix: 'P', owner: 'Architect (Claude)', description: '...', tier: N })` }] };
    }

    // ── REMOVED: append_tasks ─────────────────────────────────────────────────
    // This tool wrote directly to TASKS.md, bypassing state.sqlite entirely.
    // TASKS.md is now a generated view — hand-writing to it causes DB/file desync.
    case "append_tasks": {
      return {
        content: [{
          type: "text",
          text: "✗ append_tasks is disabled — it bypasses state.sqlite and causes desync.\n" +
                "Use add_task instead:\n" +
                "  add_task({ prefix: 'P', owner: 'Architect (Claude)', description: '...', tier: 1 })\n" +
                "add_task writes to state.sqlite and regenerates TASKS.md, state.json, and REVIEWS.md atomically.",
        }],
        isError: true,
      };
    }

    // ── get_ci_status (E-266) ─────────────────────────────────────────────────
    case "get_ci_status": {
      const res = getCiStatus(db, dirname(aiDir), args?.sha || null);
      return { content: [{ type: "text", text: JSON.stringify(res, null, 2) }] };
    }

    // ── verify_markdown_sync ──────────────────────────────────────────────────
    case "verify_markdown_sync": {
      // Per blueprint state-sync-validation.md (E-60): cross-reference
      // TASKS.md checkboxes against state.sqlite per task. Catch the case
      // where the engineer ships a feature but forgets to mark the task
      // DONE — the count-only check would miss this when totals match.
      const anomalies = [];
      const autoFixes = [];
      // E-342 (D-106 r4): while the index is behind HEAD every comparison below is against the
      // wrong state, and the auto-fixes would write it over the pulled views. Report, never write.
      // E-344 (D-108 r7): regeneration from an EMPTY index is never an auto-fix either, with or
      // without git to compare against — the views are then all that is left of the tasks.
      let refuse = _checkBehindHead(aiDir, db);
      if (!refuse && db.prepare("SELECT COUNT(*) AS n FROM tasks").get().n === 0 && existsSync(resolve(aiDir, "TASKS.md"))) {
        const listed = (readFileSync(resolve(aiDir, "TASKS.md"), "utf8").match(/^- \[[ xX]\] [A-Z]+-\d+:/gm) || []).length;
        if (listed > 0) refuse = `[EMPTY_STATE_DB] index has 0 tasks, TASKS.md lists ${listed} — run: ai state import`;
      }
      if (refuse) {
        return { content: [{ type: "text", text: [
          "[SYNC_FAIL] TASKS.md and REVIEWS.md vs state.sqlite", "Anomalies (1):", `  • ${refuse}`, "",
          `__SYNC_RESULT__ ${JSON.stringify({ status: "FAIL", anomalies: [refuse], auto_fixes: [], stale_servers: [] })}`,
        ].join("\n") }] };
      }
      // E-326 (D-102): in a team project a task present in a record file but absent from
      // state.sqlite was pulled — it is IMPORTED here, never deleted from the view by the
      // regeneration below. A legacy project returns LEGACY and is untouched.
      const imported = _importRecords(aiDir, db, { force: true });
      if (imported.status === "ERROR") anomalies.push(...imported.lines);
      else if (imported.changed) autoFixes.push(...imported.lines);
      const tasksPath   = resolve(aiDir, "TASKS.md");
      const reviewsPath = resolve(aiDir, "REVIEWS.md");

      if (existsSync(tasksPath)) {
        const tasksContent = readFileSync(tasksPath, "utf8");

        if (!tasksContent.startsWith("# TASKS (Generated from state.json)")) {
          anomalies.push("TASKS.md does not start with generated header — may have been hand-edited");
        }

        // Match: `- [x] E-54: ...` or `- [ ] P-27: ...`
        const lineRe  = /^- \[([ xX])\] ([A-Z]+-\d+):/gm;
        const mdTasks = new Map();   // id → 'DONE' | 'OPEN'
        let m;
        while ((m = lineRe.exec(tasksContent)) !== null) {
          mdTasks.set(m[2], m[1].trim().toLowerCase() === "x" ? "DONE" : "OPEN");
        }

        const dbTasks = new Map(
          db.prepare("SELECT id, status FROM tasks").all().map(t => [t.id, t.status])
        );

        // Drift type 1: in TASKS.md, missing from state
        // Drift type 2: checkbox disagrees with state status
        for (const [id, mdStatus] of mdTasks) {
          if (!dbTasks.has(id)) {
            anomalies.push(`${id} appears in TASKS.md (${mdStatus === "DONE" ? "[x]" : "[ ]"}) but is missing from state`);
            continue;
          }
          const dbStatus = dbTasks.get(id);
          if (mdStatus === "DONE" && dbStatus !== "DONE") {
            anomalies.push(`${id} is [x] in TASKS.md but ${dbStatus} in state`);
          } else if (mdStatus === "OPEN" && dbStatus === "DONE") {
            anomalies.push(`${id} is [ ] in TASKS.md but DONE in state`);
          }
        }

        // Drift type 3: in state, missing from TASKS.md
        for (const id of dbTasks.keys()) {
          if (!mdTasks.has(id)) {
            anomalies.push(`${id} exists in state but is missing from TASKS.md`);
          }
        }
      }

      // REVIEWS.md count-level safety net (auto-fix on stamp drift).
      const stampCount = db.prepare("SELECT COUNT(*) as n FROM stamps").get().n;
      if (existsSync(reviewsPath) && stampCount > 0) {
        const reviewsContent = readFileSync(reviewsPath, "utf8");
        const mdStampCount   = (reviewsContent.match(/^\[[\w_]+\]/gm) || []).length;
        if (mdStampCount < stampCount) {
          autoFixes.push(`REVIEWS.md had ${mdStampCount} stamps but state has ${stampCount} — regenerated`);
          _regenerateViews(aiDir, db);
        }
      }

      // Auto-regenerate TASKS.md when rows are missing from one side or
      // the other (anomalies still surface so the agent knows what was
      // fixed). Checkbox-mismatch anomalies are intentionally NOT
      // auto-fixed — they signal the engineer forgot to call
      // update_task_status, which is human/agent-decision territory.
      const hasMarkdownDrift = anomalies.some(a =>
        /missing from TASKS\.md|missing from state/.test(a)
      );
      if (hasMarkdownDrift) {
        _regenerateViews(aiDir, db);
        autoFixes.push("TASKS.md regenerated from state to resolve missing-row drift");
      }

      const status = anomalies.length === 0 ? "PASS" : "FAIL";
      const lines  = [`[SYNC_${status}] TASKS.md and REVIEWS.md vs state.sqlite`];

      if (anomalies.length > 0) {
        lines.push(`Anomalies (${anomalies.length}):`);
        anomalies.forEach(a => lines.push(`  • ${a}`));
      }
      if (autoFixes.length > 0) {
        lines.push(`Auto-fixes:`);
        autoFixes.forEach(a => lines.push(`  • ${a}`));
      }
      if (anomalies.length === 0 && autoFixes.length === 0) {
        lines[0] = "[SYNC_PASS] TASKS.md and REVIEWS.md are in sync with state.";
      }

      // E-249 (D-067 §3): a running server serving code that is no longer on disk is
      // reported HERE because this is the tool every session calls before trusting
      // TASKS.md — and the pre-E-245 projector that stripped the archive pointer on every
      // write was served by THIS server. Staleness does NOT change the SYNC verdict: the
      // markdown either agrees with state or it does not, and folding an operational
      // notice into that verdict would make [SYNC_FAIL] mean two different things.
      const staleLines = staleServerReport();
      if (staleLines.length > 0) {
        lines.push("");
        staleLines.forEach(l => lines.push(l));
      }

      // Structured tail for programmatic consumers (skills, CI, hooks).
      lines.push("");
      lines.push(`__SYNC_RESULT__ ${JSON.stringify({ status, anomalies, auto_fixes: autoFixes, stale_servers: staleLines })}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // ── validate_payload ──────────────────────────────────────────────────────
    case "validate_payload": {
      const schemaName = String(args.schema_name || "").trim();
      const payload    = args.payload;

      if (!schemaName) {
        return rejection("✗ schema_name is required.");
      }
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        return rejection("✗ payload must be a JSON object.");
      }

      const result = validateNamed(schemaName, payload);
      if (result.valid) {
        return {
          content: [{
            type: "text",
            text: `[SCHEMA_PASS] '${schemaName}' — payload is valid.\n` +
                  `Payload: ${JSON.stringify(payload, null, 2)}`,
          }],
        };
      }
      // E-179: SCHEMA_FAIL is the tool working as designed (it validated and the payload
      // was invalid) — an expected rejection, not a malfunction. isError stays true for the
      // model; telemetry books SUCCESS so validate_payload's ~50% "failure rate" (which was
      // just invalid payloads) no longer pollutes the deprecation aggregate.
      return rejection(
        `[SCHEMA_FAIL] '${schemaName}' — ${result.errors.length} error(s):\n` +
        result.errors.map(e => `  • ${e}`).join("\n")
      );
    }

    // ── mark_deltas_read ──────────────────────────────────────────────────────
    case "mark_deltas_read": {
      const taskIds = Array.isArray(args.task_ids) && args.task_ids.length > 0
        ? args.task_ids.map(id => String(id).trim().toUpperCase())
        : null;

      let marked;
      if (taskIds) {
        const ph = taskIds.map(() => "?").join(",");
        marked = db.prepare(
          `UPDATE deltas SET read = 1 WHERE read = 0 AND task_id IN (${ph})`
        ).run(...taskIds).changes;
      } else {
        marked = db.prepare("UPDATE deltas SET read = 1 WHERE read = 0").run().changes;
      }

      if (marked > 0) _regenerateViews(aiDir, db);

      const scope = taskIds ? taskIds.join(", ") : "all unread";
      return {
        content: [{
          type: "text",
          text: marked > 0
            ? `✓ Acknowledged ${marked} delta(s) for ${scope}.`
            : `⚠ No unread deltas found${taskIds ? ` for ${scope}` : ""}.`,
        }],
      };
    }

    // ── E-88 Multi-Variation-State-Tracker handlers (Topic Cluster Engine) ────
    // All four operate on the local aiDir's state.sqlite only (no framework
    // routing — SEO state is project-scoped). No cloud sync fires from these
    // mutations per E-73 Data-Privacy contract (only tasks cross the boundary).

    case "add_topic_seed": {
      const term = typeof args.term === "string" ? args.term.trim() : "";
      // E-179: all three guards below are EXPECTED input rejections (the caller sent a bad
      // term/volume) — booked SUCCESS for telemetry so add_topic_seed's 85.7% "failure rate"
      // (which was just invalid input) stops masquerading as a broken tool.
      if (term.length === 0 || term.length > 256) {
        return rejection("✗ [INVALID_TOPIC_TERM] term must be 1..256 chars");
      }
      // Reject shell metacharacters (mirrors seo_manager.md Preflight #3).
      if (/[;&|`$()<>\n\r]/.test(term)) {
        return rejection("✗ [INVALID_TOPIC_TERM] term contains shell metacharacters");
      }
      const targetVolume = Number.isFinite(args.target_volume) ? Math.floor(args.target_volume) : MAX_CLUSTER_PAGES_PER_SEED;
      if (targetVolume < 1 || targetVolume > MAX_CLUSTER_PAGES_PER_SEED) {
        return rejection(`✗ [INVALID_TARGET_VOLUME] must be 1..${MAX_CLUSTER_PAGES_PER_SEED}`);
      }
      const id = _nextTopicSeedId(db);
      const createdAt = new Date().toISOString();
      db.prepare(
        "INSERT INTO topic_seeds(id, term, status, target_volume, created_at, completed_at) VALUES (?, ?, ?, ?, ?, NULL)"
      ).run(id, term, "OPEN", targetVolume, createdAt);
      return {
        content: [{
          type: "text",
          text: `✓ Added TopicSeed ${id}: "${term}" (target_volume=${targetVolume})\n` +
                JSON.stringify({ id, term, status: "OPEN", target_volume: targetVolume, created_at: createdAt }, null, 2),
        }],
      };
    }

    case "add_cluster_page": {
      const seedId = String(args.seed_id || "").trim();
      const intent = String(args.intent_type || "").trim();
      // E-179: the validation/guard rejections in this handler are EXPECTED outcomes (bad
      // seed id, unknown intent, missing seed, duplicate intent, cap reached) — the tool
      // working correctly, not failing. Booked SUCCESS for telemetry.
      if (!/^TS-\d+$/.test(seedId)) {
        return rejection("✗ [INVALID_SEED_ID] expected format TS-N");
      }
      if (!_isValidIntentType(intent)) {
        return rejection(`✗ [UNKNOWN_INTENT_TYPE] '${intent}' is not a canonical cluster intent. Valid: ${SEO_ALL_INTENTS.join(", ")}`);
      }
      const seedRow = db.prepare("SELECT id FROM topic_seeds WHERE id = ?").get(seedId);
      if (!seedRow) {
        return rejection(`✗ [SEED_NOT_FOUND] TopicSeed '${seedId}' does not exist. Call add_topic_seed first.`);
      }
      // Cannibalization guard: refuse a duplicate (seed_id, intent_type) —
      // every page in a cluster MUST target a unique, non-overlapping intent.
      const dup = db.prepare(
        "SELECT id FROM cluster_pages WHERE seed_id = ? AND intent_type = ?"
      ).get(seedId, intent);
      if (dup) {
        return rejection(`✗ [INTENT_ALREADY_USED] ${seedId} already has intent '${intent}' (page ${dup.id})`);
      }
      // Defence-in-depth: enforce the lifted cluster-page cap at the storage
      // layer even if upstream (seo_manager E-87) miscounts. The Pillar page
      // does not count against the cap — only deep-dive Cluster pages do.
      if (_isClusterIntent(intent)) {
        const clusterCount = db.prepare(
          `SELECT COUNT(*) as n FROM cluster_pages WHERE seed_id = ? AND intent_type != ?`
        ).get(seedId, SEO_PILLAR_INTENT).n;
        if (clusterCount >= MAX_CLUSTER_PAGES_PER_SEED) {
          return rejection(`✗ [CLUSTER_CAP_REACHED] seed ${seedId} already has ${clusterCount}/${MAX_CLUSTER_PAGES_PER_SEED} cluster pages`);
        }
      }

      const id = _nextClusterPageId(db);
      const createdAt = new Date().toISOString();
      const blob = typeof args.content_blob === "string" ? args.content_blob : null;
      db.prepare(
        "INSERT INTO cluster_pages(id, seed_id, intent_type, content_blob, performance_metrics, published_at, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)"
      ).run(id, seedId, intent, blob, createdAt);

      return {
        content: [{
          type: "text",
          text: `✓ Added ClusterPage ${id} for ${seedId} [${intent}]\n` +
                JSON.stringify({ id, seed_id: seedId, intent_type: intent, created_at: createdAt }, null, 2),
        }],
      };
    }

    case "report_performance": {
      const pid = String(args.page_id || "").trim();
      // E-179: invalid id / invalid metrics / not-found are EXPECTED rejections (caller
      // error), booked SUCCESS for telemetry so report_performance's 60% "failure rate"
      // stops reading as a broken tool.
      if (!/^CP-\d+$/.test(pid)) {
        return rejection("✗ [INVALID_PAGE_ID] expected format CP-N");
      }
      if (!args.metrics || typeof args.metrics !== "object" || Array.isArray(args.metrics)) {
        return rejection("✗ [INVALID_METRICS] metrics must be a JSON object");
      }
      const row = db.prepare(
        "SELECT id, performance_metrics FROM cluster_pages WHERE id = ?"
      ).get(pid);
      if (!row) {
        return rejection(`✗ [PAGE_NOT_FOUND] ${pid}`);
      }
      // Merge-patch semantics: existing JSON + supplied keys; new keys
      // overwrite. Mirrors the JSON merge contract documented in the tool's
      // inputSchema description.
      let existing = {};
      if (row.performance_metrics) {
        try { existing = JSON.parse(row.performance_metrics); } catch { existing = {}; }
      }
      const merged = { ...existing, ...args.metrics };
      db.prepare(
        "UPDATE cluster_pages SET performance_metrics = ? WHERE id = ?"
      ).run(JSON.stringify(merged), pid);
      return {
        content: [{
          type: "text",
          text: `✓ Updated ${pid} performance_metrics\n` + JSON.stringify(merged, null, 2),
        }],
      };
    }

    case "get_topic_cluster": {
      const seedId = String(args.seed_id || "").trim();
      // E-179: bad seed id / not-found are EXPECTED rejections (caller error), booked SUCCESS
      // for telemetry so get_topic_cluster's 50% "failure rate" stops reading as a defect.
      if (!/^TS-\d+$/.test(seedId)) {
        return rejection("✗ [INVALID_SEED_ID] expected format TS-N");
      }
      const seed = db.prepare(
        "SELECT id, term, status, target_volume, created_at, completed_at FROM topic_seeds WHERE id = ?"
      ).get(seedId);
      if (!seed) {
        return rejection(`✗ [SEED_NOT_FOUND] ${seedId}`);
      }
      const pages = db.prepare(
        "SELECT id, intent_type, content_blob, performance_metrics, published_at, created_at FROM cluster_pages WHERE seed_id = ? ORDER BY id"
      ).all(seedId).map((p) => ({
        id:                  p.id,
        intent_type:         p.intent_type,
        content_blob:        p.content_blob,
        performance_metrics: p.performance_metrics ? JSON.parse(p.performance_metrics) : null,
        published_at:        p.published_at,
        created_at:          p.created_at,
      }));
      const clusterPages = pages.filter((p) => p.intent_type !== SEO_PILLAR_INTENT);
      const remaining = Math.max(0, seed.target_volume - clusterPages.length);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            seed,
            pages,
            counts: {
              total:     pages.length,
              pillar:    pages.filter((p) => p.intent_type === SEO_PILLAR_INTENT).length,
              cluster:   clusterPages.length,
              remaining,
              published: pages.filter((p) => p.published_at != null).length,
            },
          }, null, 2),
        }],
      };
    }

    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
});

if (isMainModule(import.meta.url)) {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
