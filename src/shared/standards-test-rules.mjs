// standards-test-rules.mjs — E-299 (D-088, .ai/blueprints/test-economics.md Component 3): the
// standards rules that make the test economy checkable, and E-400's (D-138 r1) pipe rule. Merged into RULE_REGISTRY by
// standards-checker.mjs (split out because that file is at its size limit).
//
// Each handler is `(ctx) => Violation | Violation[] | null`, ctx = { relPath, content, lines, rule }.
// By-name exemptions are applied by validateFile from standards.json `exempt_files` (E-250),
// never inside a handler.

// A suite NAMED for a task: `e143_test.sh`, `e140_e141_e142_test.sh`, `robustness_p7_p12_test.sh`.
// D-088 r1: suites are named for BEHAVIOURS; a task id is a comment or a table-row label.
const TASK_NAMED = /(?:^|_)e\d+(?:_|$)|(?:^|_)p\d+_/i;

// A task-id label inside an assertion's text: E-123, E-123.04a, P-44, T-ROLE-001.
const TASK_LABEL = /\b(?:[EP]-\d+(?:\.[0-9A-Za-z]+)?|T-[A-Z][A-Z0-9]*-\d+)\b/g;
const ASSERTION = /^\s*(?:assert_[a-z_]+|_pass|_fail|_skip)\b/;

export const TEST_RULES = {
  /**
   * D-088 r1 — a test suite is named for the behaviour it observes, never for a task.
   * Applies to tests/suites/*.sh. The file NAME is the finding (line 1).
   */
  test_suite_naming(ctx) {
    if (!/^tests\/suites\/[^/]+\.sh$/.test(ctx.relPath)) return null;
    const base = ctx.relPath.split("/").pop().replace(/_test\.sh$|\.sh$/, "");
    if (!TASK_NAMED.test(base)) return null;
    return {
      rule_id: ctx.rule.rule_id,
      severity: ctx.rule.severity || "error",
      line: 1,
      detail: `suite '${base}' is named for a task — name it for the behaviour it observes; keep task ids as comments or row labels (D-088 r1)`,
    };
  },

  /**
   * D-088 r1 — more task-id LABELS than assertions in a suite means the suite is organised by
   * task, not by behaviour. One label per assertion is the ceiling; a finding, not a block.
   */
  test_label_density(ctx) {
    if (!/^tests\/suites\/[^/]+\.sh$/.test(ctx.relPath)) return null;
    const lines = ctx.lines ?? String(ctx.content ?? "").split("\n");
    let assertions = 0;
    let labels = 0;
    for (const line of lines) {
      if (!ASSERTION.test(line)) continue;
      assertions++;
      labels += (String(line).match(TASK_LABEL) || []).length;
    }
    if (assertions === 0 || labels <= assertions) return null;
    return {
      rule_id: ctx.rule.rule_id,
      severity: ctx.rule.severity || "warning",
      line: 1,
      detail: `${labels} task-id labels across ${assertions} assertions — organise by behaviour; a label belongs on a table row, at most one per assertion (D-088 r1)`,
    };
  },
  /**
   * D-138 r1 / E-400 — NO WRITER PIPED INTO `grep -q`. Under `set -o pipefail`, `grep -q` exits
   * on its first match, the writer then dies of SIGPIPE, and the pipeline reports failure: the
   * match is lost exactly when the input is large (E-294.R3a on PR #13). A match is tested with
   * a here-string (`grep -q P <<< "$x"`), process substitution (`grep < <(cmd) -q P`) or
   * `[[ =~ ]]`. Comments are prose. `||` is not a pipe. The pipe counts inside a quoted
   * `bash -c "…"` too: the rule is "never write it", not "only where pipefail is on".
   */
  no_pipe_into_grep_q(ctx) {
    if (process.env.REIN_STANDARDS_SKIP === "pipe-grep-q") return null;
    if (!/^(tests|hooks)\/.*\.sh$/.test(ctx.relPath)) return null;
    const out = [];
    const lines = ctx.lines ?? String(ctx.content ?? "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = String(lines[i]);
      if (/^\s*#/.test(line)) continue;
      if (!/(?<!\|)\|(?!\|)\s*grep\s+(?:-[A-Za-z]+\s+)*(?:-[A-Za-z]*q[A-Za-z]*|--quiet)\b/.test(line)) continue;
      out.push({
        rule_id: ctx.rule.rule_id,
        severity: "error",
        line: i + 1,
        detail: `a writer piped into grep -q loses the match under pipefail (SIGPIPE) — use grep … <<< "$x" or grep < <(cmd) …: ${line.trim().slice(0, 70)}`,
      });
    }
    return out.length ? out : null;
  },
};
