// ci-record.mjs — the shell side of the local CI run record (E-266, D-072,
// local-ci.md §Components 3-4). `ai ci` is bash; the ci_runs table is node:sqlite. This
// CLI is the bridge, and every command goes through src/mcp/shared/ci-runs.js — the same
// module get_ci_status and the E-267 gates read — so the shell view and the MCP view
// cannot drift.
//
//   node ci-record.mjs record  --ai-dir <d> --log <path> [--prune-dir <d>] [--rein-version <v>]
//   node ci-record.mjs status  --ai-dir <d> --sha <sha> [--short]   exit 0 PASS / 1 not green / 2 no certifying row
//
// E-328 (D-102 §5a): in a team project `record` also writes the tracked .ai/ci/<sha>.json,
// and `status`/`gate` accept a member's record when this machine has no row for the sha.
//   node ci-record.mjs list    --ai-dir <d> [-n <N>]
//   node ci-record.mjs log     --ai-dir <d> --sha <sha> [--failed] [--evals-dir <d>]  exit 2 when no row / log gone
//   node ci-record.mjs gate    --ai-dir <d> --sha <sha> [--ref <r>]  exit 0 certified / 1 refused (pre-push, E-267)
//   node ci-record.mjs skip    --ai-dir <d> --sha <sha> --reason <text> [--ref <r>]
//
// E-303 (D-088): the test budget ratchet (src/mcp/shared/ci-budget.js).
//   node ci-record.mjs budget       --ai-dir <d>                          print the current budget
//   node ci-record.mjs budget-check --ai-dir <d> --log <path>             exit 1 on a regression
//   node ci-record.mjs budget-set   --ai-dir <d> --ruling D-### f=n …     the only way up
//
// E-386 (D-135 r2): how old the census baseline committed at <sha> is, in full runs.
//   node ci-record.mjs census-stale --ai-dir <d> --sha <sha>
//     → `MISSING` / `FRESH <n>` / `STALE <n>` (n = full PASS runs recorded since its CENSUS_RUN);
//       nothing at all when the commit has no tests/tools/census.mjs (no census, no baseline).
//
// Only `record` (the runner) and `skip` (the pre-push bypass) write.

import { realpathSync, existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { getDbSeeded } from "../mcp/shared/state-db.js";
import {
  recordCiRunFromLog, ciVerdict, shortLine, listCiRuns, latestCiRun, failedSections,
  pruneCiLogs, ageOf, certifyingRunFor, certifiedBy, ciAdopted, recordCiSkip,
} from "../mcp/shared/ci-runs.js";
import { writeCiRecord, readCiRecord } from "../mcp/shared/ci-evidence.mjs";
import { budgetBest, budgetCheck, budgetDrift, budgetSet, budgetSummary, driftLine, parseBudgetLine, regressionLine } from "../mcp/shared/ci-budget.js";

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--short" || a === "--failed") opts[a.slice(2)] = true;
    else if (a === "-n") opts.n = argv[++i];
    else if (a.startsWith("--")) opts[a.slice(2)] = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

function _db(aiDir) {
  if (!aiDir || !existsSync(aiDir)) {
    process.stderr.write(`ai ci: no .ai/ directory at ${aiDir} — run: ai init\n`);
    process.exit(2);
  }
  return getDbSeeded(resolve(aiDir));
}

function _suite(r) {
  return r.suite_pass == null ? "-" : `${r.suite_pass} passed, ${r.suite_fail ?? 0} failed, ${r.suite_skip ?? 0} skipped`;
}

// E-310: what the run spent. A row recorded before E-310 has none of it and prints "-".
function _resources(r) {
  if (r.lanes == null && r.peak_rss_mb == null && r.suite_seconds == null && !r.runner && r.peak_sum_rss_mb == null) return "-";
  const mb = (v) => (v != null ? `${v} MB` : "-");
  return `lanes ${r.lanes ?? "-"}, peak RSS ${mb(r.peak_rss_mb)} (largest process), ${mb(r.peak_sum_rss_mb)} (concurrent sum), ` +
    `suite ${r.suite_seconds != null ? `${r.suite_seconds}s` : "-"}, runner ${r.runner || "-"}`;
}

// E-328: a team record shaped as the row fields shortLine and _suite read.
function _recordRow(rec) {
  return {
    sha: rec.sha, status: rec.verdict, dirty: 0, started_at: rec.started,
    suite_pass: rec.tests.passed, suite_fail: rec.tests.failed, suite_skip: rec.tests.skipped,
    unit_status: null, leaked: null,
  };
}

// E-386 (D-135 r6): the serial exclusive tail, and its share of the suite step's seconds.
function _exclusive(r) {
  const pct = r.suite_seconds ? ` (${Math.round((r.exclusive_seconds / r.suite_seconds) * 100)} % of suite seconds)` : "";
  return `${r.exclusive_seconds} s${pct}`;
}

// E-386: past this many full runs since its CENSUS_RUN, the committed baseline is stale.
export const CENSUS_BASELINE_STALE_RUNS = 30;

/** The committed baseline's age at `sha`: { state: "MISSING"|"FRESH"|"STALE", runs } or null (no census). */
export function censusBaselineAge(db, repo, sha) {
  const show = (path) => {
    try { return execFileSync("git", ["-C", repo, "show", `${sha}:${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4 << 20 }); }
    catch { return null; }
  };
  try { execFileSync("git", ["-C", repo, "cat-file", "-e", `${sha}:tests/tools/census.mjs`], { stdio: "ignore" }); }
  catch { return null; }
  const text = show("tests/census-baseline.tsv");
  const iso = text && (text.split("\n").find((l) => l.startsWith("CENSUS_RUN\t")) || "").split("\t")[1];
  if (!iso) return { state: "MISSING", runs: null };
  const runs = db.prepare(
    "SELECT COUNT(*) AS n FROM ci_runs WHERE status = 'PASS' AND dirty = 0 AND shard IS NULL AND started_at > ?",
  ).get(iso).n;
  return { state: runs > CENSUS_BASELINE_STALE_RUNS ? "STALE" : "FRESH", runs };
}

function _slowest(r, n = 10) {
  let list = [];
  try { list = JSON.parse(r.slowest_json || "[]"); } catch { list = []; }
  return list.slice(0, n).map((e) => `${e.suite} ${Math.round(e.wall_ms / 1000)}s`).join(", ") || "-";
}

export function run(argv) {
  const [cmd, ...rest] = argv;
  const o = parseArgs(rest);
  switch (cmd) {
    case "record": {
      const db = _db(o["ai-dir"]);
      const id = recordCiRunFromLog(db, o.log);
      // E-328: a team project also gets the portable .ai/ci/<sha>.json (counts only).
      const row = db.prepare("SELECT * FROM ci_runs WHERE id = ?").get(id);
      const suites = (readFileSync(o.log, "utf8").match(/^CENSUS_SUITE\t/gm) || []).length || null;
      const ev = writeCiRecord(resolve(o["ai-dir"]), row, { suites, reinVersion: o["rein-version"] });
      for (const w of ev.warnings) process.stderr.write(`${w}\n`);
      if (ev.written) process.stderr.write(`ai ci: wrote .ai/ci/${row.sha}.json — commit it so the team sees this run\n`);
      else if (ev.path) process.stderr.write(`ai ci: .ai/ci/${row.sha.slice(0, 7)}….json not replaced — ${ev.reason}\n`);
      if (o["prune-dir"]) pruneCiLogs(o["prune-dir"], { keep: o.log });
      process.stdout.write(`${id}\n`);
      return 0;
    }
    case "status": {
      const db = _db(o["ai-dir"]);
      let v = ciVerdict(db, o.sha);
      // E-328: no local certifying row → a teammate's .ai/ci/<sha>.json may answer.
      let rec = null;
      if (v.kind === "NONE" || v.kind === "DIRTY" || v.kind === "SHARD") {
        const warnings = [];
        rec = readCiRecord(resolve(o["ai-dir"]), o.sha, { warnings });
        for (const w of warnings) process.stderr.write(`${w}\n`);
        if (rec) v = { kind: rec.verdict, row: _recordRow(rec) };
      }
      if (o.short) {
        process.stdout.write(`${shortLine(v, o.sha)}${rec ? ` — record from ${rec.runner}` : ""}\n`);
      } else if (rec) {
        process.stdout.write([
          `CI: ${rec.verdict} ${rec.sha.slice(0, 7)} — certified by the team record .ai/ci/${rec.sha}.json`,
          `  runner:   ${rec.runner} on ${rec.host || "?"} (rein ${rec.rein_version || "?"})`,
          `  started:  ${rec.started} (${ageOf(rec.started)})${rec.finished ? `, finished ${rec.finished}` : ""}`,
          `  suite:    ${_suite(v.row)}${rec.suites != null ? ` in ${rec.suites} suites` : ""}`,
        ].join("\n") + "\n");
      } else if (v.kind === "NONE") {
        process.stdout.write(`local CI: no run for ${o.sha.slice(0, 7)} — run: ai ci run\n`);
      } else {
        const r = v.row;
        process.stdout.write([
          `local CI: ${v.kind} ${r.sha.slice(0, 7)}${r.dirty ? " (dirty — not a certification)" : ""}${r.shard ? ` (shard ${r.shard} — not a certification)` : ""}`,
          `  ref:      ${r.ref || "-"}${r.branch ? ` (${r.branch})` : ""}`,
          `  started:  ${r.started_at} (${ageOf(r.started_at)})${r.duration_ms != null ? `, ${Math.round(r.duration_ms / 1000)}s` : ""}`,
          `  suite:    ${_suite(r)}, leaked ${r.leaked ?? 0}`,
          `  unit:     ${r.unit_status || "-"}${r.unit_coverage ? ` (${r.unit_coverage})` : ""}`,
          `  secrets:  ${r.secrets_status || "-"}`,
          `  spent:    ${_resources(r)}`,
          `  slowest:  ${_slowest(r)}`,
          ...(r.exclusive_seconds != null ? [`  exclusive: ${_exclusive(r)}`] : []),
          `  budget:   ${budgetSummary(budgetBest(db))}`,
          ...budgetDrift(db).map((d) => `  ${driftLine(d)}`),
          `  host:     node ${r.node_version || "?"}, bash ${r.bash_version || "?"}, ${r.os || "?"}`,
          ...(r.skip_reason ? [`  skipped:  ${r.skip_reason}`] : []),
          `  log:      ${r.log_path || "-"}`,
        ].join("\n") + "\n");
      }
      if (v.kind === "PASS") return 0;
      if (v.kind === "NONE" || v.kind === "DIRTY" || v.kind === "SHARD") return 2;
      return 1;
    }
    case "list": {
      const db = _db(o["ai-dir"]);
      const rows = listCiRuns(db, Number(o.n) || 10);
      if (!rows.length) {
        process.stdout.write("local CI: no runs recorded — run: ai ci run\n");
        return 0;
      }
      for (const r of rows) {
        const dur = r.duration_ms != null ? `${Math.round(r.duration_ms / 1000)}s` : "-";
        const spent = `L${r.lanes ?? "-"} ${r.peak_rss_mb != null ? `${r.peak_rss_mb}MB` : "-"}/${r.peak_sum_rss_mb != null ? `${r.peak_sum_rss_mb}MB` : "-"} ${r.suite_seconds != null ? `${r.suite_seconds}s` : "-"}`;
        process.stdout.write(
          `${r.status.padEnd(7)} ${r.sha.slice(0, 7)} ${r.dirty ? "dirty" : r.shard ? r.shard.padEnd(5) : "     "} ` +
          `${(r.branch || r.ref || "-").padEnd(28)} ${ageOf(r.started_at).padEnd(8)} ${dur.padStart(6)} ${spent.padStart(21)}  ${_suite(r)}\n` +
          (r.slowest_json ? `        slowest: ${_slowest(r)}\n` : ""));
      }
      return 0;
    }
    case "log": {
      const db = _db(o["ai-dir"]);
      const r = latestCiRun(db, o.sha);
      if (!r) {
        process.stderr.write(`ai ci log: no run recorded for ${o.sha.slice(0, 7)} — run: ai ci run\n`);
        return 2;
      }
      if (!r.log_path || !existsSync(r.log_path)) {
        process.stderr.write(`ai ci log: the log for ${r.sha.slice(0, 7)} was pruned (${r.log_path || "no path"})\n`);
        return 2;
      }
      const text = readFileSync(r.log_path, "utf8");
      if (!o.failed) {
        process.stdout.write(text);
      } else {
        const secs = failedSections(text);
        process.stdout.write(`# ${r.status} ${r.sha.slice(0, 7)} — ${r.log_path}\n`);
        process.stdout.write(secs.length ? secs.join("\n\n") + "\n" : "(no failing sections)\n");
      }
      // E-285: the skill-eval report `ai ci evals` filed under this sha, when there is one.
      const evals = o["evals-dir"] && resolve(o["evals-dir"], `${r.sha}.json`);
      if (evals && existsSync(evals)) process.stdout.write(`# skill evals: ${evals}\n`);
      return 0;
    }
    case "gate": {
      // pre-push: may this sha leave the machine? Inactive (exit 0, with a notice) until
      // the project has recorded a run, like the DONE gate.
      const db = _db(o["ai-dir"]);
      const sha7 = o.sha.slice(0, 7);
      const label = o.ref || sha7;
      const aiDir = resolve(o["ai-dir"]);
      if (!ciAdopted(db, aiDir)) {
        process.stderr.write(`[CI_GATE] ${label}: not enforced — no ai ci run recorded in this project yet\n`);
        return 0;
      }
      const repo = resolve(aiDir, "..");
      // E-328: in a team project a member's PASS record for the sha (or a tested ancestor) counts.
      const c = certifyingRunFor(db, repo, o.sha, { allowSkipped: true, aiDir });
      for (const w of c.warnings) process.stderr.write(`${w}\n`);
      if (c.ok) {
        let how = `tested ancestor ${(c.row || c.record).sha.slice(0, 7)}, only .ai/ differs`;
        if (c.via === "self") how = `${c.kind} run`;
        else if (c.via !== "ancestor") how = certifiedBy(c);
        process.stderr.write(`[CI_GATE] ${label}: ${sha7} ok (${how})\n`);
        return 0;
      }
      let why;
      const near = c.row || c.record;
      if (c.via === "self") why = `its run is ${c.kind}`;
      else if (c.via === "record") why = `its record from ${c.record.runner} is ${c.kind}`;
      else if (near) why = `nearest tested ancestor ${near.sha.slice(0, 7)} differs outside .ai/: ${c.differs.slice(0, 3).join(", ")}${c.differs.length > 3 ? ", …" : ""}`;
      else why = "no run for it or for a tested ancestor";
      process.stderr.write(
        `[CI_GATE] ${label}: no green local CI run for ${sha7} (${why}) — run: ai ci run, ` +
        "or REIN_CI_SKIP=1 REIN_CI_SKIP_REASON=\"<why>\" git push\n");
      return 1;
    }
    case "skip": {
      const reason = String(o.reason || "").trim();
      if (!reason) {
        process.stderr.write("[CI_GATE] REIN_CI_SKIP=1 needs REIN_CI_SKIP_REASON=\"<why>\" — a skip is recorded, never silent\n");
        return 1;
      }
      const db = _db(o["ai-dir"]);
      recordCiSkip(db, { sha: o.sha, ref: o.ref || null, reason });
      process.stderr.write(`[CI_GATE] ${o.ref || o.sha.slice(0, 7)}: SKIPPED (recorded) — ${reason}\n`);
      return 0;
    }
    case "budget": {
      const db = _db(o["ai-dir"]);
      process.stdout.write(`test budget: ${budgetSummary(budgetBest(db))}\n`);
      // E-366: a timing/RSS drift line is information, never a failure (D-118 r1).
      for (const d of budgetDrift(db)) process.stdout.write(`${driftLine(d)}\n`);
      return 0;
    }
    case "budget-check": {
      // The run's own `[ci] budget …` line (the last one) against the best recorded so far;
      // the run is recorded AFTER this, so it never compares with itself.
      const line = readFileSync(o.log, "utf8").split("\n").filter((l) => l.startsWith("[ci] budget ")).pop();
      if (!line) { process.stdout.write("budget: not measured in this run\n"); return 0; }
      const cur = budgetBest(_db(o["ai-dir"]));
      const regs = budgetCheck(cur.best, parseBudgetLine(line));
      for (const r of regs) process.stdout.write(`${regressionLine(r)}\n`);
      if (!cur.runs) process.stdout.write("budget: first measurement — it becomes the budget once the run is green\n");
      return regs.length ? 1 : 0;
    }
    case "budget-set": {
      const values = {};
      for (const a of o._) {
        const m = String(a).match(/^([a-z_]+)=(\d+)$/);
        if (!m) { process.stderr.write(`ai ci budget set: '${a}' is not field=<whole number>\n`); return 2; }
        values[m[1]] = Number(m[2]);
      }
      try {
        const r = budgetSet(_db(o["ai-dir"]), o.ruling, values);
        process.stdout.write(`test budget set by ${o.ruling} on ${r.sha.slice(0, 7)}: ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(" ")}\n`);
        return 0;
      } catch (e) {
        process.stderr.write(`ai ci budget set: ${e.message}\n`);
        return 2;
      }
    }
    case "census-stale": {
      const aiDir = resolve(o["ai-dir"]);
      const age = censusBaselineAge(_db(aiDir), resolve(aiDir, ".."), o.sha);
      if (age) process.stdout.write(`${age.state}${age.runs != null ? ` ${age.runs}` : ""}\n`);
      return 0;
    }
    default:
      process.stderr.write("usage: ci-record.mjs <record|status|list|log|gate|skip|budget|budget-check|budget-set|census-stale> --ai-dir <d> …\n");
      return 2;
  }
}

// Main-module check on REAL paths: argv[1] may be spelled through a symlink (macOS
// /var → /private/var) while import.meta.url is resolved — comparing the raw spellings
// made other helpers silently do nothing under `ai ci run` (E-265).
function _isMain() {
  try {
    return !!process.argv[1] &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (_isMain()) {
  try {
    process.exitCode = run(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`ai ci: ${e.message}\n`);
    process.exitCode = 2;
  }
}
