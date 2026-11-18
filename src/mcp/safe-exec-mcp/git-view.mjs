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

/**
 * True when a git line points git at another tree (09:06 r4): a `-C` whose value is not exactly
 * `.`, or `--work-tree`, `--git-dir`, `core.worktree` anywhere on it. The Architect's `.ai/` /
 * `plans/` exemption for reset/revert/checkout/clean does not hold on such a line.
 */
export function gitRelocated(raw) {
  const words = String(raw ?? "").split(/[\s;|&]+/).filter(Boolean).map(normaliseWord);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (w === "-C" && words[i + 1] !== ".") return true;
    if (/^-C./.test(w) && w !== "-C.") return true;
    if (/^--(?:work-tree|git-dir)(?:=|$)/.test(w) || /core\.worktree/i.test(w)) return true;
  }
  return false;
}
