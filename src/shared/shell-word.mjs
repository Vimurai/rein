// shell-word.mjs — one shell word as the gate reads it (D-112 r1-r2, E-350; reused by E-393 under
// D-132 addendum 4 r7). The ONE word normaliser: safe-exec's root-form check (RM_RF_ROOT) and the
// `rein gate` check (GATE_SELF_DISABLE) both read a word through it, so the two cannot drift.
//
// normaliseWord(raw) is the word the way it can expand at its most dangerous: every expansion
// ($X ${X} ${X:-…} $1 $@ $( ) `…`) empty, `$'…'` opened like a plain quote, quotes and
// backslashes removed, `//` and `/./` collapsed. `re""in`, `\rein`, `$'rein'`, `"$HOME"/x/rein`
// all come out as the name the shell runs. Hex and octal escapes inside `$'…'` are NOT decoded:
// `$'\x72ein'` is the runtime-assembly residual the classifier owns (D-089, D-132 addendum 4 r7).

const EXPANSION = /\$[A-Za-z_][A-Za-z0-9_]*|\$[0-9@*#?!$-]|\$\([^()]*\)|`[^`]*`/g;
const INNER_BRACE = /\$\{[^{}]*\}/g;

export function normaliseWord(raw) {
  let w = String(raw).replace(/\$'/g, "'");
  for (let prev = ""; prev !== w;) { prev = w; w = w.replace(INNER_BRACE, ""); }   // ${A+${B}} inside out
  return w.replace(EXPANSION, "").replace(/["'\\]/g, "")
    .replace(/\/(\.\/)+/g, "/").replace(/\/{2,}/g, "/").replace(/\/(\.\/)+/g, "/");
}

// ── D-163 r1: the self-disable lock is a three-word text predicate ──────────────────────────
// Two views of the text: V1 deletes ' " backslash-newline, every other backslash and [ ] ? *;
// V2 deletes ' and " and turns each backslash with the character after it into one space. A word
// is a maximal run of [A-Za-z0-9_-]. The text names the disable when ONE LINE of one view holds the
// words `rein`, `gate` and `off`, in any order (compared without case, as the verb fold does) —
// lines are split after the view is built (D-163 addendum 1: a long prose append names all three
// in unrelated paragraphs). What this cannot see — a word literal in neither view, or the words on
// different lines — is the r3 residual, the classifier's. hooks/pre-tool-use.sh's no-verdict
// fallback implements the same definition.
export function gateViews(text) {
  const s = String(text);
  return [
    s.replace(/\\\r?\n/g, "").replace(/['"\\[\]?*]/g, ""),
    s.replace(/['"]/g, "").replace(/\\[\s\S]?/g, " "),
  ];
}
const GATE_OFF_WORDS = ["rein", "gate", "off"];
export function namesGateOff(text) {
  return gateViews(text).some((v) => v.split("\n").some((line) => {
    const words = new Set((line.match(/[A-Za-z0-9_-]+/g) ?? []).map((w) => w.toLowerCase()));
    return GATE_OFF_WORDS.every((w) => words.has(w));
  }));
}

// Words and command boundaries of a command line, honouring quotes the way the shell does:
// whitespace inside '…', "…" or $'…' does not split, and a backslash escapes the next byte; a
// backslash-newline joins lines. Separators (outside quotes): ; & | newline ( ) and a backtick;
// `$(` opens a command, so it is a separator too, and a `$(…)` or `…` inside double quotes is
// read as a command of its own (E-393 security_engineer F1). Redirections are operators, not
// words (F2): `2>&1`, `>/dev/null`, `<f` drop with their target; a here-string's text is kept on
// the command as `.here`. Each command carries `.sep`, the separator before it ("|" for a pipe).
// Returns an array of commands, each an array of RAW words (quotes kept, for normaliseWord).
const REDIR = /^(?:<<<|<<-|<<|<>|<&|>>|>&|>\||<|>)/;
// `depth` bounds the nested `"$(…)"` re-reads (8 levels): past it, the inner text is not read
// separately — the caller's other rules still see the whole line.
export function shellCommands(cmd, depth = 0) {
  const s = String(cmd).replace(/\\\r?\n/g, "");
  const out = [], nested = [];
  // q: the closing quote while inside one; esc: a backslash escapes there ("…" and $'…', not '…').
  let words = [], cur = "", inWord = false, q = "", esc = false, redir = "", sep = "";
  const push = (w) => {
    if (redir === "<<<") (words.here ??= []).push(w);
    if (redir) { redir = ""; return; }
    words.push(w);
  };
  const endWord = () => { if (inWord) push(cur); cur = ""; inWord = false; };
  const endCmd = (next) => {
    endWord(); redir = "";
    if (words.length || words.here) { words.sep = sep; out.push(words); }
    words = []; sep = next;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (q === '"' && (c === "`" || (c === "$" && s[i + 1] === "("))) {   // a command inside "…"
        let j = i + 1, depth = 0;
        if (c === "`") { while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1; }
        else { for (depth = 1, j = i + 2; j < s.length && depth; j++) depth += s[j] === "(" ? 1 : s[j] === ")" ? -1 : 0; j--; }
        nested.push(s.slice(c === "`" ? i + 1 : i + 2, j));
        cur += s.slice(i, j + 1); i = j; continue;
      }
      cur += c;
      if (c === "\\" && esc && i + 1 < s.length) { cur += s[++i]; continue; }
      if (c === q) q = "";
      continue;
    }
    if (c === "\\" && i + 1 < s.length) { cur += c + s[++i]; inWord = true; continue; }
    if (c === "'" || c === '"') { q = c; esc = c === '"' || s[i - 1] === "$"; cur += c; inWord = true; continue; }
    if (c === "<" || c === ">" || (c === "&" && s[i + 1] === ">")) {
      if (c !== "&" && inWord && /^\d+$/.test(cur)) { cur = ""; inWord = false; } else endWord();
      const op = c === "&" ? (s[i + 2] === ">" ? "&>>" : "&>") : REDIR.exec(s.slice(i, i + 3))[0];
      if (op === "<" && s[i + 1] === "(") continue;    // <( … ): process substitution, a command
      redir = op; i += op.length - 1; continue;
    }
    if (c === "$" && s[i + 1] === "(") { endCmd(""); i++; continue; }
    if (c === "|") { const pipe = s[i + 1] !== "|"; if (!pipe) i++; else if (s[i + 1] === "&") i++; endCmd(pipe ? "|" : ""); continue; }
    if (/[;&\n()`]/.test(c)) { endCmd(""); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    cur += c; inWord = true;
  }
  endCmd("");
  if (depth < 8) for (const n of nested) for (const w of shellCommands(n, depth + 1)) { w.sep = ""; out.push(w); }
  return out;
}
