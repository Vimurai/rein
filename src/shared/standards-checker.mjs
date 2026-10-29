/**
 * standards-checker.mjs — E-80 Engineering-Standards static analyser.
 *
 * Implements the §API contract from .ai/blueprints/engineering-standards.md:
 *
 *   validateStandards(diff_path) -> ComplianceReport
 *   reportDrift(report)          -> structured warning stream (caller-decided)
 *
 * Backed by src/shared/standards.json (the Standards-Registry). Each rule
 * carries a `rule_id` whose handler lives in RULE_REGISTRY here.
 *
 * Pure node:fs / node:path / node:child_process — no external deps. Each
 * rule is a regex / line-count / glob test, kept cheap enough to honour
 * the blueprint's <200ms per-commit budget.
 *
 * Security boundary (blueprint §Security): handlers only introspect file
 * SHAPE (line count, regex matches, path patterns). They never evaluate
 * business logic, never spawn shells against the file content, never
 * read parent directories above the project root.
 *
 * Usage (programmatic):
 *   import { validateStaged, loadStandards } from "./shared/standards-checker.mjs";
 *   const rules  = loadStandards();
 *   const report = validateStaged(repoRoot, rules);
 *   if (report.summary.error_count > 0) process.exit(1);
 *
 * Usage (CLI — see scripts/standards.mjs):
 *   node scripts/standards.mjs check --staged   # default
 *   node scripts/standards.mjs check --file <path>
 *   node scripts/standards.mjs list-rules
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, relative, basename, dirname } from "node:path";
import { spawnSync } from "node:child_process";
// E-225 reuses the E-224 classifier so "executable markdown" has ONE definition.
import { classifyMarkdown } from "./markdown-exec.mjs";
import { TEST_RULES } from "./standards-test-rules.mjs";

const SERVICE = "standards-checker";

/** Default standards.json location, resolved relative to this module. */
export const DEFAULT_STANDARDS_PATH = new URL("./standards.json", import.meta.url).pathname;

/** Severity → exit-code semantics — only `error` makes the CLI exit non-zero. */
export const SEVERITY_ORDER = { info: 0, warning: 1, error: 2 };

// ── Structured stderr logger (obs_baseline §Logging) ────────────────────────
function log(level, message, extras = {}) {
  process.stderr.write(JSON.stringify({
    timestamp: new Date().toISOString(),
    level, service: SERVICE, message, ...extras,
  }) + "\n");
}

/** Load + lightly validate standards.json. Throws on schema violation. */
export function loadStandards(jsonPath = DEFAULT_STANDARDS_PATH) {
  const raw = readFileSync(jsonPath, "utf8");
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rules)) {
    throw new Error(`standards.json: expected { rules: [...] }`);
  }
  for (const r of parsed.rules) {
    if (typeof r.rule_id !== "string" || r.rule_id.length === 0) {
      throw new Error(`standards.json: rule is missing rule_id`);
    }
    if (!["info", "warning", "error"].includes(r.severity)) {
      throw new Error(`standards.json: rule ${r.rule_id} has invalid severity '${r.severity}'`);
    }
    if (typeof r.description !== "string" || r.description.length === 0) {
      throw new Error(`standards.json: rule ${r.rule_id} is missing description`);
    }
    if (typeof r.auto_fix_available !== "boolean") {
      throw new Error(`standards.json: rule ${r.rule_id} is missing auto_fix_available (boolean)`);
    }
  }
  return parsed;
}

// ── Glob matcher (sufficient for the patterns we ship in standards.json) ────
// Supports:
//   '**' / '**/'  — zero-or-more path segments (matches src/foo AND src/a/b/foo)
//   '*'           — any chars within ONE path segment
//   literal / . _ - (regex-escaped where needed)
function _globToRegex(glob) {
  let regex = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          // '**/' — zero or more directory segments (collapses empty case).
          regex += "(?:[^/]+/)*";
          i += 2;
        } else {
          // '**' at the tail or alone — greedy cross-segment match.
          regex += ".*";
          i += 1;
        }
      } else {
        // '*' — segment-local.
        regex += "[^/]*";
      }
    } else if ("\\.+^$()|[]{}?".includes(c)) {
      regex += "\\" + c;
    } else {
      regex += c;
    }
  }
  return new RegExp(`^${regex}$`);
}

function _pathMatchesAny(relativePath, globs) {
  for (const g of globs) {
    if (_globToRegex(g).test(relativePath)) return true;
  }
  return false;
}

// ── Rule handlers ───────────────────────────────────────────────────────────
// Each handler is `(ctx) => Violation | Violation[] | null`
// where ctx = { filePath, relPath, content, lines, rule, repoRoot }
// and Violation = { rule_id, severity, line?, message }.

const SECRET_PATTERNS = [
  { name: "AWS_ACCESS_KEY",      re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "STRIPE_LIVE",         re: /\bsk_live_[0-9A-Za-z]{16,}\b/ },
  { name: "SLACK_BOT_TOKEN",     re: /\bxox[bp]-[0-9A-Za-z-]{10,}\b/ },
  { name: "GITHUB_PAT",          re: /\b(ghp|ghs|gho|ghu|ghr)_[A-Za-z0-9]{30,}\b/ },
  { name: "PRIVATE_KEY_BLOCK",   re: /-----BEGIN (RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
];

export const RULE_REGISTRY = {
  /**
   * E-225 (D-058 §2): an executable markdown line must not execute a helper by a cwd- or
   * repo-relative path.
   *
   * `!`-prefixed lines in skill files are AUTO-EXECUTED by the harness at session start,
   * so `for c in src/shared/incident-aggregate.mjs ...` ran the VISITED project's copy —
   * the same defect E-223 removed from the hooks, surviving in the highest-frequency
   * skill in the system (T-LOCATOR-001).
   *
   * Two things keep this from over-blocking, and both matter: it reuses the E-224
   * classifier rather than its own idea of "executable" (so the review gate and this rule
   * cannot disagree), and it only counts paths with an EXECUTABLE EXTENSION. A skill
   * reading `src/db/schema.sql`, grepping `src/`, or `test -f src/claude/agents/x.md` is
   * handling the project's own data and is none of this rule's business — a scan of the
   * tree found 23 executable lines mentioning `src/` and only 5 that actually executed a
   * framework helper.
   */
  skill_locator_install_first(ctx) {
    if (process.env.REIN_STANDARDS_SKIP === "skill-locator") return null;
    let executable;
    try {
      ({ executable } = classifyMarkdown(ctx.content, ctx.relPath));
    } catch {
      return null; // classifier unavailable — never invent a violation
    }
    if (!executable || executable.size === 0) return null;

    // The question the rule asks: does this line hand an INTERPRETER a path the VISITED
    // PROJECT controls?
    //
    // THE INVOCATION IS TOKENISED, NOT REGEX-MATCHED. Four audit rounds each found a new
    // hole in a single-regex parser — an unparsed `--flag=value` silently ended the scan
    // for the whole line, `$'…'` and unquoted code defeated the inline-code strip,
    // backticks terminated the token — and the shapes were not running out. A tokeniser
    // answers all of them at once because it stops trying to describe every invocation
    // shape in one pattern: split on whitespace, drop the flags, look at what is left.
    const INTERPRETERS = new Set([
      "node", "bash", "sh", "zsh", "ksh", "dash",
      "python", "python3", "perl", "ruby", "source", ".",
      "tsx", "ts-node", "deno", "bun",
    ]);
    // D-061 §2 rollback: restores the pre-E-234 walk, which graded every operand as a
    // candidate program. Kept because the narrowing REMOVES findings, and a gate that
    // stops reporting needs a way back to the louder behaviour if that proves wrong.
    const PROGRAM_POSITION = process.env.REIN_STANDARDS_SKIP !== "program-position";
    // Wrappers that RESTART program position: what follows them is a program again.
    // Without this, `env FOO=1 node src/bin/rein` and `command node src/bin/rein` would read
    // as "a wrapper with arguments" and the real interpreter would never be reached.
    const POSITION_RESTARTERS = new Set([
      "env", "sudo", "nohup", "time", "command", "exec", "xargs", "eval",
    ]);
    // Flags whose OPERAND is code, not a path.
    const INLINE_CODE_FLAG = /^-{1,2}(e|c|p|eval|print|exec|X)$/;
    // Shell keywords that introduce command position, so `then . src/bin/rein` is a source.
    const CMD_KEYWORDS = new Set(["then", "do", "else", "elif", "in", "{", "!", "&&", "||", ";", "|", "("]);

    /**
     * Split a line into shell-ish tokens, keeping quoted runs together. Good enough to
     * find the operand of a command — it is not a shell parser and does not need to be.
     */
    const tokenise = (t) => {
      const toks = [];
      let i = 0;
      while (i < t.length) {
        if (/\s/.test(t[i])) { i++; continue; }
        // A token runs to the next UNQUOTED whitespace. Quotes group whitespace INSIDE a
        // token, they do not end it: `` `pwd`/src/shared/evil.mjs `` is one shell word,
        // and ending the token at the closing backtick split the root away from the path
        // so the operand read as a harmless `pwd`.
        let j = i;
        while (j < t.length && !/\s/.test(t[j])) {
          const ch = t[j];
          if (ch === '"' || ch === "'" || ch === "`") {
            const q = ch;
            j++;
            while (j < t.length && (t[j] !== q || t[j - 1] === "\\")) j++;
            j++;                       // consume the closing quote
            continue;
          }
          j++;
        }
        toks.push(t.slice(i, j));
        i = j;
      }
      return toks;
    };

    // `${PWD}` / `$(pwd)` / backtick-pwd / `$OLDPWD` all name the VISITED PROJECT's root,
    // so they are project-CONTROLLED rather than a safe absolute anchor.
    const PROJECT_ROOTED = /^[`$][{(]?\s*(PWD|OLDPWD|pwd|git\s+rev-parse)/;

    // Trailing shell punctuation is not part of the path. The tokeniser splits on
    // whitespace only, so `bash tests/run.sh; echo done` yields the operand
    // `tests/run.sh;` — which then missed the allowlist and FLAGGED an entrypoint the
    // rule explicitly permits. An over-block on a permitted shape is how a commit gate
    // teaches people to bypass it, which is the failure this whole sprint kept removing.
    const trimOperand = (t) => String(t).replace(/^["'`]+/, "").replace(/["'`]+$/, "").replace(/[;&|)]+$/, "");

    // D-061 §2 / E-234: a token with a DATA-typed extension is never a program, in any
    // position. `memory_curator.md` was blocked six times for
    //   node "${REIN}/shared/memory-worker-pool.mjs" --dlq-show .ai/memory/dlq.json
    // where the program is correctly resolved through ${REIN} and the flagged token is an
    // argument to a --dlq-show flag. Position alone must not launder one either: putting a
    // .json first does not make it a program, which is why this is tested on the TOKEN and
    // not on where it sits.
    const DATA_EXT = /\.(json|md|txt|yml|yaml|sqlite|ndjson|csv|log)$/i;

    const isProjectControlled = (raw) => {
      const rawTok = String(raw);
      const t = trimOperand(rawTok);
      if (/^\d*[<>]/.test(t)) return false;              // a redirect, not a path
      if (PROGRAM_POSITION && DATA_EXT.test(t)) return false;   // data, not a program
      // Tested on the RAW token as well: the leading backtick IS the marker, so stripping
      // quotes first hid `` `pwd`/src/... `` from the project-root check.
      if (PROJECT_ROOTED.test(rawTok) || PROJECT_ROOTED.test(t)) return true;
      if (t.startsWith("-")) return false;               // a flag
      if (t.startsWith("/")) return false;               // absolute
      if (t.startsWith("~")) return false;               // home
      if (/^\$/.test(t)) return false;                   // a variable we cannot read
      // A path carries a separator or an extension. Without this the bare fd `2` left by
      // `2>/dev/null` qualified. Trade-off recorded in T-LOCATOR-001 KNOWN UNCAUGHT:
      // an extension-less bare word like `bash setup` is no longer caught.
      return /[./]/.test(t);
    };

    const ACCEPTED = [
      /^tests\/run\.sh$/,
      /^tests\/suites\/[\w.@<>-]+\.sh$/,
      /^package\.json$/,
    ];
    const SELF_AUTHORED = /(^|\/)bug-reproducer\/SKILL\.md$/.test(ctx.relPath)
      ? [/^repro\.sh$/]
      : [];
    const isAccepted = (raw) => {
      const t = trimOperand(raw).replace(/^\.\//, "");
      if (t.split("/").some((seg) => seg === "..")) return false;
      return [...ACCEPTED, ...SELF_AUTHORED].some((re) => re.test(t));
    };

    // SECOND SIGNAL: a locator chain puts the path in a LIST and hands the interpreter a
    // variable — `for c in src/shared/x.mjs; do node "$c"; done` — so an operand test
    // alone misses the original defect.
    const BARE_EXEC_PATH =
      /(^|[\s"'`(=:}])((?:\.\.?\/)?(?:[\w.@-]+\/)*[\w.@-]+\.(?:mjs|cjs|js|sh|bash|py|pl|rb))\b/;

    const COMMENT = /^\s*(#|\/\/|\*)/;

    // E-231 (D-060 §2). Two indirections put a project path beyond the operand walk, and
    // both were recorded as KNOWN UNCAUGHT rather than left to be re-found later as bugs:
    //
    //   bash -c "node src/bin/rein"   the interpreter is INSIDE a quoted operand
    //   cat src/bin/rein | bash       the program arrives on stdin, left of the pipe
    //
    // Note what kept them invisible: an .mjs/.sh target is still caught by the second
    // signal below, so ONLY an extension-less target such as `src/bin/rein` slipped through.
    // That is why the shipped corpus contains none of these shapes.
    // Strip the wrapping quotes AND un-escape the inner ones. Inside `bash -c "..."` a
    // nested quote is written as an escaped quote, so the operand token arrives beginning
    // with a BACKSLASH — which defeated the "variable we cannot read" check and made a
    // perfectly safe ${HOME}-anchored helper read as a project path. That was a new
    // OVER-BLOCK introduced by this very change, caught by the fixture matrix written
    // before it. D-060 §2 requires treating one as a regression, not shipping it.
    const stripOuterQuotes = (t) =>
      String(t).replace(/^(["'`])([\s\S]*)\1$/, "$2").replace(/\\(["'`])/g, "$1");
    const EVALISH = new Set(["eval"]);
    const PIPE_FEEDERS = new Set(["xargs"]);

    /**
     * The operand walk, made recursive. `depth` is capped at 1: a code operand is
     * re-tokenised and scanned once. Deeper nesting is not funded — it buys shapes nobody
     * writes, and each extra layer is another chance to invent a finding.
     */
    const walk = (toks, depth) => {
      let bad = null;
      let invokes = false;
      for (let i = 0; i < toks.length && !bad; i++) {
        // Strip a leading `!` (the harness prefix) and any `Label:` before the command.
        const word = toks[i].replace(/^!+/, "").replace(/^[^:\s]*:$/, "");
        // Match on the BASENAME: `/usr/local/bin/node` and `./node_modules/.bin/tsx` are
        // the same invocation as `node`, and an exact-match set never sees them.
        const base = word.replace(/^["'`]+/, "").split("/").pop();
        const isEval = EVALISH.has(word) || EVALISH.has(base);
        if (!INTERPRETERS.has(word) && !INTERPRETERS.has(base) && !isEval) continue;
        // `.` counts only in command position — otherwise every `find . -name` reads as a
        // source, which over-blocked 33 files when `.` was a bare regex alternative.
        if (word === "." || base === ".") {
          const prev = i > 0 ? toks[i - 1].replace(/^!+/, "") : "";
          const atCmdPos = i === 0 || CMD_KEYWORDS.has(prev) || /[;&|({!]$/.test(prev) || prev.endsWith(":");
          if (!atCmdPos) continue;
        }
        invokes = true;
        // Walk the operands: skip flags, and RE-SCAN the operand of an inline-code flag.
        for (let j = i + 1; j < toks.length; j++) {
          const t = toks[j];
          if (/^-/.test(t)) {
            if (INLINE_CODE_FLAG.test(t.split("=")[0])) {
              // E-231: this operand is CODE, and code is exactly where the interpreter
              // was hiding. It used to be skipped wholesale, so `bash -c "node
              // src/bin/rein"` read as "bash, with one operand we ignore".
              const inner = toks[++j];
              if (inner !== undefined && depth < 1) {
                const r = walk(tokenise(stripOuterQuotes(inner)), depth + 1);
                if (r.bad) { bad = r.bad; break; }
              }
            }
            continue;
          }
          if (isEval) {
            // `eval` takes CODE, never a path — so its operand is re-scanned and must NOT
            // be tested as a path itself: `eval "$(command -v node)"` is not a project
            // path, and grading it as one would be an over-block.
            if (depth < 1) {
              const r = walk(tokenise(stripOuterQuotes(t)), depth + 1);
              if (r.bad) bad = r.bad;
            }
            break;
          }
          if (/^[;&|)]/.test(t)) break;                         // end of this command
          if (isProjectControlled(t) && !isAccepted(t)) {
            bad = trimOperand(t);
            break;
          }
          // D-061 §2: program position CLOSES once an operand resolves the program.
          //
          // It deliberately stays OPEN for two kinds of operand, because neither tells us
          // what actually runs: a variable this rule cannot read (`node "$HELPER" …`), and
          // an allowlisted entrypoint (`bash tests/run.sh …`). D-061 keeps both of those
          // walking, so `bash tests/run.sh src/bin/rein` is still caught. Anything else —
          // an absolute path, a home-anchored path, a plain word — RESOLVES the program,
          // and every token after it is an argument.
          if (PROGRAM_POSITION && !POSITION_RESTARTERS.has(trimOperand(t))) {
            const tt = trimOperand(t);
            const unresolved = /^\$/.test(tt) || PROJECT_ROOTED.test(t) || isAccepted(t) || DATA_EXT.test(tt);
            if (!unresolved) break;
          }
          // Keep walking — but only within THIS command. Breaking unconditionally after
          // the first non-flag token stopped the scan on an operand that was merely
          // REJECTED ("a variable we cannot read") or ACCEPTED (allowlisted), so
          // `node "$HELPER" src/bin/rein` and `bash tests/run.sh src/bin/rein` went clean.
          //
          // A token ENDING in a terminator ends the command, and that matters: without
          // it the walk ran on past `. "${HOME}/…/locate.sh";` into the NEXT command and
          // read the resolver's own logical argument (`shared/x.mjs`) as a path — an
          // over-block on the exact line this task ships. Walking further than the shell
          // would is how a scan invents a finding.
          if (/[;&|)]$/.test(t)) break;
        }
      }
      return { bad, invokes };
    };

    /**
     * A pipeline whose SINK is an interpreter is handed its program on STDIN, so the path
     * sits to the LEFT of the pipe and never appears as an operand of anything.
     * `cat src/bin/rein | bash` runs the visited project's file just as surely as
     * `bash src/bin/rein` does.
     */
    const pipeFed = (toks) => {
      for (let i = 1; i < toks.length; i++) {
        const cur = toks[i].replace(/^\|+/, "").replace(/^["'`]+/, "");
        const prev = toks[i - 1];
        const afterPipe = prev === "|" || /\|$/.test(prev) || /^\|/.test(toks[i]);
        if (!afterPipe || !cur) continue;
        let sink = cur.split("/").pop();
        // `... | xargs node` — the interpreter is xargs' own operand.
        if (PIPE_FEEDERS.has(sink)) {
          const next = (toks[i + 1] || "").replace(/^["'`]+/, "");
          if (!next || /^-/.test(next)) continue;
          sink = next.split("/").pop();
        }
        if (!INTERPRETERS.has(sink)) continue;
        for (let m = 0; m < i; m++) {
          const t = toks[m];
          if (/^-/.test(t)) continue;
          if (isProjectControlled(t) && !isAccepted(t)) return trimOperand(t);
        }
      }
      return null;
    };

    const out = [];
    for (const num of executable) {
      const line = ctx.lines[num - 1] ?? "";
      if (COMMENT.test(line)) continue;

      const toks = tokenise(line);
      const walked = walk(toks, 0);
      let bad = walked.bad;
      const invokes = walked.invokes;
      if (!bad) bad = pipeFed(toks);

      if (!bad && invokes) {
        const scrubbed = line.replace(
          /rein_locate\s+(["'`]?)([\w@-]+\/[\w.@-]+)\1/g,
          "rein_locate _",
        );
        const bare = BARE_EXEC_PATH.exec(scrubbed);
        if (bare && isProjectControlled(bare[2]) && !isAccepted(bare[2])) bad = bare[2];
      }
      if (!bad) continue;

      out.push({
        rule_id: ctx.rule.rule_id,
        severity: "error",
        line: num,
        detail: `executable markdown hands an interpreter a project-controlled path ('${bad}') — resolve it with rein_locate: ${line.trim().slice(0, 70)}`,
      });
    }
    return out.length ? out : null;
  },


  /**
   * D-064 / E-241 — RAW `trap … EXIT` IN A TEST SUITE.
   *
   * A bare `trap 'cmd' EXIT` REPLACES any existing EXIT handler. 42 suites did this after
   * sourcing assert.sh, and every one of them silently threw away the cleanup registry —
   * which is how E-227/E-228 leaked 50 tmux servers with nothing to notice. `on_exit` is
   * the spelling that chains instead of replacing.
   *
   * WHAT THIS MUST NOT FLAG, and it is the whole difficulty: a test that ASSERTS something
   * about traps quotes the string it is looking for. `ai_watch_test` greps the watcher for
   * `trap '_release_lock' EXIT`, and `harness_isolation_test` asserts the runner
   * registers `trap _rein_test_cleanup EXIT INT TERM`. Flagging those would make the rule
   * reject the tests that verify trap behaviour — the same trap E-224 and E-238 both hit,
   * where a gate blocked the document describing it.
   *
   * So: only a line whose COMMAND POSITION is `trap` counts (E-234's lesson applied to a
   * different rule), comments are skipped, and a `trap` appearing anywhere inside an
   * assert_* invocation is data, not an invocation.
   */
  no_raw_exit_trap_in_tests(ctx) {
    if (process.env.REIN_STANDARDS_SKIP === "raw-exit-trap") return null;
    if (!/^tests\/.*\.sh$/.test(ctx.relPath)) return null;
    // E-250: the tests/run.sh exemption MOVED to standards.json `exempt_files`, where
    // validateFile applies it and the summary can print it with its reason. It lived here
    // as a hardcoded regex — a coverage reduction no report could ever enumerate, which is
    // exactly what D-065 §1 says an exemption must not be.

    const out = [];
    const lines = ctx.lines ?? String(ctx.content ?? "").split("\n");
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const line = String(raw);
      if (/^\s*#/.test(line)) continue;              // a comment is prose
      if (/\bassert_\w+/.test(line)) continue;       // an assertion ABOUT traps quotes one
      if (/\bbuiltin\s+trap\b/.test(line)) continue; // deliberate escape hatch
      // E-250: the per-line escape hatch is no longer handled here. A marker consumed
      // inside the rule is invisible to the counter — the finding never exists, so nothing
      // can report that it was suppressed. validateFile now applies the marker AFTER the
      // rule produces its finding, which is what makes "3 active suppressions" a number
      // the summary can print. (The hatch itself is unchanged and still necessary: a suite
      // that BUILDS a fixture containing `trap … EXIT` is writing data, not installing a
      // handler, and no pattern distinguishes the two.)

      // `trap` in COMMAND POSITION: line start, or after a separator. Not inside a quoted
      // string, and not as an argument to something else.
      const m = /(?:^|[;&|]|\bthen\b|\bdo\b|\belse\b)\s*trap\s+(?:'[^']*'|"[^"]*"|\S+)\s+(?:EXIT|exit|0)\b/.exec(line);
      if (!m) continue;

      out.push({
        rule_id: ctx.rule.rule_id,
        severity: "error",
        line: i + 1,
        detail:
          `raw 'trap … EXIT' REPLACES the cleanup registry — use on_exit: ${line.trim().slice(0, 70)}`,
      });
    }
    return out.length ? out : null;
  },

  /**
   * D-060 §3 / E-232 — SKILL CONSENT. A `!`-prefixed line in a skill or agent file is run
   * by the harness the moment the file LOADS: before the agent has decided anything and
   * before the operator has been asked. Such a line may therefore inspect, but must never
   * EXECUTE a program the visited project supplies.
   *
   * `ai-debug` opened with `!bash tests/run.sh`, so merely loading the debugging skill ran
   * the visited project's test script. `ai-upgrade` did the same with `!npm run test`,
   * which the threat model had recorded as "agent-initiated" — it is not; it is a `!`-line.
   *
   * The test is EXECUTION, not mention. `npm outdated` and `npm audit` stay allowed: they
   * query the manifest and the registry and run none of the project's code. `npm run`
   * does, because package.json decides what it runs. This is the distinction the rule
   * encodes, and it is why the check is a denylist of execution shapes rather than an
   * allowlist of safe commands — an allowlist would reject every ordinary `git`/`grep`
   * inspection line the moment someone wrote a new one.
   */
  skill_consent_no_project_exec(ctx) {
    if (process.env.REIN_STANDARDS_SKIP === "skill-consent") return null;
    let bangLines;
    try {
      ({ bangLines } = classifyMarkdown(ctx.content, ctx.relPath));
    } catch {
      return null; // classifier unavailable — never invent a violation
    }
    if (!bangLines || bangLines.length === 0) return null;
    if (!/(^|\/)(SKILL\.md|.*\/agents\/[^/]+\.md)$/.test(ctx.relPath)) return null;

    const INTERPRETERS = new Set([
      "node", "bash", "sh", "zsh", "ksh", "dash",
      "python", "python3", "perl", "ruby", "source", ".",
      "tsx", "ts-node", "deno", "bun",
    ]);
    // Operands of these are CODE the skill itself supplies, not a project path.
    const INLINE_CODE_FLAG = /^-{1,2}(e|c|p|eval|print|exec|X)$/;
    // Package managers execute whatever the project's manifest defines.
    const PM = new Set(["npm", "pnpm", "yarn", "bun"]);
    const PM_EXEC = new Set(["run", "run-script", "test", "start", "build", "exec"]);
    // A path shape the visited project controls.
    const PROJECT_PATH = /^(\.\/|\.\.\/|tests\/|scripts\/|bin\/|src\/|tools\/)/;

    const src = String(ctx.content ?? "").split("\n");
    const findings = [];

    for (const num of bangLines) {
      const raw = src[num - 1] ?? "";
      const cmd = raw.replace(/^[^!]*!/, "");           // everything after the leading `!`
      // Each pipeline/list segment is its own invocation; `grep x | bash tests/run.sh`
      // hides the execution in the second one.
      for (const seg of cmd.split(/\|\||&&|[|;]/)) {
        const toks = seg.trim().split(/\s+/).filter(Boolean);
        if (toks.length === 0) continue;
        let head = toks[0].replace(/^["']|["']$/g, "");
        if (head === "!") { toks.shift(); head = (toks[0] || "").replace(/^["']|["']$/g, ""); }
        if (!head) continue;

        // 1. the command IS a project path: `./run.sh`, `tests/run.sh`
        if (PROJECT_PATH.test(head)) {
          findings.push(`${ctx.relPath}:${num} auto-executed \`!\` line runs a project program (${head})`);
          break;
        }
        // 2. make runs the project's Makefile
        if (head === "make" || head === "gmake") {
          findings.push(`${ctx.relPath}:${num} auto-executed \`!\` line runs make (project-supplied targets)`);
          break;
        }
        // 3. npx runs an arbitrary package
        if (head === "npx" || head === "pnpx") {
          findings.push(`${ctx.relPath}:${num} auto-executed \`!\` line runs npx (arbitrary package execution)`);
          break;
        }
        // 4. a package manager running a manifest-defined script
        if (PM.has(head)) {
          const sub = (toks[1] || "").replace(/^-+/, "");
          if (PM_EXEC.has(toks[1])) {
            findings.push(`${ctx.relPath}:${num} auto-executed \`!\` line runs \`${head} ${toks[1]}\` (package.json decides what executes)`);
            break;
          }
          void sub;
          continue; // `npm outdated` / `npm audit` — read-only queries
        }
        // 5. an interpreter handed a project path
        if (INTERPRETERS.has(head)) {
          let skipNext = false;
          let hit = null;
          for (const t0 of toks.slice(1)) {
            const t = t0.replace(/^["']|["']$/g, "");
            if (skipNext) { skipNext = false; continue; }
            if (INLINE_CODE_FLAG.test(t)) { skipNext = true; continue; }
            if (t.startsWith("-")) continue;
            if (PROJECT_PATH.test(t)) { hit = t; break; }
            break; // first non-flag operand is the program; stop either way
          }
          if (hit) {
            findings.push(`${ctx.relPath}:${num} auto-executed \`!\` line runs a project program via ${head} (${hit})`);
            break;
          }
        }
      }
    }

    if (findings.length === 0) return null;
    return {
      id: "SKILL_CONSENT",
      severity: "P0",
      detail:
        findings.slice(0, 4).join("; ") +
        " — a `!` line runs on LOAD, without the agent or the operator choosing it. " +
        "Move project-program execution into a numbered step the agent performs (D-060 §3).",
    };
  },


  file_size_limit_lines(ctx) {
    const n = ctx.lines.length;
    const warn = ctx.rule.warn_threshold ?? 500;
    const err  = ctx.rule.threshold ?? 1000;
    if (n > err) {
      return {
        rule_id: ctx.rule.rule_id, severity: "error", line: n,
        message: `file has ${n} lines (limit ${err}) — split into focused modules`,
      };
    }
    if (n > warn) {
      return {
        rule_id: ctx.rule.rule_id, severity: "warning", line: n,
        message: `file has ${n} lines (warn ≥ ${warn}) — consider splitting`,
      };
    }
    return null;
  },

  mcp_stdout_purity(ctx) {
    // Mirror E-48: refuse console.log / console.info; allow .error / .warn / .debug.
    // Skip lines that look like single-line comments. Multi-line comment
    // skipping is approximate — exact AST matching is E-81 territory.
    const violations = [];
    let inBlockComment = false;
    for (let i = 0; i < ctx.lines.length; i++) {
      let line = ctx.lines[i];
      if (inBlockComment) {
        const end = line.indexOf("*/");
        if (end < 0) continue;
        line = line.slice(end + 2);
        inBlockComment = false;
      }
      // Strip line-comments and block-comments that open/close on same line.
      line = line.replace(/\/\*[^]*?\*\//g, "");
      const startBlock = line.indexOf("/*");
      if (startBlock >= 0 && line.indexOf("*/", startBlock) < 0) {
        line = line.slice(0, startBlock);
        inBlockComment = true;
      }
      const codeOnly = line.replace(/\/\/.*$/, "");
      if (/\bconsole\.(log|info)\s*\(/.test(codeOnly)) {
        violations.push({
          rule_id: ctx.rule.rule_id, severity: "error", line: i + 1,
          message: `console.log / console.info call in src/mcp/** breaks JSON-RPC stdout purity`,
        });
      }
    }
    return violations;
  },

  no_committed_tmp_files(ctx) {
    const name = basename(ctx.relPath);
    if (/\.(tmp|bak|swp|orig)$/i.test(name)) {
      return {
        rule_id: ctx.rule.rule_id, severity: "error",
        message: `staged file ${name} looks like editor/merge cruft`,
      };
    }
    return null;
  },

  kebab_case_filenames(ctx) {
    const name = basename(ctx.relPath);
    // Strip extension(s); the stem must be either kebab-case, single-camelCase,
    // single-PascalCase, or single lower-case word.
    const stem = name.replace(/\.(js|mjs|ts|tsx)$/, "");
    if (/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(stem)) return null;          // kebab-case
    if (/^[a-z][a-zA-Z0-9]*$/.test(stem)) return null;                       // camelCase
    if (/^[A-Z][a-zA-Z0-9]*$/.test(stem) && !stem.includes("_")) return null; // PascalCase (component-ish)
    return {
      rule_id: ctx.rule.rule_id, severity: "warning",
      message: `filename '${name}' is not kebab-case / camelCase — ESM case-sensitivity risk`,
    };
  },

  no_secrets_in_diff(ctx) {
    const violations = [];
    for (let i = 0; i < ctx.lines.length; i++) {
      for (const { name, re } of SECRET_PATTERNS) {
        if (re.test(ctx.lines[i])) {
          violations.push({
            rule_id: ctx.rule.rule_id, severity: "error", line: i + 1,
            message: `secret pattern '${name}' detected in line ${i + 1} — refuse to commit`,
          });
        }
      }
    }
    return violations;
  },

  mandatory_shared_helper(ctx) {
    // Heuristic: a file under src/mcp/** that imports node:sqlite directly
    // (vs. going through state-db.js or wal-flusher.mjs) earns a warning.
    if (!ctx.relPath.startsWith("src/mcp/")) return null;
    // Skip the helpers themselves.
    if (ctx.relPath === "src/mcp/shared/state-db.js") return null;
    if (/\bfrom\s+["']node:sqlite["']/.test(ctx.content) ||
        /require\s*\(\s*["']node:sqlite["']\s*\)/.test(ctx.content)) {
      return {
        rule_id: ctx.rule.rule_id, severity: "warning",
        message: `direct node:sqlite import — prefer src/mcp/shared/state-db.js helpers`,
      };
    }
    return null;
  },
  // E-299 (D-088): test economics — suite naming and label density.
  ...TEST_RULES,
};

// ── Per-file validation ─────────────────────────────────────────────────────
/**
 * Validate one file against every applicable rule. Returns a ComplianceReport
 * per blueprint §Data Model: `{ file_path, status, violated_rules: [...] }`.
 *
 * If the file does not exist (e.g. staged then removed in the same diff),
 * returns a status:"MISSING" entry rather than throwing.
 */
// ── E-250 (D-067 §4 / D-065 §1): suppressions are counted, exemptions are named ──
//
// D-065 ruled the policy: a false positive is silenced by an explicit, greppable in-file
// marker — never by loosening the pattern — and a file that legitimately falls outside a
// rule is exempted BY NAME in the rule's config, never by narrowing the rule's scope. Both
// halves reduce coverage, so both have to be VISIBLE, which is what was still missing: the
// markers existed but nothing counted them, and the one by-name exemption was a hardcoded
// regex inside the rule where no summary could ever find it.
//
// A suppression that nobody counts is indistinguishable from a rule that stopped working.

/** `# standards:allow-<token>` anywhere on a line. Global so every marker is seen. */
const SUPPRESSION_RE = /#\s*standards:allow-([A-Za-z0-9_-]+)\b/g;

/**
 * Every token a rule answers to: its rule_id plus any `suppression_aliases`.
 * Aliases exist because the in-tree markers predate the policy — `standards:allow-raw-trap`
 * is already committed and load-bearing. Renaming it in the same change that starts
 * COUNTING markers would have made the count wrong in its first run, which is the one run
 * anybody checks.
 */
export function suppressionTokensFor(rule) {
  const out = new Set([rule.rule_id]);
  for (const a of rule.suppression_aliases || []) out.add(a);
  return out;
}

/** Every token any loaded rule answers to — used to spot a marker that matches nothing. */
export function knownSuppressionTokens(rules) {
  const out = new Set();
  for (const r of rules || []) for (const tok of suppressionTokensFor(r)) out.add(tok);
  return out;
}

/**
 * Is the finding at `line` (1-based) suppressed for `rule`?
 * The marker may sit on the flagged line or the line ABOVE it (D-065 §1) — the second form
 * is what makes a marker possible on a line whose own syntax has no room for a comment.
 */
export function isSuppressed(lines, line, rule) {
  if (!Number.isInteger(line) || line < 1) return null;
  const tokens = suppressionTokensFor(rule);
  for (const idx of [line - 1, line - 2]) {
    const text = lines[idx];
    if (typeof text !== "string") continue;
    SUPPRESSION_RE.lastIndex = 0;
    let m;
    while ((m = SUPPRESSION_RE.exec(text)) !== null) {
      if (tokens.has(m[1])) return { token: m[1], line: idx + 1 };
    }
  }
  return null;
}

/**
 * Markers in a file that match NO loaded rule. E-250 books these as findings: the author
 * believed they had silenced something, and a marker that silences nothing is worse than no
 * marker at all — it reads, to the next person, as a reviewed and accepted exception.
 * Severity is `warning`, carrying a [P1] prefix: it must be seen and acted on, but blocking
 * a commit over a typo in a comment would be the over-block D-056 governs against.
 */
export function unknownSuppressionFindings(lines, rules) {
  const known = knownSuppressionTokens(rules);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    SUPPRESSION_RE.lastIndex = 0;
    let m;
    while ((m = SUPPRESSION_RE.exec(String(lines[i]))) !== null) {
      if (known.has(m[1])) continue;
      out.push({
        rule_id: "standards_suppression_unknown",
        severity: "warning",
        line: i + 1,
        message: `[P1] '# standards:allow-${m[1]}' matches no rule — it silences nothing. ` +
                `Known: ${[...known].sort().join(", ")}`,
      });
    }
  }
  return out;
}

/**
 * Is `relPath` exempt from `rule` by name? Exemptions live in standards.json beside the
 * rule as `exempt_files: [{ path, reason }]` — next to the rule they exempt, with a reason,
 * so `list-rules` and every check summary can print them. This replaces per-rule hardcoded
 * path regexes, which were invisible to both.
 */
export function exemptionFor(relPath, rule) {
  for (const e of rule.exempt_files || []) {
    if (e && e.path === relPath) return e;
  }
  return null;
}

export function validateFile(filePath, rules, opts = {}) {
  const repoRoot = opts.repoRoot ? resolve(opts.repoRoot) : process.cwd();
  const abs = resolve(filePath);
  const relPath = relative(repoRoot, abs).split(/[\\\/]/).join("/");

  if (!existsSync(abs)) {
    return { file_path: relPath, status: "MISSING", violated_rules: [] };
  }
  let st;
  try { st = statSync(abs); } catch {
    return { file_path: relPath, status: "MISSING", violated_rules: [] };
  }
  if (!st.isFile()) {
    return { file_path: relPath, status: "SKIPPED", violated_rules: [] };
  }

  let content;
  try {
    content = readFileSync(abs, "utf8");
  } catch {
    // Binary file — only path-based rules can apply.
    content = "";
  }
  const lines = content.length > 0 ? content.split("\n") : [];

  const violations = [];
  const suppressions = [];
  const exemptions = [];
  for (const rule of rules) {
    const handler = RULE_REGISTRY[rule.rule_id];
    if (!handler) continue; // unknown rule_id — skip rather than error
    const applies = Array.isArray(rule.applies_to)
      ? _pathMatchesAny(relPath, rule.applies_to)
      : true;
    if (!applies) continue;
    // E-82 hotfix: applies_to_excludes lets rules opt specific path
    // patterns out (e.g. tests/** for no_secrets_in_diff whose own
    // fixtures document the very patterns it detects).
    if (Array.isArray(rule.applies_to_excludes)
        && _pathMatchesAny(relPath, rule.applies_to_excludes)) continue;
    // E-250: by-name exemption, checked HERE rather than inside each handler, so every
    // exemption is declared in one place that the summary can enumerate.
    const exempt = exemptionFor(relPath, rule);
    if (exempt) { exemptions.push({ rule_id: rule.rule_id, path: relPath, reason: exempt.reason || "" }); continue; }
    const result = handler({ filePath: abs, relPath, content, lines, rule, repoRoot });
    if (!result) continue;
    const produced = Array.isArray(result) ? result : [result];
    // E-250: suppression is applied CENTRALLY, so every rule supports the marker rather
    // than only the ones whose handler remembered to implement it (D-065 §1: "every E-80
    // rule supports `# standards:allow-<rule_id>`"). A suppressed finding is not dropped —
    // it is recorded, so the summary can show a growing count.
    for (const v of produced) {
      const s = isSuppressed(lines, v.line, rule);
      if (s) suppressions.push({ rule_id: rule.rule_id, path: relPath, line: s.line, token: s.token });
      else violations.push(v);
    }
  }

  // A marker matching no rule is itself a finding — see unknownSuppressionFindings.
  violations.push(...unknownSuppressionFindings(lines, rules));

  const hasError   = violations.some(v => v.severity === "error");
  const hasWarning = violations.some(v => v.severity === "warning");
  const status = hasError ? "FAIL" : hasWarning ? "WARN" : "PASS";
  return { file_path: relPath, status, violated_rules: violations, suppressions, exemptions };
}

/**
 * Validate every staged file under git's index. Used by the pre-commit
 * gate (E-82) and the CLI's default `check --staged` mode.
 *
 * Returns:
 *   {
 *     reports:  [ComplianceReport, ...],
 *     summary:  { error_count, warning_count, files_checked, elapsed_ms },
 *   }
 */
export function validateStaged(repoRoot, rules, opts = {}) {
  const t0 = Date.now();
  const root = resolve(repoRoot);
  const res = spawnSync(
    "git", ["-C", root, "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
  );
  if (res.error || res.status !== 0) {
    return {
      reports: [],
      summary: { error_count: 0, warning_count: 0, files_checked: 0, elapsed_ms: Date.now() - t0 },
    };
  }
  const staged = res.stdout.split("\n").map(s => s.trim()).filter(Boolean);
  return validateFiles(staged.map(p => resolve(root, p)), rules, { repoRoot: root, ...opts });
}

/** Validate an arbitrary set of absolute paths. Useful for tests + ad-hoc CLI. */
export function validateFiles(filePaths, rules, opts = {}) {
  const t0 = Date.now();
  const reports = filePaths.map(fp => validateFile(fp, rules, opts));
  let error_count = 0;
  let warning_count = 0;
  for (const r of reports) {
    for (const v of r.violated_rules) {
      if (v.severity === "error") error_count++;
      else if (v.severity === "warning") warning_count++;
    }
  }
  return {
    reports,
    summary: {
      error_count, warning_count,
      files_checked: reports.length,
      elapsed_ms: Date.now() - t0,
    },
  };
}

/**
 * Pre-format a ComplianceReport set for the ai-review synthesizer
 * (per blueprint §API reportDrift). Returns a structured object the
 * caller can serialize / surface to a human or stamp into REVIEWS.md.
 */
export function reportDrift(reports) {
  const driftEntries = [];
  for (const r of reports) {
    for (const v of r.violated_rules) {
      driftEntries.push({
        file_path: r.file_path,
        rule_id:   v.rule_id,
        severity:  v.severity,
        line:      v.line ?? null,
        message:   v.message,
      });
    }
  }
  return {
    drift_count: driftEntries.length,
    entries:     driftEntries,
  };
}

/**
 * Backwards-compat shim for the blueprint's `validateStandards(diff_path)`
 * API signature. `diff_path` is interpreted as a path or a git ref:
 *   - If it's an absolute / relative path to an existing file → validate that file
 *   - If it's '--staged' → validateStaged (default behaviour for pre-commit hook)
 */
export function validateStandards(diffPath, opts = {}) {
  const rules = (opts.rules || loadStandards().rules);
  if (!diffPath || diffPath === "--staged") {
    return validateStaged(opts.repoRoot || process.cwd(), rules, opts);
  }
  return validateFiles([resolve(diffPath)], rules, opts);
}
