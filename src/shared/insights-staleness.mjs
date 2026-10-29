#!/usr/bin/env node
// E-86: insights-staleness.mjs — JIT staleness probe for ~/.rein/INSIGHTS.md.
//
// Wired into ai-preflight Step 7. Decides whether the cross-project
// meta-cognition report (E-85) is stale relative to the telemetry that has
// accumulated since the last regeneration. Designed to run in <50ms — single
// stat + one COUNT() query — so the preflight budget stays intact.
//
// Usage:
//   node insights-staleness.mjs            # prints JSON envelope
//   node insights-staleness.mjs --quiet    # exit code only
//
// Output envelope (JSON):
//   { status: "FRESH" | "STALE" | "EMPTY" | "DISABLED" | "UNAVAILABLE",
//     insights_path, telemetry_path,
//     new_rows_since_insights, total_rows,
//     insights_mtime, threshold,
//     reason? }
//
// Status semantics:
//   - FRESH:        INSIGHTS.md exists AND telemetry-since-mtime < threshold.
//   - STALE:        INSIGHTS.md missing/older AND ≥ threshold new rows.
//   - EMPTY:        telemetry DB absent or holds zero rows — nothing to do.
//   - DISABLED:     AI_TELEMETRY_DISABLE=1 OR AI_INSIGHTS_STALENESS_DISABLE=1.
//   - UNAVAILABLE:  telemetry helper missing or read error — fail-open.
//
// Exit codes:
//   0 = stamped (any status, including STALE — the caller decides whether to
//       surface the report; the helper itself NEVER fails the preflight).
//
// Rollback:
//   AI_INSIGHTS_STALENESS_DISABLE=1 short-circuits the probe — useful when
//   spurious STALE warnings disrupt a session and the user wants quiet.

import { existsSync, statSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { TELEMETRY_DB_PATH } from "./telemetry.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_INSIGHTS_PATH  = resolve(homedir(), ".rein", "INSIGHTS.md");
// E-257: the ACTIVE store — AI_TELEMETRY_DB_PATH when a test run redirected it.
export const DEFAULT_TELEMETRY_PATH = TELEMETRY_DB_PATH;
export const DEFAULT_THRESHOLD = 200;

function _isDisabled() {
  return process.env.AI_TELEMETRY_DISABLE === "1" ||
         process.env.AI_INSIGHTS_STALENESS_DISABLE === "1";
}

// Locator chain mirrors E-58 / E-65 / E-75 / E-83: in-repo dev tree first,
// then the installed copy. Returns the resolved path or null.
function _resolveTelemetryHelper() {
  const candidates = [
    resolve(SCRIPT_DIR, "telemetry.mjs"),
    resolve(homedir(), ".rein", "shared", "telemetry.mjs"),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export async function checkInsightsStaleness(opts = {}) {
  const insightsPath  = opts.insights_path  || DEFAULT_INSIGHTS_PATH;
  const telemetryPath = opts.telemetry_path || DEFAULT_TELEMETRY_PATH;
  const threshold     = Number.isInteger(opts.threshold) && opts.threshold > 0
    ? opts.threshold
    : DEFAULT_THRESHOLD;

  const baseEnv = {
    insights_path: insightsPath,
    telemetry_path: telemetryPath,
    threshold,
    new_rows_since_insights: 0,
    total_rows: 0,
    insights_mtime: null,
  };

  if (_isDisabled()) {
    return { ...baseEnv, status: "DISABLED", reason: "AI_TELEMETRY_DISABLE or AI_INSIGHTS_STALENESS_DISABLE set" };
  }

  if (!existsSync(telemetryPath)) {
    return { ...baseEnv, status: "EMPTY", reason: "telemetry.sqlite absent" };
  }

  const helperPath = _resolveTelemetryHelper();
  if (!helperPath) {
    return { ...baseEnv, status: "UNAVAILABLE", reason: "telemetry.mjs helper not found in locator chain" };
  }

  let helper;
  try {
    helper = await import(helperPath);
  } catch (e) {
    return { ...baseEnv, status: "UNAVAILABLE", reason: `helper import failed: ${e.message}` };
  }

  // Cap insights_mtime to telemetry totals via getTelemetryStats(). The
  // helper opens read-only paths and never writes during this probe.
  let totalStats;
  try {
    totalStats = helper.getTelemetryStats({ db_path: telemetryPath });
  } catch (e) {
    return { ...baseEnv, status: "UNAVAILABLE", reason: `stats read failed: ${e.message}` };
  }
  // E-261 (D-070 §5): count tool_executions ONLY. The probe summed both tables and reported
  // 132,436 rows against a tool_executions of 128,677 — the row counts people read in the
  // STALE banner, and compare against the store, are tool rows; task_velocity is a separate
  // per-task metric (one row per DONE) and never meant "new traffic since INSIGHTS.md".
  const totalRows = totalStats?.tool_executions?.count ?? 0;
  if (totalRows === 0) {
    return { ...baseEnv, status: "EMPTY", total_rows: 0, reason: "telemetry DB present but empty" };
  }

  // No INSIGHTS.md yet — STALE iff totals already crossed the threshold.
  if (!existsSync(insightsPath)) {
    if (totalRows >= threshold) {
      return {
        ...baseEnv,
        status: "STALE",
        total_rows: totalRows,
        new_rows_since_insights: totalRows,
        reason: `INSIGHTS.md missing and ${totalRows} rows accumulated (>= ${threshold})`,
      };
    }
    return {
      ...baseEnv,
      status: "FRESH",
      total_rows: totalRows,
      new_rows_since_insights: totalRows,
      reason: `INSIGHTS.md missing but only ${totalRows} rows total (< ${threshold})`,
    };
  }

  // INSIGHTS.md exists — count rows newer than its mtime.
  let mtimeIso;
  try {
    mtimeIso = statSync(insightsPath).mtime.toISOString();
  } catch (e) {
    return { ...baseEnv, status: "UNAVAILABLE", reason: `stat(insights) failed: ${e.message}` };
  }

  let sinceStats;
  try {
    sinceStats = helper.getTelemetryStats({ db_path: telemetryPath, since_iso: mtimeIso });
  } catch (e) {
    return { ...baseEnv, status: "UNAVAILABLE", insights_mtime: mtimeIso, reason: `since-stats read failed: ${e.message}` };
  }
  const newRows = sinceStats?.tool_executions?.count ?? 0;

  if (newRows >= threshold) {
    return {
      ...baseEnv,
      status: "STALE",
      total_rows: totalRows,
      new_rows_since_insights: newRows,
      insights_mtime: mtimeIso,
      reason: `INSIGHTS.md older than ${newRows} new telemetry rows (>= ${threshold})`,
    };
  }

  return {
    ...baseEnv,
    status: "FRESH",
    total_rows: totalRows,
    new_rows_since_insights: newRows,
    insights_mtime: mtimeIso,
    reason: `${newRows} new rows since INSIGHTS.md (< ${threshold})`,
  };
}

// CLI entry — used by the ai-preflight Step 7 shell snippet.
async function _runCli() {
  const argv = process.argv.slice(2);
  const quiet = argv.includes("--quiet");
  const envelope = await checkInsightsStaleness();
  if (!quiet) {
    process.stdout.write(JSON.stringify(envelope) + "\n");
  }
  // Never break preflight — exit 0 regardless of status.
  process.exit(0);
}

const _isMain = import.meta.url === `file://${process.argv[1]}`;
if (_isMain) {
  _runCli().catch((e) => {
    process.stderr.write(
      JSON.stringify({ service: "insights-staleness", level: "error", message: e.message }) + "\n"
    );
    // Still exit 0 — staleness probe must NEVER block preflight.
    process.exit(0);
  });
}
