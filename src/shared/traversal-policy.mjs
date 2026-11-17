// traversal-policy.mjs — how `run_review` grades a `../` in a diff (E-222, D-057 §2).
//
// WHY THIS EXISTS:
//   The check was one flat regex — any added line containing `../`, `/etc/` or `/root/`
//   was a P0 that BLOCKED the commit. That is right for a path assembled from runtime
//   input and wrong for the ordinary idiom of resolving a file relative to the script
//   that needs it. It blocked E-220's own fix for a real vulnerability, on a line
//   (`"${_sd}/../shared/sync-manifest.mjs"`) whose shape already existed at four other
//   sites in the same file — they simply were not in that diff.
//
//   A gate that fires on correct code teaches people to route around it, which costs more
//   than the check earns. So the severity now depends on what the `../` is ANCHORED to:
//
//     /etc/ or /root/                          → P0, unchanged
//     `../` anchored to a script-relative base → P1 advisory (still reported)
//     `../` anywhere else                      → P0, unchanged
//
//   Advisory, not silent: a P1 still appears in the report, so a reviewer sees every
//   traversal. Only the BLOCKING changes.
//
// Rollback: REIN_REVIEW_STRICT_TRAVERSAL=1 restores the flat regex (every `../` is P0).

/**
 * Bases that make a `../` script-relative rather than input-relative. Kept as ONE
 * exported constant so the policy has a single definition and the fixtures can enumerate
 * it — a second copy in the checker is how the two would drift apart.
 */
import { classifyMarkdown, addedLines, isProseOnlyFile, isGeneratedRecord, isInertInputTable } from "./markdown-exec.mjs";

/**
 * Build an anchor matcher: the base pattern, then only the characters that can
 * legitimately sit between a script-relative base and the `../` it prefixes.
 *
 * The tail excludes `/`, `;` and `+` deliberately. An earlier cut allowed any non-slash
 * tail, which let a DISTANT anchor excuse an unrelated traversal on the same line —
 * `a("${_sd}"); b(x + "/../")` graded advisory because `${_sd}` appeared earlier in the
 * line, even though the dangerous `../` was concatenated onto a variable. A statement
 * separator or a concatenation between the two means they are not the same path, so the
 * anchor does not vouch for it. Quotes, parens, commas and `&&` stay allowed, because
 * the real idioms are wrapped in them: `join(__dirname, "../x")` and
 * `"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../src"`.
 */
function anchored(base) {
  return new RegExp(base.source + '[^/;+]*\\/?$');
}

export const SCRIPT_RELATIVE_ANCHORS = [
  { name: "__dirname",        re: anchored(/__dirname/) },
  { name: "import.meta.url",  re: anchored(/import\.meta\.url/) },
  { name: "fileURLToPath",    re: anchored(/fileURLToPath\([^)]*\)/) },
  { name: "BASH_SOURCE",      re: anchored(/BASH_SOURCE(\[[^\]]*\])?/) },
  { name: "$0",               re: anchored(/\$0/) },
  // Shell variables conventionally holding "the directory of this script".
  { name: "self_dir",         re: anchored(/\$\{?_?(SELF_DIR|self_dir|_sd|SCRIPT_DIR|script_dir)\}?/) },
  // Install-mirror roots: these are OUR directories, not a path built from input.
  // Bare `~` is deliberately NOT an anchor — too easy to hit in prose, and it does not
  // expand inside the quoted contexts these paths actually appear in.
  { name: "install mirror",   re: anchored(/(\$\{?REIN\}?|\$\{?REIN_HOME[^}]*\}?|\.rein|\$\{?HOME\}?)/) },
  // node's own "resolve relative to this module" idiom.
  { name: "new URL(...)",     re: /new URL\(\s*["'`]?$/ },
  // A STATIC MODULE SPECIFIER is script-relative by definition — the runtime resolves it
  // against the importing module, never against cwd or any input. `import x from "../y"`
  // is the purest anchored case there is, and it was missing: the E-224 wiring commit
  // tripped P0 on its own import line. The quote must follow the keyword immediately, so
  // `require(userInput + "../")` still has no anchor and stays blocking.
  // Built with anchored() so a MULTI-LEVEL specifier works: in "../../shared/y.mjs"
  // every `../` must be anchored, and the second one is not adjacent to the quote.
  { name: "module specifier", re: anchored(/\b(from|import|require)\s*\(?\s*["'`]/) },
];

const RUNTIME_P0 = /(\/etc\/|\/root\/)/;

/**
 * Grade one added diff line.
 * @returns {{severity: "P0"|"P1"|null, detail: string, anchor?: string}}
 */
/**
 * A whole-line comment. Not executed, so not runtime path handling — the same principle
 * D-058 §3 applies to markdown prose, applied consistently one level in.
 *
 * This was found the hard way: the E-224 wiring commit tripped P0 on its OWN comment,
 * which quotes `join(req.path, "../")` as the example of what must stay blocking. The
 * original E-222 fixture asserted "bare traversal in prose → P0" and that fixture was
 * wrong about its own intent — it was describing a COMMENT, which cannot execute.
 *
 * Only WHOLE-line comments. A trailing comment on a code line leaves the line graded,
 * because the code on it is still code.
 */
const WHOLE_LINE_COMMENT = /^\+?\s*(\/\/|#|\*|\/\*|<!--)/;

/**
 * E-428: test files. A hostile-input literal (`"../../etc/passwd"`) or a relative mock
 * (`vi.mock("../..")`) is what a test of path handling is MADE of; blocking it pushed a
 * downstream project to obfuscate its tests, which hides exactly what a reviewer should
 * read. A test file's traversal is graded advisory (P1, still reported), never P0.
 * Non-test source is graded as before — an fs/path sink there is never exempt.
 *
 * Matched per path SEGMENT, so `src/tests_util.js` or `contests/x.js` is not a test file.
 *
 * Nothing under tests/fixtures/ is a test file here: D-116 r2 (E-363) pins that a script
 * there is still graded — only its inert `*-cases.json` tables are data
 * (isInertInputTable in markdown-exec.mjs). A fixture is input other code consumes, not a
 * test, so the E-428 exemption does not reach it.
 */
const TEST_FILE = [
  /(^|\/)(tests|__tests__|testdata)\//,
  /_test\.go$/,
  /\.test\.(js|jsx|ts|tsx|mjs|cjs)$/,
];
const FIXTURES = /^(\.\/)?tests\/fixtures\//;

export function isTestFile(path) {
  const p = String(path ?? "");
  return !FIXTURES.test(p) && TEST_FILE.some((re) => re.test(p));
}

/**
 * E-428: inline suppression, `rein:allow PATH_TRAVERSAL <reason>` on the line itself.
 * The reason is mandatory: a marker without one suppresses nothing. A suppression is
 * never silent — `classifyDiffTraversal` returns every one so the review lists it.
 */
const ALLOW_MARKER = /rein:allow\s+PATH_TRAVERSAL\b(.*)$/;

export function allowMarker(line) {
  const m = ALLOW_MARKER.exec(String(line ?? ""));
  if (!m) return null;
  const reason = m[1].replace(/(\*\/|--!?>)\s*$/, "").trim();
  return { reason: /\w/.test(reason) ? reason : "" };
}

export function classifyTraversalLine(line, { strict = false } = {}) {
  const v = gradeLine(line, { strict });
  if (strict || !v.severity) return v;
  const marker = allowMarker(line);
  if (!marker) return v;
  if (marker.reason) return { severity: null, detail: v.detail, suppressed: marker.reason };
  return { ...v, detail: `${v.detail}  (rein:allow marker has no reason — not honoured)` };
}

function gradeLine(line, { strict = false } = {}) {
  const text = String(line ?? "");
  const detail = text.trim().slice(0, 80);

  if (!strict && WHOLE_LINE_COMMENT.test(text)) return { severity: null, detail };

  // Absolute system paths are never anchored to anything and stay P0 in both modes.
  if (RUNTIME_P0.test(text)) return { severity: "P0", detail };
  if (!text.includes("../")) return { severity: null, detail };
  if (strict) return { severity: "P0", detail };

  // Every `../` in the line must be anchored for the line to be advisory. One
  // unanchored occurrence is enough to keep it blocking — a line may legitimately
  // carry both, and the dangerous one governs.
  let idx = text.indexOf("../");
  let matchedAnchor = null;
  while (idx !== -1) {
    const before = text.slice(0, idx);
    const hit = SCRIPT_RELATIVE_ANCHORS.find((a) => a.re.test(before));
    if (!hit) return { severity: "P0", detail };
    matchedAnchor = matchedAnchor || hit.name;
    idx = text.indexOf("../", idx + 3);
  }
  return { severity: "P1", detail, anchor: matchedAnchor };
}

/**
 * Grade a whole diff. Returns the worst severity found plus its detail, or null.
 * Added lines only (`^+` and not `+++`), matching the original check.
 *
 * Line-shape only — no file awareness. `classifyDiffTraversal` below is what the review
 * gate uses; this remains for callers grading a blob of lines.
 */
export function classifyTraversal(diff, { strict = false } = {}) {
  const added = String(diff ?? "").split("\n").filter((l) => /^\+[^+]/.test(l));
  let advisory = null;
  for (const line of added) {
    const v = classifyTraversalLine(line, { strict });
    if (v.severity === "P0") return v;
    if (v.severity === "P1" && !advisory) advisory = v;
  }
  return advisory;
}

/**
 * Grade a diff the way `run_review` does: per file, per line, markdown-aware (E-224).
 *
 * Exported so the review gate and its tests run THE SAME CODE. A test that re-implements
 * the loop it is checking certifies the copy, not the shipped behaviour — E-219 F4 was
 * exactly that, an inline duplicate of a guard asserting the bug was fine.
 *
 * @param {string} diff
 * @param {{ strict?: boolean, readFile: (relPath: string) => string }} opts
 *   `readFile` must throw for a path it cannot read; unreadable files are graded in full
 *   (fail closed — an unclassifiable file must not become an exempt one).
 * @returns {{ traversal: object|null, proseExec: string[],
 *            suppressed: Array<{file: string, line: number, reason: string}> }}
 *   `suppressed` lists every line a reasoned `rein:allow PATH_TRAVERSAL` marker excused
 *   (E-428) — the review prints it, so a suppression is auditable.
 */
export function classifyDiffTraversal(diff, { strict = false, readFile } = {}) {
  const cache = new Map();
  const classify = (f) => {
    if (!cache.has(f)) {
      let parsed;
      try { parsed = classifyMarkdown(readFile(f), f); }
      catch { parsed = { executable: null, bangLines: [] }; }
      cache.set(f, parsed);
    }
    return cache.get(f);
  };

  let worst = null;
  const proseExec = [];
  const suppressed = [];
  for (const { file, line, text } of addedLines(diff)) {
    const isMd = file.endsWith(".md");
    if ((isGeneratedRecord(file) || isInertInputTable(file)) && !strict) continue;   // records and contract tables are data (E-224, E-363)
    let grade = true;
    if (isMd && !strict) {
      const { executable } = classify(file);
      grade = executable === null ? true : executable.has(line);
    }
    if (isMd && isProseOnlyFile(file) && /^\+\s*!/.test(text)) proseExec.push(`${file}:${line}`);
    if (!grade) continue;
    let v = classifyTraversalLine(text, { strict });
    if (v.suppressed) { suppressed.push({ file, line, reason: v.suppressed }); continue; }
    if (v.severity === "P0" && !strict && isTestFile(file)) v = { ...v, severity: "P1", anchor: "test file" };
    // No early exit on the first P0: the scan keeps collecting suppressions and prose
    // lines so the report is complete. The FIRST P0 stays the one reported.
    if (v.severity === "P0" && worst?.severity !== "P0") worst = { ...v, file, line };
    if (v.severity === "P1" && !worst) worst = { ...v, file, line };
  }
  return { traversal: worst, proseExec, suppressed };
}
