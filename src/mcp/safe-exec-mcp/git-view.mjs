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

// Every possible subcommand of each git command in one command's words (raw and normalised,
// index-aligned): onSub(word, index) per candidate; then onDone(options) once per git word, with
// the global-option words read (a dynamic word counts as one — it may expand to `-c k=v`). Checking the options once per git word
// keeps the walk linear in its own words (security_engineer E-453 F8: a check per candidate over
// the growing list was cubic — 26 s on `git -a `×800).
// One visited set for the whole command: the words reachable from a position are the same
// whichever git word reached it first, so a later git word that meets a visited position has
// already had its candidates and options reported (`git -a `×n was quadratic, F8).
function walk(rawWords, words, onSub, onDone) {
  const seen = new Set();
  for (let i = 0; i < words.length; i++) {
    if (!isGit(words[i])) continue;
    const queue = [i + 1];
    const options = [];
    while (queue.length) {
      const k = queue.pop();
      if (k >= words.length) continue;
      if (seen.has(k)) continue;
      seen.add(k);
      const w = words[k], r = rawWords[k];
      if (dynamic(r)) {                                   // may expand to an option and its value
        options.push(r);
        let end = k;
        for (let open = openBraces(r); open > 0 && end + 1 < words.length; ) open += openBraces(rawWords[++end]);
        queue.push(end + 1, end + 2);
      } else if (w.startsWith("-") && w.length > 1) {
        options.push(w);
        if (SPACE_VALUED.has(w)) queue.push(k + 2);
        else if (w.includes("=")) queue.push(k + 1);
        else queue.push(k + 1, k + 2);                    // an option that may take a value
      } else {
        onSub(w, k);
      }
    }
    if (onDone) onDone(options);
  }
}

// Each reader's commands as [rawWords, words] (the grammar-free readers: A2A 09:06 r2, 09:16 —
// two cuts, each a view of its own, and a line blocks if ANY view hits; a new view may never turn
// a blocked row into a pass, 09:16 rule).
//   - commands end at ; | & newline (the first cut: `git $(echo -C .) push` stays one command);
//   - commands also end at ( ) and backticks (`$(…; git -C . push)` would leave `push)`).
// In both, a word also ends at < and > — bash ends a word there (`push>/dev/null`).
// A2A 09:19: a redirection is a lexical token, not grammar — each operator (with or without an fd
// number) is dropped WITH its target, attached or separate, before the cut, so `git >x push`,
// `git -C .>x push` and `git 2>/dev/null push` leave `git push`; `<<<` drops its word and `<<` /
// `<<-` the heredoc delimiter.
function readers(raw, visit) {
  for (const cmd of shellCommands(raw)) visit(cmd, cmd.map(readWord));
  const text = String(raw ?? "").replace(REDIRECT, " ");
  for (const cut of [/[;|&\n]+/, /[;|&\n()`]+/]) {
    for (const seg of text.split(cut)) {
      const rawWords = seg.split(/[\s<>]+/).filter(Boolean);
      visit(rawWords, rawWords.map(readWord));
    }
  }
}

/** One `git <subcommand> …` line per possible subcommand of every git command (or ""). */
export function gitCommandView(raw) {
  const out = [];
  // Only the subcommand word: the rules match `git <verb>`, and the reset/checkout targets come
  // from the tokens. Emitting the rest of the command made `git `×10k quadratic (2.7 s).
  readers(raw, (rawWords, words) => walk(rawWords, words, (w) => {
    if (FORBIDDEN.has(w.toLowerCase())) out.push("git " + w);
  }));
  return out.join("\n");
}

// E-453 (D-167 r7): the Architect passes no configuration to git. Configuration is:
//   - a `-c` (spaced or glued) or `--config-env` among git's global options, or a word there that
//     may expand to one (fail closed); git's top-level parser matches long options exactly;
//   - a git command whose words are dynamic (`git "$@"`, `git $o` — checked once per git word, so
//     a walk with no subcommand candidate is checked too, F3), or come from stdin or a placeholder
//     (`xargs git`, `find -exec git {}`) — fail closed;
//   - `-c`/`--config` after `clone` (they set the new repository's config, security_engineer F2),
//     and anywhere in the command a `-c`/`--config` whose value holds `=` or may expand to it;
//   - a `git config` (or `git-config`) that is not a read. git's legacy config parser stops at
//     the first non-option, so a read flag counts only before it: `git config k v --get` is a
//     write with a value-pattern (F1). The options that take a value are skipped with it.
const CONFIG_READ_FLAGS = new Set(["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--get-color",
  "--get-colorbool", "-l", "--list"]);
const CONFIG_READ_SUBS = new Set(["get", "list"]);   // git 2.46+ `git config get|list …`, first word only
const CONFIG_WRITE_FLAGS = new Set(["--add", "--replace-all", "--unset", "--unset-all", "--rename-section",
  "--remove-section", "-e", "--edit"]);
const CONFIG_VALUED = new Set(["-f", "--file", "--blob", "--type", "--default", "--comment"]);
const passesConfig = (w) => w === "-c" || /^-c./.test(w) || /^--config-env(=|$)/.test(w);
const placeholder = (w) => w.includes("{}");
const CONFIG_LONG = /^--conf(?:i(?:g)?)?(?:=|$)/;
const STDIN_RUNNERS = new Set(["xargs", "parallel"]);
// G2 (second pass): a dynamic word anywhere (`--file $f`) may split into a key and a value — not a read.
function configRead(rest, rawRest) {
  if (rawRest.some(dynamic)) return false;
  if (CONFIG_READ_SUBS.has(rest[0])) return !rest.some((w) => CONFIG_WRITE_FLAGS.has(w));
  let read = false;
  for (let j = 0; j < rest.length; j++) {
    const w = rest[j];
    if (w === "--" || !w.startsWith("-") || w.length < 2) break;       // the first non-option ends the options
    if (CONFIG_WRITE_FLAGS.has(w) || /^--(?:edit|add|unset|replace|rename|remove)/.test(w)) return false;
    if (CONFIG_READ_FLAGS.has(w)) read = true;
    if (CONFIG_VALUED.has(w)) j++;
  }
  return read;
}
const gitDashed = (w) => /^git-[a-z]/.test(w.slice(w.lastIndexOf("/") + 1).toLowerCase());
function commandPassesConfig(rawWords, words) {
  let hit = false;
  const gitAt = words.findIndex((w) => isGit(w) || gitDashed(w));
  if (gitAt < 0) return false;
  if (words.slice(0, gitAt).some((w) => STDIN_RUNNERS.has(w.slice(w.lastIndexOf("/") + 1)))) return true;
  // The dashed exec-path forms (`/usr/lib/git-core/git-config`) are git <sub> (F6).
  for (let i = gitAt; i < words.length; i++) {
    const base = words[i].slice(words[i].lastIndexOf("/") + 1).toLowerCase();
    if (base === "git-config" && !configRead(words.slice(i + 1), rawWords.slice(i + 1))) return true;
  }
  walk(rawWords, words, (w, k) => {
    if (placeholder(w) || (w.toLowerCase() === "config" && !configRead(words.slice(k + 1), rawWords.slice(k + 1)))) hit = true;
  }, (options) => {
    if (options.some((o) => passesConfig(o) || dynamic(o) || placeholder(o))) hit = true;
  });
  if (hit) return true;
  // After the subcommand: `-c`/`--config` with a value that sets a key, or any after `clone` (F2).
  // parse-options takes a short-option bundle (`-qc`) and an unambiguous long prefix (`--conf`), so
  // after `clone` both count (G1, second pass). One forward pass over the command's words.
  let clone = false;
  for (let j = gitAt + 1; j < words.length; j++) {
    const w = words[j];
    if (w.toLowerCase() === "clone") clone = true;
    if (clone && (/^-[^-]*c/.test(w) || CONFIG_LONG.test(w))) return true;
    if (/^-c.|^--conf(?:i(?:g)?)?=/.test(w) && w.includes("=")) return true;
    if (w === "-c" || CONFIG_LONG.test(w)) {
      const v = rawWords[j + 1];
      if (v !== undefined && (clone || dynamic(v) || words[j + 1].includes("="))) return true;
    }
  }
  return false;
}
/** True when a git command on the line passes configuration to git or writes it (E-453). */
export function gitPassesConfig(raw) {
  let hit = false;
  readers(raw, (rawWords, words) => { if (!hit && commandPassesConfig(rawWords, words)) hit = true; });
  return hit;
}

/** True when any reader sees a git command (plain, path or dashed `git-<sub>`) on the line (F5, F6). */
export function runsGit(raw) {
  let hit = false;
  readers(raw, (rawWords, words) => { if (!hit && words.some((w) => isGit(w) || gitDashed(w))) hit = true; });
  return hit;
}

// The D-167 r7 names (HOME stays from E-353, D-112 r3 b) set or exported in a command, read from
// the decoded words (F4: `env $'GIT_X=v' git diff`, `export G$'I'T_X=v`):
//   - `NAME=v`, `NAME+=v`, `NAME[i]=v` as a word — prefix, env, export or declare alike — unless the
//     command is a search that runs nothing (`git grep GIT_PAGER=`, E-353 e);
//   - a setter verb (export, declare, typeset, local, readonly, read, mapfile, readarray, getopts;
//     printf only through -v) followed by the name, by a word whose name part is dynamic
//     (`export $n=v`), or by a nameref to the name (`declare -n r=GIT_X`).
const CONFIG_NAME = "(?:GIT_[A-Za-z0-9_]*|EDITOR|VISUAL|PAGER|XDG_CONFIG_HOME|HOME)";
const NAME_ASSIGN = new RegExp("^" + CONFIG_NAME + "(?:\\[[^\\]]*\\])?\\+?=");
const NAME_WORD = new RegExp("^" + CONFIG_NAME + "(?:\\[|\\+?=|$)");
const NAMEREF = new RegExp("^[A-Za-z_][A-Za-z0-9_]*=" + CONFIG_NAME + "$");
const SETTERS = new Set(["export", "declare", "typeset", "local", "readonly", "read", "mapfile", "readarray", "getopts"]);
const SEARCHES = new Set(["grep", "egrep", "fgrep", "rg", "ag"]);
const RUNS_OPTION = /^(--pre(=|$)|-O|--open-files-in-pager)/;
const verbOf = (w) => w.slice(w.lastIndexOf("/") + 1);
function commandSetsName(rawWords, words) {
  const first = verbOf(words[0] ?? "");
  const search = (SEARCHES.has(first) || (isGit(first) && words.includes("grep"))) && !words.some((w) => RUNS_OPTION.test(w));
  let setter = null, wrapper = false;
  for (let j = 0; j < words.length; j++) {
    const w = words[j], v = verbOf(w);
    if (!search && NAME_ASSIGN.test(w)) return true;
    // G3 (second pass): a for/select loop variable is assigned each pass.
    if ((v === "for" || v === "select") && j + 1 < words.length &&
      (NAME_WORD.test(words[j + 1]) || dynamic(rawWords[j + 1]))) return true;
    // G4: between env/sudo and the command they run, a dynamic word may be `NAME=value`.
    // G3 (d): env's -S/--split-string text (glued or bundled, `-SHOME=x`, `-iS…`) is more words
    // and assignments — fail closed on a git line.
    if (v === "env" || v === "sudo") { wrapper = v; continue; }
    if (wrapper) {
      if (isGit(w) || gitDashed(w)) wrapper = false;
      else if (dynamic(rawWords[j])) return true;
      else if (wrapper === "env" && (/^-[^-]*S/.test(w) || /^--sp/.test(w))) return true;
    }
    if (SETTERS.has(v) || v === "printf") { setter = v; continue; }
    // G3 (b, c): a nameref declaration (`declare -n r`, `local -gn r=$n`) can point at any name.
    if (setter && setter !== "printf" && /^-[^-]*n/.test(w) && setter !== "read" && setter !== "mapfile" &&
      setter !== "readarray") return true;
    if (!setter) continue;
    if (setter === "printf") {
      const name = w === "-v" ? words[j + 1] : /^-v./.test(w) ? w.slice(2) : null;
      const rawName = w === "-v" ? rawWords[j + 1] : rawWords[j];
      if (name !== null && (name === undefined || NAME_WORD.test(name) || dynamic(rawName.split("=")[0]))) return true;
      continue;
    }
    if (NAME_WORD.test(w) || NAMEREF.test(w) || (!w.startsWith("-") && dynamic(rawWords[j].split("=")[0]))) return true;
  }
  return false;
}
/** True when a command on the line sets or exports a D-167 r7 name (E-453). */
export function setsGitConfigName(raw) {
  // `${NAME:=v}` / `${NAME=v}` assign as they expand.
  if (new RegExp("\\$\\{" + CONFIG_NAME + "(\\[[^\\]]*\\])?:?=").test(String(raw ?? ""))) return true;
  let hit = false;
  readers(raw, (rawWords, words) => { if (!hit && words.length && commandSetsName(rawWords, words)) hit = true; });
  return hit;
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
// E-453 (D-167 r8): a command that runs another in a named directory is a directory change —
// `env -C`/`--chdir`, `sudo -D`/`--chdir`, `find -execdir`/`-okdir` — and so is a sourced script
// (`source`, `.` as the command word), which may cd. Fail closed: the operand is not compared with
// the project root, a short-option bundle holding the letter counts (`env -iC`), and a long
// option counts by any prefix getopt_long accepts (`env --ch`, `sudo --ch`).
const WRAPPED_CD = { env: (w) => /^-[^-]*C/.test(w) || /^--c(h(d(i(r)?)?)?)?(=|$)/.test(w),
  sudo: (w) => /^-[^-]*D/.test(w) || /^--ch(d(i(r)?)?)?(=|$)/.test(w) };
const SOURCE_LEAD = new Set(["builtin", "command", "time", "exec", "if", "then", "else", "elif", "do",
  "while", "until", "!", "{", "-p", "--"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
function wrapperCdBeforeGit(text) {
  let moved = false;
  for (const seg of text.replace(REDIRECT, " ").split(/[;|&()`\n]+/)) {
    const words = seg.split(/\s+/).filter(Boolean).map(readWord);
    let lead = true, wrapper = null;
    for (const w of words) {
      if (moved && isGit(w)) return true;
      const verb = w.slice(w.lastIndexOf("/") + 1);
      if (lead && (verb === "." || verb === "source")) moved = true;
      if (wrapper && w.startsWith("-") && WRAPPED_CD[wrapper](w)) moved = true;
      if (w === "-execdir" || w === "-okdir") moved = true;
      // F7: a trap's code (`trap 'source s' DEBUG`) runs before the git command — fail closed.
      if (verb === "trap") moved = true;
      if (Object.hasOwn(WRAPPED_CD, verb)) wrapper = verb;
      // F7: `{` opens a body wherever it stands (`function f { . s; }`): the next word leads.
      lead = w === "{" || (lead && (SOURCE_LEAD.has(w) || ASSIGNMENT.test(w)));
    }
  }
  return false;
}

function cdBeforeGit(raw, projectRoot) {
  // A backslash-newline joins two lines into one word (`c\<newline>d` is cd — pass 2).
  const text = String(raw ?? "").replace(/\\\r?\n/g, "");
  if (dynamicVerbBeforeGit(text) || wrapperCdBeforeGit(text)) return true;
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
