// git-redirect.mjs — a git line that points git at other executable text (E-350, D-111 r6 iii).
// A hooks directory is a set of programs git runs on commit/checkout/merge, and GIT_DIR names
// the repository whose hooks and config git loads. Setting either is how text the Architect may
// write (.ai/, plans/) becomes code the next git command executes, so these block for the
// Architect regardless of the target path. Reading the value is not setting it.
//
// Matched on the text with quotes and backslashes removed: the shell joins `core."hooksPath"`,
// `core.hooks\Path` and `"git"` into the plain words before git sees them.
const HOOKS_KEY = /core\.hookspath/i;

export function gitRedirectHits(raw) {
  const r = String(raw ?? "").replace(/["'\\]/g, "");
  if (!/(^|[^A-Za-z0-9_.-])git(\s|$)/.test(r)) return [];
  const hits = [];
  // git -c core.hooksPath=…, git --config-env=core.hooksPath=…, or the config pushed through
  // GIT_CONFIG_PARAMETERS / GIT_CONFIG_KEY_<n> (the same setting by another spelling).
  const viaFlag = /(^|\s)(-c\s*|--config-env[=\s])core\.hookspath\s*=/i.test(r);
  const viaEnv = /(^|[\s;&|(])(export\s+)?GIT_CONFIG_(PARAMETERS|KEY_[0-9]+)=[^\s;&|]*core\.hookspath/i.test(r);
  // git [global options] config [scope flags] core.hooksPath <value> — unless it only reads it.
  let viaConfig = false;
  for (const m of r.matchAll(/\bgit\b[^\n;&|]*?\sconfig\b([^\n;&|]*)/gi)) {
    const args = m[1];
    if (HOOKS_KEY.test(args) && !/(^|\s)(--get|--get-all|--get-regexp|-l|--list)(\s|$)/.test(args)) viaConfig = true;
  }
  if (viaFlag || viaEnv || viaConfig) {
    hits.push({ id: "ARCH_GIT_HOOKS_PATH",
      message: "setting core.hooksPath is a forbidden Architect operation — a hooks directory is code git executes, whatever its path" });
  }
  // GIT_DIR= / GIT_WORK_TREE= on the same command line as git (prefix assignment or export), and
  // their flag spellings --git-dir / --work-tree as git's own global options (before the
  // subcommand — `git rev-parse --git-dir` only prints the path). -C, -c and --namespace take a
  // value, so the word after them is skipped too.
  if (/(^|[\s;&|(])(export\s+)?(GIT_DIR|GIT_WORK_TREE)=/.test(r) ||
      /\bgit\s+((-C|-c|--namespace|--exec-path|--super-prefix|--config-env)\s+\S+\s+|-\S+\s+)*--(git-dir|work-tree)(=|\s)/.test(r)) {
    hits.push({ id: "ARCH_GIT_DIR_OVERRIDE",
      message: "pointing git at another GIT_DIR / work tree is a forbidden Architect operation — it loads that repository's hooks and config" });
  }
  return hits;
}
