#!/usr/bin/env node
/**
 * token-budget-mcp — AI-OS Token Budget & Cost Governance (E-140, §27)
 *
 * Tracks LLM token spend per task in real-time.
 * Persists usage to ~/.ai-os/usage.sqlite.
 * Warns when output exceeds configurable thresholds.
 *
 * Tools:
 *   report_cost(task_id, tokens, model?, usd?)  → record token usage for a task
 *   get_token_budget()                          → remaining budget + session totals
 *   get_usage_report(days?)                     → full usage breakdown by task/date
 *   set_budget(token_threshold?, usd_threshold?) → configure warning thresholds
 *   reset_session()                             → clear session counters (not DB)
 *
 * Security:
 *   - All DB operations use parameterized queries (no injection vectors).
 *   - execSync forbidden — uses node:sqlite (Node 22+ built-in) synchronous API directly.
 *   - DB path fixed to ~/.ai-os/usage.sqlite (no user-controlled path).
 */

import { isMainModule } from "../shared/is-main.mjs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { instrument } from "../../shared/mcp-telemetry.mjs";
import { mkdirSync, existsSync } from "fs";
import { resolve, join } from "path";
import { homedir } from "os";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "../shared/logger.js";

// ── Structured logger (obs_baseline §Logging) ────────────────────────────────
const logger = createLogger("token-budget-mcp");

// ── SQLite setup ──────────────────────────────────────────────────────────────

const STORE_DIR  = resolve(homedir(), ".ai-os");
const DB_PATH    = join(STORE_DIR, "usage.sqlite");

let db = null;

function getDb() {
  if (db) return db;
  try {
    mkdirSync(STORE_DIR, { recursive: true });
    const conn = new DatabaseSync(DB_PATH);
    conn.exec("PRAGMA journal_mode = WAL;");
    conn.exec(`
      CREATE TABLE IF NOT EXISTS usage (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id   TEXT    NOT NULL,
        model     TEXT    NOT NULL DEFAULT 'unknown',
        tokens    INTEGER NOT NULL DEFAULT 0,
        usd       REAL    NOT NULL DEFAULT 0.0,
        recorded_at TEXT  NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_usage_task  ON usage(task_id);
      CREATE INDEX IF NOT EXISTS idx_usage_date  ON usage(recorded_at);
      CREATE TABLE IF NOT EXISTS budget (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO budget(key, value) VALUES ('token_warn_threshold', '50000');
      INSERT OR IGNORE INTO budget(key, value) VALUES ('usd_warn_threshold',   '1.00');
    `);
    db = conn; // only cache after full schema setup succeeds
    return db;
  } catch (e) {
    logger.warn("getDb", "DB init failed — token tracking unavailable", { code: e.code, error: e.message });
    return null;
  }
}

// Session counters (in-memory, reset on server restart)
let sessionTokens = 0;
let sessionUsd    = 0.0;
let sessionTasks  = new Set();

function getBudgetConfig(db) {
  const rows = db.prepare("SELECT key, value FROM budget").all();
  const cfg = {};
  for (const r of rows) cfg[r.key] = r.value;
  return {
    tokenWarn: parseInt(cfg["token_warn_threshold"] || "50000", 10),
    usdWarn:   parseFloat(cfg["usd_warn_threshold"] || "1.00"),
  };
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "token-budget-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "report_cost",
      description:
        "Record token usage and optional USD cost for a task. " +
        "Call after each LLM invocation to maintain accurate budget tracking. " +
        "Emits a warning if cumulative session tokens exceed the configured threshold.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "E-## or P-## task ID (e.g. 'E-140')." },
          tokens:  { type: "number", description: "Number of tokens consumed." },
          model:   { type: "string", description: "Model name (e.g. 'claude-sonnet-4-6'). Defaults to 'unknown'." },
          usd:     { type: "number", description: "Cost in USD. Defaults to 0 if not known." },
        },
        required: ["task_id", "tokens"],
      },
    },
    {
      name: "get_token_budget",
      description:
        "Returns the current session token usage, remaining budget until warning threshold, " +
        "and all-time totals from the SQLite store. Use at session start for budget awareness.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "get_usage_report",
      description:
        "Returns a detailed usage breakdown grouped by task and date. " +
        "Default: last 7 days. Use for sprint cost reviews or budget audits.",
      inputSchema: {
        type: "object",
        properties: {
          days: { type: "number", description: "Number of days to look back. Default: 7." },
          task_id: { type: "string", description: "Filter by task ID (optional)." },
        },
      },
    },
    {
      name: "set_budget",
      description:
        "Configure token and USD warning thresholds. " +
        "Once session tokens exceed token_threshold, report_cost emits a [BUDGET_WARN].",
      inputSchema: {
        type: "object",
        properties: {
          token_threshold: { type: "number", description: "Token count that triggers a warning. Default: 50000." },
          usd_threshold:   { type: "number", description: "USD amount that triggers a warning. Default: 1.00." },
        },
      },
    },
    {
      name: "reset_session",
      description:
        "Resets in-memory session counters to zero. Does NOT delete SQLite records. " +
        "Call at the start of a new work session to get fresh budget headroom.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

instrument(server, "token-budget-mcp", CallToolRequestSchema);
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    // ── report_cost ──────────────────────────────────────────────────────────
    case "report_cost": {
      const taskId = String(args.task_id || "unknown").slice(0, 32);
      const tokens = Math.max(0, Math.round(Number(args.tokens) || 0));
      const model  = String(args.model || "unknown").slice(0, 64);
      const usd    = Math.max(0, Number(args.usd) || 0);

      sessionTokens += tokens;
      sessionUsd    += usd;
      sessionTasks.add(taskId);

      const d = getDb();
      let dbOk = false;
      if (d) {
        try {
          d.prepare(
            "INSERT INTO usage(task_id, model, tokens, usd) VALUES (?, ?, ?, ?)"
          ).run(taskId, model, tokens, usd);
          dbOk = true;
        } catch { /* silent */ }
      }

      const lines = [
        `✓ Cost recorded — ${taskId}: ${tokens.toLocaleString()} tokens${usd > 0 ? ` / $${usd.toFixed(4)}` : ""}`,
        `  Session total: ${sessionTokens.toLocaleString()} tokens / $${sessionUsd.toFixed(4)}`,
        dbOk ? `  Persisted to ${DB_PATH}` : `  ⚠ SQLite unavailable — in-memory only (requires Node.js 22+ with node:sqlite)`,
      ];

      // Budget warning
      if (d) {
        const { tokenWarn, usdWarn } = getBudgetConfig(d);
        if (sessionTokens >= tokenWarn) {
          lines.push(`\n[BUDGET_WARN] Session tokens (${sessionTokens.toLocaleString()}) exceeded threshold (${tokenWarn.toLocaleString()}). Consider archiving context.`);
        }
        if (usd > 0 && sessionUsd >= usdWarn) {
          lines.push(`[BUDGET_WARN] Session cost ($${sessionUsd.toFixed(4)}) exceeded USD threshold ($${usdWarn.toFixed(2)}).`);
        }
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // ── get_token_budget ─────────────────────────────────────────────────────
    case "get_token_budget": {
      const d = getDb();
      const lines = [
        "## Token Budget Status",
        "",
        `**Session (since last reset)**`,
        `  Tokens used:  ${sessionTokens.toLocaleString()}`,
        `  USD spent:    $${sessionUsd.toFixed(4)}`,
        `  Tasks active: ${[...sessionTasks].join(", ") || "(none)"}`,
      ];

      if (d) {
        const { tokenWarn, usdWarn } = getBudgetConfig(d);
        const remaining = Math.max(0, tokenWarn - sessionTokens);
        lines.push(`  Tokens remaining until warn: ${remaining.toLocaleString()} / ${tokenWarn.toLocaleString()}`);
        lines.push(`  USD remaining until warn: $${Math.max(0, usdWarn - sessionUsd).toFixed(4)} / $${usdWarn.toFixed(2)}`);
        lines.push("");

        try {
          const allTime = d.prepare(
            "SELECT SUM(tokens) as t, SUM(usd) as u, COUNT(DISTINCT task_id) as tasks FROM usage"
          ).get();
          lines.push("**All-time (SQLite)**");
          lines.push(`  Total tokens: ${(allTime.t || 0).toLocaleString()}`);
          lines.push(`  Total USD:    $${(allTime.u || 0).toFixed(4)}`);
          lines.push(`  Unique tasks: ${allTime.tasks || 0}`);
          lines.push(`  DB: ${DB_PATH}`);
        } catch { /* ignore */ }
      } else {
        lines.push("  ⚠ SQLite unavailable — requires Node.js 22+ with node:sqlite for persistent tracking.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    // ── get_usage_report ─────────────────────────────────────────────────────
    case "get_usage_report": {
      const d = getDb();
      if (!d) {
        return {
          content: [{ type: "text", text: "⚠ SQLite unavailable. Requires Node.js 22+ with node:sqlite to enable usage reports." }],
        };
      }

      const days   = Math.min(90, Math.max(1, Number(args.days) || 7));
      const taskId = args.task_id ? String(args.task_id).slice(0, 32) : null;

      try {
        let rows;
        if (taskId) {
          rows = d.prepare(
            "SELECT task_id, model, SUM(tokens) as tokens, SUM(usd) as usd, COUNT(*) as calls, " +
            "MIN(recorded_at) as first, MAX(recorded_at) as last " +
            "FROM usage WHERE task_id = ? AND recorded_at >= datetime('now', ? || ' days') " +
            "GROUP BY task_id, model ORDER BY tokens DESC"
          ).all(taskId, `-${days}`);
        } else {
          rows = d.prepare(
            "SELECT task_id, model, SUM(tokens) as tokens, SUM(usd) as usd, COUNT(*) as calls, " +
            "MIN(recorded_at) as first, MAX(recorded_at) as last " +
            "FROM usage WHERE recorded_at >= datetime('now', ? || ' days') " +
            "GROUP BY task_id, model ORDER BY tokens DESC LIMIT 50"
          ).all(`-${days}`);
        }

        if (rows.length === 0) {
          return { content: [{ type: "text", text: `No usage data in the last ${days} days.` }] };
        }

        const lines = [`## Usage Report (last ${days} days)`, ""];
        let totalTokens = 0, totalUsd = 0;
        for (const r of rows) {
          lines.push(`**${r.task_id}** [${r.model}]`);
          lines.push(`  Tokens: ${r.tokens.toLocaleString()} | USD: $${(r.usd || 0).toFixed(4)} | Calls: ${r.calls}`);
          lines.push(`  Period: ${r.first?.slice(0, 10)} → ${r.last?.slice(0, 10)}`);
          totalTokens += r.tokens;
          totalUsd    += (r.usd || 0);
        }
        lines.push("");
        lines.push(`**Total**: ${totalTokens.toLocaleString()} tokens / $${totalUsd.toFixed(4)}`);
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        return { content: [{ type: "text", text: `✗ Query failed: ${e.message}` }], isError: true };
      }
    }

    // ── set_budget ───────────────────────────────────────────────────────────
    case "set_budget": {
      const d = getDb();
      if (!d) {
        return { content: [{ type: "text", text: "⚠ SQLite unavailable. Cannot persist budget settings." }] };
      }

      const results = [];
      if (args.token_threshold != null) {
        const t = Math.max(1000, Math.round(Number(args.token_threshold)));
        d.prepare("INSERT OR REPLACE INTO budget(key, value) VALUES ('token_warn_threshold', ?)").run(String(t));
        results.push(`✓ Token warning threshold set to ${t.toLocaleString()}`);
      }
      if (args.usd_threshold != null) {
        const u = Math.max(0.01, Number(args.usd_threshold));
        d.prepare("INSERT OR REPLACE INTO budget(key, value) VALUES ('usd_warn_threshold', ?)").run(String(u));
        results.push(`✓ USD warning threshold set to $${u.toFixed(2)}`);
      }
      if (results.length === 0) {
        results.push("⚠ No thresholds provided. Pass token_threshold and/or usd_threshold.");
      }
      return { content: [{ type: "text", text: results.join("\n") }] };
    }

    // ── reset_session ────────────────────────────────────────────────────────
    case "reset_session": {
      const prev = { tokens: sessionTokens, usd: sessionUsd, tasks: sessionTasks.size };
      sessionTokens = 0;
      sessionUsd    = 0.0;
      sessionTasks  = new Set();
      return {
        content: [{
          type: "text",
          text:
            `✓ Session counters reset.\n` +
            `  Previous session: ${prev.tokens.toLocaleString()} tokens / $${prev.usd.toFixed(4)} / ${prev.tasks} tasks\n` +
            `  SQLite history preserved.`,
        }],
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
