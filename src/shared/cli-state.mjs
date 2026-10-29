// cli-state.mjs — `rein state migrate --team|--legacy` and `rein task done <id>` (E-325, D-102).
//
// Both write through the same library as task-synchronizer-mcp (state-db.js → record-store.mjs),
// so the shell surface is not a second writer. `rein task done` applies the SAME completion gates
// as update_task_status and run_handover (src/shared/completion-gates.mjs): a third door to DONE
// without them would reopen what E-319 closed. hooks/post-commit.sh calls it for "Fixes E-##".
//
// The gates' environment rollbacks are NOT honoured here. For the MCP server they are fixed
// when it boots; for this command they would be the env of whatever ran it — the agent's Bash
// call, or a project's settings `env` — and an env switch is an attacker's switch
// (hooks-contract, E-291). main() removes them before any gate reads them.
//
// E-326: `rein state import` brings the index up to the pulled record files (record-import.mjs).
// It is run by the post-merge / post-checkout / post-rewrite hooks and at session start, exits
// 0 whatever happens, and with REIN_STATE_IMPORT=0 the hook runs (--hook) are no-ops that
// leave one telemetry row. `state parity` is the pre-commit check; `state merge-driver` is the
// git merge driver for record files (`rein sync` configures it).
// E-342 (D-106): in a legacy project (no team.json) `state import` merges HEAD:.ai/state.json
// into the index per record instead (legacy-import.mjs); --force ignores the imported blob id.
//
// Usage: node cli-state.mjs state migrate --team [--trunk <name>] | --legacy
//        node cli-state.mjs state import [--dry-run] [--force] [--hook <name>]
//        node cli-state.mjs state parity
//        node cli-state.mjs state health [--repair] [--short]     (E-344: rein doctor / rein-preflight)
//        node cli-state.mjs state merge-driver <base> <ours> <theirs> [<path>]
//        node cli-state.mjs task done <id> [--summary <text>]
//        node cli-state.mjs team add <email> --range <P>:<from>-<to>
//        node cli-state.mjs team show
//        node cli-state.mjs team planner-check      (one warning line, or nothing)
//        node cli-state.mjs task claim <id> | release <id> [--reason <text>] | claims [--fetch]
// E-327: `rein team` edits .ai/team.json, the per-developer id ranges and the planner (D-102 §3).
//        node cli-state.mjs trunk [--doctor]
// E-331: `rein task claim|release` publish a claim on origin/<trunk> (task-claims.mjs, D-102 §4);
// `rein task claims` lists the IN_PROGRESS tasks there (session start and rein-preflight).
// E-341 (D-105 r2): `rein trunk` prints the resolved trunk, so skills and agents say $(rein trunk)
// instead of a literal; `--doctor` is the [TRUNK_UNSET]/[TRUNK_MISMATCH] check `rein doctor` runs.
// Exit: 0 done or nothing to do; 1 refused or failed; 2 usage.

import { existsSync } from "node:fs";
import { isMainModule } from "../mcp/shared/is-main.mjs";
import { resolve, dirname } from "node:path";
import { getDbSeeded, completeTask, regenerateViews, withTransaction, openIndexIfExists } from "../mcp/shared/state-db.js";
import { importLegacy, checkBehindHead, stateHealth } from "../mcp/shared/legacy-import.mjs";
import { migrateTeam, migrateLegacy } from "../mcp/shared/record-migrate.mjs";
import { importRecords, checkParity, mergeRecord } from "../mcp/shared/record-import.mjs";
import { isRecordStore } from "../mcp/shared/record-store.mjs";
import { recordToolExecution } from "./telemetry.mjs";
import { readTeam, writeTeam, newTeam, addRange, describeTeam, TeamError, logPath, recentLog } from "../mcp/shared/team.mjs";
import { gitEmail } from "../mcp/shared/record-store.mjs";
import { completionGates } from "./completion-gates.mjs";
import { findAiDir } from "./cli-add-task.mjs";
import { claimTask, releaseTask, publishDone, listClaims } from "../mcp/shared/task-claims.mjs";
import { resolveTrunk, trunkDoctor } from "../mcp/shared/trunk.mjs";

const SUMMARY_CAP = 200;
// The completion gates' rollback switches (ci-runs.js checkCiDoneGate, build-stamp.mjs).
export const GATE_ROLLBACK_VARS = ["REIN_CI_GATE", "REIN_BUILD_STAMP"];

function _withoutRollbacks(env) {
  const out = { ...env };
  for (const k of GATE_ROLLBACK_VARS) delete out[k];
  return out;
}

const USAGE = `usage: rein state migrate --team [--trunk <name>] | --legacy
       rein state import [--dry-run] [--force]
       rein state parity
       rein task done <id> [--summary <text>]
       rein task claim <id>
       rein task release <id> [--reason <text>]
       rein task claims [--fetch]
       rein team add <email> --range <P>:<from>-<to>
       rein team show
       rein log path
       rein log recent [-n <N>]
       rein trunk [--doctor]`;

/** `rein team add` — appends a range; an overlap with anyone is refused, naming the clash. */
export function runTeamAdd(aiDir, email, spec) {
  if (!isRecordStore(aiDir)) return { code: 1, out: "rein team: not a team project — run: rein state migrate --team" };
  const m = /^([A-Z]{1,4}):(\d+)-(\d+)$/.exec(spec || "");
  if (!m) return { code: 2, out: "rein team add: --range must look like E:425-524" };
  try {
    const existing = readTeam(aiDir);
    const team = existing || newTeam(gitEmail(aiDir), {});
    const next = addRange(team, email, m[1], Number(m[2]), Number(m[3]));
    writeTeam(aiDir, next);
    const created = existing ? "" : `\n  created .ai/team.json with YOU (${team.planner}) as the planner — only the planner adds P tasks`;
    return { code: 0, out: `✓ ${email} ${m[1]}:${m[2]}-${m[3]} added to .ai/team.json — commit it so every clone allocates from it${created}` };
  } catch (e) {
    if (e instanceof TeamError) return { code: 1, out: `✗ [${e.code}] ${e.message}` };
    throw e;
  }
}

export function runTeamShow(aiDir) {
  try {
    const team = readTeam(aiDir);
    if (!team) return { code: 0, out: "no .ai/team.json — ids are allocated max+1 (single-operator project)" };
    return { code: 0, out: describeTeam(aiDir, getDbSeeded(aiDir), team) };
  } catch (e) {
    if (e instanceof TeamError) return { code: 1, out: `✗ [${e.code}] ${e.message}` };
    throw e;
  }
}

/** For `rein pane architect`: one warning line when this git email is not the planner. */
export function runPlannerCheck(aiDir) {
  try {
    const team = readTeam(aiDir);
    const email = gitEmail(aiDir);
    if (!team || team.planner === email) return { code: 0, out: "" };
    return { code: 0, out: `[NOT_PLANNER] ${email} is not this project's planner (${team.planner}) — add_task with prefix P will be refused.` };
  } catch (e) {
    return { code: 0, out: `[TEAM_INVALID] ${String(e.message).slice(0, 200)}` };
  }
}

/** Never fails: an import runs from git hooks and must not block a pull. @returns {{code:0, out:string}} */
export function runStateImport(aiDir, { dryRun = false, force = false, hook = null, env = process.env } = {}) {
  if (hook && env.REIN_STATE_IMPORT === "0") {
    recordToolExecution({ tool_name: "state_import", execution_time_ms: 0, status: "BYPASS", source: "hook" }, { sync: true });
    return { code: 0, out: `[STATE_IMPORT] skipped (${hook}): REIN_STATE_IMPORT=0` };
  }
  if (!existsSync(aiDir)) return { code: 0, out: "" };
  try {
    // E-342 (D-106): a legacy project imports HEAD's tracked state.json per record.
    const res = isRecordStore(aiDir)
      ? importRecords(aiDir, getDbSeeded(aiDir), { dryRun, force })
      : importLegacy(aiDir, getDbSeeded(aiDir), { dryRun, force, render: regenerateViews, transaction: withTransaction });
    return { code: 0, out: res.lines.join("\n") };
  } catch (e) {
    return { code: 0, out: `[STATE_IMPORT] failed — ${String(e.message).replace(/[\r\n]+/g, " ").slice(0, 200)}; the index is unchanged` };
  }
}

/**
 * E-344 (D-108 r8): rein doctor's State Health. Observes without seeding; --repair runs the
 * import (never the lossy migrate-state). --short prints only the verdict line (rein-preflight).
 * @returns {{code:0, out:string}}
 */
export function runStateHealth(aiDir, { repair = false, short = false } = {}) {
  if (!existsSync(aiDir)) return { code: 0, out: "  — skipped (no .ai/ directory)" };
  const res = stateHealth(aiDir, openIndexIfExists(aiDir));
  const lines = short ? [res.lines.at(-1).trim()] : [...res.lines];
  if (repair && res.action === "import") {
    const imp = runStateImport(aiDir, { force: true }).out;
    lines.push(`  repaired: rein state import${imp ? `\n${imp.split("\n").map((l) => `    ${l}`).join("\n")}` : " (nothing to merge)"}`);
  } else if (repair && res.action === "migrate") {
    lines.push("  not repaired: rebuilding from TASKS.md loses summaries and stamps — run rein migrate-state yourself");
  }
  return { code: 0, out: lines.join("\n") };
}

/** @returns {{code:number, out:string}} 0 in parity (or a legacy project), 1 otherwise. */
export function runStateParity(aiDir) {
  if (!existsSync(aiDir) || !isRecordStore(aiDir)) return { code: 0, out: "" };
  const res = checkParity(aiDir, getDbSeeded(aiDir));
  if (res.ok) return { code: 0, out: "" };
  return { code: 1, out: ["record files and the index disagree:", ...res.lines.map((l) => `  ${l}`), "fix: rein state import"].join("\n") };
}

/** @returns {{code:number, out:string}} */
export function runStateMigrate(aiDir, mode, { trunk = null } = {}) {
  if (!existsSync(aiDir)) return { code: 1, out: `rein state migrate: no .ai/ directory at ${aiDir} — run: rein init` };
  const res = mode === "--team" ? migrateTeam(aiDir, { trunk }) : migrateLegacy(aiDir);
  if (!res.ok) return { code: 1, out: `✗ [${res.code}] ${res.message}` };
  return { code: 0, out: `✓ ${res.message}` };
}

/** @returns {{code:number, out:string}} */
export function runTaskDone(aiDir, id, summary, { env = _withoutRollbacks(process.env), buildOpts = {} } = {}) {
  if (!/^[A-Z]+-\d+$/.test(id || "")) return { code: 2, out: `rein task done: invalid task id ${JSON.stringify(id)}` };
  const db  = getDbSeeded(aiDir);
  const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(id);
  if (!row) return { code: 1, out: `✗ ${id} not found in state.` };
  if (row.status === "DONE") return { code: 0, out: `${id} is already DONE.` };
  const behind = checkBehindHead(aiDir, db);   // E-342 (D-106 r4): refuse before any write
  if (behind) return { code: 1, out: `✗ ${behind}` };
  const refused = completionGates({ cwd: dirname(resolve(aiDir)), db, id, buildOpts, env });
  // The shared refusal text names the MCP-side env bypass, which does not apply here.
  if (refused) return { code: 1, out: refused.content.map((c) => c.text.replace(/\s*\(bypass: [^)]*\)/g, "")).join("\n") };
  const text = summary ? String(summary).slice(0, SUMMARY_CAP) : null;
  const unblocked = completeTask(aiDir, db, id, text);
  regenerateViews(aiDir, db);
  const pub = publishDone(aiDir, id);   // E-331: clears this user's claim on origin/<trunk>
  return { code: 0, out: `✓ ${id} → DONE${text ? ": " + text : ""}${unblocked.length ? ` | unblocked: ${unblocked.join(", ")}` : ""}${pub ? ` | ${pub.message}` : ""}` };
}

/** `rein task claim|release` — @returns {{code:number, out:string}} */
export function runTaskClaim(aiDir, verb, id, reason = null) {
  if (!existsSync(aiDir)) return { code: 1, out: `rein task ${verb}: no .ai/ directory — run: rein init` };
  try {
    const res = verb === "claim" ? claimTask(aiDir, id) : releaseTask(aiDir, id, reason);
    if (res.ok) return { code: 0, out: res.message };
    return { code: 1, out: res.message.startsWith("[") ? `✗ ${res.message}` : `✗ [${res.code}] ${res.message}` };
  } catch (e) {
    return { code: 1, out: `✗ rein task ${verb}: ${String(e.message).replace(/[\r\n]+/g, " ").slice(0, 300)}` };
  }
}

/**
 * `rein trunk` — the resolved name on one line (exit 0), else the [NO_TRUNK] line (exit 1).
 * `--doctor` — rein doctor's trunk lines; exit 0 always (advisory).
 */
export function runTrunk(root, { doctor = false } = {}) {
  try {
    if (doctor) return { code: 0, out: trunkDoctor(root).join("\n") };
    const t = resolveTrunk(root);
    return t.name ? { code: 0, out: t.name } : { code: 1, out: t.message };
  } catch (e) {
    const msg = String(e.message).replace(/[\r\n]+/g, " ").slice(0, 300);
    return { code: doctor ? 0 : 1, out: doctor ? `[TRUNK] unavailable — ${msg}` : `[NO_TRUNK] ${msg}` };
  }
}

/** `rein task claims [--fetch]` — never fails: it runs at session start. */
export function runTaskClaims(aiDir, { fetch = false } = {}) {
  if (!existsSync(aiDir)) return { code: 0, out: "" };
  try {
    return { code: 0, out: listClaims(aiDir, { fetch }).join("\n") };
  } catch (e) {
    return { code: 0, out: `[CLAIMS] unavailable — ${String(e.message).replace(/[\r\n]+/g, " ").slice(0, 200)}` };
  }
}

export function main(argv, cwd = process.cwd()) {
  const [group, verb, ...rest] = argv;
  // build-stamp.mjs reads its switch from process.env directly, so both go from there too.
  for (const k of GATE_ROLLBACK_VARS) delete process.env[k];
  const aiDir = findAiDir(cwd);
  // E-333 (D-102 §8): where a LOG entry goes (the rein-log skill appends there), and the newest
  // entries across every developer's file when team.json shared_log is true (rein-preflight).
  if (group === "log" && verb === "path" && rest.length === 0) return { code: 0, out: logPath(aiDir) };
  if (group === "log" && verb === "recent" && (rest.length === 0 || (rest.length === 2 && rest[0] === "-n" && /^\d{1,3}$/.test(rest[1])))) {
    return { code: 0, out: recentLog(aiDir, rest.length ? Number(rest[1]) : 5).join("\n") };
  }
  if (group === "state" && verb === "migrate" && (rest[0] === "--team" || rest[0] === "--legacy") && rest.length === 1) {
    return runStateMigrate(aiDir, rest[0]);
  }
  if (group === "state" && verb === "migrate" && rest[0] === "--team" && rest[1] === "--trunk" && rest.length === 3) {
    return runStateMigrate(aiDir, "--team", { trunk: rest[2] });
  }
  if (group === "trunk" && (verb === undefined || (verb === "--doctor" && rest.length === 0))) {
    return runTrunk(dirname(resolve(aiDir)), { doctor: verb === "--doctor" });
  }
  if (group === "state" && verb === "health") {
    return runStateHealth(aiDir, { repair: rest.includes("--repair"), short: rest.includes("--short") });
  }
  if (group === "state" && verb === "import") {
    const opts = { dryRun: false, force: false, hook: null };
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === "--dry-run") opts.dryRun = true;
      else if (rest[i] === "--force") opts.force = true;
      else if (rest[i] === "--hook" && rest[i + 1]) opts.hook = rest[++i];
      else return { code: 2, out: USAGE };
    }
    return runStateImport(aiDir, opts);
  }
  if (group === "state" && verb === "parity" && rest.length === 0) return runStateParity(aiDir);
  if (group === "state" && verb === "merge-driver" && rest.length >= 3) {
    return { code: mergeRecord(rest[0], rest[1], rest[2], rest[3] || "", { cwd }), out: "" };
  }
  if (group === "team" && verb === "add" && rest.length === 3 && rest[1] === "--range") return runTeamAdd(aiDir, rest[0], rest[2]);
  if (group === "team" && verb === "add" && rest.length === 2 && rest[1].startsWith("--range=")) return runTeamAdd(aiDir, rest[0], rest[1].slice(8));
  if (group === "team" && verb === "show" && rest.length === 0) return runTeamShow(aiDir);
  if (group === "team" && verb === "planner-check" && rest.length === 0) return runPlannerCheck(aiDir);
  if (group === "task" && (verb === "claim" || verb === "release") && rest.length >= 1) {
    const [id, ...flags] = rest;
    let reason = null;
    for (let i = 0; i < flags.length; i++) {
      if (verb === "release" && flags[i] === "--reason") reason = flags[++i] ?? null;
      else if (verb === "release" && flags[i].startsWith("--reason=")) reason = flags[i].slice("--reason=".length);
      else return { code: 2, out: USAGE };
    }
    return runTaskClaim(aiDir, verb, String(id).toUpperCase(), reason);
  }
  if (group === "task" && verb === "claims" && rest.every((f) => f === "--fetch")) return runTaskClaims(aiDir, { fetch: rest.length > 0 });
  if (group === "task" && verb === "done" && rest.length >= 1) {
    const [id, ...flags] = rest;
    let summary = null;
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === "--summary") summary = flags[++i] ?? null;
      else if (flags[i].startsWith("--summary=")) summary = flags[i].slice("--summary=".length);
      else return { code: 2, out: USAGE };
    }
    return runTaskDone(aiDir, String(id).toUpperCase(), summary);
  }
  return { code: 2, out: USAGE };
}

if (isMainModule(import.meta.url)) {
  let res;
  try {
    res = main(process.argv.slice(2));
  } catch (e) {
    res = { code: 1, out: `✗ ${e.message}` };
  }
  if (res.out) (res.code === 0 ? process.stdout : process.stderr).write(res.out + "\n");
  process.exit(res.code);
}
