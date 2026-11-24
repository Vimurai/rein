// record-archive.mjs — `rein archive`: keep the hand-written record small (E-466, D-169,
// .ai/blueprints/lean-core.md §Component 7).
//
//   COMM.md      keeps its last ten `## Handoff` sections; everything before the tenth-newest
//                handoff (older handoffs and any note between them) moves.
//   SECURITY.md  a `## ` section whose heading date is more than 90 days old moves. A section
//                with no date in its heading is policy text and stays.
//   REVIEWS.md   a generated view: the lines of stamps dated more than 90 days ago move, and the
//                view then shows only the stamps dated after the newest archived line
//                (record-store.mjs reviewsArchivedThrough). The stamps stay in state.sqlite and
//                state.json, so the DONE gates still read them.
//
// Each moved section goes to .ai/archive/<FILE>-<year>.md byte for byte, oldest first; the
// archive file is written and read back before the source is rewritten, so a crash leaves a
// duplicate, never a loss. Nothing is deleted, and DECISIONS.md is not touched.

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { getDbSeeded, regenerateViews } from "../mcp/shared/state-db.js";
import { stampLineDate } from "../mcp/shared/record-store.mjs";

export const COMM_KEEP = 10;
export const RECORD_KEEP_DAYS = 90;

/** YYYY-MM-DD of `now` minus `days`; a section dated before it is older than `days` days. */
export function cutoffDay(now = new Date(), days = RECORD_KEEP_DAYS) {
  return new Date(now.getTime() - days * 86400000).toISOString().slice(0, 10);
}

/**
 * Split markdown at its `## ` headings, outside fenced code. The parts concatenate back to the
 * input exactly: preamble + every section's text.
 * @returns {{preamble:string, sections:{heading:string, text:string}[]}}
 */
export function splitSections(text) {
  const lines = text.split(/(?<=\n)/);
  let preamble = "";
  const sections = [];
  let fence = null;
  for (const line of lines) {
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) fence = fence === null ? f[1] : (fence === f[1] ? null : fence);
    if (fence === null && !f && /^## /.test(line)) {
      sections.push({ heading: line.replace(/\r?\n$/, ""), text: line });
    } else if (sections.length) {
      sections[sections.length - 1].text += line;
    } else {
      preamble += line;
    }
  }
  return { preamble, sections };
}

/** The first YYYY-MM-DD in a heading, or null. */
export function headingDate(heading) {
  const m = /\b(\d{4}-\d{2}-\d{2})\b/.exec(heading);
  return m ? m[1] : null;
}

/** COMM.md: the sections before the COMM_KEEP-th newest handoff move. */
export function planComm(text, keep = COMM_KEEP) {
  const { preamble, sections } = splitSections(text);
  const handoffs = sections.map((s, i) => (/^## Handoff\b/.test(s.heading) ? i : -1)).filter((i) => i >= 0);
  if (handoffs.length <= keep) return { moved: [], kept: text };
  const cut = handoffs[handoffs.length - keep];
  return {
    moved: sections.slice(0, cut),
    kept: preamble + sections.slice(cut).map((s) => s.text).join(""),
  };
}

/** SECURITY.md (or any dated-section file): a section dated before `cutoff` moves. */
export function planDated(text, cutoff) {
  const { preamble, sections } = splitSections(text);
  const old = (s) => { const d = headingDate(s.heading); return d !== null && d < cutoff; };
  return {
    moved: sections.filter(old),
    kept: preamble + sections.filter((s) => !old(s)).map((s) => s.text).join(""),
  };
}

/** Group moved sections by year (the heading date, else the previous section's year, else now's). */
function byYear(moved, now) {
  const out = new Map();
  let year = null;
  for (const s of moved) {
    const d = headingDate(s.heading);
    year = d ? d.slice(0, 4) : (year || now.toISOString().slice(0, 4));
    out.set(year, (out.get(year) || "") + s.text);
  }
  return out;
}

/** Append `text` to .ai/archive/<stem>-<year>.md and read it back. @returns the path. */
function appendArchive(aiDir, stem, year, text) {
  const dir = resolve(aiDir, "archive");
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `${stem}-${year}.md`);
  if (!existsSync(path)) {
    writeFileSync(path, `# ${stem}.md archive — ${year}\n\nMoved here byte for byte by \`rein archive\` (E-466), oldest first.\n\n`);
  }
  const prev = readFileSync(path, "utf8");
  const sep = prev.endsWith("\n") ? "" : "\n";
  appendFileSync(path, sep + text);
  if (!readFileSync(path, "utf8").endsWith(text)) throw new Error(`[ARCHIVE_READBACK] ${path} does not end with the moved text`);
  return path;
}

function moveSections(aiDir, name, plan, now) {
  if (!plan.moved.length) return null;
  const files = [];
  for (const [year, text] of byYear(plan.moved, now)) files.push(appendArchive(aiDir, name.replace(/\.md$/, ""), year, text));
  writeFileSync(resolve(aiDir, name), plan.kept);
  return { name, moved: plan.moved.length, files };
}

/** REVIEWS.md: the view is regenerated, the old stamp lines are archived, the view regenerated again. */
function archiveReviews(aiDir, cutoff, now) {
  const path = resolve(aiDir, "REVIEWS.md");
  if (!existsSync(path)) return null;
  const old = (l) => { const d = stampLineDate(l); return d !== null && d < cutoff; };
  // The state is opened only when the view has a line to move: an archive run with nothing to
  // do writes no view (a handoff in a project without state creates none).
  if (!readFileSync(path, "utf8").split("\n").some(old)) return null;
  const db = getDbSeeded(aiDir);
  regenerateViews(aiDir, db);                       // move the lines of the current view
  const lines = readFileSync(path, "utf8").split(/(?<=\n)/);
  const moved = lines.filter(old);
  if (!moved.length) return null;
  const years = new Map();
  for (const l of moved) {
    const y = stampLineDate(l).slice(0, 4);
    years.set(y, (years.get(y) || "") + (l.endsWith("\n") ? l : l + "\n"));
  }
  const files = [];
  for (const [year, text] of years) files.push(appendArchive(aiDir, "REVIEWS", year, text));
  regenerateViews(aiDir, db);
  const after = readFileSync(path, "utf8");
  const want = lines.filter((l) => !old(l)).join("");
  const warn = after === want ? null : "[ARCHIVE_VIEW_MISMATCH] REVIEWS.md after the move is not the old view minus the moved lines — run verify_markdown_sync";
  return { name: "REVIEWS.md", moved: moved.length, files, warn };
}

/**
 * Archive COMM.md, SECURITY.md and REVIEWS.md.
 * @returns {{lines:string[], files:string[]}} files: every archive file written.
 */
export function archiveRecord(aiDir, now = new Date()) {
  const cutoff = cutoffDay(now);
  const results = [];
  const comm = resolve(aiDir, "COMM.md");
  if (existsSync(comm)) results.push(moveSections(aiDir, "COMM.md", planComm(readFileSync(comm, "utf8")), now));
  const sec = resolve(aiDir, "SECURITY.md");
  if (existsSync(sec)) results.push(moveSections(aiDir, "SECURITY.md", planDated(readFileSync(sec, "utf8"), cutoff), now));
  results.push(archiveReviews(aiDir, cutoff, now));
  const lines = [];
  const files = [];
  for (const r of results.filter(Boolean)) {
    const rel = r.files.map((f) => `.ai/archive/${f.split("/").pop()}`);
    lines.push(`  ${r.name}: ${r.moved} sections → ${rel.join(", ")}`);
    if (r.warn) lines.push(`  ${r.warn}`);
    files.push(...r.files);
  }
  if (!lines.length) lines.push(`  Nothing to move (COMM.md keeps ${COMM_KEEP} handoffs; SECURITY.md and REVIEWS.md keep ${RECORD_KEEP_DAYS} days, since ${cutoff}).`);
  return { lines, files: [...new Set(files)] };
}
