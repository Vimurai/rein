// recheck.mjs — `rein recheck` (E-479, D-176, .ai/blueprints/acceptance-replay.md §Component 2).
//
// Replays the live set of recorded acceptance checks (CHECK stamps, grammar in checks.mjs) at
// the current commit and records one CHECKS_PASS or CHECKS_FAIL stamp for HEAD.
//
//   rein recheck [--list] [--json]
//   rein recheck --retire <task>#<n> --by <D-###|E-###|P-##> --reason <text>
//   exit 0 all hold (or none) / retired; 1 a check is broken, or a retire is refused; 2 usage
//
// SECURITY (D-176 r7, §Security): this runs command text taken from the ledger, at the trust
// level of the project's test suite. It runs in the CALLER's shell only, so inside a role pane
// that role's sandbox bounds it. Nothing under src/mcp/ imports this file: the MCP server runs
// outside the sandbox, and the DONE gate reads the stamp this writes, never runs a check. No
// allowlist of commands (the text gate that judged commands was deleted, D-169 r2); `--list`
// shows every command before anything runs.

import { spawn, spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { parseCheck, parseCheckId, parseRetire, evaluate, expectText } from "./checks.mjs";
import { checkSupersededBy } from "./completion-gates.mjs";
import { findAiDir } from "./cli-add-task.mjs";
import { getDbSeeded, regenerateViews } from "../mcp/shared/state-db.js";
import { insertStamp } from "../mcp/shared/record-store.mjs";
import { isMainModule } from "../mcp/shared/is-main.mjs";

export const TIME_LIMIT_MS = 30_000;
export const STDOUT_MAX = 64 * 1024;
const AGENT = "rein recheck";

const USAGE = `usage: rein recheck [--list] [--json]
       rein recheck --retire <task>#<n> --by <D-###|E-###|P-##> --reason <text>`;

/**
 * The live set (§Data Model): for each DONE task, the newest CHECK per clause, minus every id
 * with a CHECK_RETIRED stamp. → { live: [check], retired: [id] } — `retired` lists the ids of
 * DONE tasks' checks that a retirement ended.
 */
export function liveSet(db) {
  const done = new Set(db.prepare("SELECT id FROM tasks WHERE status = 'DONE'").all().map((r) => r.id));
  const stamps = db.prepare("SELECT type, task_id, summary FROM stamps WHERE type IN ('CHECK', 'CHECK_RETIRED') ORDER BY id").all();
  const newest = new Map();
  const ended = new Set();
  for (const s of stamps) {
    if (s.type === "CHECK_RETIRED") {
      const r = parseRetire(s.summary, s.task_id);
      if (r.ok) ended.add(r.retire.id);
      continue;
    }
    const c = parseCheck(s.summary, s.task_id);
    if (c.ok && done.has(c.check.task)) newest.set(c.check.id, c.check);   // a later stamp replaces
  }
  const all = [...newest.values()];
  return { live: all.filter((c) => !ended.has(c.id)), retired: all.filter((c) => ended.has(c.id)).map((c) => c.id) };
}

/**
 * Run one command in `cwd` through bash, stdin closed, stderr dropped. The process group is
 * killed at the time limit or past STDOUT_MAX bytes. → Promise<{ code, stdout, error }>
 */
export function runCommand(command, { cwd, timeoutMs = TIME_LIMIT_MS, maxBytes = STDOUT_MAX } = {}) {
  return new Promise((done) => {
    const child = spawn("bash", ["-c", command], { cwd, stdio: ["ignore", "pipe", "ignore"], detached: true });
    let out = Buffer.alloc(0);
    let error = null;
    const stop = (why) => {
      if (error) return;
      error = why;
      try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => stop(`timed out after ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    child.stdout.on("data", (d) => {
      out = Buffer.concat([out, d]);
      if (out.length > maxBytes) stop("output too large");
    });
    child.on("error", (e) => { clearTimeout(timer); done({ code: null, stdout: "", error: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); done({ code, stdout: out.toString("utf8"), error }); });
  });
}

/** Tracked changes outside .ai/ (the .ai/-only rule the stamp gates use); untracked files do not count. */
export function isDirty(root) {
  const r = spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=no", "--", ".", ":(exclude).ai"], { encoding: "utf8" });
  return r.status !== 0 || r.stdout.trim() !== "";
}

function _head(root) {
  const r = spawnSync("git", ["-C", root, "rev-parse", "--verify", "HEAD"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function _stamp(aiDir, db, type, task_id, summary) {
  insertStamp(aiDir, db, { type, agent: AGENT, task_id, timestamp: new Date().toISOString(), summary });
  regenerateViews(aiDir, db);
}

/** `rein recheck [--json]`: run the live set, print, record. → { code, out } */
export async function runRecheck(aiDir, { json = false, opts = {} } = {}) {
  const root = dirname(aiDir);
  const db = getDbSeeded(aiDir);
  const { live, retired } = liveSet(db);
  const t0 = Date.now();
  const holds = [];
  const broken = [];
  for (const c of live) {
    const run = await runCommand(c.command, { cwd: root, ...opts });
    const v = run.error ? { holds: false, got: run.error } : evaluate(c.expect, run);
    if (v.holds) holds.push(c.id);
    else broken.push({ id: c.id, expect: expectText(c.expect), got: v.got, command: c.command });
  }
  const secs = `${((Date.now() - t0) / 1000).toFixed(1)} s`;
  const head = _head(root);
  const sha7 = head ? head.slice(0, 7) : "(no HEAD)";
  const dirty = !head || isDirty(root);
  if (!dirty) {
    _stamp(aiDir, db, broken.length ? "CHECKS_FAIL" : "CHECKS_PASS", null, broken.length
      ? `[CHECKS_FAIL] at ${sha7} — ${broken.length} broken of ${live.length}: ${broken.map((b) => b.id).join(", ")}`
      : `[CHECKS_PASS] at ${sha7} — ${holds.length} hold, ${retired.length} retired`);
  }
  const tail = dirty ? " (dirty: not recorded)" : "";
  if (json) {
    return { code: broken.length ? 1 : 0, out: JSON.stringify({ sha: head, holds, broken, retired }, null, 2) };
  }
  const lines = broken.map((b) => `✗ [CHECK_BROKEN] ${b.id} expected ${b.expect}, got ${b.got}: ${b.command}`);
  lines.push(broken.length
    ? `✗ [CHECKS_FAIL] ${broken.length} broken of ${live.length} (${secs})${tail}`
    : `✓ [CHECKS_PASS] ${holds.length} hold, ${retired.length} retired (${secs})${tail}`);
  return { code: broken.length ? 1 : 0, out: lines.join("\n") };
}

/** `rein recheck --list`: one line per live check; runs nothing. */
export function runList(aiDir) {
  const { live } = liveSet(getDbSeeded(aiDir));
  return { code: 0, out: live.map((c) => `${c.id} | ${expectText(c.expect)} | ${c.command}`).join("\n") };
}

/** `rein recheck --retire <id> --by <ref> --reason <text>`. */
export function runRetire(aiDir, id, by, reason) {
  const db = getDbSeeded(aiDir);
  const cid = parseCheckId(id);
  if (!cid || !liveSet(db).live.some((c) => c.id === cid.id)) return { code: 1, out: `✗ [CHECK_UNKNOWN] ${id} is not a live check` };
  const known = /^D-\d+$/.test(by) ? checkSupersededBy(aiDir, by) === null
    : /^[EP]-\d+$/.test(by) && !!db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(by);
  if (!known) return { code: 1, out: `✗ [RETIRE_UNKNOWN] ${by} is not a decision or a task` };
  const summary = `${cid.id} | ${by} | ${String(reason).replace(/\s+/g, " ").trim()}`;
  const r = parseRetire(summary, cid.task);
  if (!r.ok) return { code: 1, out: `✗ [CHECK_MALFORMED] CHECK_RETIRED: ${r.reason}` };
  _stamp(aiDir, db, "CHECK_RETIRED", cid.task, summary);
  return { code: 0, out: `✓ ${cid.id} retired by ${by}` };
}

/** argv (after the verb) → { mode, ... } or null for usage. */
export function parseArgs(argv) {
  const a = { mode: "run", json: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--list") a.list = true;
    else if (k === "--json") a.json = true;
    else if (["--retire", "--by", "--reason"].includes(k) && i + 1 < argv.length) a[k.slice(2)] = argv[++i];
    else return null;
  }
  const retiring = ["retire", "by", "reason"].filter((k) => a[k] !== undefined);
  if (retiring.length) return retiring.length === 3 && !a.list && !a.json ? { ...a, mode: "retire" } : null;
  if (a.list) return a.json ? null : { mode: "list" };
  return a;
}

export async function main(argv, cwd = process.cwd()) {
  const a = parseArgs(argv);
  if (!a) return { code: 2, out: USAGE };
  const aiDir = findAiDir(cwd);
  if (a.mode === "list") return runList(aiDir);
  if (a.mode === "retire") return runRetire(aiDir, a.retire, a.by, a.reason);
  return runRecheck(aiDir, { json: a.json });
}

if (isMainModule(import.meta.url)) {
  const r = await main(process.argv.slice(2));
  if (r.out) (r.code === 2 ? process.stderr : process.stdout).write(r.out + "\n");
  process.exit(r.code);
}
