// verb-fold.mjs — a command verb matches without regard to case (D-145 r2, E-398).
// On a case-insensitive filesystem (macOS default, Windows) `GIT`, `/usr/bin/RM` and `"Bash"` run
// git, rm and bash, but the gate's token rules compare verbs case-sensitively, so a capitalised verb
// walked past them (`GIT config core.hooksPath x` passed for the Architect). runAnalysis folds every
// gate verb to lower case before any rule runs.
//
// THE INVARIANT: the fold only turns A–Z into a–z. It never adds, removes or moves a byte —
// foldVerbs(s).length === s.length. A first cut rebuilt the word without its quotes, which re-paired
// every quote after it, so `echo "a RM" ; rm -rf "/"` read the real rm as quoted text and PASSED
// (security_engineer E-398 pass 3, P0). Quotes, backslashes and `$'…'` stay exactly where they are;
// only the decision "is this a verb?" looks through them.
//
// What is folded: within each word (split on whitespace and shell operators), each segment between
// `{`, `}`, `,`, `=` and `:` — so `{BASH,}`, `${X:-BASH}` and `--command='MKDIR` reach the verb —
// whose text, after the shell's quote/backslash removal and `$'` decoding, is a gate verb or the path
// to one; only the letters after the segment's last `/` change. Operands keep their case: `.AI/x` is
// not `.ai/x` on Linux, and folding a directory would OPEN a write outside .ai/. A git subcommand is
// case-sensitive in git itself; a git config key is already matched case-insensitively.

// Every verb a safe-exec rule names (index.js BLOCK/WARN rules, architect-writes.mjs, gate-guard.mjs,
// code-strings.mjs, git-redirect.mjs, the D-112 wave tables). A verb added to a rule is added here.
const VERBS = new Set([
  // file writers / destroyers
  "rm", "mv", "cp", "ln", "tee", "touch", "mkdir", "rmdir", "chmod", "chown", "truncate", "install",
  "rsync", "dd", "unlink", "patch", "sponge", "shred", "sed", "perl", "awk", "gawk", "mawk",
  "tar", "unzip", "cpio", "find", "mkfs",
  // vcs, network, project tools
  "git", "curl", "wget", "make", "npm", "npx", "rein",
  // wrappers and builtins the gate reads through
  "sudo", "su", "runuser", "env", "nice", "command", "exec", "xargs", "time", "nohup", "stdbuf",
  "timeout", "watch", "script", "eval", "source", "history", "setsid", "flock", "builtin",
  // shells and interpreters (code-strings carriers)
  "bash", "sh", "zsh", "dash", "ash", "ksh", "mksh", "fish", "csh", "tcsh", "yash", "posh",
  "node", "nodejs", "ruby", "deno", "bun", "lua", "php", "tmux", "parallel",
]);
const VERB_SHAPES = /^(?:python[0-9.]*|node[0-9.]+|mkfs\.[a-z0-9]+)$/;
export const isVerb = (lower) => VERBS.has(lower) || VERB_SHAPES.test(lower);

// What the shell makes of a segment's quoting: `$'` opens an ANSI-C string, quotes and backslashes go.
const unquote = (seg) => seg.replace(/\$(?=')/g, "").replace(/["'\\]/g, "");
const lowerAZ = (s) => s.replace(/[A-Z]+/g, (m) => m.toLowerCase());

function foldSegment(seg) {
  if (!/[A-Z]/.test(seg)) return seg;
  const plain = unquote(seg).replace(/^\$/, "");
  // A verb glued to a one-letter option — `env -S'RM -rf src'`, `-cBASH` (D-145 addendum 2): the
  // option letter keeps its case (`-S` is not `-s`); the verb after it is lowered in place.
  const glued = /^-[A-Za-z](.+)$/.exec(plain);
  if (glued && /[A-Z]/.test(glued[1]) && isVerb(glued[1].toLowerCase())) {
    const m = /^(?:\$?["'\\])*-(?:["'\\])*[A-Za-z]/.exec(seg);   // through the option letter, quoting included
    if (!m) return seg;                            // `$-SRM`: `$-` is bash's flags parameter, not an option
    return seg.slice(0, m[0].length) + lowerAZ(seg.slice(m[0].length));
  }
  const base = plain.slice(plain.lastIndexOf("/") + 1);
  if (!/[A-Z]/.test(base) || !isVerb(base.toLowerCase())) return seg;
  const cut = seg.lastIndexOf("/") + 1;           // same `/` in the raw segment: quotes never hold one we skip
  return seg.slice(0, cut) + lowerAZ(seg.slice(cut));
}

/** The command with every gate verb lowered in place; every other byte is unchanged. */
export function foldVerbs(cmd) {
  const s = String(cmd);
  if (!/[A-Z]/.test(s)) return s;
  // After a `:` the expansion operator's sign (`${X:-BASH}`, `:+`, `:?`) is not part of the verb.
  return s.replace(/[^\s;&|()<>`]+/g, (word) => word.replace(/[^{},=:]+/g, (seg, at) =>
    word[at - 1] === ":" && /^[-+?]/.test(seg) ? seg[0] + foldSegment(seg.slice(1)) : foldSegment(seg)));
}
