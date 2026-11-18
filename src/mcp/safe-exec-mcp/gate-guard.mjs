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
//     - `rein gate …` at command position (off, on, status — the agent has no business here);
//     - any mention of `gate-override.json` (the override FILE — not the stem, which names
//       the gate-override.py module and is fine to stage, grep or edit);
//     - a write into ~/.rein/ — redirection, a write verb, or an inline interpreter that
//       names the path. Reading ~/.rein (cat, ls, node ~/.rein/shared/x.mjs) stays allowed.
//     The ONLY writers of ~/.rein are the literal allowlist: `bash install-rein.sh`,
//     `rein install`, `rein sync`, `rein doctor` — none of which names the path, so none trips this.
//   isUnderRein(target, home) → true when a Write/Edit target resolves inside ~/.rein/
//     (realpath of the deepest existing ancestor, so a not-yet-created file and a symlink
//     into the mirror are both caught).

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { gateViews, namesGateOff, normaliseWord, shellCommands, unquoteWord } from "../../shared/shell-word.mjs";

// Command position: start, a separator or grouping char, a shell keyword or a prefix that
// runs its argument, `VAR=value` assignments, or the program string of `sh -c` / `bash -c`
// (critic_security P1-2: `X=1 rein gate`, `{ rein gate;}`, `if/eval/timeout/! rein gate`,
// `bash -c 'rein gate'` all slipped the narrower head).
// E-393 (D-132 addendum 4 r7): `)` (a case arm) and stdbuf/setsid/flock/builtin join the head.
// A prefix with flags or arguments (`env -i`, `nice -n 5`, `flock f`) is beyond a regex head;
// gateCommandHit below reads those word by word.
const CMD_HEAD =
  "(?:^|[;&|\\n`(){!]|\\b(?:sudo|env|nohup|time|command|exec|xargs|then|do|else|if|while|until|eval|nice|stdbuf|setsid|flock|builtin)\\s+" +
  "|\\btimeout\\s+\\S+\\s+|\\b(?:ba|z|da|k)?sh\\s+-c\\s+['\"]?)" +
  "\\s*(?:[A-Za-z_][A-Za-z0-9_]*=\\S*\\s+)*";
// The `rein` token, allowing the quoting and escaping a shell removes ("rein", 're'in, r\ein):
// an optional quote or backslash may sit between any two of its letters.
const CLI_WORD = "(?:\\S*/)?[\"']?" + "rein".split("").join("[\"'\\\\]?") + "[\"']?";
const CLI_GATE = new RegExp(CMD_HEAD + CLI_WORD + "\\s+[\"']?gate\\b", "i");
// The mirror, spelled the ways a shell command spells it.
// A quoted home (`"$HOME"/.rein`, critic_security P2) is the same path.
const REIN_PATH = String.raw`["']?(?:~|\$HOME|\$\{HOME\}|${escapeRe(homedir())})["']?/\.rein(?:/|\b)`;
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
const REL_REIN = /(?:^|[\s"'=<>(/])\.rein(?:\/|["'\s]|$)/;
// Named from ABOVE home without entering it: `../../.rein` from anywhere under HOME, or
// `<home's basename>/.rein` (`cd /Users && rm <you>/.rein/…`).
const PARENT_REIN = new RegExp(
  String.raw`(?:^|[\s"'=<>(])(?:\.\.\/)+\.rein(?:\/|["'\s]|$)|(?:^|[\s"'=<>(/])` +
    escapeRe(basename(homedir())) + String.raw`\/\.rein(?:\/|["'\s]|$)`
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

// ── E-393 (D-132 addendum 4 r7): `rein gate` assembled from quotes, escapes and wrappers ──────
// The regex above sees `rein` only right after a head; the shell also runs it after `env -i`,
// `nice -n 5`, `sudo -u x`, `timeout -s KILL 5`, `flock f`, `exec -a x`, `time -p`, as `re""in`,
// `\rein`, `$'rein'`, and with `g'a'te` or `--` before the subcommand. Each command is read word by
// word (quote-aware, src/shared/shell-word.mjs — the D-112 normaliser, not a second one): keywords,
// assignments and wrappers with their flags and positional arguments are skipped; the first word
// left is the program. A quoted string at command position (`bash -c '…'`, `flock f -c '…'`,
// `env -S '…'`, `eval '…'`) is a program too and is read again, to depth 3. Runtime assembly
// (`x=rein; $x gate off`, `$'\x72ein'`) stays the classifier's residual, as named since D-089.
// arg: flags that consume the next word; pos: positional words before the program; shell: takes its
// program from stdin when given none (`bash`, `bash -s`, `at now`) — a here-string or a pipe into it
// is read again (security_engineer F6; `echo '…' | bash`); rest: every word is an operand (`at`);
// split: `-S…` / `--split-string=…` carries the program (F5).
const SHELL = { arg: ["-o", "-O", "+o", "+O"], shell: true };
const WRAPPERS = new Map([
  ["env", { arg: ["-u", "--unset", "-C", "--chdir", "-a", "--argv0"], split: true }],
  ["nice", { arg: ["-n", "--adjustment"] }],
  ["sudo", { arg: ["-u", "--user", "-g", "--group", "-C", "--close-from", "-D", "--chdir", "-h", "--host",
                   "-p", "--prompt", "-r", "--role", "-t", "--type", "-U", "--other-user", "-T", "--command-timeout",
                   "-R", "--chroot"] }],
  ["stdbuf", { arg: ["-i", "-o", "-e", "--input", "--output", "--error"] }],
  ["setsid", {}],
  ["flock", { arg: ["-w", "--wait", "--timeout", "-E", "--conflict-exit-code"], pos: 1 }],
  ["exec", { arg: ["-a"] }],
  ["command", {}], ["builtin", {}], ["nohup", {}], ["eval", {}],
  ["time", { arg: ["-f", "--format", "-o", "--output"] }],
  ["timeout", { arg: ["-s", "--signal", "-k", "--kill-after"], pos: 1 }],
  ["xargs", { arg: ["-I", "-L", "-n", "--max-args", "-P", "--max-procs", "-s", "--max-chars", "-d",
                    "--delimiter", "-E", "-a", "--arg-file"] }],
  ...["sh", "bash", "zsh", "dash", "ash", "ksh", "mksh", "yash", "posh"].map((n) => [n, SHELL]),
  // critic_security P1-1 (E-393): further commands that run their arguments.
  ["ionice", { arg: ["-c", "--class", "-n", "--classdata", "-p", "--pid", "-P", "--pgid", "-u", "--uid"] }],
  ["taskset", { arg: [], pos: 1 }],                                   // taskset [-c] MASK cmd
  ["chrt", { arg: ["-T", "-P", "-D"], pos: 1 }],                      // chrt [-f] PRIO cmd
  ["script", { arg: ["-E", "--echo", "-I", "--log-in", "-O", "--log-out", "-B", "--log-io", "-T",
                     "--log-timing", "-m", "--logging-format", "-t"], pos: 1 }],  // -c's string is re-read
  ["su", { arg: ["-s", "--shell", "-g", "--group", "-G", "--supp-group", "-w", "--whitelist-environment"], pos: 1 }],
  ["runuser", { arg: ["-u", "--user", "-s", "--shell", "-g", "--group", "-G", "--supp-group"], pos: 1, noPosWith: ["-u", "--user"] }],
  ["sg", { arg: [], pos: 1 }],
  ["doas", { arg: ["-u", "-C"] }],
  ["watch", { arg: ["-n", "--interval", "-q", "--equexit"] }],
  ["strace", { arg: ["-e", "-o", "-p", "-s", "-u", "-E", "-a", "-b", "-I", "-O", "-P", "-S", "-X"] }],
  ["ltrace", { arg: ["-e", "-o", "-p", "-s", "-u", "-a", "-n", "-l", "-x", "-F"] }],
  ["unshare", { arg: ["-S", "--setuid", "-G", "--setgid", "-R", "--root", "-w", "--wd", "--propagation"] }],
  ["nsenter", { arg: ["-t", "--target", "-S", "--setuid", "-G", "--setgid", "-r", "--root", "-w", "--wd"] }],
  ["chronic", {}], ["unbuffer", {}], ["caffeinate", { arg: ["-t", "-w"] }], ["busybox", {}],
  ["prlimit", { arg: ["-p", "--pid"] }], ["faketime", { arg: [], pos: 1 }],
  ["firejail", {}], ["torsocks", { arg: ["-u", "-p", "-a", "-P"] }], ["proxychains", { arg: ["-f"] }],
  ["proxychains4", { arg: ["-f"] }], ["catchsegv", {}], ["valgrind", {}], ["rlwrap", {}],
  // security_engineer F8 (E-393), the ones with a plain argument grammar.
  ["eatmydata", {}], ["setpriv", { arg: ["--reuid", "--regid", "--groups", "--inh-caps", "--ambient-caps", "--bounding-set",
                                         "--securebits", "--pdeathsig", "--selinux-label", "--apparmor-profile"] }],
  ["ssh", { arg: ["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q",
                  "-R", "-S", "-W", "-w", "-B"], pos: 1 }],        // ssh HOST cmd… (localhost is this machine)
  ["systemd-run", { arg: ["-p", "--property", "-u", "--unit", "-E", "--setenv", "-M", "--machine", "-H", "--host",
                          "--uid", "--gid", "--nice", "--description", "--slice", "--working-directory",
                          "--on-active", "--on-calendar", "--timer-property"] }],
  ["at", { arg: ["-q", "-f", "-t"], shell: true, rest: true }],
  ["batch", { arg: ["-q", "-f"], shell: true, rest: true }],
]);
const KEYWORDS = new Set(["!", "{", "}", "if", "then", "do", "else", "elif", "while", "until", "coproc"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

// F4: a word may be a brace list or a glob that the shell turns into `rein` or `gate`.
// Bounded: at most 64 words out, whatever the nesting (a brace bomb cannot blow up the gate).
function expandBraces(w) {
  let out = [w];
  for (let n = 0; n < 5; n++) {
    const next = [];
    let grew = false;
    for (const x of out) {
      const m = /\{([^{}]*,[^{}]*)\}/.exec(x);
      if (!m) { next.push(x); continue; }
      grew = true;
      for (const alt of m[1].split(",")) {
        if (next.length >= 64) break;
        next.push(x.slice(0, m.index) + alt + x.slice(m.index + m[0].length));
      }
    }
    out = next.slice(0, 64);
    if (!grew) break;
  }
  return out;
}
function named(w, name) {
  const b = w.toLowerCase();
  if (b === name) return true;
  if (!/[*?[]/.test(b)) return false;
  try {
    return new RegExp("^" + b.replace(/[.+^$(){}|\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]") + "$").test(name);
  } catch { return false; }
}
// F-residual, cheap half: `${X:-rein}` is read as its default and `$IFS` as a space.
const gateText = (s) => s.replace(/\$\{IFS\}|\$IFS(?![A-Za-z0-9_])/g, " ")
  .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=]([^{}$]*)\}/g, "$1");
const normWords = (raw) => raw.flatMap((w) => { const n = normaliseWord(w); return /\s/.test(n) ? [n] : expandBraces(n); });

function skipWrapperArgs(words, i, wr) {
  let pos = wr.pos || 0;
  while (i < words.length) {
    const w = words[i];
    if (wr.split) { const m = /^(?:-S|--split-string=)(.+)$/s.exec(w); if (m) { words[i] = m[1]; break; } }
    if (/\s/.test(w)) break;                            // a program string (`script -qc '…' f`, `su -c '…'`): re-read
    if (wr.noPosWith?.includes(w)) pos = 0;            // `runuser -u USER cmd` has no positional user
    // `-` alone counts (`su - root`); a shell's `+x` / `+O opt` too.
    if (w.startsWith("-") || (wr.shell && w.startsWith("+"))) { i += wr.arg?.includes(w) ? 2 : 1; continue; }
    if (ASSIGNMENT.test(w)) { i++; continue; }          // env NAME=val …
    if (wr.rest || pos > 0) { pos--; i++; continue; }
    break;
  }
  return i;
}

// → true (the command runs `rein gate`), "stdin" (its program comes from stdin) or false.
function wordsHitGate(words, depth) {
  let i = 0, viaXargs = false;
  while (i < words.length) {
    const w = words[i];
    // An empty word (`$UNSET`, `""`) is read at its most dangerous: it vanishes, as it may in the shell.
    if (w === "" || KEYWORDS.has(w) || ASSIGNMENT.test(w)) { i++; continue; }
    if (/\s/.test(w)) return depth < 3 && gateCommandHit(w, depth + 1);
    const base = w.slice(w.lastIndexOf("/") + 1).toLowerCase();
    const wr = WRAPPERS.get(base);
    if (wr) {
      if (base === "xargs") viaXargs = true;
      i = skipWrapperArgs(words, i + 1, wr);
      if (wr.shell && i >= words.length) return "stdin";
      continue;
    }
    if (base === "find") {                               // find … -exec/-execdir/-ok/-okdir CMD ; | +
      for (let k = i + 1; k < words.length; k++) {
        if (!/^-(?:exec|execdir|ok|okdir)$/.test(words[k])) continue;
        let e = k + 1;
        while (e < words.length && words[e] !== ";" && words[e] !== "+") e++;
        if (wordsHitGate(words.slice(k + 1, e), depth) === true) return true;
      }
      return false;
    }
    if (!named(base, "rein")) return false;
    let j = i + 1;                                       // `rein -- gate`, `rein --x gate`
    while (j < words.length && words[j].startsWith("-")) j++;
    if (j >= words.length) return viaXargs;              // F7: `… | xargs rein` takes `gate` from stdin
    return named(words[j], "gate");
  }
  return false;
}

// What a command writes to a pipe, when that is plain text: echo / printf arguments, cat's here-string.
function piped(raw, norm) {
  const base = (norm[0] ?? "").slice(norm[0].lastIndexOf("/") + 1);
  if (base === "echo" || base === "printf") {
    return raw.slice(1).map((w) => w.replace(/\$'/g, "'").replace(/["']/g, "").replace(/\\n/g, "\n"))
      .filter((w) => !/^-[neE]+$/.test(w)).join(" ");
  }
  return base === "cat" && raw.here ? raw.here.map(normaliseWord).join("\n") : null;
}

/** True when some command on the line runs `rein gate`, however its words are spelled. */
export function gateCommandHit(raw, depth = 0) {
  let prev = null;
  for (const cmd of shellCommands(gateText(String(raw)))) {
    const norm = normWords(cmd);
    const r = wordsHitGate(norm, depth);
    if (r === true) return true;
    if (r === "stdin" && depth < 3) {
      for (const h of cmd.here ?? []) if (gateCommandHit(normaliseWord(h), depth + 1)) return true;
      if (cmd.sep === "|" && prev !== null && gateCommandHit(prev, depth + 1)) return true;
    }
    prev = piped(cmd, norm);
  }
  return false;
}

const MSG_ESCAPE = "Operator escape — in YOUR terminal, not through the agent: rein gate off";

// D-163: the lock is r1's three-word predicate (namesGateOff). The name rules below — the CLI
// form (regex and the frozen word reader, r5), the override file, a write under ~/.rein/ — read
// the raw text AND view V1 (r6), so static quoting (`~/.re''in/gate-overr""ide.json`) is no
// longer a way around them; assembly from variables is still the classifier's (r3).
export function selfDisableHits(raw) {
  const s = String(raw ?? "");
  if (namesGateOff(s) || envSplitNamesGateOff(s)) {
    return [{ id: "GATE_SELF_DISABLE", message: `the command names \`rein\`, \`gate\` and \`off\` (D-163) — ` +
      `BLOCKED for every role; put such text in a file (Write tool, \`git commit -F <file>\`). ${MSG_ESCAPE}` }];
  }
  const hits = nameRuleHits(s);
  return hits.length ? hits : nameRuleHits(gateViews(s)[0]);
}

// E-439 (security_engineer finding (e), A2A 2026-11-18 13:17, to be D-163 addendum 2 r13): `env -S`
// has an escape layer of its own under the shell's — `\_` is a space there — so the three words can
// be literal to env and to no view (`env -S'r''ein\_gate\_off'`, `env -Srein\\_gate\\_off`). A
// decoder for that one carrier: each word of a command is unquoted exactly (unquoteWord), the
// argument of an `env` word's -S / -<cluster>S / --split-string[=] is decoded as env does (\_ \t \n
// \v \f \r a space, \c ends it, \X is X) and the lock's predicate reads it, again to depth 3 (a
// program string, or an env -S inside one). Adds no grammar to the frozen reader (D-163 r5):
// shellCommands and gateCommandHit are unchanged. `${VAR}` inside the string is expanded by env at
// run time and stays the r3 residual; the hook's fallback does not decode env -S (named residual).
function envDecode(arg) {
  let out = "";
  for (let i = 0; i < arg.length; i++) {
    if (arg[i] !== "\\" || i + 1 >= arg.length) { out += arg[i]; continue; }
    const n = arg[++i];
    if (n === "c") break;
    out += "_tnvfr".includes(n) ? " " : n;
  }
  return out;
}
// Third pass (f1-f4): env's options are not parsed — a value-taking letter in a cluster (`-vu X`)
// or an abbreviated long option (`--unse X`, `--spl`) made a getopt model miss the -S — so EVERY
// word after an `env` word is read as a possible -S (an over-block needs the three words in the
// decoded text); here-string words are read too (`bash <<< "env -S…"`); the name is matched as a
// glob, and Debian/Ubuntu's `gnuenv` counts (`/usr/bin/en? -S…`).
const SPLIT_LONG = /^--s(?:p(?:l(?:i(?:t(?:-(?:s(?:t(?:r(?:i(?:n(?:g)?)?)?)?)?)?)?)?)?)?)?(?:=|$)/;
function envSplitNamesGateOff(raw, depth = 0) {
  for (const cmd of shellCommands(gateText(String(raw)))) {   // `${E:-env}` read as its default, as for rein
    const words = cmd.map(unquoteWord);
    for (const h of cmd.here ?? []) if (depth < 3 && envSplitNamesGateOff(unquoteWord(h), depth + 1)) return true;
    // Every word after the FIRST env word is read once (a later env word adds nothing): linear,
    // not quadratic in the env words (fourth pass P3: 4 000 × `env -Sa` took 8 s).
    let first = -1;
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      if (/\s/.test(w) && depth < 3 && envSplitNamesGateOff(w, depth + 1)) return true;
      const b = w.slice(w.lastIndexOf("/") + 1).toLowerCase();
      if (first === -1 && (named(b, "env") || named(b, "gnuenv"))) first = i;
    }
    if (first !== -1) {
      for (let k = first + 1; k < words.length; k++) {
        const t = words[k];
        let arg = null;
        if (SPLIT_LONG.test(t)) arg = t.includes("=") ? t.slice(t.indexOf("=") + 1) : words[k + 1] ?? null;
        else if (/^-[A-Za-z0-9]*S/.test(t)) { const at = t.indexOf("S"); arg = t.length > at + 1 ? t.slice(at + 1) : words[k + 1] ?? null; }
        if (arg === null) continue;
        const prog = envDecode(arg);
        if (namesGateOff(prog) || (depth < 3 && envSplitNamesGateOff(prog, depth + 1))) return true;
      }
    }
  }
  return false;
}

function nameRuleHits(s) {
  const hits = [];
  if (CLI_GATE.test(s) || gateCommandHit(s)) {
    hits.push({ id: "GATE_SELF_DISABLE", message: `\`rein gate\` is operator-only — BLOCKED for every role. ${MSG_ESCAPE}` });
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
        "only `bash install-rein.sh`, `rein install`, `rein sync` and `rein doctor` write there",
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
  let root = join(home, ".rein");
  try { root = realpathSync(root); } catch { /* not installed: compare lexically */ }
  const r = resolveDeep(t);
  return r === root || r.startsWith(root + sep);
}
