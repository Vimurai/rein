// git-view.mjs — each git command as `git <subcommand> …`, the way git reads it (E-438, D-163
// addendum 2 r2; A2A rulings 2026-11-18 08:19 and 09:06).
// The Architect's git rules matched `\bgit\s+push` on the raw text, so `"git" push` (a quoted verb)
// and `git -C . push` (a global option before the subcommand) passed — and with them
// `g=git; "$g" push` and `$g -C . push` after the assigned-verb expansion (assigned-verbs.mjs).
// gitCommandView returns one line per POSSIBLE subcommand of each git command, so the same rules can
// match `git push` on it:
//   - words are read through the shared normaliser (quotes and backslashes removed —
//     src/shared/shell-word.mjs, no second normaliser);
//   - every word between `git` and the first plain word is a global option (09:06 r1: the list is
//     not extended — `--glob-pathspecs`, `--no-advice`, `--attr-source x` are options too). A word in
//     the space-valued set consumes the next word; a word with `=` does not; any other option word
//     MAY take a value, so both the next word and the one after it are tested as the subcommand;
//   - a word holding `$` or a backtick before the subcommand may expand to an option and its value
//     (`${A:+-C .}`): it counts as such an option, an unclosed `${` running to the word that closes it
//     (09:06 r3, fail closed);
//   - two readers (09:06 r2): the frozen shellCommands (D-163 r5) and a reader with no shell grammar
//     that splits on ; | & and newlines, then on whitespace — so a quote-state slip in the first
//     (`# it's`, an apostrophe in a heredoc body) cannot hide the command. A line blocks if either
//     reader yields a forbidden subcommand.
import { realpathSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { decodeAnsiC, normaliseWord, shellCommands } from "../../shared/shell-word.mjs";

const SPACE_VALUED = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env",
  "--attr-source", "--super-prefix", "--exec-path", "--list-cmds"]);
// 09:12 narrowing: a candidate is a subcommand only when it IS one of the Architect's forbidden
// verbs (exact, case-folded) — `git --no-pager log -- push.md` names a file, not a push.
const FORBIDDEN = new Set(["reset", "revert", "checkout", "clean", "merge", "rebase", "push", "pull", "branch"]);
const isGit = (w) => w.slice(w.lastIndexOf("/") + 1).toLowerCase() === "git";
// 09:12 (A): $'…' and $"…" are quoting, not expansion — they are decoded, not skipped.
const dynamic = (raw) => /[$`]/.test(raw.replace(/\$'(?:[^'\\]|\\[\s\S])*'|\$"[^"]*"/g, ""));
const readWord = (raw) => normaliseWord(decodeAnsiC(raw));
// A redirection operator with its target (for the grammar-free readers only — shellCommands is frozen).
// The fd prefix is digits or bash's named fd `{NAME}` glued to the operator (A2A 09:22: `{fd}>f`,
// `{fd}>&-`); a spaced `{fd} >f` or a brace list `{a,b}` stays an ordinary word, as bash reads it.
const REDIRECT = /(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})?(?:<<<|<<-|<<|&>>|&>|>>|>\||<>|>&|<&|<|>)[ \t]*(?:"[^"\n]*"|'[^'\n]*'|[^\s<>;|&()`]*)/g;
const openBraces = (raw) => (raw.match(/\$\{/g) || []).length - (raw.match(/\}/g) || []).length;

// The subcommand lines of one command's words (raw and normalised, index-aligned).
function views(rawWords, words, out) {
  for (let i = 0; i < words.length; i++) {
    if (!isGit(words[i])) continue;
    const seen = new Set();
    const queue = [i + 1];
    while (queue.length) {
      const k = queue.pop();
      if (k >= words.length || seen.has(k)) continue;
      seen.add(k);
      const w = words[k], r = rawWords[k];
      if (dynamic(r)) {                                   // may expand to an option and its value
        let end = k;
        for (let open = openBraces(r); open > 0 && end + 1 < words.length; ) open += openBraces(rawWords[++end]);
        queue.push(end + 1, end + 2);
      } else if (w.startsWith("-") && w.length > 1) {
        if (SPACE_VALUED.has(w)) queue.push(k + 2);
        else if (w.includes("=")) queue.push(k + 1);
        else queue.push(k + 1, k + 2);                    // an option that may take a value
      } else {
        // Only the subcommand word: the rules match `git <verb>`, and the reset/checkout targets come
        // from the tokens. Emitting the rest of the command made `git `×10k quadratic (2.7 s).
        if (FORBIDDEN.has(w.toLowerCase())) out.push("git " + w);
      }
    }
  }
}

/** One `git <subcommand> …` line per possible subcommand of every git command (or ""). */
export function gitCommandView(raw) {
  const out = [];
  for (const cmd of shellCommands(raw)) views(cmd, cmd.map(readWord), out);
  // The grammar-free readers (A2A 09:06 r2, 09:16): two cuts, each a view of its own, and a line
  // blocks if ANY view hits — a new view may never turn a blocked row into a pass (09:16 rule).
  //   - commands end at ; | & newline (the first cut: `git $(echo -C .) push` stays one command);
  //   - commands also end at ( ) and backticks (`$(…; git -C . push)` would leave `push)`).
  // In both, a word also ends at < and > — bash ends a word there (`push>/dev/null`).
  // A2A 09:19: a redirection is a lexical token, not grammar — each operator (with or without an fd
  // number) is dropped WITH its target, attached or separate, before the cut, so `git >x push`,
  // `git -C .>x push` and `git 2>/dev/null push` leave `git push`; `<<<` drops its word and `<<` /
  // `<<-` the heredoc delimiter.
  const text = String(raw ?? "").replace(REDIRECT, " ");
  for (const cut of [/[;|&\n]+/, /[;|&\n()`]+/]) {
    for (const seg of text.split(cut)) {
      const rawWords = seg.split(/[\s<>]+/).filter(Boolean);
      views(rawWords, rawWords.map(readWord), out);
    }
  }
  return out.join("\n");
}

// E-441 (D-164 r7; .ai/SECURITY.md "E-438" RX1, RX2): a `cd`, `pushd` or `popd` before a git
// command moves the tree git runs in, so `.ai/x` there names another tree's `.ai/`. A directory
// change counts unless its operand is literally the project root the analyzer was given (the
// `cd <project root> &&` prefix every Bash call carries). Fail closed: no root given, no operand
// (`cd` goes HOME), `-`, a `pushd +N`, any `popd`, or an operand holding `$` or a backtick all
// count. Grammar-free, like the readers above: any word before the git word, split on ; | & ( ) `
// { } < > and whitespace, so a subshell `(cd .. && git …)` is seen.
const CD_VERBS = new Set(["cd", "pushd", "popd"]);
const CD_OPTION = /^-[LPe@]+$/;
const trimSlash = (p) => normalize(p).replace(/(.)\/+$/, "$1");
function rootForms(projectRoot) {
  if (!projectRoot) return null;
  const forms = new Set([trimSlash(String(projectRoot))]);
  try { forms.add(realpathSync(String(projectRoot))); } catch { /* the given spelling only */ }
  return forms;
}
function cdLeavesRoot(rawWords, k, roots) {
  if (!roots || readWord(rawWords[k]).toLowerCase() === "popd") return true;
  let j = k + 1;
  while (j < rawWords.length && CD_OPTION.test(normaliseWord(rawWords[j]))) j++;
  if (j < rawWords.length && normaliseWord(rawWords[j]) === "--") j++;
  const raw = rawWords[j];
  if (raw === undefined || /[$`]/.test(raw)) return true;
  const w = normaliseWord(raw);
  return !(isAbsolute(w) && roots.has(trimSlash(w)));
}
// security_engineer passes 1-2: a word the shell builds at run time — an expansion (`${X:-cd}`,
// `$c`, `cd${IFS}/tmp`) or a brace list (`{cd,/tmp}`) — may be cd. Parsing for the command word
// lost to redirections, quoted assignments, `time -p`, `\builtin` (pass 2), so the reader is
// inverted (fail closed): a segment holding such a word counts as a possible cd UNLESS its first
// word is a plain literal command that cannot run cd in this shell (`echo "$X"`, `cat "$F"`).
// A shell keyword or a word that runs its arguments in this shell is never that command.
const PLAIN = /^[A-Za-z0-9_./+:][A-Za-z0-9_./+:-]*$/;
const RUNS_IN_SHELL = new Set(["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "for", "select",
  "case", "in", "esac", "function", "time", "builtin", "command", "exec", "eval", "trap", "source", ".", "cd", "pushd", "popd",
  "alias", "unalias"]);   // pass 3: `alias c="${X:-cd}"` defines a command word that may be cd
const BRACE_LIST = /\{[^{}]*(?:,|\.\.)[^{}]*\}/;
function dynamicVerbBeforeGit(text) {
  let built = false;
  // A redirection is dropped with its target first (`0<&- ${X:-cd}` — pass 2), as above.
  for (const seg of text.replace(REDIRECT, " ").split(/[;|&()`\n]+/)) {
    const words = seg.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    if (built && words.some((w) => isGit(readWord(w)))) return true;
    const first = words[0];
    if (PLAIN.test(first) && !RUNS_IN_SHELL.has(first.toLowerCase())) continue;
    if (words.some((w) => dynamic(w) || BRACE_LIST.test(w))) built = true;
  }
  return false;
}
function cdBeforeGit(raw, projectRoot) {
  // A backslash-newline joins two lines into one word (`c\<newline>d` is cd — pass 2).
  const text = String(raw ?? "").replace(/\\\r?\n/g, "");
  if (dynamicVerbBeforeGit(text)) return true;
  // Words read as readWord reads them: `$'\x63d'` is cd (security_engineer pass 1).
  const rawWords = text.split(/[\s;|&()`{}<>]+/).filter(Boolean);
  const roots = rootForms(projectRoot);
  let moved = false;
  for (let k = 0; k < rawWords.length; k++) {
    const w = readWord(rawWords[k]);
    if (CD_VERBS.has(w.toLowerCase())) { if (cdLeavesRoot(rawWords, k, roots)) moved = true; }
    else if (moved && isGit(w)) return true;
  }
  return false;
}

/**
 * True when a git line points git at another tree (09:06 r4): a `-C` whose value is not exactly
 * `.`, or `--work-tree`, `--git-dir`, `core.worktree` anywhere on it — or (E-441) a `cd`, `pushd`
 * or `popd` before the git command that leaves `projectRoot`. The Architect's `.ai/` / `plans/`
 * exemption for reset/revert/checkout/clean does not hold on such a line.
 */
export function gitRelocated(raw, projectRoot) {
  if (cdBeforeGit(raw, projectRoot)) return true;
  const words = String(raw ?? "").split(/[\s;|&]+/).filter(Boolean).map(normaliseWord);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "-C" && words[i + 1] !== ".") return true;
    if (/^-C./.test(w) && w !== "-C.") return true;
    if (/^--(?:work-tree|git-dir)(?:=|$)/.test(w) || /core\.worktree/i.test(w)) return true;
  }
  return false;
}
