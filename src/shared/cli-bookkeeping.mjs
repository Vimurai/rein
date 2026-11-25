// cli-bookkeeping.mjs — `rein done`, `rein handoff`, `rein decide` (E-461, D-169 r7,
// .ai/blueprints/lean-core.md §Component 4 and §API).
//
// Three commands replace the bookkeeping skills (rein-task, arch-task, rein-handoff,
// task-planner, decision-recorder, rein-log). A step whose result can be computed is one
// command; the model only writes the entry and sends the wake line these print.
//
//   rein done <id> --summary <text>
//     The task goes DONE through the state layer and the completion gates (runTaskDone, the
//     same path as `rein task done`), then the LOG line is appended and the digest rebuilt.
//     Exit 1 names the missing stamp. A stale build prints one [BUILD_STALE] line, not a refusal.
//   rein handoff --to architect|engineer --file <entry>
//     Writes `---`, `## Handoff — <time> UTC` and `**From**`, then the entry, to .ai/COMM.md
//     (E-475; the time is the commit message's), and commits it with every dirty tracked .ai/ path
//     (D-104, D-147 r1: `git commit --only`, the list taken against HEAD), then prints the
//     short sha and the wake line for SendMessage. It runs `rein archive` first (E-466), and
//     the archive files it writes ride the same commit. Where COMM.md is gitignored (D-175)
//     the entry is written, nothing is staged or committed, the wake line says "not
//     committed" and a [COMM_LOCAL] note follows. Exit 1 when the entry lacks
//     "Next action needed" or holds its own `## Handoff` line ([HANDOFF_HEADING]).
//   rein decide --file <entry>
//     Assigns the next D-number, requires a decision, a reason and a rollback, and appends the
//     entry to .ai/DECISIONS.md. Prints the D-###.
//   rein archive [--logs]
//     Keeps the record small (E-466, lean-core.md §Component 7; record-archive.mjs): COMM.md
//     handoffs older than the last ten, and SECURITY.md and REVIEWS.md sections older than 90
//     days, move to .ai/archive/<FILE>-<year>.md byte for byte. `rein handoff` runs it. Tasks
//     and stamps stay in state: a closed task is printed by `rein task show <id>`, and the DONE
//     gates read the stamps. --logs also moves a non-empty LOG.md and SESSION.md to
//     .ai/archive/YYYY-MM/<name>.<YYYYMMDD_HHMM>.md and starts a fresh LOG.md (from the retired
//     rein-archive skill). Nothing is deleted.
//
// Exit: 0 done; 1 refused (the reason is printed); 2 usage.

import { existsSync, readFileSync, appendFileSync, writeFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { spawnSync } from "node:child_process";
import { isMainModule } from "../mcp/shared/is-main.mjs";
import { runTaskDone, GATE_ROLLBACK_VARS } from "./cli-state.mjs";
import { findAiDir } from "./cli-add-task.mjs";
import { appendLog } from "../mcp/shared/team.mjs";
import { writeDigest } from "./digest-build.mjs";
import { archiveRecord } from "./record-archive.mjs";
import { laneCodeLine } from "./lane-code.mjs";
import { getDbSeeded, regenerateViews } from "../mcp/shared/state-db.js";

const USAGE = `usage: rein done <id> --summary <text>
       rein handoff --to architect|engineer --file <entry>
       rein decide --file <entry>
       rein archive [--logs]`;

const ROLES = { architect: "Architect", engineer: "Engineer" };

function today() { return new Date().toISOString().slice(0, 10); }
function stampUtc() { return new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC"; }

function readEntry(file, cwd) {
  if (!file) return { error: { code: 2, out: USAGE } };
  const p = resolve(cwd, file);
  if (!existsSync(p)) return { error: { code: 1, out: `✗ [ENTRY_MISSING] ${file} does not exist` } };
  const text = readFileSync(p, "utf8");
  if (!text.trim()) return { error: { code: 1, out: `✗ [ENTRY_EMPTY] ${file} is empty` } };
  return { text };
}

/** Parse `--flag value` / `--flag=value` pairs; anything else is a usage error. */
function parseFlags(args, known) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const eq = a.indexOf("=");
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (!known.includes(name)) return null;
    const val = eq > 0 ? a.slice(eq + 1) : args[++i];
    if (val === undefined) return null;
    out[name.slice(2)] = val;
  }
  return out;
}

// ── rein done ───────────────────────────────────────────────────────────────────────
/** @returns {{code:number, out:string}} */
export function runDone(aiDir, id, summary, opts = {}) {
  if (!id || typeof summary !== "string" || !summary.trim()) return { code: 2, out: USAGE };
  const res = runTaskDone(aiDir, String(id).toUpperCase(), summary.trim(), opts);
  if (res.code !== 0 || res.already) return res;
  const lines = [res.out];
  appendLog(aiDir, `${today()} | Claude | ${String(id).toUpperCase()} | ${summary.trim()}`);
  try {
    writeDigest(dirname(resolve(aiDir)));
  } catch (e) {
    lines.push(`[DIGEST_BUILD_FAILED] ${String(e.message).slice(0, 200)} — run: rein digest build`);
  }
  return { code: 0, out: lines.join("\n") };
}

// ── rein handoff ────────────────────────────────────────────────────────────────────
function git(root, args) {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 60000 });
  return { ok: !r.error && r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim() };
}

/** The handoff line: the entry's **Trigger** value, else the first line under "Next action needed". */
export function handoffLine(text) {
  const trig = /^\*\*Trigger\*\*:\s*(.+)$/m.exec(text);
  if (trig) return trig[1].trim();
  const next = /Next action needed[^\n]*\n+([\s\S]*)/.exec(text);
  const first = next ? next[1].split("\n").map((l) => l.replace(/^[-*]\s*/, "").trim()).find(Boolean) : null;
  return first || "handoff";
}

/** @returns {{code:number, out:string}} */
export function runHandoff(aiDir, { to, file } = {}, { cwd = process.cwd() } = {}) {
  const target = ROLES[String(to || "").toLowerCase()];
  if (!target || !file) return { code: 2, out: USAGE };
  const entry = readEntry(file, cwd);
  if (entry.error) return entry.error;
  if (!/Next action needed/.test(entry.text)) {
    return { code: 1, out: `✗ [HANDOFF_INCOMPLETE] ${file} has no "Next action needed" section — say what the ${target} does next` };
  }
  // E-475 (D-174 r7): the command writes the heading; an entry that carries its own is refused.
  if (/^## Handoff/m.test(entry.text)) {
    return { code: 1, out: `✗ [HANDOFF_HEADING] ${file} has its own "## Handoff" line — remove it (and its **From** line): rein handoff writes the heading` };
  }
  const root = dirname(resolve(aiDir));
  if (!git(root, ["rev-parse", "--git-dir"]).ok) return { code: 1, out: `✗ [NOT_A_REPO] ${root} is not a git work tree` };
  // D-175 r1/r4: where the ignore rules cover COMM.md the entry is written and nothing is
  // committed — never add -f (D-104 r2). Whole .ai/ ignored is the owner's choice (quiet);
  // COMM.md alone is a leftover line that `rein sync` removes.
  const commIgnored = git(root, ["check-ignore", "-q", ".ai/COMM.md"]).ok;
  const dirIgnored = commIgnored && git(root, ["check-ignore", "-q", "--no-index", ".ai/"]).ok;
  const from = target === "Architect" ? "Engineer" : "Architect";
  const when = stampUtc();
  const comm = resolve(aiDir, "COMM.md");
  const prev = existsSync(comm) ? readFileSync(comm, "utf8") : "";
  const sep = prev && !prev.endsWith("\n") ? "\n" : "";
  // A `---` line opens the entry unless COMM.md already ends with one; the heading's time is
  // the commit message's.
  const rule = /(^|\n)---\s*$/.test(prev) ? "" : "---\n";
  const body = entry.text.endsWith("\n") ? entry.text : entry.text + "\n";
  const head = `${rule}## Handoff — ${when}\n**From**: ${from} → ${target}\n`;
  if (prev) appendFileSync(comm, sep + head + body); else writeFileSync(comm, head + body);

  // E-466: the record is archived before the commit; the archive files ride it when tracked.
  const notes = [];
  const archived = [];
  try {
    const res = archiveRecord(aiDir);
    for (const f of res.files) {
      const rel = `.ai/archive/${basename(f)}`;
      if (!git(root, ["check-ignore", "-q", rel]).ok) archived.push(rel);
      // D-175 r3: a gitignored .ai/ is the owner's choice — no advice to sync it away.
      else if (!dirIgnored) notes.push(`[ARCHIVE_IGNORED] ${rel} is gitignored here and stays on disk only — run: rein sync`);
    }
    if (res.files.length) notes.push("[RECORD-ARCHIVE]", ...res.lines);
  } catch (e) {
    notes.push(`[ARCHIVE_FAILED] ${String(e.message).slice(0, 300)} — the handoff goes on; run: rein archive`);
  }

  const verb = target === "Architect" ? "review and plan next" : "execute the OPEN queue";
  const to_ = `SendMessage to "${basename(root)} · ${target}": ${handoffLine(entry.text)} — ${verb}.`;
  // D-172 addendum 1 r24 (F8): name any file in the lanes that is not a record.
  const laneNote = () => { try { const lc = laneCodeLine(root); if (lc) notes.push(lc); } catch { /* never fails the handoff */ } };
  if (commIgnored) {
    const what = dirIgnored ? ".ai/" : ".ai/COMM.md";
    const wake = `${to_} Details: .ai/COMM.md handoff ${when} (not committed: ${what} is gitignored here).`;
    const local = dirIgnored
      ? "[COMM_LOCAL] .ai/COMM.md is gitignored here; the handoff is on this disk only"
      : "[COMM_LOCAL] .ai/COMM.md alone is gitignored in this clone; the handoff is on this disk only — run: rein sync to track it";
    laneNote();
    return { code: 0, out: [wake, local, ...notes].join("\n") };
  }

  const add = git(root, ["add", "--", ".ai/COMM.md", ...archived]);
  if (!add.ok) return { code: 1, out: `✗ [HANDOFF_COMMIT_FAILED] git add .ai/COMM.md: ${add.err.slice(0, 300)}` };
  // D-147 r1 / addendum r1: every tracked .ai/ path that differs from HEAD rides the commit,
  // staged or not; --only commits exactly these, whatever else the index holds.
  const hasHead = git(root, ["rev-parse", "--verify", "-q", "HEAD"]).ok;
  const dirty = hasHead
    ? git(root, ["diff", "--name-only", "HEAD", "--", ".ai/", ":(exclude).ai/COMM.md"]).out.split("\n").filter(Boolean)
    : [];
  const msg = `chore(.ai): COMM handoff ${when} (${from})`;
  const only = [...new Set([".ai/COMM.md", ...archived, ...dirty])];
  const commit = git(root, ["commit", "-q", "--only", ...only, "-m", msg]);
  if (!commit.ok) return { code: 1, out: `✗ [HANDOFF_COMMIT_FAILED] ${(commit.err || commit.out).slice(0, 600)}` };
  const sha = git(root, ["rev-parse", "--short", "HEAD"]).out;
  const wake = `${to_} Details: .ai/COMM.md handoff ${when}, commit ${sha}.`;
  laneNote();
  return { code: 0, out: [sha, wake, ...notes].join("\n") };
}

// ── rein decide ─────────────────────────────────────────────────────────────────────
/** The parts a decision entry must carry; @returns the names of the missing ones. */
export function missingDecisionParts(text) {
  const missing = [];
  if (!/^##\s+\S/m.test(text)) missing.push("a '## <title>' heading");
  if (!/^\*\*Decision\*\*:\s*\S/m.test(text)) missing.push("a decision ('**Decision**: <one sentence>')");
  if (!/^(###\s+Why\b[^\n]*\n+\s*\S|\*\*(Why|Reason)\*\*:\s*\S|###\s+Reason\b[^\n]*\n+\s*\S)/m.test(text)) {
    missing.push("a reason ('### Why needed' with text)");
  }
  if (!/^(###\s+Rollback\b[^\n]*\n+\s*(?!---)\S|\*\*Rollback\*\*:\s*\S)/m.test(text)) missing.push("a rollback ('### Rollback' with text)");
  return missing;
}

/** The next D-number: the highest `## D-<n>` heading plus one. */
export function nextDecisionId(decisionsText) {
  let max = 0;
  for (const m of decisionsText.matchAll(/^## D-(\d+)\b/gm)) max = Math.max(max, Number(m[1]));
  return `D-${String(max + 1).padStart(3, "0")}`;
}

/** @returns {{code:number, out:string}} */
export function runDecide(aiDir, { file } = {}, { cwd = process.cwd() } = {}) {
  if (!file) return { code: 2, out: USAGE };
  const entry = readEntry(file, cwd);
  if (entry.error) return entry.error;
  const missing = missingDecisionParts(entry.text);
  if (missing.length) return { code: 1, out: `✗ [DECISION_INCOMPLETE] ${file} lacks ${missing.join(", ")}` };
  const path = resolve(aiDir, "DECISIONS.md");
  const prev = existsSync(path) ? readFileSync(path, "utf8") : "# DECISIONS\n";
  const id = nextDecisionId(prev);
  // The entry's own heading may carry a placeholder id (`## D-### — title`); the command numbers it.
  let text = entry.text.replace(/^##\s+(?:D-[\dX#?]+\s*—\s*)?(.+)$/m, (_, t) => `## ${id} — ${t.trim()}`);
  if (!/^\*\*Date\*\*:/m.test(text)) text = text.replace(/^(## D-\d+ — .*)$/m, `$1\n\n**Date**: ${today()}`);
  text = text.replace(/^\s*(---\s*\n)?/, "").replace(/\s*(\n---\s*)?$/, "");
  const sep = prev.trimEnd().endsWith("---") ? "\n\n" : "\n\n---\n\n";
  writeFileSync(path, prev.trimEnd() + sep + text + "\n\n---\n");
  return { code: 0, out: id };
}

const LOG_HEADER = "# LOG (Append-only)\nFormat: YYYY-MM-DD HH:MM | Actor | Tool | File\n\n";
const ROTATED_LOGS = ["LOG.md", "SESSION.md"];

/** @returns {{code:number, out:string}} */
export function runArchive(aiDir, { logs = false } = {}, now = new Date()) {
  if (!aiDir || !existsSync(aiDir)) return { code: 1, out: "✗ No .ai/ directory found. Run: rein init" };
  // The views are rebuilt first, so TASKS.md is open-only and REVIEWS.md current (E-466).
  if (existsSync(resolve(aiDir, "state.json")) || existsSync(resolve(aiDir, "state.sqlite"))) regenerateViews(aiDir, getDbSeeded(aiDir));
  const lines = ["✓ [RECORD-ARCHIVE]", ...archiveRecord(aiDir, now).lines];
  if (logs) {
    const iso = now.toISOString();
    const month = iso.slice(0, 7);
    const ts = iso.slice(0, 10).replace(/-/g, "") + "_" + iso.slice(11, 16).replace(":", "");
    const dir = resolve(aiDir, "archive", month);
    for (const name of ROTATED_LOGS) {
      const src = resolve(aiDir, name);
      if (!existsSync(src) || statSync(src).size === 0) continue;
      const dest = resolve(dir, `${name.replace(/\.md$/, "")}.${ts}.md`);
      if (existsSync(dest)) return { code: 1, out: `✗ [ARCHIVE_EXISTS] ${dest} — never overwritten; retry in a minute` };
      mkdirSync(dir, { recursive: true });
      renameSync(src, dest);
      if (name === "LOG.md") writeFileSync(src, LOG_HEADER + `${iso.slice(0, 16).replace("T", " ")} | rein | Archive | LOG.md → ${dest}\n`);
      lines.push(`  ${name} → ${dest}`);
    }
  }
  return { code: 0, out: lines.join("\n") };
}

// ── CLI ─────────────────────────────────────────────────────────────────────────────
export function main(argv, cwd = process.cwd()) {
  const [verb, ...rest] = argv;
  for (const k of GATE_ROLLBACK_VARS) delete process.env[k];   // as cli-state: an env switch is not the operator's
  const aiDir = findAiDir(cwd);
  if (verb === "done") {
    const [id, ...flags] = rest;
    const f = parseFlags(flags, ["--summary"]);
    if (!id || id.startsWith("--") || !f) return { code: 2, out: USAGE };
    return runDone(aiDir, id, f.summary);
  }
  if (verb === "handoff") {
    const f = parseFlags(rest, ["--to", "--file"]);
    return f ? runHandoff(aiDir, f, { cwd }) : { code: 2, out: USAGE };
  }
  if (verb === "decide") {
    const f = parseFlags(rest, ["--file"]);
    return f ? runDecide(aiDir, f, { cwd }) : { code: 2, out: USAGE };
  }
  if (verb === "archive") {
    if (rest.some((a) => a !== "--logs")) return { code: 2, out: USAGE };
    return runArchive(aiDir, { logs: rest.includes("--logs") });
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
