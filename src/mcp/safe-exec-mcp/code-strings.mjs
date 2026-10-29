// code-strings.mjs — the strings a command line hands to something that EXECUTES them (E-350,
// D-111 r6 i). A quoted argument is one token, so `su -c 'rm -rf src' root` showed the Architect
// sovereignty rules no `rm` at all. D-111 r3: a string given to -c, eval, su -c or env -S IS
// code — the caller re-analyses each string returned here as if it had been typed unquoted.
//
// Carriers, per simple command (segments split on ; && || | & and parentheses, so an unrelated
// `grep -c 'rm -rf x'` later on the line is not mistaken for one):
//   shells       bash/sh/zsh/dash/ash/ksh/mksh/fish/csh/tcsh  -c (or a cluster holding c: -lc)
//   su, runuser  -c <s> | -c<s> | --command <s> | --command=<s>
//   script       -c <s> | a cluster ending in c (-qc) | --command <s>
//   flock        -c <s> | --command <s>
//   env          -S <s> | -S<s> | a cluster holding S (-iS) | --split-string[=]<s>; the values of
//                -u/--unset and -C/--chdir are skipped, not taken for the command
//   eval, watch, sudo -s/-i: every following word, joined (each runs its words through a shell)
//   interpreters python*/node/perl/ruby/deno/bun -c|-e|-E|--eval|-p|--print [=]<program>: the
//                program is not shell, so its string literals are joined into one shell line
//                (os.system("rm -rf x"), execSync("…"), subprocess.run(["rm","-rf","x"])).
import { parse } from "shell-quote";

const SHELLS = /^(bash|sh|zsh|dash|ash|ksh|mksh|fish|csh|tcsh)$/;
const INTERPRETERS = /^(python[0-9.]*|node|nodejs|perl|ruby|deno|bun)$/;
const INTERP_FLAGS = new Set(["-c", "-e", "-E", "--eval", "-p", "--print"]);
const SEPARATORS = new Set([";", "&&", "||", "|", "&", "(", ")", "|&", ";;"]);
// A carrier inside backticks or $( ) arrives as "`sh" / "$(sh": the punctuation is not its name.
const base = (t) => String(t).replace(/^[`$("']+/, "").split("/").pop();

function segments(raw) {
  let parsed;
  try { parsed = parse(String(raw), (k) => `$${k}`); } catch { return []; }
  const out = [[]];
  for (const node of parsed) {
    if (typeof node === "string") out[out.length - 1].push(node);
    else if (node && node.op === "glob") out[out.length - 1].push(node.pattern);
    else if (node && SEPARATORS.has(node.op)) out.push([]);
  }
  return out.filter((s) => s.length);
}

// String literals of a non-shell program, joined so a list form (["rm","-rf","x"]) reads as one line.
function literals(program) {
  const found = [...String(program).matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|`((?:\\.|[^`\\])*)`/g)];
  return found.map((m) => m[1] ?? m[2] ?? m[3]).join(" ");
}

// The code string carried by seg[i] (whose base is b), or null.
function carried(seg, i, b) {
  const rest = seg.slice(i + 1);
  const at = (j) => (j < rest.length ? rest[j] : null);
  if (b === "eval" || b === "watch") return rest.length ? rest.join(" ") : null;
  if (b === "sudo") {
    const k = rest.findIndex((t) => t === "-s" || t === "-i" || t === "--shell" || t === "--login");
    return k === -1 || k + 1 >= rest.length ? null : rest.slice(k + 1).join(" ");
  }
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j];
    if (SHELLS.test(b)) {
      if (/^-[A-Za-z]*c[A-Za-z]*$/.test(t)) return at(j + 1);
      if (/^[-+][oO]$/.test(t)) { j++; continue; }             // -O extglob / +o posix: a value follows
      if (!/^[-+]/.test(t)) return null;                       // a script path: its args are not code
    } else if (b === "su" || b === "runuser") {
      if (t === "-c" || t === "--command" || /^-[A-Za-z]+c$/.test(t)) return at(j + 1);   // -c, -lc
      if (t.startsWith("--command=")) return t.slice("--command=".length);
      if (/^-c./.test(t)) return t.slice(2);
    } else if (b === "script") {
      if (/^-[A-Za-z]*c$/.test(t) || t === "--command") return at(j + 1);
      if (t.startsWith("--command=")) return t.slice("--command=".length);
    } else if (b === "flock") {
      if (t === "-c" || t === "--command") return at(j + 1);
    } else if (b === "env") {
      if (t === "--split-string") return at(j + 1);
      if (t.startsWith("--split-string=")) return t.slice("--split-string=".length);
      if (t === "-u" || t === "--unset" || t === "-C" || t === "--chdir") { j++; continue; }
      if (/^-[A-Za-z]+/.test(t) && !t.startsWith("--")) {
        const s = t.indexOf("S");
        if (s !== -1) return t.length > s + 1 ? t.slice(s + 1) : at(j + 1);
        if (/[uC]$/.test(t)) j++;                              // -iu NAME: the value is next
        continue;
      }
      if (!t.startsWith("-") && !t.includes("=")) return null; // env's command starts here
    } else if (INTERPRETERS.test(b)) {
      if (INTERP_FLAGS.has(t)) return at(j + 1) === null ? null : literals(at(j + 1));
      const eq = /^(--eval|--print|-e|-p)=(.*)$/s.exec(t);
      if (eq) return literals(eq[2]);
      if (/^-[A-Za-z]*[ceEp]$/.test(t)) return at(j + 1) === null ? null : literals(at(j + 1));
      if (!t.startsWith("-")) return null;                     // a script path
    } else {
      return null;
    }
  }
  return null;
}

const CARRIERS = (b) => SHELLS.test(b) || INTERPRETERS.test(b) ||
  ["eval", "watch", "sudo", "su", "runuser", "script", "flock", "env"].includes(b);

export function codeStrings(raw) {
  const found = [];
  for (const seg of segments(raw)) {
    for (let i = 0; i < seg.length; i++) {
      const b = base(seg[i]);
      if (!CARRIERS(b)) continue;
      const code = carried(seg, i, b);
      if (code !== null && code.trim()) found.push(code);
      if (b === "eval" || b === "watch") break;                // the rest of the segment is its program
    }
  }
  return found;
}
