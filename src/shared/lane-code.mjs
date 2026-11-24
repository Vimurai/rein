// lane-code.mjs — the [LANE_CODE] report (D-172 addendum 1 r24, E-462, T-SANDBOXLANE-001 F8).
//
// WHY THIS EXISTS:
//   The Architect's lane (.ai/ and plans/) is inside the project by design, so a tool the
//   Engineer points at the whole tree reads it: `node --test` at the root collected an
//   Architect-written plans/zz.test.mjs and ran it with the Engineer's src/ write (F8). F8 is
//   an accepted residual; this is its detective control. Every file under .ai/ and plans/,
//   tracked or not (untracked and git-ignored files count, and no sub-directory is skipped),
//   whose extension is not a record's is named in one line. Nothing is printed when there are
//   none.
//
// Callers (one copy of the rule, two places it is shown):
//   hooks/session-start.sh  — the Engineer's session brief, as an anomaly line
//   src/shared/cli-bookkeeping.mjs — `rein handoff`, as a note under the wake line
//
// CLI: node lane-code.mjs [<project root>]   → the line on stdout, or nothing; always exit 0.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isMainModule } from "../mcp/shared/is-main.mjs";

/** The record extensions D-172 a1 r24 allows (compared lower-case). */
// D-172 a1 r25 adds .svg .html .png .gif .jpg .pdf (records and drawings, not code a tool loads).
export const LANE_ALLOWED_EXT = Object.freeze([".md", ".json", ".txt", ".yml", ".yaml", ".tsv", ".sqlite", ".log",
  ".svg", ".html", ".png", ".gif", ".jpg", ".pdf"]);
/** D-172 a1 r25: Rein's own lane files, exempt by exact path. No other dotfile is. */
export const LANE_EXEMPT_PATHS = Object.freeze([".ai/.gitignore", ".ai/.last-import-blob"]);
/** sqlite's side files of an allowed `.sqlite` database. */
const SQLITE_SIDE = /\.sqlite-(wal|shm)$/;
export const LANE_DIRS = Object.freeze([".ai", "plans"]);
/** A bound on the walk, so a pathological tree cannot stall a session start. */
const MAX_ENTRIES = 20000;

/** @returns {boolean} whether a file's NAME is a record the lanes may hold. */
export function laneAllowed(name) {
  const n = String(name).toLowerCase();
  if (SQLITE_SIDE.test(n)) return true;
  const dot = n.lastIndexOf(".");
  // A dotfile with no further dot (`.gitignore`) has no extension, as path.extname says.
  if (dot <= 0) return false;
  return LANE_ALLOWED_EXT.includes(n.slice(dot));
}

/**
 * Every file under <root>/.ai and <root>/plans whose name is not a record, as paths relative
 * to root (forward slashes), sorted. Symlinks are reported by name and never followed.
 * @returns {{files: string[], partial: boolean}} partial: the walk hit MAX_ENTRIES.
 */
export function laneCodeFiles(root) {
  const files = [];
  let seen = 0;
  let partial = false;
  const walk = (abs, rel) => {
    let ents;
    try { ents = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (++seen > MAX_ENTRIES) { partial = true; return; }
      const r = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(join(abs, e.name), r);
      else if (!laneAllowed(e.name) && !LANE_EXEMPT_PATHS.includes(r)) files.push(r);
      if (partial) return;
    }
  };
  for (const d of LANE_DIRS) if (!partial) walk(join(resolve(root), d), d);
  return { files: files.sort(), partial };
}

/**
 * The one [LANE_CODE] line, or "" when the lanes hold only records. At most `show` paths are
 * named and the line stays under `width` characters (the session brief cuts an anomaly at 400).
 */
export function laneCodeLine(root, { show = 10, width = 380 } = {}) {
  const { files, partial } = laneCodeFiles(root);
  if (!files.length) return "";
  const head = `[LANE_CODE] ${files.length}${partial ? "+" : ""} file(s) under .ai/ or plans/ are not records (F8, D-172 a1 r24): `;
  const tail = " — read them first; point a test runner at its test dirs, not the root";
  const named = [];
  for (const f of files.slice(0, show)) {
    const rest = files.length - named.length - 1;
    const more = rest > 0 ? ` (+${rest} more)` : "";
    if ((head + [...named, f].join(", ") + more + tail).length > width) break;
    named.push(f);
  }
  const rest = files.length - named.length;
  const list = named.length ? named.join(", ") + (rest > 0 ? ` (+${rest} more)` : "") : `${files.length} not named`;
  return head + list + tail;
}

if (isMainModule(import.meta.url)) {
  try {
    const line = laneCodeLine(process.argv[2] || process.cwd());
    if (line) process.stdout.write(line + "\n");
  } catch { /* a report never fails its caller */ }
  process.exit(0);
}
