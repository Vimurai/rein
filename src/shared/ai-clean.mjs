#!/usr/bin/env node
// ai-clean.mjs — the writer behind `ai clean` (E-272, D-074, version-lifecycle.md
// §Component 4). The scan lives in legacy-registry.mjs and has no removal code at all;
// this file is the only place that moves or signals anything.
//
//   node ai-clean.mjs plan    --project <root> [--scope all|project|home] [--json]
//   node ai-clean.mjs apply   --project <root> [--all] [--scope …] [--json]
//   node ai-clean.mjs restore --date <YYYY-MM-DD>
//   node ai-clean.mjs purge   [--older-than 30d]
//   node ai-clean.mjs doctor  --project <root>
//
// Exit codes (§API): 0 nothing (more) to do, 1 findings remain, 2 a trash failure.
// The interactive confirmation is NOT here: `ai clean` in src/bin/ai owns the terminal
// and refuses on a non-interactive stdin without --yes, exactly as `ai start --kill`
// does. This process is therefore safe to drive from a script or a test.
//
// NOTHING IS DELETED. Every removal is a MOVE into ~/.rein/trash/<date>/ beside a
// manifest that records the origin, the class, the registry entry and the sha256 — so
// `--restore <date>` is a real rollback and not a promise. A housekeeping command that
// can lose data is one an operator will never run, which would make the whole registry
// pointless.

import {
  existsSync, mkdirSync, renameSync, rmSync, rmdirSync, cpSync, readFileSync, writeFileSync,
  appendFileSync, readdirSync, lstatSync, statSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { scan, summarize, sha256File, registryPath } from "./legacy-registry.mjs";
import { redact } from "./publish-scan.mjs"; // E-379 (D-130)

const DEFAULT_RETENTION_DAYS = 30;

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all" || a === "--json" || a === "--yes") o[a.slice(2)] = true;
    else if (a.startsWith("--")) o[a.slice(2)] = argv[++i];
    else o._.push(a);
  }
  return o;
}

const today = () => new Date().toISOString().slice(0, 10);
const trashRoot = (home) => join(home, ".rein", "trash");

/** The trash mirrors the origin path, so a restore needs no guessing. */
function trashTargetFor(home, date, origin) {
  return join(trashRoot(home), date, origin.replace(/^\/+/, ""));
}

// ── moving ───────────────────────────────────────────────────────────────────

/**
 * Move `from` to `to`, creating parents. A cross-device origin (the $TMPDIR CI work
 * dirs are routinely on another filesystem) falls back to copy + verify + delete: an
 * EXDEV that surfaced as "clean failed" would leave the operator with a 1.3G directory
 * and no way to remove it through the supported command.
 */
function moveInto(from, to) {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
    return "rename";
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    if (!existsSync(to)) throw new Error(`copy to ${to} produced nothing`);
    rmSync(from, { recursive: true, force: true });
    return "copy";
  }
}

// E-346: does the path itself exist (a dangling symlink counts — existsSync would follow it)?
function lexists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

function readManifest(dir) {
  const p = join(dir, "manifest.json");
  if (!existsSync(p)) return [];
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function writeManifest(dir, items) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(items, null, 2) + "\n");
}

// E-352 (D-112 r6): every manifest read-modify-write runs under one lock. Concurrent reapers
// (each `ai sync`, four CI lanes on one HOME) each read the manifest, appended their own moves
// and wrote it back — the last writer won, and the other moves lost the entry --restore needs.
// The lock is an atomic mkdir beside the manifest. A holder killed outright leaves it behind,
// so one older than 60 s is taken over (moved aside first, so two waiters cannot both take it)
// and reported once.
const LOCK_STALE_MS = 60_000;
const _nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const _ageMs = (p) => { try { return Date.now() - statSync(p).mtimeMs; } catch { return null; } };

function lockManifest(dir) {
  const lock = join(dir, "manifest.json.lock");
  for (;;) {
    try { mkdirSync(lock); break; } catch (e) {
      if (e.code === "ENOENT") { mkdirSync(dir, { recursive: true }); continue; }
      if (e.code !== "EEXIST") throw e;
    }
    const age = _ageMs(lock);
    if (age === null) continue;                        // released between our mkdir and stat
    if (age <= LOCK_STALE_MS) { _nap(25); continue; }
    const aside = `${lock}.stale-${process.pid}-${Date.now()}`;
    try { renameSync(lock, aside); } catch { continue; } // another waiter took it over first
    // A fresh lock can replace the stale one between our stat and our rename: give it back.
    if ((_ageMs(aside) ?? Infinity) <= LOCK_STALE_MS) { try { renameSync(aside, lock); } catch { /* retaken */ } continue; }
    rmSync(aside, { recursive: true, force: true });
    process.stderr.write(`ai clean: took over a stale lock (held ${Math.round(age / 1000)} s): ${lock}\n`);
  }
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = (sig) => { release(); process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 })[sig]); };
  function release() {
    process.removeListener("exit", release);
    for (const s of signals) process.removeListener(s, onSignal);
    rmSync(lock, { recursive: true, force: true });
    try { rmdirSync(dir); } catch { /* holds a manifest or trash: keep it */ }
  }
  process.once("exit", release);
  for (const s of signals) process.once(s, onSignal);
  return release;
}

// ── processes ────────────────────────────────────────────────────────────────

/** TERM, then KILL if it is still there. Never trashed — a process is not a path. */
function signalProcess(pid) {
  try { process.kill(pid, "SIGTERM"); } catch (e) { if (e.code === "ESRCH") return "gone"; return `TERM failed: ${e.code}`; }
  // Give it the two seconds the watcher needs to release its lock and exit, without
  // spinning the CPU: Atomics.wait on a private buffer is the synchronous sleep.
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (let waited = 0; waited < 2000; waited += 50) {
    try { process.kill(pid, 0); } catch { return "TERM"; }
    Atomics.wait(sleeper, 0, 0, 50);
  }
  try { process.kill(pid, "SIGKILL"); return "KILL"; } catch { return "TERM"; }
}

// ── logging ──────────────────────────────────────────────────────────────────

function logApply({ home, project, action, ids, count }) {
  const ts = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const line = `${ts} | ${project || "(no project)"} | ${action} | ${count} | ${ids.join(",")}\n`;
  try {
    mkdirSync(join(home, ".rein"), { recursive: true });
    appendFileSync(join(home, ".rein", "clean.log"), line);
  } catch { /* the apply already happened; a log failure must not undo it */ }
  const projLog = project ? join(project, ".ai", "LOG.md") : null;
  if (projLog && existsSync(projLog)) {
    const d = ts.slice(0, 10);
    const t = ts.slice(11, 16);
    try {
      appendFileSync(projLog, redact(`${d} ${t} | ai clean | ${action} | ${count} item(s): ${ids.join(", ")}\n`,
        { file: ".ai/LOG.md", aiDir: join(project, ".ai") }));
    } catch { /* same */ }
  }
}

// ── reporting ────────────────────────────────────────────────────────────────

const GROUPS = [
  ["safe", "safe — reproducible from src/ or provably ours"],
  ["prompt", "prompt — may hold your content (needs --all)"],
  ["not-ours", "not ours — reported only, never touched"],
];

// One registry entry can match hundreds of paths — 660 role locks on this machine — and
// a wall of them buries the three findings the operator has to think about. Each entry
// shows a few examples and its count; --json is the full list.
const SHOW_PER_ENTRY = 3;

function render(findings, notes, { applied = [], disabled = false } = {}) {
  const out = [];
  if (!findings.length) out.push("ai clean: no legacy artefacts found.");
  for (const [cls, label] of GROUPS) {
    const rows = findings.filter((f) => f.class === cls);
    if (!rows.length) continue;
    out.push(`${label}  (${rows.length})`);
    const byEntry = new Map();
    for (const f of rows) {
      if (!byEntry.has(f.entry_id)) byEntry.set(f.entry_id, []);
      byEntry.get(f.entry_id).push(f);
    }
    for (const [id, group] of byEntry) {
      for (const f of group.slice(0, SHOW_PER_ENTRY)) {
        const act = f.action === "report" ? "report only" : (f.kind === "process" ? "signal TERM/KILL" : "move to trash");
        out.push(`  ${f.path}`);
        out.push(`      ${f.entry_id} · ${f.kind} · ${f.why} · ${act}`);
        if (f.detail) out.push(`      cwd ${f.detail}`);
      }
      if (group.length > SHOW_PER_ENTRY) {
        out.push(`  … and ${group.length - SHOW_PER_ENTRY} more matching ${id} (--json lists them all)`);
      }
    }
    out.push("");
  }
  for (const n of notes) out.push(`note: ${n}`);
  for (const a of applied) out.push(a);
  if (disabled) out.push("REIN_CLEAN_DISABLE=1 — findings only, nothing was touched.");
  return out.join("\n");
}

/**
 * Exit code for a set of remaining findings. `not-ours` and report-only findings are
 * PERMANENT by design (~/.gemini/ is not ours to remove, a settings allow is rewritten by
 * `ai init`), so counting them as "findings remain" would make the exit code a constant 1
 * on any real machine and therefore useless. Only findings `ai clean` could still act on
 * set exit 1.
 */
function exitFor(findings) {
  return summarize(findings).actionable > 0 ? 1 : 0;
}

// ── commands ─────────────────────────────────────────────────────────────────

function scanFor(o) {
  const home = o.home ? resolve(o.home) : homedir();
  const project = o.project ? resolve(o.project) : null;
  const srcRoots = [];
  const ws = join(home, ".rein", "config", "rein-workspace.txt");
  if (existsSync(ws)) {
    try {
      const w = readFileSync(ws, "utf8").split("\n")[0].trim();
      if (w && existsSync(w)) srcRoots.push(w);
    } catch { /* no clone recorded — not-in-src entries then report nothing */ }
  }
  // Running from the clone itself (dev tree, and every test fixture) still has a source
  // tree even when no install recorded one. Walked up with dirname rather than a parent
  // URL: the CAPABILITIES scanner reads a parent hop in a path expression as traversal
  // (the E-224 shape — a module specifier graded as code), and this file resolves nothing
  // the caller supplied, so there is no reason to argue the point in a waiver. The
  // scanner grades COMMENTS too, so this one says it in words.
  //   …/<repo>/src/shared/ai-clean.mjs → …/<repo>
  const selfRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
  if (existsSync(join(selfRoot, "src", "mcp")) && !srcRoots.includes(selfRoot)) srcRoots.push(selfRoot);

  const result = scan({
    project, home, tmp: o.tmp ? resolve(o.tmp) : tmpdir(), srcRoots,
    scope: o.scope || "all",
    registryPath: o["registry"] || registryPath({ home, repoRoot: srcRoots[0] || null }),
  });
  // E-273: `--only <id,id>` narrows every mode to the named registry entries. `ai sync`
  // uses it to reap dead ~/.rein/run/ records on every run without also acting on the
  // rest of the registry, which stays the operator's explicit `ai clean` decision.
  // Present-but-empty (`--only ""`, or `--only` as the last argument) matches NOTHING: a
  // narrowing flag that silently widened to the whole registry would be the worst reading.
  if ("only" in o) {
    const ids = new Set(String(o.only ?? "").split(",").map((x) => x.trim()).filter(Boolean));
    result.findings = result.findings.filter((f) => ids.has(f.entry_id));
  }
  return { home, project, result };
}

function cmdPlan(o) {
  const { result } = scanFor(o);
  const { findings, notes } = result;
  if (o.json) {
    process.stdout.write(JSON.stringify({ findings, notes, counts: summarize(findings) }, null, 2) + "\n");
  } else {
    process.stdout.write(render(findings, notes) + "\n");
    const c = summarize(findings);
    process.stdout.write(
      `\nai clean (dry run): ${c.safe} safe, ${c.prompt} prompt, ${c["not-ours"]} not ours.\n` +
      (c.safe ? "  remove the safe class with:   ai clean --apply\n" : "") +
      (c.prompt ? "  include the prompt class with: ai clean --apply --all\n" : ""));
  }
  return exitFor(findings);
}

function cmdApply(o) {
  const { home, project, result } = scanFor(o);
  const classes = new Set(o.all ? ["safe", "prompt"] : ["safe"]);
  const targets = result.findings.filter((f) => f.action !== "report" && classes.has(f.class));
  const remaining = result.findings.filter((f) => !targets.includes(f));

  if (!targets.length) {
    if (!o.json) process.stdout.write(render(result.findings, result.notes) + "\nai clean: nothing to remove in the selected classes.\n");
    else process.stdout.write(JSON.stringify({ moved: [], signalled: [], remaining, counts: summarize(result.findings) }, null, 2) + "\n");
    return exitFor(result.findings);
  }

  const date = today();
  const dir = join(trashRoot(home), date);
  const release = targets.some((f) => f.kind !== "process") ? lockManifest(dir) : () => {};
  try { return applyLocked(o, { home, project, result, targets, remaining, date, dir }); }
  finally { release(); }
}

function applyLocked(o, { home, project, result, targets, remaining, date, dir }) {
  const manifest = readManifest(dir);
  const moved = [];
  const signalled = [];
  const failures = [];
  // E-346 (D-109 r3): concurrent reapers (every `ai sync`, four CI lanes sharing one HOME) scan
  // the same dead records. A target another one moved between our scan and our move is GONE —
  // the outcome apply wants — not a failure. It was one, swallowed by the sync step's
  // `|| true`; once sync stopped swallowing it, every concurrent sync reported FAILED.
  const vanished = [];

  for (const f of targets) {
    if (f.kind === "process") {
      const how = signalProcess(f.pid);
      signalled.push({ pid: f.pid, entry_id: f.entry_id, result: how });
      continue;
    }
    let to = trashTargetFor(home, date, f.origin);
    if (!lexists(f.origin)) { vanished.push(f.origin); continue; }
    // A build record is named per server, so the same path dies again the same day. The
    // earlier copy keeps its slot; this one goes beside it (`.1`, `.2`, …), never over it —
    // the manifest records each copy's own trash path, so --restore needs no guessing.
    for (let n = 1; lexists(to); n++) to = `${trashTargetFor(home, date, f.origin)}.${n}`;
    try {
      const sha = f.kind === "file" ? sha256File(f.origin) : null;
      const how = moveInto(f.origin, to);
      const item = {
        origin: f.origin, class: f.class, entry_id: f.entry_id, kind: f.kind,
        sha256: sha, moved_at: new Date().toISOString(), trash: to, via: how,
      };
      manifest.push(item);
      moved.push(item);
    } catch (e) {
      if (e.code === "ENOENT" && !lexists(f.origin)) vanished.push(f.origin);
      else failures.push(`${f.origin}: ${e.message}`);
    }
  }

  if (moved.length) writeManifest(dir, manifest);
  if (moved.length || signalled.length) {
    logApply({
      home, project, action: o.all ? "apply --all" : "apply",
      count: moved.length + signalled.length,
      ids: [...new Set([...moved, ...signalled].map((m) => m.entry_id))],
    });
  }

  if (o.json) {
    process.stdout.write(JSON.stringify({
      trash: moved.length ? dir : null, moved, signalled, vanished, failures, remaining,
      counts: summarize(remaining),
    }, null, 2) + "\n");
  } else {
    const lines = [];
    for (const m of moved) lines.push(`  moved   ${m.origin}  →  ${m.trash}`);
    for (const s of signalled) lines.push(`  ${s.result === "gone" ? "gone   " : "stopped"} pid ${s.pid} (${s.entry_id}, ${s.result})`);
    for (const x of failures) lines.push(`  FAILED  ${x}`);
    process.stdout.write(render(remaining, result.notes, { applied: lines }) + "\n");
    process.stdout.write(
      `\nai clean: ${moved.length} moved to ${dir}, ${signalled.length} process(es) signalled` +
      `${failures.length ? `, ${failures.length} failed` : ""}.\n` +
      (moved.length ? `  undo with: ai clean --restore ${date}\n` : ""));
  }
  if (failures.length) return 2;
  return exitFor(remaining);
}

function cmdRestore(o) {
  const home = o.home ? resolve(o.home) : homedir();
  const date = String(o.date || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    process.stderr.write("ai clean --restore: needs a date in YYYY-MM-DD form (see ~/.rein/trash/)\n");
    return 2;
  }
  const dir = join(trashRoot(home), date);
  if (!existsSync(join(dir, "manifest.json"))) {
    process.stderr.write(`ai clean --restore: nothing recorded for ${date} (${dir})\n`);
    return 2;
  }
  const release = lockManifest(dir);
  try { return restoreLocked(o, { home, date, dir }); }
  finally { release(); }
}

function restoreLocked(o, { home, date, dir }) {
  const manifest = readManifest(dir);
  if (!manifest.length) {
    process.stderr.write(`ai clean --restore: nothing recorded for ${date} (${dir})\n`);
    return 2;
  }
  const kept = [];
  let restored = 0;
  for (const item of manifest) {
    if (existsSync(item.origin)) {
      process.stdout.write(`  refused  ${item.origin} exists again — left in the trash\n`);
      kept.push(item);
      continue;
    }
    if (!existsSync(item.trash)) {
      process.stdout.write(`  missing  ${item.trash} is gone (purged?)\n`);
      continue;
    }
    try {
      moveInto(item.trash, item.origin);
      if (item.sha256) {
        const now = sha256File(item.origin);
        if (now !== item.sha256) process.stdout.write(`  WARNING  ${item.origin} restored with a different hash\n`);
      }
      process.stdout.write(`  restored ${item.origin}\n`);
      restored += 1;
    } catch (e) {
      process.stdout.write(`  FAILED   ${item.origin}: ${e.message}\n`);
      kept.push(item);
    }
  }
  writeManifest(dir, kept);
  logApply({ home, project: o.project ? resolve(o.project) : null, action: `restore ${date}`, count: restored, ids: [...new Set(manifest.map((m) => m.entry_id))] });
  process.stdout.write(`ai clean --restore ${date}: ${restored} restored, ${kept.length} left in the trash.\n`);
  return kept.length ? 1 : 0;
}

function cmdPurge(o) {
  const home = o.home ? resolve(o.home) : homedir();
  const m = String(o["older-than"] || `${DEFAULT_RETENTION_DAYS}d`).match(/^(\d+)d?$/);
  if (!m) {
    process.stderr.write("ai clean --purge: --older-than takes a number of days, e.g. 30d\n");
    return 2;
  }
  const days = Number(m[1]);
  const root = trashRoot(home);
  if (!existsSync(root)) { process.stdout.write("ai clean --purge: the trash is empty.\n"); return 0; }
  const cutoff = Date.now() - days * 86400000;
  let n = 0;
  for (const name of readdirSync(root)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
    const when = Date.parse(`${name}T00:00:00Z`);
    if (!Number.isFinite(when) || when >= cutoff) continue;
    try { rmSync(join(root, name), { recursive: true, force: true }); n += 1; process.stdout.write(`  purged ${name}\n`); }
    catch (e) { process.stdout.write(`  FAILED ${name}: ${e.message}\n`); }
  }
  process.stdout.write(`ai clean --purge: ${n} day-folder(s) older than ${days}d removed.\n`);
  return 0;
}

const MIRROR_ORPHAN_IDS = new Set(["mirror-orphan-mcp", "mirror-orphan-hook"]);

/** The `ai doctor` lines (§Component 6). Never exits non-zero: doctor reports. */
function cmdDoctor(o) {
  const { result } = scanFor(o);
  const c = summarize(result.findings);
  const w = (result.notes.find((n) => n.startsWith("orphan-watcher:")) || "").match(/(\d+) live, (\d+) orphaned/);
  const total = c.safe + c.prompt;
  process.stdout.write(
    total
      ? `  ✗ legacy artefacts: ${c.safe} safe / ${c.prompt} prompt — run: ai clean\n`
      : "  ✓ legacy artefacts: none\n");
  if (w) {
    process.stdout.write(
      Number(w[2]) > 0
        ? `  ✗ watchers: ${w[1]} live, ${w[2]} orphaned — run: ai clean --apply\n`
        : `  ✓ watchers: ${w[1]} live, 0 orphaned\n`);
  }
  if (c["not-ours"]) process.stdout.write(`  - ${c["not-ours"]} path(s) listed as not ours (never touched) — see: ai clean\n`);
  // E-273 (D-074 §Components 6): the install mirror's own orphans, on a line of their own —
  // a mirror that drifted from src/ is an install problem, not project litter.
  const mirror = result.findings.filter((f) => MIRROR_ORPHAN_IDS.has(f.entry_id)).length;
  process.stdout.write(mirror
    ? `  ✗ mirror orphans: ${mirror} — run: ai clean\n`
    : "  ✓ mirror orphans: none\n");
  return 0;
}

export function run(argv) {
  const [cmd, ...rest] = argv;
  const o = parseArgs(rest);
  // §Rollback: the whole feature degrades to a report.
  const disabled = process.env.REIN_CLEAN_DISABLE === "1";
  switch (cmd) {
    case "plan": return cmdPlan(o);
    case "apply":
      if (disabled) {
        const rc = cmdPlan(o);
        process.stdout.write("REIN_CLEAN_DISABLE=1 — findings only, nothing was touched.\n");
        return rc;
      }
      return cmdApply(o);
    case "restore": return disabled ? (process.stderr.write("ai clean: REIN_CLEAN_DISABLE=1 — restore is also disabled.\n"), 2) : cmdRestore(o);
    case "purge": return disabled ? (process.stderr.write("ai clean: REIN_CLEAN_DISABLE=1 — purge is also disabled.\n"), 2) : cmdPurge(o);
    case "doctor": return cmdDoctor(o);
    default:
      process.stderr.write("usage: ai-clean.mjs <plan|apply|restore|purge|doctor> --project <root> [--all] [--json] [--only <entry-id,…>]\n");
      return 2;
  }
}

// Main-module check on REAL paths: argv[1] may be spelled through a symlink (macOS
// /var → /private/var) while import.meta.url is resolved — comparing raw spellings made
// other helpers silently do nothing under `ai ci run` (E-265).
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
    process.stderr.write(`ai clean: ${e.message}\n`);
    process.exitCode = 2;
  }
}
