// build-stamp.mjs — Booted-Build Staleness (E-249, D-067 §3).
//
// THE DEFECT THIS ANNOUNCES. ESM caches a module for the lifetime of the process. An MCP
// server is a LONG-LIVED process: it imports its projector, its policy modules and
// src/mcp/shared/* once, at startup, and serves that code until something restarts it.
// `bash install-ai-os.sh` rewrites ~/.ai-os; `git pull` rewrites src/. Neither reaches a
// running server. The task synchroniser went on serving the PRE-E-245 projector and
// stripped the archive pointer on every write, and E-227's run_review reported a P0 the
// shipped checker no longer emits. In both cases the gate was reporting on code that was
// no longer on disk, and nothing said so.
//
// WHY ANNOUNCE RATHER THAN RELOAD (the D-067 §3 refusal). E-237 hot-reloads four POLICY
// modules — pure, side-effect-free predicates where a mid-process swap is safe. state-db
// and the projectors are NOT in that set and must not join it: the write path's
// correctness cannot depend on which version of a module happened to be resident when a
// transaction started. A stale server is ANNOUNCED with evidence and restarted by the
// operator; it is never patched live. Nor does a server exit on source change — the
// harness does not restart MCP servers, so a self-terminating one is unrecoverable while
// a stale one is merely wrong-and-labelled.
//
// WHAT A STAMP IS. The CONTENT hash of the entry file plus every file in the server's
// `mcp/shared/` directory, and the newest mtime among them. Content, not mtime alone:
// `install-ai-os.sh` rewrites files whether or not their bytes changed (E-229's
// _atomic_copy_tree), and a server serving byte-identical code is not stale — reporting
// it would train the operator to ignore the notice. The mtime is carried anyway because
// it is what the message quotes ("mirror changed <ts>"), and it is read in FLOAT
// milliseconds: whole-second mtime made E-229's watcher re-exec mechanism inert for
// same-second rewrites, which is the exact `ai sync` case.
//
// HOW A SEPARATE PROCESS FINDS OUT. Each server writes ~/.ai-os/run/build-<server>.json at
// startup. `verify_markdown_sync`, the `ai-preflight` skill, `ai doctor`, `ai sync` and
// `install-ai-os.sh` read that directory, drop records whose pid is gone, recompute the
// stamp from the SAME paths the record names, and report every mismatch. Comparing
// booted-against-current-at-the-same-path is what makes the check correct for a server
// booted from the mirror AND for one booted from a repo checkout.
//
// Rollback: AI_OS_BUILD_STAMP=0 — no record is written, no `_meta.booted_build` is
// attached, and every consumer reports nothing.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isFrameworkClone } from "./locate.mjs";

export const RUN_DIR = join(homedir(), ".ai-os", "run");
const RECORD_PREFIX = "build-";
const RECORD_SUFFIX = ".json";

/** The rollback switch (D-067 §3). Read live, never cached, so a test can toggle it. */
export function buildStampEnabled() {
  return process.env.AI_OS_BUILD_STAMP !== "0";
}

// A server name reaches the filesystem as part of a path, so it is sanitised the same way
// safe-exec sanitises a session id — a crafted name must not traverse out of the run dir.
function sanitizeName(name) {
  return String(name || "").replace(/[^A-Za-z0-9._-]/g, "");
}

export function recordPathFor(serverName, runDir = RUN_DIR) {
  return join(runDir, `${RECORD_PREFIX}${sanitizeName(serverName)}${RECORD_SUFFIX}`);
}

// The files that constitute a server's build: its entry file, plus every file in the
// `shared/` directory beside its own (src/mcp/shared/* for an MCP server). Sorted, so the
// hash does not depend on readdir order.
export function buildInputsFor(entryFile) {
  const entry = resolve(entryFile);
  const files = [];
  if (existsSync(entry)) files.push(entry);

  const sharedDir = resolve(dirname(entry), "..", "shared");
  if (existsSync(sharedDir)) {
    let names = [];
    try { names = readdirSync(sharedDir); } catch { names = []; }
    for (const n of names.sort()) {
      const p = join(sharedDir, n);
      try { if (statSync(p).isFile()) files.push(p); } catch { /* raced away — skip */ }
    }
  }
  return files;
}

/**
 * Compute the build stamp for an entry file.
 * @returns {{hash:string, mtime_ms:number, mtime_iso:string, file_count:number, entry:string}|null}
 *          null when the entry file does not exist (an uninstalled or moved server —
 *          nothing to compare, and a fabricated stamp would compare unequal forever).
 */
export function stampFor(entryFile) {
  const entry = resolve(entryFile);
  if (!existsSync(entry)) return null;

  const files = buildInputsFor(entry);
  const h = createHash("sha256");
  let newest = 0;
  for (const f of files) {
    let st, buf;
    try { st = statSync(f); buf = readFileSync(f); } catch { continue; }
    // The path goes into the hash under its BASENAME, not its absolute path: the same
    // build installed under ~/.ai-os and under a repo checkout must hash identically, or
    // every consumer would report a permanent false mismatch after a move.
    h.update(basename(f));
    h.update("\0");
    h.update(createHash("sha256").update(buf).digest("hex"));
    h.update("\n");
    if (st.mtimeMs > newest) newest = st.mtimeMs;
  }
  return {
    hash: h.digest("hex").slice(0, 12),
    mtime_ms: newest,
    mtime_iso: new Date(newest).toISOString(),
    file_count: files.length,
    entry,
  };
}

// One stamp per process, computed at first use. A server that recomputed per call would
// report the CURRENT disk state, which is the opposite of the question being asked.
const _booted = new Map();

/**
 * The build this process booted with, for `_meta.booted_build`. Also writes the run-dir
 * record on first call so other processes can see it.
 * @returns {object|null} the stamp, or null when disabled / entry unresolvable.
 */
export function bootedBuild(serverName, entryFile = process.argv[1], runDir = RUN_DIR) {
  if (!buildStampEnabled()) return null;
  const key = sanitizeName(serverName);
  if (_booted.has(key)) return _booted.get(key);

  const stamp = entryFile ? stampFor(entryFile) : null;
  _booted.set(key, stamp);
  if (stamp && isStdioServerInvocation()) writeBootRecord(serverName, stamp, runDir);
  return stamp;
}

// Only a LONG-LIVED stdio server gets a run-dir record. Several servers double as one-shot
// CLIs — safe-exec-mcp's `--check` runs on every Bash tool call through the PreToolUse hook —
// and those processes are gone microseconds later. Recording them would put a file write on
// the hook's hot path and fill the run dir with records the next scan only has to reap.
//
// The discriminator is argv shape, which is exactly how the two modes differ: .mcp.json
// launches a server as `node <entry>` with no arguments, while every CLI mode is selected by
// a flag. (`--no-warnings` goes to node, not the script, so it never reaches argv here.)
export function isStdioServerInvocation() {
  return process.argv.length <= 2;
}

/** Test seam — forget the per-process cache. */
export function _resetBootedBuild() { _booted.clear(); }

// Writing the record must never break a server's startup: a read-only HOME, a full disk or
// a racing sibling are all survivable, and the only cost is that staleness goes
// unannounced for that server.
export function writeBootRecord(serverName, stamp, runDir = RUN_DIR) {
  try {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    writeFileSync(recordPathFor(serverName, runDir), JSON.stringify({
      server: serverName,
      pid: process.pid,
      entry: stamp.entry,
      hash: stamp.hash,
      mtime_ms: stamp.mtime_ms,
      booted_at: new Date().toISOString(),
    }, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

// `process.kill(pid, 0)` sends no signal; it only asks whether the pid can be signalled.
// EPERM means the process EXISTS but belongs to someone else — still alive, so it must not
// be read as dead. Only ESRCH is death.
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e && e.code === "EPERM"; }
}

/**
 * Every running server whose booted build no longer matches what is on disk.
 * @returns {Array<{server:string, booted_at:string, booted_hash:string,
 *                  current_hash:string, mirror_changed_at:string, entry:string}>}
 */
export function listStaleServers({ runDir = RUN_DIR, reap = true } = {}) {
  if (!buildStampEnabled()) return [];
  let names = [];
  try { names = readdirSync(runDir); } catch { return []; }

  const stale = [];
  for (const n of names.sort()) {
    if (!n.startsWith(RECORD_PREFIX) || !n.endsWith(RECORD_SUFFIX)) continue;
    const p = join(runDir, n);
    let rec;
    try { rec = JSON.parse(readFileSync(p, "utf8")); } catch { continue; }
    if (!rec || typeof rec !== "object" || !rec.entry || !rec.hash) continue;

    // A record for a process that has exited is not evidence about anything running. Reap
    // it, so a machine that has started hundreds of short-lived servers does not accumulate
    // records that make every scan slower and no scan more truthful.
    if (!pidAlive(rec.pid)) {
      if (reap) { try { unlinkSync(p); } catch { /* another scan won the race */ } }
      continue;
    }

    const current = stampFor(rec.entry);
    if (!current || current.hash === rec.hash) continue;
    stale.push({
      server: rec.server || n.slice(RECORD_PREFIX.length, -RECORD_SUFFIX.length),
      booted_at: rec.booted_at || new Date(rec.mtime_ms || 0).toISOString(),
      booted_hash: rec.hash,
      current_hash: current.hash,
      mirror_changed_at: current.mtime_iso,
      entry: rec.entry,
    });
  }
  return stale;
}

// ── The task-completion gate (D-067 §3, third bullet) ────────────────────────────────
//
// The ruling asks that a task whose diff touched `src/mcp/**` or `src/bin/**` not be
// marked DONE without evidence of `bash install-ai-os.sh` plus a server restart, because
// "the three CI-only failures this sprint were all a laptop mirror a release behind".
//
// The evidence is taken from STATE, not from prose. A LOG line saying `bash
// install-ai-os.sh` is evidence that the words were typed; a mirror that matches src/ is
// evidence that the install happened. The two questions the gate actually asks are
// therefore direct ones, and neither needs a git diff:
//
//   1. Does the mirror still differ from src/ under the gated roots?  → install not run.
//   2. Is any RUNNING server serving a build that is no longer on disk? → not restarted.
//
// Asking (1) this way also removes the need to reconstruct "the task's diff", which is
// not knowable from a task id: a task's changes may be uncommitted, on a branch, or
// already merged. If the operator touched nothing under those roots, src/ and the mirror
// agree and the gate is silent — which is the same answer a perfect diff would give.
export const GATED_ROOTS = ["mcp", "bin"];

const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__"]);

// Files the INSTALL itself rewrites. `ai mcp-setup` runs `npm install` inside the mirror,
// which regenerates every lockfile there — so a lockfile under the mirror differs from the
// one in src/ permanently and by design (the repo pins `^1.0.0`, the installed tree
// resolves `*`). Comparing them would make the gate fire on every task forever, and a gate
// that can never be satisfied is one the operator learns to disable — which costs more
// than the gate was ever worth. The question is whether a RUNNING SERVER is executing old
// code; a lockfile is not code.
const SKIP_NAMES = new Set(["package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml"]);

function walkFiles(dir, base = dir, out = []) {
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name) || SKIP_NAMES.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, base, out);
    else if (e.isFile()) out.push(p.slice(base.length + 1));
  }
  return out;
}

function fileDigest(p) {
  try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return null; }
}

/**
 * Files under the gated roots where the repo and the install mirror disagree.
 * @returns {{installed:boolean, drift:string[], truncated:boolean}} `installed:false` when
 *          there is no mirror to be behind (a fresh clone) — the gate stays silent, since
 *          an absent mirror cannot serve stale code to anyone.
 */
export function mirrorDrift({ repoRoot, mirrorRoot = join(homedir(), ".ai-os"),
                              roots = GATED_ROOTS, limit = 20,
                              frameworkOnly = true } = {}) {
  if (!repoRoot || !existsSync(join(repoRoot, "src"))) return { installed: false, drift: [], truncated: false };
  if (!existsSync(mirrorRoot)) return { installed: false, drift: [], truncated: false };
  // Only the framework clone has a src/ tree the mirror is a copy OF. A downstream project
  // with its own `src/bin/` would otherwise be compared against ~/.ai-os/bin and told every
  // one of its own files had "drifted" — the gate would fire on projects that do not ship
  // AI-OS at all. (`frameworkOnly:false` is the seam the tests use with a fixture pair.)
  if (frameworkOnly && !isFrameworkClone(repoRoot)) return { installed: false, drift: [], truncated: false };

  const drift = [];
  let truncated = false;
  for (const root of roots) {
    const srcDir = join(repoRoot, "src", root);
    if (!existsSync(srcDir)) continue;
    for (const rel of walkFiles(srcDir)) {
      if (drift.length >= limit) { truncated = true; break; }
      const a = join(srcDir, rel);
      const b = join(mirrorRoot, root, rel);
      if (!existsSync(b) || fileDigest(a) !== fileDigest(b)) drift.push(`src/${root}/${rel}`);
    }
    if (truncated) break;
  }
  return { installed: true, drift, truncated };
}

/**
 * The completion gate itself.
 * @returns {{ok:true}|{ok:false, code:string, message:string}}
 */
export function checkCompletionBuildGate({ repoRoot, mirrorRoot, runDir, frameworkOnly } = {}) {
  if (!buildStampEnabled()) return { ok: true };

  const { installed, drift, truncated } = mirrorDrift({
    repoRoot, mirrorRoot, ...(frameworkOnly === undefined ? {} : { frameworkOnly }),
  });
  if (installed && drift.length > 0) {
    const shown = drift.slice(0, 8).map(d => `    • ${d}`).join("\n");
    return {
      ok: false,
      code: "BUILD_STALE",
      message:
        `✗ [BUILD_STALE] ${drift.length}${truncated ? "+" : ""} file(s) under src/mcp/ or src/bin/ differ from the install mirror:\n` +
        `${shown}${drift.length > 8 ? `\n    • …and ${drift.length - 8} more` : ""}\n\n` +
        `  Server and CLI code only reaches a running session through the mirror, and an MCP\n` +
        `  server serves whatever it imported at startup (D-067 §3). Marking this DONE now\n` +
        `  records work that nothing in this session is actually running.\n\n` +
        `  Fix: bash install-ai-os.sh, then restart the MCP servers, then mark DONE.\n` +
        `  Rollback: AI_OS_BUILD_STAMP=0 disables this gate.`,
    };
  }

  const stale = listStaleServers({ ...(runDir ? { runDir } : {}) });
  if (stale.length > 0) {
    return {
      ok: false,
      code: "BUILD_STALE",
      message:
        `✗ [BUILD_STALE] the mirror is current but ${stale.length} running server(s) booted an older build:\n` +
        formatStaleLines(stale).map(l => `    ${l}`).join("\n") + "\n\n" +
        `  ESM caches modules for the process lifetime, so these servers are still serving the\n` +
        `  code they started with — including any gate that would have reviewed this task.\n\n` +
        `  Fix: restart the MCP servers, then mark DONE.\n` +
        `  Rollback: AI_OS_BUILD_STAMP=0 disables this gate.`,
    };
  }

  return { ok: true };
}

/** The single message shape every consumer prints (D-067 §3). */
export function formatStaleLines(stale) {
  return (stale || []).map(s =>
    `[STALE_SERVER] ${s.server} booted ${s.booted_at}, mirror changed ${s.mirror_changed_at} — restart required`);
}

/** Convenience for the five consumers: compute and format in one call. */
export function staleServerReport(opts = {}) {
  return formatStaleLines(listStaleServers(opts));
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────
// `ai doctor`, `ai sync` and install-ai-os.sh are shell; they read this through the CLI
// rather than reimplementing the scan, so there is one definition of "stale" in the tree.
// Exit code is ALWAYS 0: staleness is an announcement, not a failure, and a non-zero exit
// here would abort `ai sync` under `set -e` — the exact class of defect E-247 just fixed.
function main(argv) {
  const args = argv.slice(2);
  if (args.includes("--stale") || args.includes("--stale-json")) {
    const stale = listStaleServers();
    if (args.includes("--stale-json")) process.stdout.write(JSON.stringify(stale) + "\n");
    else for (const line of formatStaleLines(stale)) process.stdout.write(line + "\n");
    return 0;
  }
  if (args.includes("--stamp")) {
    const i = args.indexOf("--stamp");
    const entry = args[i + 1];
    process.stdout.write(JSON.stringify(entry ? stampFor(entry) : null) + "\n");
    return 0;
  }
  process.stderr.write("usage: build-stamp.mjs --stale | --stale-json | --stamp <entry-file>\n");
  return 0;
}

// Run-directly detection, matching the src/shared convention (insights-staleness.mjs) but
// via pathToFileURL, which encodes a path containing spaces the way import.meta.url does.
// Note the standing limitation of every argv[1]-based check in this tree: `node -e '…'
// <this-file>` puts the module's own path in argv[1] and reads as "run directly". That is
// the program-position hazard D-061 ruled on, in its ESM form — so callers pass this
// module's path in the environment, never as the first argument.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv));
}
