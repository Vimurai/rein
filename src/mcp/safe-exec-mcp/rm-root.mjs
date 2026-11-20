// rm-root.mjs — the RM_RF_ROOT root and cwd forms and the RM_RF recursive-force test.
// Moved out of index.js by E-442 (D-164 r8): a pure move, no rule, message or verdict changed.

import { normaliseWord } from "../../shared/shell-word.mjs";
import { expandAssignedVerbs } from "./assigned-verbs.mjs";
import { shellTokens as _tokens } from "./tokens.mjs";

// E-125: rm invoked with BOTH recursive and force — combined (-rf/-fr/-Rfv…) OR
// SPLIT (`rm -r -f`), OR --no-preserve-root. Split flags are equivalent to -rf, so
// a fail-closed gate must treat them identically (plain hasSequence missed them).
function _shortFlagHas(strTokens, ch) {
  return strTokens.some((t) => /^-[A-Za-z]+$/.test(t) && t.slice(1).includes(ch));
}
export function rmRecursiveForce(tokens) {
  const t = tokens.filter((x) => typeof x === "string").map((x) => String(x));
  if (!t.some((x) => x.split("/").pop() === "rm")) return false;   // E-340: /bin/rm is rm
  if (t.includes("--no-preserve-root")) return true;
  // E-340 review: an UPPERCASE R in a bundle (`-Rf`, `-fR`) is recursive too — the lowercase-only
  // test let `rm -Rf /` through with no warning at all.
  const recursive = t.includes("--recursive") || _shortFlagHas(t, "r") || _shortFlagHas(t, "R");
  const force = t.includes("--force") || _shortFlagHas(t, "f");
  return recursive && force;
}

// E-125: catastrophic rm targets (root/home). Tokenizers EXPAND $HOME→"" and turn
// `/*` into a glob object (both dropped from string tokens), and bare ~ slips the
// old token-only check — so also scan the raw string. Only consulted inside the
// rm-recursive-force rule, where any root/home target is irreversible.
// E-353 (D-112 r3 d): /bin and /opt join the system roots.
const ROOT_TOKEN = /^(\/$|\/root|\/home|\/etc|\/usr|\/var|\/boot|\/bin|\/opt|~$|~\/|\$HOME(\/|$)|\$\{HOME\}(\/|$))/;
function hasRootPaths(tokens, raw) {
  const strTokens = tokens.filter((t) => typeof t === "string").map((t) => String(t));
  if (strTokens.some((t) => ROOT_TOKEN.test(t))) return true;
  if (raw == null) return false;
  const r = String(raw);
  // E-353 (A2A ruling 2026-11-18): each word again as the shell reads it — quotes and backslashes
  // removed, `//` and `/./` collapsed (the shared D-112 normaliser): `//opt`, `/./bin`, `/"usr"`.
  if (r.split(/[\s;&|<>()]+/).some((w) => /[/"'\\]/.test(w) && ROOT_TOKEN.test(normaliseWord(w)))) return true;
  if (/(^|[\s=])(\$HOME|\$\{HOME\})(\/|\s|$)/.test(r)) return true;  // $HOME / ${HOME} (tokenizer expands to "")
  if (/(^|\s)~(\/|\s|$)/.test(r)) return true;                      // ~ or ~/
  // E-353 (d): ~+ ($PWD), ~- ($OLDPWD) and the directory-stack forms ~N, ~+N, ~-N.
  if (/(^|\s)["']?~(?:[+-][0-9]*|[0-9]+)(["'\/\s]|$)/.test(r)) return true;
  // A2A ruling 2026-11-18: $PWD / $OLDPWD are ~+ / ~- by value — bare, braced, quoted, and with
  // :? (always set, so it never fails closed), alone or with / or /*. "${X:?}"/* stays the escape.
  if (/(^|\s)"?\$(?:\{(?:PWD|OLDPWD)(?::\?[^}]*)?\}|(?:PWD|OLDPWD)(?![A-Za-z0-9_]))"?(?:\/\*?)?"?(\s|;|&|\||$)/.test(r)) return true;
  if (/(^|\s)\/\*(\s|$)/.test(r)) return true;                      // /* glob (dropped from tokens)
  // E-350 (D-111 r6 ii): ~user is that user's home.
  if (/(^|\s)["']?~[A-Za-z_][A-Za-z0-9_.-]*["']?(\/|\s|$)/.test(r)) return true;
  return _emptyExpansionRoot(r);
}

// E-350 (D-111 r6 ii, security_engineer P0-1): each word is normalised the way it can expand at
// its most dangerous — every expansion ($X ${X} ${X:-} $1 $@ $( ) `…`) empty, quotes and
// backslashes removed ($'/' is /), // and /./ collapsed. A word that then starts with `/` and
// whose first component is nothing, a glob, a brace list, `.` or `..` is `/`, `/*` or a set of
// top-level directories: `$A/$B/*`, `"/"*`, `\/*`, `//*`, `/{bin,usr}`. A word that BEGINS with
// ${X:?…} fails closed when X is unset (not root-form) — one nested inside $( ) or another ${ }
// exempts nothing. "$X"/dist names one subdirectory, and so does a glob with a literal part
// ("$TMPDIR"/rein-*, "$OUT"/*.log): only a bare glob, class or brace list is the whole root.
// The word normaliser itself is shared with GATE_SELF_DISABLE (E-393): src/shared/shell-word.mjs.
const BARE_GLOB = /^(\.?(\*|\?|\[[^\]]*\])+|\{[^}]*\})$/;
function _emptyExpansionRoot(r) {
  // $( ) and `…` may hold spaces, so they are emptied before the line is cut into words — on
  // whitespace AND on shell separators: `$X/*; echo` ends the operand at the `;`.
  for (const word of String(r).replace(/\$\([^()]*\)|`[^`]*`/g, "").split(/[\s;&|<>()]+/)) {
    if (!/[/$`"'\\]/.test(word) || /^["']?\$\{[A-Za-z_][A-Za-z0-9_]*:?\?/.test(word)) continue;
    const w = normaliseWord(word);
    if (!w.startsWith("/")) continue;
    const first = w.slice(1).split("/")[0];
    if (first === "" || first === "." || first === ".." || BARE_GLOB.test(first)) return true;
  }
  return false;
}

// E-340 (finding 6, 2026-10-23): `cd /home/dev/Dev/rein; …; rm -rf .ai/stale-…` was blocked
// because hasRootPaths matched the cd's /home path, not an rm operand. The rule now ignores ONE
// leading `cd <plain absolute dir> ;|&&` when that directory is not one an rm below it could
// wipe (root, a system tree at any depth, a home tree within two levels of /home): every rm
// after it then works below a project-like directory, and the rest of the line is judged
// exactly as before. Nothing else is narrowed: two cuts that split the line into simple
// commands and read each rm's own operands failed critic_security (every parser gap hid an rm),
// so the whole-line match stays the model. Also new: an rm -rf with a `..` component anywhere on
// the line blocks (`rm -rf ../../..` matched no root path).
const SAFE_CD_PREFIX = /^\s*cd\s+(\/[A-Za-z0-9_.@%+,=:\/-]*)\s*(?:;|&&)/;
const CD_DANGER =
  /^\/(etc|usr|var|boot|root|bin|sbin|lib[0-9a-z_]*|opt|srv|proc|sys|dev|snap|nix|run|private|System|Library|Applications|Volumes)(\/|$)|^\/(home|Users|mnt|media)(\/[^/]+){0,2}$/;
const KEEP_CD_PREFIX =
  /\b(cd|pushd|popd|CDPATH|chdir|eval|exec|source|alias|function|bash|sh|zsh|dash|ash|ksh|mksh|tcsh|csh|fish|busybox)\b|\n|[`$({]|=\s*[\/~]|\s-[A-Za-z]*[CD]\s*[\/~.]|~[A-Za-z_]|(^|[;&|])\s*\.\s/;
function withoutSafeCdPrefix(raw) {
  const r = String(raw ?? "");
  const m = SAFE_CD_PREFIX.exec(r);
  if (!m) return r;
  const dir = m[1].replace(/\/{2,}/g, "/").replace(/(.)\/+$/, "$1");
  if (dir === "/" || /(^|\/)\.\.?(\/|$)/.test(dir) || CD_DANGER.test(dir)) return r;
  const rest = r.slice(m[0].length);
  // Only while nothing after the prefix can change directory again or run text this match does
  // not see (critic_security / security_engineer, E-340 third review): cd/pushd/popd/CDPATH, a
  // second line, eval/exec/source/alias/function, a shell, $ or a backtick, ( or {, a directory
  // option with its path attached (`--chdir=/etc`, `-C/etc`, `-D~`), or ~user. Stripping the
  // prefix can only ever yield HEAD's verdict on the rest of the line.
  if (KEEP_CD_PREFIX.test(rest)) return r;
  return rest;
}
const DOTDOT = /(^|\/)\.\.(\/|$)/;
export function rmRootHit(tokens, raw) {
  // E-353 (A2A ruling 2026-11-18, folded in): `r=rm; $r -rf /` is rm — the assigned-verb expansion
  // applies to RM_RF_ROOT too, for every role (union: it only adds a block).
  if (rmRootHitOn(tokens, raw)) return true;
  const exp = expandAssignedVerbs(raw);
  return exp !== String(raw ?? "") && rmRootHitOn(_tokens(exp), exp);
}
function rmRootHitOn(tokens, raw) {
  const rest = withoutSafeCdPrefix(raw);
  const t = rest === String(raw ?? "") ? tokens : _tokens(rest);
  // E-353 (D-112 r3 d): a glob word (`a/../../*`, `/tmp/../*`) is not a string token, so the `..`
  // component is also looked for in the text itself.
  // A2A ruling 2026-11-18: and in each word as the shell reads it (`/tmp/.\./*`, `/tmp/.''./*`).
  return rmRecursiveForce(t) && (hasRootPaths(t, rest) || t.some((x) => DOTDOT.test(x)) ||
    /(^|[\s"'=\/])\.\.(\/|[\s"']|$)/.test(rest) ||
    rest.split(/[\s;&|<>()]+/).some((w) => /["'\\]/.test(w) && DOTDOT.test(normaliseWord(w))));
}
