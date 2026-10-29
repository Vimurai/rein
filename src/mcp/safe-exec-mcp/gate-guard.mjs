// gate-guard.mjs — E-291 (D-081 r2, D-083 r5-6; sovereignty-hardening.md §Hook Toolchain
// Pinning Component 6): keep the agent from switching its own gate off.
//
// CEILING, stated once and honestly (D-083 r5): the agent runs as the operator's uid, so
// anything the operator can do the agent can attempt. These rules make self-disabling
// EXPENSIVE and LOUD — tamper-RESISTANT — not impossible: a command string assembled at run
// time (`a=ai; $a gate off`, base64, an interpreter reading an encoded program) is the named
// residual. The independent layer is the classifier's hard_deny rule (E-293), which a project
// cannot reach.
//
//   selfDisableHits(raw) → [{id, message}] for a Bash command (every role):
//     - `ai gate …` at command position (off, on, status — the agent has no business here);
//     - any mention of `gate-override.json` (the override FILE — not the stem, which names
//       the gate-override.py module and is fine to stage, grep or edit);
//     - a write into ~/.rein/ — redirection, a write verb, or an inline interpreter that
//       names the path. Reading ~/.rein (cat, ls, node ~/.rein/shared/x.mjs) stays allowed.
//     The ONLY writers of ~/.rein are the literal allowlist: `bash install-rein.sh`,
//     `ai install`, `ai sync`, `ai doctor` — none of which names the path, so none trips this.
//   isUnderRein(target, home) → true when a Write/Edit target resolves inside ~/.rein/
//     (realpath of the deepest existing ancestor, so a not-yet-created file and a symlink
//     into the mirror are both caught).

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";

// Command position: start, a separator or grouping char, a shell keyword or a prefix that
// runs its argument, `VAR=value` assignments, or the program string of `sh -c` / `bash -c`
// (critic_security P1-2: `X=1 ai gate`, `{ ai gate;}`, `if/eval/timeout/! ai gate`,
// `bash -c 'ai gate'` all slipped the narrower head).
const CMD_HEAD =
  "(?:^|[;&|\\n`({!]|\\b(?:sudo|env|nohup|time|command|exec|xargs|then|do|else|if|while|until|eval|nice)\\s+" +
  "|\\btimeout\\s+\\S+\\s+|\\b(?:ba|z|da|k)?sh\\s+-c\\s+['\"]?)" +
  "\\s*(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*";
// The `ai` token, allowing the quoting and escaping a shell removes ("ai", 'a'i, a\i).
const AI_TOKEN = "(?:\\S*/)?[\"']?a[\"'\\\\]?i[\"']?";
const AI_GATE = new RegExp(CMD_HEAD + AI_TOKEN + "\\s+[\"']?gate\\b", "i");
// The mirror's directory name. E-383 (D-132 r3): until 0.5 the installer leaves the
// pre-rename name as a symlink to ~/.rein, so a write through it reaches the same hooks —
// both names are the mirror. A machine that has not run the new installer yet still has
// the old name as a real directory, which is the install the gate is protecting.
const MIRROR = String.raw`\.(?:rein|ai-os)`; // rename:legacy-fallback
// The mirror, spelled the ways a shell command spells it.
// A quoted home (`"$HOME"/.rein`, critic_security P2) is the same path.
const REIN_PATH = String.raw`["']?(?:~|\$HOME|\$\{HOME\}|${escapeRe(homedir())})["']?/` + MIRROR + String.raw`(?:/|\b)`;
const REDIRECT_INTO = new RegExp(String.raw`(?:^|[^<])>{1,2}\|?\s*["']?` + REIN_PATH);
const WRITE_VERB = new RegExp(
  CMD_HEAD +
    String.raw`(?:rm|mv|cp|ln|tee|touch|mkdir|rmdir|chmod|chown|truncate|install|rsync|dd|unlink|patch|sed\s+-i|perl\s+-i|perl\s+-pi)\b[^;&|\n]*?` +
    REIN_PATH,
  "i"
);
// Entering the mirror and writing there without naming the path twice (critic_security
// P1-2): `cd ~/.rein && …>…` / write verb, and `-C ~/.rein` (tar -x, git checkout, make).
const CD_INTO = new RegExp(String.raw`\b(?:cd|pushd)\s+` + REIN_PATH);
const ANY_WRITE = new RegExp(String.raw`>|` + CMD_HEAD +
  String.raw`(?:rm|mv|cp|ln|tee|touch|mkdir|rmdir|chmod|chown|truncate|install|rsync|dd|unlink|patch|tar|git|sed\s+-i|perl\s+-p?i)\b`, "i");
const DASH_C_INTO = new RegExp(String.raw`(?:^|\s)-C\s*["']?` + REIN_PATH);
// Entering HOME and naming the mirror RELATIVELY (critic_security P1-2, E-294 review, two
// passes): `cd ~ && rm .rein/run/launch/N.json` and `cd $HOME && cat > .rein/…` passed every
// pattern above, which all need the mirror spelled from HOME. A launch record and a role token
// live there now (T-ROLE-001), so entering HOME and then writing a relative `.rein` path is
// the same write. HOME is entered by `cd`/`pushd` in COMMAND position (so `fix-cd` is not a cd),
// with optional `--`/`-P`/`-L`/`-e`/`-@`, as a bare `cd` or any spelling of HOME, including a
// trailing `/`, `/.`, `//` inside or outside the quotes; the argument ends at a separator, a
// redirection, a comment or the end of the command.
const HOME_SPELLED = String.raw`["']?(?:~|\$HOME|\$\{HOME\}|${escapeRe(homedir())})(?:/+\.?)*["']?(?:/+\.?)*`;
const CD_HOME = new RegExp(
  CMD_HEAD + String.raw`(?:builtin\s+)?(?:cd|pushd)(?:\s+-[-PLe@]*)*(?:\s+` + HOME_SPELLED +
    String.raw`)?\s*(?:$|[;&|\n)<>#]|\d[<>])`
);
// The mirror named relative to HOME: `.rein` after whitespace, a quote, `=`, a redirection, a
// paren or a `/` (so `././.rein`, `x/../.rein`), as a whole name — `.rein-cache` and
// `.rein.txt` are other files.
const REL_REIN = new RegExp(String.raw`(?:^|[\s"'=<>(/])` + MIRROR + String.raw`(?:\/|["'\s]|$)`);
// Named from ABOVE home without entering it: `../../.rein` from anywhere under HOME, or
// `<home's basename>/.rein` (`cd /Users && rm <you>/.rein/…`).
const PARENT_REIN = new RegExp(
  String.raw`(?:^|[\s"'=<>(])(?:\.\.\/)+` + MIRROR + String.raw`(?:\/|["'\s]|$)|(?:^|[\s"'=<>(/])` +
    escapeRe(basename(homedir())) + String.raw`\/` + MIRROR + String.raw`(?:\/|["'\s]|$)`
);
// `find … -delete` / `-exec` is a write; an inline interpreter after entering HOME is a write
// (os.remove / fs.rmSync never spell the mirror from HOME).
const FIND_WRITE = String.raw`|` + CMD_HEAD + String.raw`find\b[^;&|\n]*\s-(?:delete|exec|execdir|ok|okdir)\b`;
const INTERP_WRITE = String.raw`|` + CMD_HEAD + String.raw`(?:python3?|node|perl|ruby)\s+-[ce]\b`;
const FIND_INTO = new RegExp(CMD_HEAD + String.raw`find\b[^;&|\n]*?` + REIN_PATH + String.raw`[^;&|\n]*\s-(?:delete|exec|execdir|ok|okdir)\b`, "i");
// A literal `cd` target that RESOLVES to HOME from the gate's cwd (`cd ../../..` from a project,
// `cd /Users/<you>`): the spellings above cannot know where `..` lands; the gate can.
const CD_ARG = new RegExp(
  CMD_HEAD + String.raw`(?:builtin\s+)?(?:cd|pushd)(?:\s+-[-PLe@]*)*\s+(["']?)([^\s;&|<>#()"'$~\`]+)\1(?=\s|$|[;&|<>#)])`,
  "g"
);
function cdTargetsHome(s, cwd = process.cwd()) {
  let home;
  try { home = realpathSync(homedir()); } catch { home = resolve(homedir()); }
  for (const m of s.matchAll(CD_ARG)) {
    let t = resolve(cwd, m[2]);
    try { t = realpathSync(t); } catch { /* compare lexically */ }
    if (t === home) return true;
  }
  return false;
}
const WRITE_AFTER_ENTER = new RegExp(ANY_WRITE.source + FIND_WRITE + INTERP_WRITE, "i");
const INTERPRETER_NAMING = new RegExp(
  CMD_HEAD + String.raw`(?:python3?|node|perl|ruby|bash|sh|zsh)\s+-[ce]\b[^\n]*?` + REIN_PATH,
  "i"
);

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const MSG_ESCAPE = "Operator escape — in YOUR terminal, not through the agent: ai gate off";

export function selfDisableHits(raw) {
  const s = String(raw ?? "");
  const hits = [];
  if (AI_GATE.test(s)) {
    hits.push({ id: "GATE_SELF_DISABLE", message: `\`ai gate\` is operator-only — BLOCKED for every role. ${MSG_ESCAPE}` });
  } else if (/gate-override\.json/i.test(s)) {
    // The FILE name only. The bare stem over-blocked ordinary work — a branch named
    // engineer/e291-gate-override and `git add src/shared/gate-override.py` (recorded in
    // gate_override_test E-291.05g). Writes anywhere under ~/.rein are caught below anyway.
    hits.push({ id: "GATE_SELF_DISABLE", message: `the gate override file is operator-only — BLOCKED for every role. ${MSG_ESCAPE}` });
  } else if (REDIRECT_INTO.test(s) || WRITE_VERB.test(s) || INTERPRETER_NAMING.test(s) || FIND_INTO.test(s) ||
             DASH_C_INTO.test(s) || (CD_INTO.test(s) && WRITE_AFTER_ENTER.test(s)) ||
             ((CD_HOME.test(s) || cdTargetsHome(s)) && REL_REIN.test(s) && WRITE_AFTER_ENTER.test(s)) ||
             (PARENT_REIN.test(s) && WRITE_AFTER_ENTER.test(s))) {
    hits.push({
      id: "GATE_SELF_DISABLE",
      message: "writes under ~/.rein/ (the Rein install: hooks, gate, secrets) are BLOCKED for every role — " +
        "only `bash install-rein.sh`, `ai install`, `ai sync` and `ai doctor` write there",
    });
  }
  return hits;
}

// Realpath of the deepest existing ancestor, re-joined with the not-yet-existing tail.
function resolveDeep(p) {
  let cur = resolve(p);
  const tail = [];
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cur = parent;
  }
  let real = cur;
  try { real = realpathSync(cur); } catch { /* keep the lexical path */ }
  return tail.length ? join(real, ...tail) : real;
}

export function isUnderRein(target, home = homedir()) {
  if (!target) return false;
  const t = isAbsolute(target) ? target : resolve(process.cwd(), target);
  const r = resolveDeep(t);
  // E-383: the pre-rename name too — a real directory on a machine not yet migrated, a
  // symlink (which realpath folds into ~/.rein) after.
  return [".rein", ".ai-os"].some((name) => { // rename:legacy-fallback
    let root = join(home, name);
    try { root = realpathSync(root); } catch { /* not installed: compare lexically */ }
    return r === root || r.startsWith(root + sep);
  });
}
