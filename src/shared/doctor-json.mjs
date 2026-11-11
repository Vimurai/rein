#!/usr/bin/env node
// doctor-json.mjs — renders `rein doctor --json` (E-421; D-153 r3, D-155 r5;
// .ai/blueprints/release-artifact.md §Component 5, §Data Model "Doctor document").
//
//   node doctor-json.mjs <records-file> <version>
//
// The records file holds what _dr / _dr_lines appended in src/bin/rein: five NUL-terminated
// fields per record — id, status (ok|warn|fail, or "-" for the line's glyph), line, fix,
// subject. id "+" is a continuation: its line joins the record before it with "\n".
// Prints one JSON document and a newline; nothing else on stdout. node: modules only.

import { readFileSync } from "node:fs";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The blueprint's glyphs, plus the markers doctor also prints: - n/a, ? unknown, ⓘ info, — skipped.
const GLYPH = { "✓": "ok", "○": "ok", "⚠": "warn", "!": "warn", "✗": "fail", "-": "ok", "?": "warn", "ⓘ": "ok", "—": "ok" };

export function statusOf(line) {
  const t = line.trimStart();
  for (const [g, s] of Object.entries(GLYPH)) if (t === g || t.startsWith(`${g} `)) return s;
  return "ok";
}

/** The text after the first "run: " (a continuation line may hold it), up to the end of its
 * line or a " (", " — " or "; " that follows it; null when no line names a command. */
export function fixOf(line) {
  const i = line.indexOf("run: ");
  if (i === -1) return null;
  let f = line.slice(i + 5);
  for (const stop of ["\n", " (", " — ", "; "]) {
    const j = f.indexOf(stop);
    if (j !== -1) f = f.slice(0, j);
  }
  f = f.replace(/[)\s.]+$/, "").trim();
  return f || null;
}

export function render(raw, version) {
  const fields = raw.split("\0");
  const checks = [];
  for (let i = 0; i + 5 <= fields.length; i += 5) {
    const [id, st, line, fix, subject] = fields.slice(i, i + 5);
    if (id === "+") {
      const prev = checks[checks.length - 1];
      if (prev) prev.line += `\n${line.trimStart()}`;
      continue;
    }
    checks.push({
      id,
      subject: subject || null,
      status: st === "ok" || st === "warn" || st === "fail" ? st : statusOf(line),
      line: line.trimStart(),
      fix: fix || null,
    });
  }
  // (id, subject) is unique within a document: a repeat without its own subject is numbered.
  const seen = new Map();
  for (const c of checks) {
    const k = `${c.id}\0${c.subject ?? ""}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n > 1) c.subject = `${c.subject ?? ""}#${n}`;
  }
  for (const c of checks) if (!c.fix && c.status !== "ok") c.fix = fixOf(c.line);
  const status = checks.some((c) => c.status === "fail") ? "fail" : checks.some((c) => c.status === "warn") ? "warn" : "ok";
  return { schema: 1, version, status, checks };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const [file, version] = process.argv.slice(2);
  if (!file || !version) {
    process.stderr.write("usage: doctor-json.mjs <records-file> <version>\n");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(render(readFileSync(file, "utf8"), version))}\n`);
}
