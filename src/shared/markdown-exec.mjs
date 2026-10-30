// markdown-exec.mjs — which lines of a markdown file are CODE and which are PROSE
// (E-224, D-058 §3).
//
// WHY THIS EXISTS:
//   `run_review` graded every added line the same way, so the Architect's own D-057 prose
//   in `.ai/DECISIONS.md` tripped a P0 PATH_TRAVERSAL — it QUOTES `join(req.path, "../")`
//   as the example of what must stay blocking. A review gate that blocks the document
//   describing the gate is the same over-block E-222 set out to remove, one layer up.
//
//   The obvious fix — skip `.md` — is the dangerous one, and it is why this file exists
//   rather than a one-line filter. Skill files carry `!`-prefixed lines that the harness
//   AUTO-EXECUTES at session start, and `src/shared/skills/rein-preflight/SKILL.md:18` is
//   exactly such a line resolving a helper cwd-relative (T-LOCATOR-001, still open at the
//   time of writing). Skipping markdown would blind the gate to the one class of markdown
//   that genuinely runs.
//
//   So: `!`-lines and fences tagged with an executable language are CODE; everything else
//   in a markdown file is DOCUMENTATION. PATH_TRAVERSAL applies to code lines only.
//   HARDCODED_SECRET keeps applying everywhere — a leaked credential in prose is still a
//   leaked credential.

/** Fence tags whose contents are executed, or are close enough that we grade them. */
export const EXECUTABLE_FENCE_TAGS = new Set([
  "bash", "sh", "zsh", "shell", "console",
  "js", "mjs", "cjs", "javascript", "node",
  "python", "py",
]);

/** Files whose `!`-lines the harness auto-executes. */
// Claude Code auto-executes `!`-lines in slash-command markdown too
// (`.claude/commands/**.md`), not only in SKILL.md and agent files. Anchored to the
// tool's own directories rather than any path containing `commands/` — an unanchored
// `.*\/commands\/` would also grade `docs/commands/usage.md` as code — and it covers
// the NESTED namespaced form `.claude/commands/<ns>/<cmd>.md`, which `[^/]+\.md` missed,
// i.e. the insurance was incomplete in the one place it was meant to apply. Both the
// CANONICAL trees (`src/claude/commands/…`, `src/agents/…`) and the generated mirrors
// count: the standards rule and the commit gate run over `src/`, so covering only the
// mirror would grade a canonical command file as prose exactly where it is enforced —
// inverting the E-201 lesson that `src/` is canonical and mirrors are derived. No file
// exists in this repo today, so nothing is live — but the day one is added, the
// whole E-224/E-225 apparatus would be blind to it, which is the cheapest kind of
// gap to close before it matters.
const SKILL_OR_AGENT =
  /(^|\/)(SKILL\.md|.*\/agents\/[^/]+\.md|(?:\.|src\/)(?:claude|agents)\/commands\/.*\.md)$/;

/** `.ai/` documentation, where an executable line has no legitimate purpose. */
const PROSE_ONLY = /(^|\/)\.ai\/([^/]+\.md|blueprints\/.*\.md)$/;

export function isSkillOrAgentFile(path) {
  return SKILL_OR_AGENT.test(String(path || ""));
}

export function isProseOnlyFile(path) {
  return PROSE_ONLY.test(String(path || ""));
}

/**
 * Generated records that carry human prose but are never executed.
 *
 * `.ai/state.json` is the task database's serialised view: it stores every task
 * DESCRIPTION verbatim, so the Architect writing "resolve ../shared/x" into a task
 * registers a `../` in a committed file and blocks the next commit. That is the same
 * defect this module exists to remove — a review gate grading a RECORD as code — one
 * file type over from the markdown case D-058 §3 rules on.
 *
 * Deliberately an exact-path allowlist, not a `.json` rule: `package.json` scripts and
 * config files genuinely can carry paths that matter, and exempting a whole extension to
 * fix one generated file would be the blanket-skip mistake this module was written to
 * avoid. Extending §3 beyond markdown is flagged for the Architect rather than assumed.
 */
const GENERATED_RECORDS = new Set([".ai/state.json"]);

export function isGeneratedRecord(path) {
  return GENERATED_RECORDS.has(String(path || "").replace(/^\.\//, ""));
}

/**
 * E-363 (D-116 r2): a contract table is an INERT INPUT TABLE — rows of commands and paths fed
 * to a gate under test, never run or opened (test-economics.md §Contract tables). Its whole
 * point is to carry attack strings (`../`, `/etc/`), so grading it as code made every table
 * change a P0 that a reviewer had to rule a false positive (E-301). Exact shapes only: a JSON
 * file under tests/fixtures/ named `*-cases.json`, or the wave proof `wave1-inputs.json`. A
 * script under tests/fixtures/ (`.mjs`, `.sh`) is still graded. No inline marker: it would
 * move a byte-pinned table's sha. Shared by run_review (PATH_TRAVERSAL, through
 * classifyDiffTraversal) and named in critic_security's checklist.
 */
const INERT_TABLE = /^tests\/fixtures\/(?:[^/]+\/)*(?:[^/]+-cases|wave1-inputs)\.json$/;

export function isInertInputTable(path) {
  return INERT_TABLE.test(String(path || "").replace(/^\.\//, ""));
}

/**
 * Classify every line of a markdown file.
 *
 * @returns {{ executable: Set<number>, bangLines: number[] }} 1-based line numbers.
 *   `bangLines` is reported separately because an executable line appearing in a
 *   prose-only file is itself a finding, not merely a line to grade.
 */
export function classifyMarkdown(content, path = "") {
  const lines = String(content ?? "").split("\n");
  const executable = new Set();
  const bangLines = [];
  const skillish = isSkillOrAgentFile(path);

  let fenceTag = null;   // non-null while inside a fenced block
  let fenceMark = "";    // the exact ``` or ~~~ run that opened it

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const num = i + 1;
    const fence = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)/.exec(line);

    if (fence) {
      if (fenceTag === null) {
        // Opening. The tag decides whether the body is code we grade.
        fenceMark = fence[1][0];
        fenceTag = (fence[2] || "").toLowerCase();
        continue;
      }
      if (fence[1][0] === fenceMark && !fence[2]) {
        // Closing (a bare fence of the same character). A tagged fence inside a fence is
        // body text, not a close — markdown nests by fence LENGTH, and treating any fence
        // as a close would end the block early and mark real code as prose.
        fenceTag = null;
        fenceMark = "";
        continue;
      }
      continue;
    }

    if (fenceTag !== null) {
      if (EXECUTABLE_FENCE_TAGS.has(fenceTag)) executable.add(num);
      continue;
    }

    // A `!`-prefixed line in a skill or agent file is auto-executed by the harness.
    // Outside those files it is ordinary prose ("!" starts plenty of sentences), so the
    // file type is part of the test rather than the prefix alone.
    if (/^\s*[A-Za-z][^:]{0,60}:\s*!/.test(line) || /^\s*!/.test(line)) {
      if (skillish) {
        executable.add(num);
        bangLines.push(num);
      } else if (isProseOnlyFile(path) && /^\s*!/.test(line)) {
        // Recorded even here: `.ai/` docs must contain no executable lines, and the
        // caller decides whether that is a failure.
        bangLines.push(num);
      }
    }
  }
  return { executable, bangLines };
}

/**
 * Walk a unified diff and yield the ADDED lines with their new-file line numbers.
 * @returns {Array<{ file: string, line: number, text: string }>}
 */
export function addedLines(diff) {
  const out = [];
  let file = "";
  let newNum = 0;
  for (const raw of String(diff ?? "").split("\n")) {
    const plusFile = /^\+\+\+ b\/(.*)$/.exec(raw);
    if (plusFile) { file = plusFile[1]; continue; }
    if (/^--- /.test(raw)) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { newNum = Number(hunk[1]); continue; }
    if (!file) continue;
    if (raw.startsWith("+")) { out.push({ file, line: newNum, text: raw }); newNum++; continue; }
    if (raw.startsWith("-") || raw.startsWith("\\")) continue;   // removed / no-newline
    newNum++;                                                     // context line
  }
  return out;
}
