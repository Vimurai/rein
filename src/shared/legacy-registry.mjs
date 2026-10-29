#!/usr/bin/env node
// legacy-registry.mjs — the loader and scanner for src/config/legacy-artefacts.json
// (E-272, D-074, version-lifecycle.md §Component 3).
//
// WHAT THIS IS. Every AI-OS version leaves things behind: a provider workspace whose
// provider is gone, a shim rulefile, a mirror directory the registry no longer lists, a
// lock for a session that ended months ago. Until now that knowledge lived in prose (the
// D-069 sweep PRINTED `rm -r` hints) or nowhere at all. The registry is the single list,
// as DATA: adding an entry needs no code change here.
//
// WHAT THIS IS NOT. It never deletes and never signals. It answers one question —
// "what, on this machine, matches the registry right now, and why?" — and hands the
// findings to ai-clean.mjs, which is the only writer. Keeping the two apart is what makes
// the dry run trustworthy: the scan cannot have side effects because it has no code for
// them.
//
// THE CLASS IS NOT THE VERDICT. An entry's `class` is its ceiling, not its answer. A
// `safe` entry carrying `known_hashes` is only safe for THIS path if the bytes still hash
// to a version we shipped; a file the operator edited is reported as `prompt` with the
// reason, because their edit outranks our bookkeeping (the E-220 rule, applied to
// removal instead of to sync).

import { createHash } from "node:crypto";
import {
  existsSync, readFileSync, readdirSync, statSync, lstatSync, realpathSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, dirname, basename, resolve, sep } from "node:path";

export const KINDS = new Set(["file", "dir", "setting", "process"]);
export const CLASSES = new Set(["safe", "prompt", "not-ours"]);

// The rule names the loader dispatches. `class: safe` demands one of these OR
// `known_hashes` — a bare `safe` path is rejected, so "remove it, trust me" is not
// expressible in the data.
//
// DIVERGENCE from version-lifecycle.md §API, which enumerates four (not-in-registry,
// dead-pid, not-in-manifest, orphan-process):
//   * `not-in-src` is required by §Component 3's OWN seed list ("~/.ai-os/hooks/<not in
//     src/hooks>", "the six orphaned v2 contracts") — a mirror file is stale exactly when
//     the source tree stopped shipping it, and no hash list can say that.
//   * `stale-mtime` exists because `~/.ai-os/run/role-*.lock` HAS NO PID: the E-129 token
//     is keyed by Claude session id and its record holds {v, role, session_id, hmac}. The
//     blueprint's "(dead pid)" describes an artefact that does not exist. Age is the only
//     signal available, and it is a safe one — SessionStart re-mints a token on resume.
// Both are recorded for the Architect rather than smuggled in as "dead-pid".
export const RULES = new Set([
  "not-in-registry", "not-in-src", "not-in-manifest", "dead-pid", "orphan-process",
  "stale-mtime",
]);

// `not-in-registry` and `orphan-process` are implemented by the kind-specific scanners
// (scanSettingAllows, scanProcesses) rather than as path predicates, so the loader ties
// each to its kind: a rule that has no implementation for the kind it is written against
// would make the entry a permanent silent no-op — the E-251 "scan that never ran" shape.
const RULE_FOR_KIND = { setting: "not-in-registry", process: "orphan-process" };

const DEFAULT_REGISTRY = "config/legacy-artefacts.json";

/** Resolve the registry through the install mirror, then the clone. */
export function registryPath({ home = homedir(), repoRoot = null } = {}) {
  const candidates = [
    join(home, ".ai-os", DEFAULT_REGISTRY),
    ...(repoRoot ? [join(repoRoot, "src", DEFAULT_REGISTRY)] : []),
    resolve(new URL("../config/legacy-artefacts.json", import.meta.url).pathname),
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

/**
 * Load and VALIDATE the registry. Throws on anything malformed: a registry that is
 * half-wrong is worse than one that is missing, because the scan would silently cover
 * less than the operator thinks.
 */
export function loadRegistry(path) {
  if (!path || !existsSync(path)) throw new Error(`legacy registry not found: ${path || "(no path)"}`);
  let reg;
  try {
    reg = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`legacy registry is not valid JSON (${path}): ${e.message}`);
  }
  if (reg.version !== 1) throw new Error(`legacy registry version must be 1, got ${JSON.stringify(reg.version)}`);
  if (!Array.isArray(reg.registry_history)) throw new Error("legacy registry: registry_history must be an array");
  if (!Array.isArray(reg.entries) || reg.entries.length === 0) throw new Error("legacy registry: entries must be a non-empty array");

  const seen = new Set();
  for (const e of reg.entries) {
    const where = `entry ${JSON.stringify(e && e.id)}`;
    if (!e || typeof e.id !== "string" || !e.id) throw new Error("legacy registry: every entry needs a string id");
    if (seen.has(e.id)) throw new Error(`legacy registry: duplicate entry id ${e.id}`);
    seen.add(e.id);
    if (typeof e.path !== "string" || !e.path) throw new Error(`${where}: path must be a non-empty string`);
    if (!KINDS.has(e.kind)) throw new Error(`${where}: kind must be one of ${[...KINDS].join("|")}`);
    if (!CLASSES.has(e.class)) throw new Error(`${where}: class must be one of ${[...CLASSES].join("|")}`);
    if (typeof e.since !== "string" || !e.since) throw new Error(`${where}: since must be a version or "*"`);
    if (e.rule !== undefined && !RULES.has(e.rule)) throw new Error(`${where}: unknown rule ${JSON.stringify(e.rule)}`);
    const required = RULE_FOR_KIND[e.kind];
    if (required) {
      if (e.rule !== required) throw new Error(`${where}: kind ${e.kind} must carry rule ${required}`);
    } else if (e.rule !== undefined && !RULE_FN[e.rule]) {
      throw new Error(`${where}: rule ${e.rule} has no path implementation — it belongs to kind ${Object.keys(RULE_FOR_KIND).find((k) => RULE_FOR_KIND[k] === e.rule)}`);
    }
    if (e.known_hashes !== undefined && !Array.isArray(e.known_hashes)) throw new Error(`${where}: known_hashes must be an array`);
    // §API: a bare `safe` path is rejected by the loader.
    if (e.class === "safe" && !e.rule && !(e.known_hashes || []).length) {
      throw new Error(`${where}: class "safe" needs a rule or known_hashes — a bare safe path is refused`);
    }
    if (e.rule === "stale-mtime" && !(Number(e.max_age_days) > 0)) {
      throw new Error(`${where}: rule stale-mtime needs a positive max_age_days`);
    }
    // Only the LAST segment may hold a wildcard: the matcher reads one directory, so a
    // mid-path `*` would silently match nothing and the entry would look clean forever.
    if (e.kind !== "process" && e.path.replace(/\/+$/, "").split("/").slice(0, -1).some((s) => s.includes("*"))) {
      throw new Error(`${where}: only the last path segment may contain '*' (got ${e.path})`);
    }
  }
  return reg;
}

export function sha256File(p) {
  try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return null; }
}

const isWithin = (root, p) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Longest-first so `~/.ai-os/…` never reports as merely "$HOME". */
function rootFor(roots, p) {
  return Object.entries(roots)
    .filter(([, r]) => r && isWithin(r, p))
    .sort((a, b) => b[1].length - a[1].length)[0] || null;
}

// ── path expansion ───────────────────────────────────────────────────────────

function globToRe(glob) {
  return new RegExp("^" + glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*") + "$");
}

/**
 * Expand one entry's path into absolute candidates that EXIST.
 * `~/…` → HOME, `$TMPDIR/…` → the temp root, anything else → project-relative.
 */
export function expandEntryPaths(entry, ctx) {
  const raw = entry.path.replace(/\/+$/, "");
  let base;
  let rel = raw;
  if (raw.startsWith("~/")) { base = ctx.home; rel = raw.slice(2); }
  else if (raw.startsWith("$TMPDIR/")) { base = ctx.tmp; rel = raw.slice(8); }
  else { base = ctx.project; }
  if (!base) return [];

  const full = join(base, rel);
  const dir = dirname(full);
  const bn = basename(full);
  if (!bn.includes("*")) return existsSync(full) ? [full] : [];

  let names;
  try { names = readdirSync(dir); } catch { return []; }
  const re = globToRe(bn);
  return names.filter((n) => re.test(n)).map((n) => join(dir, n)).sort();
}

// ── rules ────────────────────────────────────────────────────────────────────
// Each returns { stale: boolean, why: string }. `stale: false` means the path is still
// in service and is NOT a finding — the difference between a report that means something
// and a list of everything AI-OS ever wrote.

function pidAlive(pid) {
  if (!(Number.isInteger(pid) && pid > 0)) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function readPid(p, source) {
  try {
    if (source && source.startsWith("json:")) {
      const v = JSON.parse(readFileSync(p, "utf8"))[source.slice(5)];
      return Number.isInteger(v) ? v : Number(v) || null;
    }
    const file = source && source.startsWith("file:") ? join(p, source.slice(5)) : p;
    const m = readFileSync(file, "utf8").match(/\d+/);
    return m ? Number(m[0]) : null;
  } catch { return null; }
}

/** True when ANY pid named by a `guard_pids` glob is alive — something may still own this. */
function guardAlive(entry, ctx) {
  if (!entry.guard_pids) return false;
  for (const p of expandEntryPaths({ ...entry, path: entry.guard_pids, kind: "file" }, ctx)) {
    if (pidAlive(readPid(p, entry.guard_pid_source || null))) return true;
  }
  return false;
}

function ruleNotInSrc(p, entry, ctx) {
  const rel = entry.src_root ? join(entry.src_root, basename(p)) : null;
  if (!rel) return { stale: false, why: "no src_root recorded — cannot prove it is gone" };
  for (const root of ctx.srcRoots) {
    const cand = join(root, rel);
    if (existsSync(cand)) return { stale: false, why: `still shipped at ${rel}` };
  }
  if (!ctx.srcRoots.length) return { stale: false, why: "no source tree available to compare against" };
  return { stale: true, why: `no source tree ships ${rel} any more` };
}

function ruleNotInManifest(p, entry, ctx) {
  const dir = dirname(p);
  const name = basename(p);
  const manifest = ctx.readManifest(dir);
  if (!manifest) return { stale: false, why: "no _SYNC_MANIFEST.json — nothing proves sync wrote it" };
  const recorded = manifest.entries?.[name];
  if (!recorded) return { stale: false, why: "not written by sync (user-authored)" };
  const current = sha256File(existsSync(join(p, "SKILL.md")) ? join(p, "SKILL.md") : p);
  if (current !== recorded) return { stale: false, why: "modified since sync wrote it" };
  if (ctx.manifestSources(dir).includes(name)) return { stale: false, why: "still in the source set" };
  return { stale: true, why: "written by sync, unmodified, no longer in the source set" };
}

function ruleDeadPid(p, entry, ctx) {
  if (guardAlive(entry, ctx)) return { stale: false, why: "a live run still holds the lock" };
  const pid = readPid(p, entry.pid_source || null);
  if (pid === null) {
    return entry.guard_pids
      ? { stale: true, why: "no live run owns it" }
      : { stale: false, why: "no pid recorded — liveness unknown, left alone" };
  }
  return pidAlive(pid)
    ? { stale: false, why: `pid ${pid} is alive` }
    : { stale: true, why: `pid ${pid} is gone` };
}

function ruleStaleMtime(p, entry) {
  const days = Number(entry.max_age_days);
  let mt;
  try { mt = statSync(p).mtimeMs; } catch { return { stale: false, why: "unreadable" }; }
  const age = (Date.now() - mt) / 86400000;
  return age > days
    ? { stale: true, why: `last touched ${age.toFixed(1)}d ago (over ${days}d)` }
    : { stale: false, why: `touched ${age.toFixed(1)}d ago` };
}

const RULE_FN = {
  "not-in-src": ruleNotInSrc,
  "not-in-manifest": ruleNotInManifest,
  "dead-pid": ruleDeadPid,
  "stale-mtime": ruleStaleMtime,
};

// ── processes (kind: process) ────────────────────────────────────────────────

function pidCwd(pid) {
  if (existsSync(`/proc/${pid}/cwd`)) {
    try { return realpathSync(`/proc/${pid}/cwd`); } catch { return null; }
  }
  try {
    const out = execFileSync("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 });
    const line = out.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch { return null; }
}

/**
 * Every process whose command line names the entry's script, split live / orphaned.
 *
 * Orphaned = working in the TEMP ROOT and not the recorded holder of the watcher lock in
 * its own project. Both halves matter: `ai start` runs a watcher from a real project, so
 * a cwd under $TMPDIR means a test fixture, and the lock is what a watcher the operator
 * is USING holds — a housekeeping command must never take that one.
 *
 * ppid is RECORDED but NOT required, though every orphan on this machine had ppid 1. A
 * process whose parent exited but has not been reaped yet still reports the zombie's pid
 * as its parent, so requiring ppid === 1 silently missed orphans — including the suite's
 * own fixtures, which is how this was found. Reparenting is a consequence of the parent
 * being gone, not evidence about the watcher.
 */
export function scanProcesses(entry, ctx) {
  let out = "";
  try {
    out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,command="],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 6000 });
  } catch { return { live: [], orphaned: [] }; }
  const needle = entry.path;
  const live = [];
  const orphaned = [];
  for (const line of out.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const [, pidStr, ppidStr, cmd] = m;
    const pid = Number(pidStr);
    if (pid === process.pid) continue;
    if (!new RegExp(`(^|[/\\s])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(cmd)) continue;
    const cwd = pidCwd(pid);
    const inTmp = !!cwd && !!ctx.tmp && isWithin(ctx.tmp, cwd);
    const holdsLock = !!cwd && readPid(join(cwd, ".ai", ".ai-watch.lock", "pid")) === pid;
    if (inTmp && !holdsLock) {
      orphaned.push({ pid, ppid: Number(ppidStr), cwd, cmd: cmd.trim() });
    } else {
      live.push({ pid, cwd, cmd: cmd.trim() });
    }
  }
  return { live, orphaned };
}

// ── settings (kind: setting) ─────────────────────────────────────────────────

/**
 * `mcp__<server>__*` allow entries for a server registry.json no longer lists. Reported,
 * never rewritten: `ai clean` moves paths to the trash, and a JSON key is not a path.
 * `ai init`/`ai sync` own this file (E-273). settings.local.json is user-owned and is
 * only ever printed.
 */
export function scanSettingAllows(p, ctx) {
  let allows;
  try { allows = JSON.parse(readFileSync(p, "utf8")).permissions?.allow; } catch { return []; }
  if (!Array.isArray(allows)) return [];
  const out = [];
  for (const a of allows) {
    const m = typeof a === "string" && a.match(/^mcp__([A-Za-z0-9_.-]+)__/);
    if (!m) continue;
    const srv = m[1];
    if (ctx.registryServers.has(srv)) continue;
    if (!ctx.registryHistory.has(srv)) continue; // never shipped → the operator's own
    out.push({ allow: a, server: srv });
  }
  return out;
}

// ── the scan ─────────────────────────────────────────────────────────────────

function buildContext({ project, home = homedir(), tmp = tmpdir(), registry, srcRoots = [] }) {
  const servers = new Set();
  for (const root of [join(home, ".ai-os"), ...srcRoots.map((r) => join(r, "src"))]) {
    const p = join(root, "config", "registry.json");
    if (!existsSync(p)) continue;
    try {
      for (const n of Object.keys(JSON.parse(readFileSync(p, "utf8")).mcp_servers || {})) servers.add(n);
    } catch { /* a registry we cannot read must not make every server look retired */ }
  }
  let realTmp = tmp;
  try { realTmp = realpathSync(tmp); } catch { /* keep the spelling we were given */ }
  const manifestCache = new Map();
  return {
    project: project ? resolve(project) : null,
    home: resolve(home),
    tmp: realTmp,
    srcRoots,
    registryServers: servers,
    registryHistory: new Set(registry.registry_history),
    // A registry we could not read anywhere is reported, not guessed around.
    registryReadable: servers.size > 0,
    readManifest(dir) {
      if (!manifestCache.has(dir)) {
        const p = join(dir, "_SYNC_MANIFEST.json");
        let m = null;
        try { const j = JSON.parse(readFileSync(p, "utf8")); if (j.version === 1 && j.entries) m = j; } catch { m = null; }
        manifestCache.set(dir, m);
      }
      return manifestCache.get(dir);
    },
    // The source set for a synced dir is not derivable here without re-deriving the role
    // manifest, so absence from the manifest's own record is the only evidence used.
    manifestSources() { return []; },
  };
}

/**
 * Scan the machine for registry matches.
 * @returns {{findings: object[], notes: string[], registry: object}}
 */
export function scan(opts) {
  const registry = opts.registry || loadRegistry(opts.registryPath || registryPath(opts));
  const ctx = buildContext({ ...opts, registry });
  const scope = opts.scope || "all"; // all | project | home
  const findings = [];
  const notes = [];
  if (!ctx.registryReadable) notes.push("no readable registry.json — settings allows were not audited");

  const roots = { project: ctx.project, home: ctx.home, tmp: ctx.tmp };
  // The same roots, physical: a root reached through a symlink (/var → /private/var) must
  // still contain its own files when the PARENT check below resolves them.
  const realRoots = Object.fromEntries(Object.entries(roots).map(([k, r]) => {
    try { return [k, r ? realpathSync(r) : r]; } catch { return [k, r]; }
  }));

  for (const entry of registry.entries) {
    if (entry.kind === "process") {
      if (scope === "project") continue;
      const { live, orphaned } = scanProcesses(entry, ctx);
      for (const proc of orphaned) {
        findings.push({
          entry_id: entry.id, kind: "process", class: entry.class, path: `pid ${proc.pid}`,
          origin: null, pid: proc.pid, detail: proc.cwd || "(cwd unknown)",
          why: `working in ${ctx.tmp} (ppid ${proc.ppid}), holds no project lock`,
          action: entry.class === "not-ours" ? "report" : "signal",
          note: entry.note || "",
        });
      }
      notes.push(`${entry.id}: ${live.length} live, ${orphaned.length} orphaned`);
      continue;
    }

    const isHomeEntry = entry.path.startsWith("~/") || entry.path.startsWith("$TMPDIR/");
    if (scope === "project" && isHomeEntry) continue;
    if (scope === "home" && !isHomeEntry) continue;
    if (!isHomeEntry && !ctx.project) continue;

    for (const p of expandEntryPaths(entry, ctx)) {
      // Security (§Security): only under the project root, HOME or the temp root, and
      // never through a symlink that leaves them. A symlink is reported, never followed.
      let st;
      try { st = lstatSync(p); } catch { continue; }
      const holder = rootFor(roots, p);
      if (!holder) continue;
      if (st.isSymbolicLink()) {
        findings.push({
          entry_id: entry.id, kind: entry.kind, class: "not-ours", path: p, origin: p,
          why: "a symlink — reported, never followed or moved", action: "report",
          note: entry.note || "",
        });
        continue;
      }
      // lstat covers the LAST segment only. A symlinked parent (a project whose `.ai/` links
      // elsewhere) would otherwise let a project-relative entry move a file out of the link's
      // target — so the parent is resolved and must still lie under the same root.
      let realParent = null;
      try { realParent = realpathSync(dirname(p)); } catch { /* unresolvable → reported below */ }
      if (!realParent || !isWithin(realRoots[holder[0]], join(realParent, basename(p)))) {
        findings.push({
          entry_id: entry.id, kind: entry.kind, class: "not-ours", path: p, origin: p,
          why: "its directory resolves outside the scanned root — reported, never moved", action: "report",
          note: entry.note || "",
        });
        continue;
      }
      if (entry.kind === "dir" && !st.isDirectory()) continue;
      if (entry.kind === "file" && !st.isFile()) continue;

      if (entry.kind === "setting") {
        if (!ctx.registryReadable) continue;
        const hits = scanSettingAllows(p, ctx);
        for (const h of hits) {
          findings.push({
            entry_id: entry.id, kind: "setting", class: entry.class, path: `${p} → ${h.allow}`,
            origin: null, why: `${h.server} is not in registry.json but AI-OS once shipped it`,
            action: "report", note: entry.note || "",
          });
        }
        continue;
      }

      let cls = entry.class;
      let why = "listed in the legacy registry";

      if (entry.rule) {
        const r = RULE_FN[entry.rule](p, entry, ctx);
        if (!r.stale) continue;
        why = r.why;
      }

      // known_hashes: safe only while the bytes are one we shipped.
      if (cls === "safe" && (entry.known_hashes || []).length && st.isFile()) {
        const h = sha256File(p);
        if (!h || !entry.known_hashes.includes(h)) {
          cls = "prompt";
          why = "edited since AI-OS wrote it (no shipped version matches its hash)";
        } else {
          why = "byte-identical to a version AI-OS shipped";
        }
      }

      findings.push({
        entry_id: entry.id, kind: entry.kind, class: cls, path: p, origin: p,
        root: holder[0], why, action: cls === "not-ours" ? "report" : "trash",
        note: entry.note || "",
      });
    }
  }

  return { findings, notes, registry };
}

/** Counts by class, plus how many findings `ai clean` could actually act on. */
export function summarize(findings) {
  const c = { safe: 0, prompt: 0, "not-ours": 0, actionable: 0, report_only: 0 };
  for (const f of findings) {
    c[f.class] = (c[f.class] || 0) + 1;
    if (f.action === "report") c.report_only += 1; else c.actionable += 1;
  }
  return c;
}
