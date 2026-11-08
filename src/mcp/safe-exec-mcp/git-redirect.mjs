// git-redirect.mjs — a git line that points git at other executable text (E-350, D-111 r6 iii).
// A hooks directory is a set of programs git runs on commit/checkout/merge, and GIT_DIR names
// the repository whose hooks and config git loads. Setting either is how text the Architect may
// write (.ai/, plans/) becomes code the next git command executes, so these block for the
// Architect regardless of the target path. Reading the value is not setting it.
//
// Matched on the text with quotes and backslashes removed: the shell joins `core."hooksPath"`,
// `core.hooks\Path` and `"git"` into the plain words before git sees them.
const HOOKS_KEY = /core\.hookspath/i;
// git's global options that take the next word as their value.
const VALUED_FLAGS = new Set(["-C", "-c", "--namespace", "--exec-path", "--super-prefix", "--config-env"]);

// `git [options] --git-dir…|--work-tree…`: after a `git` word, a run of options (a word of two
// or more characters starting with `-`, or a VALUED_FLAGS word and its value) then --git-dir /
// --work-tree, followed by `=` or whitespace. One right-to-left pass over the words instead of
// the alternation regex it replaces, which backtracked exponentially on `-C -! -C -! …`
// (E-397, CodeQL js/redos); the words it accepts are the same.
function gitDirFlagged(r) {
  const words = [...r.matchAll(/\S+/g)];
  const at = new Map(words.map((w, i) => [w.index, i]));
  const reach = new Array(words.length + 2).fill(false);
  for (let i = words.length - 1; i >= 0; i--) {
    const w = words[i][0];
    const target = /^--(git-dir|work-tree)=/.test(w) ||
      ((w === "--git-dir" || w === "--work-tree") && words[i].index + w.length < r.length);
    reach[i] = target || (w.length > 1 && w[0] === "-" && reach[i + 1]) || (VALUED_FLAGS.has(w) && reach[i + 2]);
  }
  for (const m of r.matchAll(/\bgit\s+/g)) {
    const i = at.get(m.index + m[0].length);
    if (i !== undefined && reach[i]) return true;
  }
  return false;
}

// The argument text of every `git … config …` on the line: what
// r.matchAll(/\bgit\b[^\n;&|]*?\sconfig\b([^\n;&|]*)/gi) captured, in linear time (E-398). The
// lazy regex retried its scan from every `git` word, quadratic in the word count (~100 ms at
// MAX_WORDS on `git `×10k). Here the `git` words, the `\sconfig\b` starts and the separators
// are each listed once and walked with forward-only cursors. Exactly the regex's semantics: the
// whitespace before `config` may itself be a newline (\s), nothing between the `git` word and it
// may be one of \n ; & |, the capture runs to the next of those, and the next `git` is looked
// for after the capture (non-overlapping matches).
export function configArgs(r) {
  const gits = [...r.matchAll(/\bgit\b/gi)].map((m) => m.index);
  const cfgs = [...r.matchAll(/\s(?=config\b)/gi)].map((m) => m.index);
  const seps = [...r.matchAll(/[\n;&|]/g)].map((m) => m.index);
  const out = [];
  let gi = 0, ci = 0, si = 0, from = 0;
  while (gi < gits.length) {
    const g = gits[gi++];
    if (g < from) continue;
    const gEnd = g + 3;
    while (si < seps.length && seps[si] < gEnd) si++;
    const segEnd = si < seps.length ? seps[si] : r.length;   // the lazy run may not cross it…
    while (ci < cfgs.length && cfgs[ci] < gEnd) ci++;
    if (ci >= cfgs.length) break;                            // no `config` after any later git either
    const s = cfgs[ci];
    if (s > segEnd) continue;                                // …but the \s may BE it (a newline)
    const argStart = s + 7;                                  // \s + "config"
    let k = si;
    while (k < seps.length && seps[k] < argStart) k++;
    const argEnd = k < seps.length ? seps[k] : r.length;
    out.push(r.slice(argStart, argEnd));
    from = argEnd;
  }
  return out;
}

export function gitRedirectHits(raw) {
  const r = String(raw ?? "").replace(/["'\\]/g, "");
  if (!/(^|[^A-Za-z0-9_.-])git(\s|$)/.test(r)) return [];
  const hits = [];
  // git -c core.hooksPath=…, git --config-env=core.hooksPath=…, or the config pushed through
  // GIT_CONFIG_PARAMETERS / GIT_CONFIG_KEY_<n> (the same setting by another spelling).
  const viaFlag = /(^|\s)(-c\s*|--config-env[=\s])core\.hookspath\s*=/i.test(r);
  // The value is captured and searched rather than scanned up to the key inside the regex, which
  // was quadratic on `GIT_CONFIG_KEY_0=(GIT_CONFIG_KEY_0=(…` (E-397, CodeQL js/polynomial-redos).
  // A later assignment inside a consumed value ends where that value ends, so it adds nothing.
  const viaEnv = [...r.matchAll(/(^|[\s;&|(])(export\s+)?GIT_CONFIG_(PARAMETERS|KEY_[0-9]+)=([^\s;&|]*)/gi)]
    .some((m) => HOOKS_KEY.test(m[4]));
  // git [global options] config [scope flags] core.hooksPath <value> — unless it only reads it.
  const viaConfig = configArgs(r).some((args) =>
    HOOKS_KEY.test(args) && !/(^|\s)(--get|--get-all|--get-regexp|-l|--list)(\s|$)/.test(args));
  if (viaFlag || viaEnv || viaConfig) {
    hits.push({ id: "ARCH_GIT_HOOKS_PATH",
      message: "setting core.hooksPath is a forbidden Architect operation — a hooks directory is code git executes, whatever its path" });
  }
  // GIT_DIR= / GIT_WORK_TREE= on the same command line as git (prefix assignment or export), and
  // their flag spellings --git-dir / --work-tree as git's own global options (before the
  // subcommand — `git rev-parse --git-dir` only prints the path). -C, -c and --namespace take a
  // value, so the word after them is skipped too.
  if (/(^|[\s;&|(])(export\s+)?(GIT_DIR|GIT_WORK_TREE)=/.test(r) || gitDirFlagged(r)) {
    hits.push({ id: "ARCH_GIT_DIR_OVERRIDE",
      message: "pointing git at another GIT_DIR / work tree is a forbidden Architect operation — it loads that repository's hooks and config" });
  }
  return hits;
}
