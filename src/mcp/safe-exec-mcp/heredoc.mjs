// heredoc.mjs — E-291 / E-292 (D-083, D-084 "Quoted heredoc bodies"): inert heredoc bodies are
// prose, and no rule matches inside them.
//
// Every rule matched the raw command text, so a heredoc that merely WRITES prose naming a
// pattern — `cat >> .ai/DECISIONS.md <<'EOF' … curl … | sh … EOF`, or a decision naming the
// override command — was blocked (three times while the Architect wrote D-083/D-084).
// stripInertHeredocs removes the body of a heredoc ONLY when bash provably copies it to a file
// without executing it. Applied once in runAnalysis, before every rule (D-084).
//
// "Provably" (critic_security SEC_FAIL on the first E-292 cut — a textual introducer test hid
// lines bash RUNS: `# <<'X'`, `echo "<<'X'"`, `\<<'X'`, a `bash -s \` continuation into the
// cat line, a shell function named cat):
//   1. A small lexer walks the command as bash does — single/double quotes, backslash, `#`
//      comments, line continuations, and the bodies of EVERY heredoc (any command, quoted or
//      not) — so an introducer counts only at TOP LEVEL: not inside a quote, not after a
//      continuation, not in a comment, not inside another heredoc's body.
//   2. The consumer line is exactly: optional `cd /<plain path> &&`, then `cat` or `tee [-a]`
//      with plain-word file operands / `>`/`>>` redirects, ONE quoted delimiter `<<'D'`/`<<"D"`
//      (`<<-` allowed), nothing else — no quote, `$`, backtick, backslash, `#`, `;`, `|`, `&`
//      (beyond the one `&&`), `(`, `)`, `<` (beyond the operator). A quoted delimiter means the
//      shell expands nothing in the body.
//   3. Nothing is stripped if the text outside the bodies can redefine what `cat`/`tee` are
//      (`function`, `alias`, `hash`, `enable`, `exec`, `shopt`, a PATH/BASH_ENV/ENV assignment)
//      or holds any grouping/pipe/`eval`/`$'` (see REDEFINES).
//   4. A body saved to a file that a LATER scanned line might run stays scanned: any later line
//      naming a sink's basename (quotes removed), or carrying `$`, a glob, a backtick, `<`,
//      `eval`, `source` or `.`. Inert consumer lines and their terminators are not "later
//      lines" (appending twice to one file executes nothing). Fixpoint over the kept set.
// Residual (THREAT_MODEL T-HOOKABORT-001 / D-084 r4): a file written now and executed by a
// LATER Bash call is beyond any per-command scan. A missing terminator hides nothing.

const WORD = String.raw`[A-Za-z0-9_./@%+,=:-]+`;
const CD_PREFIX_RE = new RegExp(String.raw`^\s*cd\s+/` + String.raw`[A-Za-z0-9_./@%+,=:-]*` + String.raw`\s*&&\s*`);
const SINK_OP = String.raw`(?:\s+(?:>>?\s*)?` + WORD + `)`;
const CONSUMER_RE = new RegExp(
  String.raw`^\s*(?:cat|tee(?:\s+-a)?)` + SINK_OP + String.raw`*\s*<<(-?)\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2` + SINK_OP + String.raw`*\s*$`
);
// Also: ANY grouping or pipe outside the bodies — `{ }`, `( )`, `$( )`, backticks, `|` — or
// `eval`, or ANSI `$'…'` quoting (the lexer does not model it). A group spanning the consumer
// lines could route tee's stdout copy of the body into an interpreter (critic_security P0,
// second review); refusing to strip is simpler and safer than modelling nesting.
const REDEFINES = /[(){}`|]|\$'|\beval\b|\bfunction\b|\balias\b|\bhash\b|\benable\b|\bshopt\b|\bexec\b|\bPATH\b|\b(?:BASH_ENV|ENV)\+?=/;
const RUNS_LATER = /[$*?[`<]|\beval\b|\bsource\b|(^|[\s;&|(])\.(\s|$)/;

// The files a validated consumer writes to: redirect targets, and tee's file operands.
function sinkPaths(consumer) {
  const words = consumer.replace(/<<-?\s*['"][A-Za-z_][A-Za-z0-9_]*['"]/, " ").trim().split(/\s+/);
  const isTee = words[0] === "tee";
  const out = [];
  for (let k = 1; k < words.length; k++) {
    let w = words[k];
    if (w === ">" || w === ">>") { if (words[k + 1]) out.push(words[++k]); continue; }
    if (w.startsWith(">")) { out.push(w.replace(/^>>?/, "")); continue; }
    if (isTee && !w.startsWith("-")) out.push(w);
  }
  return out.filter((p) => p && p !== "/dev/null");   // /dev/null alone leaves no sink → not inert-by-file
}

// Heredoc operators on one line, outside quotes/comments: [{ delim, dash }] in order.
// Also returns the lexer state at the end of the line.
function lexLine(line, st) {
  const ops = [];
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (st.sq) { if (ch === "'") st.sq = false; i++; continue; }
    if (ch === "\\") { if (i === line.length - 1) { st.cont = true; return ops; } i += 2; continue; }
    if (st.dq) { if (ch === '"') st.dq = false; i++; continue; }
    if (ch === "'") { st.sq = true; i++; continue; }
    if (ch === '"') { st.dq = true; i++; continue; }
    if (ch === "#" && (i === 0 || /[\s;&|()]/.test(line[i - 1]))) return ops;   // comment
    if (ch === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      const m = /^<<(-?)\s*(?:'([^']*)'|"([^"]*)"|\\?([A-Za-z0-9_]+))/.exec(line.slice(i));
      if (m) { ops.push({ dash: m[1] === "-", delim: m[2] ?? m[3] ?? m[4] }); i += m[0].length; continue; }
    }
    i++;
  }
  return ops;
}

/**
 * @param {string} raw
 * @param {{ readOnlyLines?: boolean }} [opts] readOnlyLines (E-340, the Architect sovereignty
 *   rules only): a line OUTSIDE the bodies that readOnlyLine() proves runs nothing but read-only
 *   commands is ignored by rules 3 and 4. Off (the default), the function is unchanged.
 */
export function stripInertHeredocs(raw, { readOnlyLines = false } = {}) {
  const text = String(raw ?? "");
  const lines = text.split("\n");
  const cands = [];            // { intro, from, to, sinks } — inert bodies (from..to-1), terminator at `to`
  const st = { sq: false, dq: false, cont: false };
  const whole = [];            // line n starts and ends at top level and opens no heredoc
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const top = !st.sq && !st.dq && !st.cont;
    st.cont = false;
    const ops = lexLine(line, st);
    if (ops.length === 0) { whole[i] = top && !st.sq && !st.dq && !st.cont; continue; }
    let cand = null;
    if (top && ops.length === 1 && !st.sq && !st.dq && !st.cont) {
      const consumer = line.replace(CD_PREFIX_RE, "");
      // At least one real file: a stdout/fd/device sink can be wired to an interpreter by an
      // earlier `exec 3> >(sh)` / `exec > >(sh)` (and `exec` disables stripping, rule 3).
      const sinks = CONSUMER_RE.test(consumer) ? sinkPaths(consumer) : [];
      if (sinks.length > 0 && sinks.every((p) => !/^\/(dev|proc)\//.test(p))) cand = { intro: i, sinks };
    }
    // Skip every heredoc body this line opened (bash reads them in order after the line).
    let j = i + 1;
    let complete = true;
    for (const op of ops) {
      while (j < lines.length && (op.dash ? lines[j].replace(/^\t+/, "") : lines[j]) !== op.delim) j++;
      if (j >= lines.length) { complete = false; break; }
      if (cand) { cand.from = i + 1; cand.to = j; }
      j++;
    }
    if (!complete) break;                       // no terminator: hide nothing from here on
    if (cand) cands.push(cand);
    i = j - 1;
  }
  if (cands.length === 0) return text;

  const inBody = (n, set) => set.some((c) => n >= c.from && n < c.to);
  const inertLine = (n, set) => set.some((c) => n === c.intro || n === c.to);
  const readOnly = (n) => readOnlyLines && whole[n] === true && readOnlyLine(lines[n]);
  // Under the relaxation a body is also kept when its FILE runs without being named on any line
  // (critic_security, E-340 review): a Makefile, anything under .git/ or .github/, shell rc and
  // profile files, package.json, crontab, or any absolute path outside /tmp (/etc/profile.d …).
  // And it is all-or-nothing: EVERY non-blank line outside the bodies, other than their introducer
  // and terminator lines, must be read-only — before or after the heredoc. One line that is not
  // (`git -c core.hooksPath=.ai/hooks commit` runs a body written to .ai/hooks/post-commit without
  // naming it) keeps every body scanned, exactly as without the relaxation.
  if (readOnlyLines) {
    for (let k = cands.length - 1; k >= 0; k--) if (cands[k].sinks.some((p) => IMPLICIT_RUN.test(p))) cands.splice(k, 1);
    if (cands.length === 0) return text;
    const other = (n) => !inBody(n, cands) && !inertLine(n, cands) && lines[n].trim() !== "";
    if (lines.some((_, n) => other(n) && !readOnly(n))) return text;
  }
  // Rule 3: anything outside the bodies that can change what `cat`/`tee` resolve to.
  const outside = lines.filter((_, n) => !inBody(n, cands) && !readOnly(n)).join("\n");
  if (REDEFINES.test(outside)) return text;

  // Rule 4 (fixpoint): a body whose file a later scanned line might run stays scanned.
  let kept = cands;
  for (let changed = true; changed; ) {
    changed = false;
    kept = kept.filter((c) => {
      const later = [];
      for (let n = c.to + 1; n < lines.length; n++) if (!inBody(n, kept) && !inertLine(n, kept) && !readOnly(n)) later.push(lines[n]);
      const rest = later.join("\n").replace(/['"\\]/g, "");
      const names = c.sinks.map((p) => p.split("/").pop()).filter(Boolean);
      const runs = RUNS_LATER.test(rest) || names.some((b) => rest.includes(b));
      if (runs) changed = true;
      return !runs;
    });
  }
  return lines.filter((_, n) => !inBody(n, kept)).join("\n");
}

// ── E-340: a line that provably runs only read-only commands ─────────────────────────────────
// The Architect's 2026-10-23 D-105 append was blocked as ARCH_GIT_PUSH because the body named
// pushing; stripInertHeredocs kept that body scanned because the line after the terminator was
//   echo "appended; D count: $(grep -c '^## D-' .ai/DECISIONS.md)"; tail -3 .ai/DECISIONS.md | head -1
// (a `$`, parentheses, a pipe, the sink's name). That line runs echo, grep, tail and head: it can
// neither run the file nor redefine cat. readOnlyLine proves it by ALLOWLIST — every command head,
// at top level and inside $( ), is in READ_ONLY — and refuses anything it does not model:
// redirections, `&`, subshells, braces, backticks, backslashes, $'…', arithmetic, a variable or a
// quote at a head, an unbalanced quote. A refusal only means "not exempt" — the line is then
// scanned exactly as before E-340. Two earlier E-340 cuts modelled the whole shell and marked text
// as DATA by denylist; both failed critic_security, because every parser gap hid a command.
const IMPLICIT_RUN =
  /(?:^|\/)(?:GNUmakefile|[Mm]akefile|[^/]*\.mk|\.(?:bash|zsh|ksh)?rc|\.(?:bash_)?profile|\.bash_login|\.zprofile|\.zlogin|\.zshenv|\.envrc|\.npmrc|package\.json|\.gitconfig|crontab|\.pre-commit-config\.yaml|conftest\.py)$|(?:^|\/)\.(?:git|github|husky)\/|^\/(?!tmp\/)/;
const READ_ONLY = new Set([
  // not printf: `printf -v PATH …` assigns a variable (critic_security, E-340 third review)
  "echo", "grep", "egrep", "fgrep", "tail", "head", "wc", "cat", "ls", "cut", "tr",
  "true", "false", "test", "[", "pwd", "basename", "dirname", "stat",
]);
export function readOnlyLine(line) {
  const s = String(line);
  const stack = [];          // "dq" | "sub" — the top level is the empty stack
  let head = true;           // the next word in a code context is a command head
  let i = 0;
  const inCode = () => stack.length === 0 || stack[stack.length - 1] === "sub";
  while (i < s.length) {
    const ch = s[i];
    if (!inCode()) {                               // inside "…": only $( ) and the closing quote matter
      if (ch === '"') { stack.pop(); i++; continue; }
      if (ch === "\\" || ch === "`") return false;
      if (ch === "$" && s[i + 1] === "(") { if (s[i + 2] === "(") return false; stack.push("sub"); head = true; i += 2; continue; }
      i++; continue;
    }
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === ";" || ch === "|") {
      if (head) return false;                      // an empty command: `;;`, `| |`, a leading `|`
      if (s[i + 1] === ch) i++;                    // `||`, `;;` refused above unless after a word
      head = true; i++; continue;
    }
    if (ch === "&") { if (s[i + 1] !== "&" || head) return false; head = true; i += 2; continue; }
    if (ch === ")") { if (stack[stack.length - 1] !== "sub" || head) return false; stack.pop(); head = false; i++; continue; }
    if (ch === "$" && s[i + 1] === "(") {
      if (head || s[i + 2] === "(") return false;
      stack.push("sub"); head = true; i += 2; continue;
    }
    if ("<>(){}`\\#".includes(ch)) return false;
    if (ch === "$" && s[i + 1] === "'") return false;
    if (ch === "'") {
      if (head) return false;
      const e = s.indexOf("'", i + 1);
      if (e === -1) return false;
      i = e + 1; continue;
    }
    if (ch === '"') { if (head) return false; stack.push("dq"); i++; continue; }
    // a plain word: up to whitespace or a character handled above
    let j = i;
    while (j < s.length && !/[\s;|&()<>{}`\\#'"]/.test(s[j]) && !(s[j] === "$" && s[j + 1] === "(")) j++;
    const word = s.slice(i, j);
    if (head) {
      if (!READ_ONLY.has(word)) return false;
      head = false;
    }
    i = j;
  }
  return stack.length === 0 && !head;
}
