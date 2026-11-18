// assigned-verbs.mjs — a verb kept in a name is still the verb (E-353, D-112 r3 a).
// `g=git; $g push`, `G=git; ${G} reset --hard` and `alias g=git; g push` ran git for the
// Architect while every sovereignty rule saw `$g`, `${G}` or `g`. expandAssignedVerbs returns the
// command with each USE of such a name replaced by its value, so the caller can run the same
// rules on that text too (the verdict is the union — this only ever adds a block).
//
// What counts: an assignment NAME=VALUE (or an array NAME=(VALUE …)) or `alias NAME=VALUE`
// anywhere on the line whose value's first word — read the way the shell reads it: quotes and
// backslashes removed, $'…' opened (the shared D-112 normaliser), path stripped, case folded —
// is a gate verb (verb-fold.mjs isVerb). `g=gi""t`, `g=\git`, `g=$'git'`, `g=(git)` all hold git
// (security_engineer, A2A ruling 2026-11-18). A use is `$NAME` or `${NAME…}` with any index or
// operator (`${g[0]}`, `${g:-x}`), or an alias name at command position. A value built at run time
// (`g=$(echo git)`, `g=$x`) is not modelled: that is the classifier's residual (D-089).
import { isVerb } from "./verb-fold.mjs";
import { normaliseWord } from "../../shared/shell-word.mjs";

// One shell word (quoted runs, $'…', escapes and plain characters), or an array `( … )`.
const VALUE = String.raw`(\((?:[^)\n])*\)|(?:\$'[^'\n]*'|"[^"\n]*"|'[^'\n]*'|\\.|[^\s;&|()"'\x60\\$])+)`;
const ASSIGN = new RegExp(
  String.raw`(?:^|[\s;&|(])(?:export\s+|local\s+|readonly\s+|typeset\s+(?:-[A-Za-z]+\s+)*|declare\s+(?:-[A-Za-z]+\s+)*)?([A-Za-z_][A-Za-z0-9_]*)\+?=` + VALUE, "g");
const ALIAS = new RegExp(String.raw`(?:^|[\s;&|(])alias\s+([A-Za-z_][A-Za-z0-9_.:+-]*)=` + VALUE, "g");
// Uses, each replaced in ONE pass with a Map lookup (linear in the text, whatever the number of
// names — a per-name replace was quadratic: 158 ms on 1500 aliases).
const VAR_USE = /\$\{([A-Za-z_][A-Za-z0-9_]*)[^}\n]*\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
const CMD_WORD = /(^|[;&|(\n]\s*|\b(?:then|do|else|time)\s+|!\s+)([A-Za-z_][A-Za-z0-9_.:+-]*)(?=\s|$|[;&|)])/g;

function verbValue(raw) {
  const inner = raw.startsWith("(") ? raw.slice(1, -1) : raw;
  const v = normaliseWord(inner).trim();
  const first = v.split(/\s+/)[0] ?? "";
  const b = first.slice(first.lastIndexOf("/") + 1).toLowerCase();
  return b && isVerb(b) ? v : null;
}

/** The command with every use of a verb-holding name replaced by its value (or the input). */
export function expandAssignedVerbs(text) {
  const s = String(text ?? "");
  if (!s.includes("=")) return s;
  const vars = new Map(), aliases = new Map();
  for (const m of s.matchAll(ASSIGN)) { const v = verbValue(m[2]); if (v) vars.set(m[1], v); }
  for (const m of s.matchAll(ALIAS)) { const v = verbValue(m[2]); if (v) aliases.set(m[1], v); }
  let out = s;
  if (vars.size) out = out.replace(VAR_USE, (all, braced, bare) => vars.get(braced ?? bare) ?? all);
  if (aliases.size) out = out.replace(CMD_WORD, (all, pre, name) => (aliases.has(name) ? pre + aliases.get(name) : all));
  return out;
}
