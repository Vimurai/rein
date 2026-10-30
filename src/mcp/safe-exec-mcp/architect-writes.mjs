// architect-writes.mjs — what a caller in the `architect` role may write, and how a
// command's write targets are identified.
//
// EXTRACTED FROM index.js (E-216): the analyser had grown past the 1000-line standards
// limit, and this is the cohesive piece — one question ("does this command write
// outside .ai//plans/?"), asked of three different surfaces (a tool-supplied path, a
// shell command, and the paths a verb names). Splitting it here keeps that question in
// one file rather than interleaved with the general command analysis.
//
// The invariant this module exists to uphold, learned across seven audit rounds:
// TEXT THE PARSER HAS ALREADY CLASSIFIED AS DATA MUST NEVER BE READ AS SYNTAX.
// Every defect found in it was that rule broken — a quoted `>` in prose, `-t` taken
// from another command's flags, `|` inside a printf format, `>` inside an awk literal,
// a newline inside a quoted string, a heredoc tag narrower than the shell's. Anything
// added here should be checked against that invariant first.

import { parse } from "shell-quote";
import { existsSync, realpathSync, lstatSync } from "node:fs";
import { join, isAbsolute, normalize, relative, dirname, basename, resolve as resolvePath } from "node:path";

// A path operand the Architect is allowed to touch: within .ai/ or plans/
// (optionally prefixed with ./). Bare commit-ish refs (HEAD, hashes, branch
// names) are NOT safe paths, so an unscoped `git reset --hard HEAD` blocks.
const SAFE_ARCHITECT_PATH = /^(\.\/)?(\.ai|plans)(\/|$)/;

export function isSafeArchitectPath(tok) {
  return SAFE_ARCHITECT_PATH.test(tok);
}

// ── E-208 (D-054, role-abstraction.md §Components 5): Write/Edit sovereignty ───
// SAFE_ARCHITECT_PATH above matches the RELATIVE operands that appear in a shell
// command. The Write/Edit tools hand the hook an ABSOLUTE path instead, so it must
// first be normalised against the project root before the same .ai/ | plans/ rule
// can be applied. Kept separate from the token-based command analyser because the
// input shape differs: one path, already parsed, no shell quoting to reason about.
//
// WHY THIS EXISTS: the Architect pane is Claude, which HAS Write/Edit tools. §35
// ANTI-DRIFT was prompt-level only for those.
//
// SCOPE — READ THIS BEFORE RELYING ON IT (E-208 audit; widened by E-216 / D-055 R1):
// this function covers the NATIVE write tools (Write|Edit|MultiEdit|NotebookEdit).
// The other two channels are covered ELSEWHERE, not here:
//   - shell writes  → analyzeArchitectWrites() below (redirections, tee/cp/mv/install/
//     ln/rsync/dd/truncate/patch, sed -i / perl -i, git apply; inline interpreters
//     blocked outright)
//   - MCP write tools → `permissions.deny` in .claude/settings.architect.json (E-216),
//     because a hook cannot reliably see a pre-approved MCP call's arguments
// STATED RESIDUAL, still not covered: exotic encodings (base64-piped payloads), git
// plumbing (hash-object/update-index/update-ref), and interactive editors (vim/ed).
// So the shell channel is substantially narrowed but not airtight — this is strong
// defence in depth, and a determined Architect with a shell is still not fully
// contained. The Git Lane (E-214) is the last checkpoint before history.
//
// PATH GATING ITSELF also has limits, so do not read the list above as "everything
// else is airtight":
//   - HARDLINKS are handled below by an nlink check, NOT by path resolution — no
//     resolution algorithm can see through one (see the check in this function).
//   - TOCTOU: the hook approves a path, then the tool opens it. A concurrent
//     `ln -sf` between those two moments is not observable here. Inherent to
//     hook-based gating, and it needs the same shell channel already declared open.
/**
 * boundedRel — resolve `rawPath` against `projectRoot` and report the path RELATIVE to
 * it, or a block reason. This is the shared half of every path gate in the system.
 *
 * E-221 note: it was shared for a reason. `propose-patch-mcp` carried its own four-line
 * `safePath` — resolve, relative, reject a leading ".." — and a symlinked DIRECTORY
 * component inside the project (`src/esc -> ../outside`) walked straight through it: the
 * lexical relative path contains no "..", so the check passed, and the write followed the
 * link out of the project. That is the same class E-216 spent seven rounds on and E-219 F1
 * reintroduced. Two predicates for one rule will always drift; there is now one.
 */
export function boundedRel(rawPath, projectRoot) {
  if (!rawPath || typeof rawPath !== "string") return { blocked: false, rel: null };

  // A parent-directory segment must be rejected BEFORE any resolution, because
  // `normalize` and `resolve` collapse it LEXICALLY (a pure string operation) while
  // the kernel applies it to the SYMLINK TARGET. Given a link inside .ai/ pointing at
  // a directory under src/, a path that walks through that link and then back up one
  // level collapses, as a string, to something still inside .ai/ — so the gate allowed
  // it — while the kernel resolved it to a file under src/. That wrote real bytes to a
  // real source file through the native Write tool (E-208 audit round 2).
  // Resolving symlinks first does not fix it — the two orders disagree by design.
  for (const seg of String(rawPath).split(/[\\/]+/)) {
    if (seg === "..") {
      return { blocked: true, reason: "path contains a '..' segment, which cannot be resolved safely across symlinks" };
    }
  }

  // Strip trailing separators BEFORE resolving. `existsSync(".ai/link/")` is false for
  // a symlink-to-FILE (ENOTDIR), so the ancestor walk would skip the leaf, re-attach
  // it as an unresolved tail, and hand back `.ai/link` — inside the allowed root,
  // never resolved to its target. `.ai/link` blocked while `.ai/link/` allowed
  // (E-208 audit round 2).
  // A loop, not /[\\/]+$/: that regex is quadratic on a long run of separators that does not
  // end the string (E-397, CodeQL js/polynomial-redos).
  const s = String(rawPath);
  let end = s.length;
  while (end > 0 && (s[end - 1] === "/" || s[end - 1] === "\\")) end--;
  const cleanedPath = s.slice(0, end) || rawPath;

  let rel;
  try {
    const abs = isAbsolute(cleanedPath) ? normalize(cleanedPath) : resolvePath(projectRoot, cleanedPath);
    // Symlinks are resolved BEFORE the boundary test, or a link planted inside the root
    // silently forwards a write to any target. The write target itself may not exist
    // yet, so resolve the nearest EXISTING ancestor and re-attach the unresolved tail.
    rel = relative(realpathRoot(projectRoot), realpathNearest(abs));
  } catch {
    return { blocked: true, reason: "path could not be resolved against the project root" };
  }
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { blocked: true, reason: "path is outside the project root" };
  }
  return { blocked: false, rel };
}

/**
 * HARDLINK check — the one place path resolution genuinely cannot help. A hardlink is
 * not a REFERENCE to a file, it IS the file under a second equally canonical name, so
 * realpath has nothing to see through: `ln src/bin/rein .ai/h` then `Write .ai/h` writes
 * src/bin/rein, and every path-based check agrees the target is inside .ai/. Only an inode
 * property distinguishes it. One lstat, and it can only ever ADD restriction to a write
 * we were about to allow. Directories legitimately carry nlink > 1 (subdirectory
 * back-references), so this is restricted to regular files. A missing target is not yet
 * a file and cannot be an alias for one.
 */
export function hardlinkAlias(projectRoot, rel, escapesWhat = "outside the project root") {
  try {
    const st = lstatSync(join(realpathRoot(projectRoot), rel));
    if (st.isFile() && st.nlink > 1) {
      return {
        blocked: true,
        reason: `target has ${st.nlink} hard links — it is the same inode as a file elsewhere, so writing it would write ${escapesWhat}`,
      };
    }
  } catch {
    // Target does not exist yet (the common case for a new file) — nothing to alias.
  }
  return null;
}

/**
 * The PROJECT boundary, for every role. Used by propose-patch-mcp (E-221) so a confirmed
 * patch cannot write outside the project it was proposed in, by any mechanism.
 */
export function projectPathVerdict(rawPath, projectRoot) {
  const b = boundedRel(rawPath, projectRoot);
  if (b.blocked || b.rel === null) return b;
  return hardlinkAlias(projectRoot, b.rel) || { blocked: false, rel: b.rel };
}

export function architectPathVerdict(rawPath, projectRoot) {
  const b = boundedRel(rawPath, projectRoot);
  if (b.blocked) return b;
  if (b.rel === null) return { blocked: false }; // nothing to gate — never invent a block
  // Already normalised above, so any embedded parent-directory segments have been
  // collapsed — an escape attempt shows up as a rel that leaves the root, caught above.
  if (isSafeArchitectPath(b.rel)) {
    return hardlinkAlias(projectRoot, b.rel, "outside .ai//plans/") || { blocked: false };
  }
  return { blocked: true, reason: "the Architect may only write under .ai/ or plans/" };
}

// realpath of the project root itself (the root may sit under a symlinked prefix,
// e.g. /tmp -> /private/tmp on macOS; without this every path would look "outside").
function realpathRoot(root) {
  try { return realpathSync(root); } catch { return root; }
}

// realpath the deepest EXISTING ancestor of `abs`, then re-attach the not-yet-created
// tail. A write target usually does not exist yet, so realpathSync(abs) would throw;
// resolving the ancestor still defeats a symlinked directory component.
function realpathNearest(abs) {
  let cur = abs;
  const tail = [];
  for (let i = 0; i < 64; i++) {
    if (existsSync(cur)) {
      // FAIL CLOSED: a realpath error must NOT degrade to the unresolved path — that
      // is a fail-open in a security decision, and it is what let a trailing slash on
      // a symlinked leaf (ENOTDIR) slip through (E-208 audit round 2). Throwing here
      // is caught by architectPathVerdict, which returns blocked.
      const real = realpathSync(cur); // may throw — intentional
      return tail.length ? join(real, ...tail.reverse()) : real;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.push(basename(cur));
    cur = parent;
  }
  return abs;
}

// Project root for the path gate: nearest ancestor of cwd containing .ai/.
export function findProjectRootFrom(start) {
  let dir = resolvePath(start || process.cwd());
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".ai"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolvePath(start || process.cwd());
}

// ── E-216 (D-055 R1): Architect shell write policy ───────────────────────────
// The E-208 gate covers the NATIVE write tools; this closes the shell channel that
// audit left open (`echo pwned > src/bin/rein` wrote real bytes to a real source file).
//
// REDIRECTS ARE READ STRUCTURALLY, from shell-quote's parse output, never from the raw
// string. The first cut used a raw regex and was wrong in both directions: it missed
// `echo x>src/x` (no space), `&>` and `>|`, and it fired on a `>` inside QUOTED prose —
// blocking `echo "a -> b"`, `git commit -m "... -> ..."` and `grep '>' notes.md`. The
// Architect's whole job is writing prose into .ai/, and this repo's own notation is
// full of `->`, so that over-block was the more damaging half. parse() yields
// {op:">"} only for a real redirection and never inside quotes.
//
// TARGETS ARE RESOLVED THROUGH THE SAME PATH LOGIC AS THE WRITE-TOOL GATE
// (architectPathVerdict), so the two layers of one rule cannot disagree. A bare prefix
// test let `.ai/../src/x` walk straight out while the Write/Edit layer caught it.
//
// TWO CLASSES:
//   1. Target-bearing forms — allowed only when every resolved target is in scope.
//   2. Inline interpreters — refused when they carry a program (inline flag, heredoc,
//      here-string, or as the sink of a pipe): the write target lives inside a program
//      string this analyser does not execute, so "is the target in scope?" is a
//      question it cannot honestly answer. awk is handled on its own terms — refused
//      only when its program text can write — because `awk '{print $1}' f` is an
//      ordinary read and refusing every awk would over-block badly.
//
// RESOLUTION NOTE: a relative write target is resolved against the PROJECT ROOT, not
// the command's effective cwd, so `cd .ai && echo x > notes.md` and a `$PWD`-built path
// both BLOCK. Both fail closed, and the Architect's own tooling uses repo-relative
// paths, so this is a deliberate conservatism rather than a defect.
//
// STATED RESIDUAL (tests pin this wording): exotic encodings (base64-piped payloads),
// git plumbing (hash-object/update-index/update-ref), interactive editors (vim/ed),
// MCP tool proxying beyond the names denied in the architect overlay, DELETION via
// `find -delete` / `find -exec rm` (this gate reasons about WRITES, not removals), and
// an awk program supplied by `-f` whose file lies outside .ai//plans/ (refused, but the
// program text itself is never read). Substantially narrowed; not airtight. The Git
// Lane (E-214) is the last checkpoint before anything reaches history.

// Redirect targets that are not filesystem writes.
const ARCH_NULL_SINKS = /^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/;

// Write verbs whose LAST operand is the destination; earlier operands are read.
const ARCH_DEST_LAST_VERBS = new Set(["cp", "mv", "install", "rsync", "ln"]);
// Write verbs where every operand is a target.
const ARCH_DEST_ALL_VERBS = new Set(["tee", "truncate", "patch", "sponge"]);
// Verbs whose destination is named by a flag VALUE.
const ARCH_FLAG_DEST = {
  curl: ["-o", "--output"],
  wget: ["-O", "--output-document"],
  tar: ["-C", "--directory"],
  unzip: ["-d"],
  dd: [],           // dd uses of=<path>, handled separately
};
// Flags that consume the NEXT token as a value, so it is not a path operand.
// PER-VERB, not global: a global set was wrong in both directions. `-t` is a
// DESTINATION for cp/mv/install (`cp -t src/ .ai/a` writes into src/) but was being
// swallowed as a value, leaving the SOURCE as the "last operand" — a real bypass. And
// `-p` is boolean for tee, so swallowing it ate the legitimate target of
// `tee -p .ai/log`. Same root cause, opposite symptoms.
const ARCH_VALUE_FLAGS_BY_VERB = {
  truncate: ["-s", "--size", "-r", "--reference"],
  install: ["-m", "--mode", "-o", "--owner", "-g", "--group", "-S", "--suffix"],
  cp: ["-S", "--suffix"],
  mv: ["-S", "--suffix"],
  ln: ["-S", "--suffix"],
  rsync: ["--exclude", "--include", "--files-from", "-e", "--rsh"],
  tar: ["-f", "--file", "-C", "--directory"],
  unzip: ["-d", "-x"],
  curl: ["-o", "--output"],
  wget: ["-O", "--output-document"],
  tee: [],
  patch: ["-i", "--input", "-p", "--strip", "-d", "--directory"],
  sponge: [],
};
// Destination-naming flags for the dest-last verbs (GNU coreutils).
const ARCH_TARGET_DIR_FLAGS = ["-t", "--target-directory"];

// Interpreters that take a program on the command line. Versioned binaries included:
// `python3.11 -c` evaded a fixed-name set.
const ARCH_INTERPRETER_RE = /^(python|node|perl|ruby|php|bash|sh|zsh|deno|bun)[0-9.]*$/;
const ARCH_INLINE_FLAGS = new Set([
  "-c", "-e", "-E", "-r", "-p", "-m", "--eval", "--print", "--command", "--run",
]);

// git subcommands that restore/overwrite working-tree files.
// `switch` is the modern equivalent of `checkout` and overwrites working-tree files
// identically — omitting it was the same inconsistency as omitting `restore`.
const ARCH_GIT_WRITE_SUBS = new Set(["apply", "restore", "switch", "checkout-index", "am"]);

/** basename, so /bin/cp and cp are the same verb (the interpreter loop already did this). */
function _base(tok) {
  return String(tok || "").replace(/^.*\//, "");
}

/** Non-flag operands of `verb`, skipping flags AND the values those flags consume. */
function _writeOperands(tokens, verb) {
  const i = tokens.findIndex((t) => _base(t) === verb);
  if (i === -1) return [];
  const valueFlags = new Set(ARCH_VALUE_FLAGS_BY_VERB[verb] || []);
  const out = [];
  const rest = tokens.slice(i + 1).map(String);
  for (let j = 0; j < rest.length; j++) {
    const t = rest[j];
    if (!t || t === "--") continue;
    if (t.startsWith("-")) {
      if (valueFlags.has(t)) j++; // consume the value
      continue;
    }
    out.push(t);
  }
  return out;
}



/**
 * Value of a flag, in every spelling a GNU tool accepts:
 *   --opt value | --opt=value | -o value | -oVALUE | -abcVALUE (clustered shorts)
 *
 * ONE resolver, used by every caller. Two near-identical helpers previously disagreed
 * about which spellings they understood — `_targetDirFlag` handled `=` and `_flagDest`
 * did not — so `curl --output=src/x` and `curl -osrc/x` walked straight past. Each new
 * spelling would have reopened the hole; folding them together closes the class.
 */
function _flagValue(tokens, flags, { allowClustered = true } = {}) {
  const rest = tokens.map(String);
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    for (const f of flags) {
      if (t === f) return rest[i + 1] ?? null;              // -o value / --opt value
      if (f.startsWith("--") && t.startsWith(f + "=")) return t.slice(f.length + 1);
      if (!f.startsWith("--") && f.length === 2 && t.startsWith(f) && t.length > 2 && !t.startsWith("--")) {
        return t.slice(2);                                   // -oVALUE
      }
      // Clustered shorts: `curl -sSLo .ai/x` — the flag letter ends the cluster.
      // NOT applied to -t: `ls -lt`, `sort -rt`, `find -nt` are ordinary read flags
      // that end in `t`, so this heuristic is ambiguous by construction for -t and
      // produced false destinations ("cp targeting 'src/'" from an `ls -lt src/` in a
      // DIFFERENT command). Kept for -o, where clustering is a real idiom.
      // Clustered shorts (`curl -sSLo X`, `cp -at DIR`). Safe now that callers pass a
      // window scoped to one verb inside one segment: the `ls -lt` in a DIFFERENT
      // command that forced this off can no longer be in view.
      if (allowClustered && !f.startsWith("--") && f.length === 2 &&
          /^-[A-Za-z]{2,}$/.test(t) && t.endsWith(f[1])) {
        return rest[i + 1] ?? null;
      }
    }
  }
  return null;
}

/** `-t DIR` / `--target-directory[=]DIR` destination, or null. */
function _targetDirFlag(tokens) {
  return _flagValue(tokens, ARCH_TARGET_DIR_FLAGS);
}

/**
 * Split a command on newlines that are actually COMMAND SEPARATORS — skipping any
 * newline inside a quoted string or a heredoc body.
 *
 * This is the only place left that inspects raw text before the parser has spoken, and
 * it is therefore the last place the recurring invariant can be violated: text the
 * parser would classify as DATA must never be read as SYNTAX. A plain
 * `raw.split(/\n/)` cut through the body of
 *   git commit -m "fix: thing\n\nArchitect > Engineer handoff"
 * leaving fragments with unbalanced quotes, which then re-parsed as commands — so a
 * multi-line commit message or a blueprint documenting `cp .ai/a src/x` was analysed as
 * if the Architect had RUN it. Writing prose into .ai/ that contains shell examples is
 * the Architect's actual job, so that over-block struck the core use case.
 *
 * Heredocs matter for the same reason and are tracked here explicitly: the heredoc
 * DETECTOR further down deliberately works on the whole raw string because a heredoc
 * body spans newlines — this splitter has to honour the same fact rather than cutting
 * that body into commands.
 */
function _splitCommandLines(raw) {
  const text = String(raw);
  const lines = [];
  let cur = "";
  let quote = null;          // "'" or '"' when inside a quoted span
  let heredocTag = null;     // set while inside a heredoc body
  let pendingTag = null;     // tag seen; body starts at the next newline
  let hdLine = "";           // current line within a heredoc body (terminator check)

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    // Inside a heredoc body: DISCARD it. The body is DATA being written, not commands
    // to analyse — accumulating it meant `cat > .ai/doc.md <<EOF … Run: cp .ai/a src/x
    // … EOF` was read as if the Architect had run that cp. Documenting a shell command
    // inside a blueprint is the job. The heredoc-fed-INTERPRETER case is caught
    // separately by the detector on the raw string, which is why dropping the body
    // here loses no coverage.
    if (heredocTag !== null) {
      if (ch === "\n") {
        if (hdLine.trim() === heredocTag) { heredocTag = null; }
        hdLine = "";
      } else {
        hdLine += ch;
      }
      continue;
    }

    // Backslash escape (outside single quotes, where it is literal).
    if (ch === "\\" && quote !== "'") {
      cur += ch + (text[i + 1] ?? "");
      i++;
      continue;
    }

    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }

    // Heredoc introducer: << or <<- then an optionally quoted word.
    if (ch === "<" && text[i + 1] === "<") {
      // Match the tag the way the SHELL delimits it — an optionally quoted word — not
      // a \w-shaped approximation. `[A-Za-z_][A-Za-z0-9_]*` broke both ways on a tag
      // containing a non-word character: unquoted `<<END-OF` captured only `END`, so
      // the splitter waited for a terminator that never arrived and DISCARDED the rest
      // of the input (commands bash does run vanished from analysis); quoted
      // `<<'END-OF'` failed the backreference entirely, so no heredoc was recognised
      // and the body was parsed as commands. Same invariant as every round before it:
      // the tag's extent is defined by the shell, and the regex substituted its own.
      // (?!<) keeps `<<<` here-strings out — they are not heredocs.
      const m = /^<<-?(?!<)\s*(['"]?)([^\s'"<>|&;()]+)\1/.exec(text.slice(i));
      if (m) { pendingTag = m[2]; cur += m[0]; i += m[0].length - 1; continue; }
    }

    if (ch === "\n") {
      // The command line ENDS here; a heredoc body (if any) follows and is discarded.
      lines.push(cur);
      cur = "";
      if (pendingTag !== null) { heredocTag = pendingTag; pendingTag = null; hdLine = ""; }
      continue;
    }
    cur += ch;
  }
  lines.push(cur);
  return lines.filter((l) => l.trim());
}

/**
 * Architect shell-write violations. Returns [{id,message}].
 *
 * STRUCTURE: every check runs PER COMMAND SEGMENT. Earlier revisions segmented only the
 * write-verb section — the site where the cross-command bug happened to be demonstrated
 * — and left the awk, in-place-editor and git sections reading the whole flattened
 * token list. That produced both bypasses (`git status && git restore src/x` passed,
 * because only the FIRST `git` token was inspected) and over-blocks (`sed -i '' s/a/b/
 * .ai/n && git diff` reported `git` and `diff` as sed's write targets). Applying the
 * same discipline everywhere is the fix; doing it in one place was not.
 */

// A redirect that WRITES its target. shell-quote 1.8 parsed `>|` as `>` then `|`, and `&>` as `&`
// then `>`, so the two-op shapes were caught by `>` alone; shell-quote >= 1.10 returns them as ONE
// operator (`{op:">|"}`, `{op:"&>"}`, `{op:"&>>"}`), and a fresh `npm install` of ^1.8.1 resolves
// 1.12 — so the Architect write gate stopped seeing `echo x &> src/x` on every new install (E-294
// CI, 2026-10-04). Every shape is listed so both parser generations give the same verdict. `>&`
// is NOT here: its target is a file descriptor (`2>&1`), never a path.
const WRITE_REDIRECT_OPS = new Set([">", ">>", ">|", "&>", "&>>"]);

export function analyzeArchitectWrites(tokens, raw) {
  const violations = [];
  const seen = new Set();
  const bad = (id, message) => {
    const k = id + "|" + message;
    if (!seen.has(k)) { seen.add(k); violations.push({ id, message }); }
  };
  const root = findProjectRootFrom(process.cwd());
  const outOfScope = (target) => architectPathVerdict(target, root).blocked;

  const check = (verb, targets) => {
    if (targets.length === 0) {
      bad("ARCH_WRITE_UNPARSED",
        `${verb} with no resolvable target is blocked (fail-closed) for the Architect role.`);
      return;
    }
    for (const t of targets) {
      if (ARCH_NULL_SINKS.test(t)) continue;
      if (outOfScope(t)) {
        bad("ARCH_SHELL_WRITE",
          `${verb} targeting '${t}' writes outside .ai//plans/ — a forbidden Architect operation.`);
      }
    }
  };

  // ── Build segments ────────────────────────────────────────────────────────
  // NEWLINE IS A SEPARATOR THE PARSER NEVER EMITS: shell-quote treats it as ordinary
  // whitespace, so `git status\ngit restore src/x` arrived as ONE token list and the
  // second command was invisible. The newline split therefore has to happen on the RAW
  // string, before parsing — it cannot come from the op stream. Multi-line commands are
  // routine from an agent, so this is a common path, not an edge case.
  // Each unit is { tokens, redirects }. Redirect targets are captured DURING this walk
  // and removed from the token list — they are not command operands. An earlier
  // revision re-parsed `seg.join(" ")` to recover them, which was the same mistake
  // this whole section exists to avoid: reconstructing text loses the quoting, so
  // `echo "a -> b"` came back as a redirection and `echo x > src/x` lost its op
  // entirely. Structure is read once, from the parse, and carried forward.
  const segments = [];
  const pipeSinks = [];
  const WRAPPERS = new Set(["sudo", "env", "nice", "command", "xargs", "time", "nohup", "stdbuf"]);
  for (const line of _splitCommandLines(raw)) {
    let parsed;
    try { parsed = parse(line) || []; } catch { parsed = []; }
    if (!parsed.length) {
      segments.push({ tokens: line.trim().split(/\s+/), redirects: [] });
      continue;
    }
    let cur = { tokens: [], redirects: [] };
    for (let i = 0; i < parsed.length; i++) {
      const node = parsed[i];
      if (node && typeof node === "object") {
        if (WRITE_REDIRECT_OPS.has(node.op)) {
          // Target is the next STRING, skipping any further ops (`>|` under shell-quote 1.8).
          let j = i + 1;
          while (j < parsed.length && parsed[j] && typeof parsed[j] === "object") j++;
          if (typeof parsed[j] === "string") {
            cur.redirects.push(parsed[j]);
            parsed[j] = null;        // consumed: not a command operand
          } else {
            cur.redirects.push(null); // unresolvable → fail closed below
          }
          continue;
        }
        if (node.op === "|") {
          let k = i + 1;
          while (k < parsed.length && typeof parsed[k] === "string" &&
                 (WRAPPERS.has(_base(parsed[k])) || /^-/.test(parsed[k]) || /=/.test(parsed[k]))) k++;
          if (typeof parsed[k] === "string") pipeSinks.push(_base(parsed[k]));
        }
        if (["&&", "||", ";", "|", "&"].includes(node.op)) {
          segments.push(cur);
          cur = { tokens: [], redirects: [] };
        }
        continue;
      }
      if (node === null) continue; // consumed as a redirect target
      cur.tokens.push(String(node));
    }
    segments.push(cur);
  }
  const units = segments.filter((u) => u.tokens.length || u.redirects.length);
  if (!units.length) units.push({ tokens: tokens.map(String), redirects: [] });

  // Piping a program into an interpreter: the program arrives on stdin, which is the
  // same "target is inside a program string we do not execute" case.
  for (const sink of pipeSinks) {
    if (ARCH_INTERPRETER_RE.test(sink)) {
      bad("ARCH_INLINE_INTERPRETER",
        `piping into ${sink} is a forbidden Architect operation — the program arrives on stdin ` +
        "and its write target cannot be determined. Use the Write/Edit tools.");
    }
  }

  // Heredoc-fed interpreter: detection-only and fail-closed, so it stays on the raw
  // string — a heredoc body legitimately spans newlines. _splitCommandLines above
  // honours the same fact rather than cutting a heredoc body into commands; the two
  // must agree, and an earlier revision where only this side knew it produced the
  // over-block on `cat > .ai/doc.md <<EOF … EOF`.
  if (/\b(python|node|perl|ruby|php|bash|sh|zsh)[0-9.]*\b[^\n|;&]*<<-?\s*['"]?[A-Za-z_]/.test(raw)) {
    bad("ARCH_INLINE_INTERPRETER",
      "a heredoc-fed interpreter is a forbidden Architect operation — its write target is " +
      "inside the heredoc body. Use the Write/Edit tools instead.");
  }

  // ── Per-segment analysis — EVERY section, not just the verbs ─────────────
  for (const unit of units) {
    const seg = unit.tokens;
    const bases = new Set(seg.map(_base));

    // 1. Inline interpreters carrying a program.
    for (let i = 0; i < seg.length; i++) {
      const base = _base(seg[i]);
      if (!ARCH_INTERPRETER_RE.test(base)) continue;
      const rest = seg.slice(i + 1);
      const inlineLetters = /^(perl|ruby|node|deno|bun)/.test(base) ? "e" : "ce";
      const hasInlineFlag = rest.some((r) =>
        ARCH_INLINE_FLAGS.has(r) ||
        (/^-[A-Za-z]+$/.test(r) && [...r.slice(1)].some((ch) => inlineLetters.includes(ch))));
      if (hasInlineFlag) {
        bad("ARCH_INLINE_INTERPRETER",
          `${base} with an inline program/module is a forbidden Architect operation — its write ` +
          "target cannot be determined without executing it. Use the Write/Edit tools " +
          "(path-gated to .ai//plans/).");
      }
    }
    if (bases.has("eval")) {
      bad("ARCH_INLINE_INTERPRETER",
        "eval is a forbidden Architect operation — its effect cannot be analysed statically.");
    }

    // 2. awk — EVERY occurrence in the segment (an early `break` let a second awk hide).
    for (let i = 0; i < seg.length; i++) {
      if (!/^(g|m|n)?awk$/.test(_base(seg[i]))) continue;
      const rest = seg.slice(i + 1);
      if (rest.some((t) => t === "inplace" || /^-i/.test(t))) {
        bad("ARCH_INLINE_INTERPRETER",
          "awk -i inplace is a forbidden Architect operation — it edits files in place.");
        continue;
      }
      const progFile = _flagValue(rest, ["-f", "--file"]);
      if (progFile !== null) {
        if (outOfScope(progFile)) {
          bad("ARCH_INLINE_INTERPRETER",
            "awk -f names a program file whose contents this gate cannot read — refused unless " +
            "the program itself is under .ai//plans/.");
        }
        continue;
      }
      const AWK_VALUE_FLAGS = new Set(["-v", "-F", "-f", "--assign", "--field-separator", "--file"]);
      let program = null;
      for (let j = 0; j < rest.length; j++) {
        const t = rest[j];
        if (!t) continue;
        if (t.startsWith("-")) { if (AWK_VALUE_FLAGS.has(t)) j++; continue; }
        program = t;
        break;
      }
      if (!program) continue;
      // Strip string literals: `printf "%s | %s"` and `print "a > b"` are formatting,
      // not redirection. A real `print "x" > "src/x"` keeps its operator outside them.
      const bare = program.replace(/"(\\.|[^"\\])*"/g, '""').replace(/'(\\.|[^'\\])*'/g, "''");
      if (/\b(print|printf)\b[^;}]*>>?\s*("|\$|[A-Za-z_(])/.test(bare) ||
          /\b(print|printf)\b[^;}]*\|/.test(bare) ||
          /\bsystem\s*\(/.test(bare)) {
        bad("ARCH_INLINE_INTERPRETER",
          "an awk program that redirects, pipes from print, or calls system() is a forbidden " +
          "Architect operation — its write target is inside the program text. Use Write/Edit.");
      }
    }

    // 3. Write verbs.
    for (const verb of ARCH_DEST_LAST_VERBS) {
      if (!bases.has(verb)) continue;
      // Clustered `-t` is resolved WITHIN THIS VERB'S WINDOW. It had to be dropped
      // while resolution was global (`ls -lt` in another command produced a false
      // destination); segmentation makes it safe again, and `cp -at`/`-rt` are valid
      // GNU spellings that would otherwise stay open.
      const vi = seg.findIndex((t) => _base(t) === verb);
      const window = seg.slice(vi);
      const td = _flagValue(window, ARCH_TARGET_DIR_FLAGS, { allowClustered: true });
      if (td !== null) { check(verb, [td]); continue; }
      check(verb, _writeOperands(seg, verb).slice(-1));
    }
    for (const verb of ARCH_DEST_ALL_VERBS) {
      if (bases.has(verb)) check(verb, _writeOperands(seg, verb));
    }
    for (const [verb, flags] of Object.entries(ARCH_FLAG_DEST)) {
      if (!bases.has(verb) || flags.length === 0) continue;
      const dest = _flagValue(seg, flags);
      if (dest) check(verb, [dest]);
    }
    if (bases.has("dd")) {
      const of = seg.find((t) => t.startsWith("of="));
      if (of) check("dd", [of.slice(3)]);
    }
    for (const verb of ["tar", "unzip", "cpio"]) {
      if (!bases.has(verb)) continue;
      const UNZIP_READ_FLAGS = /^-[ltvpz]+$/;
      if (verb === "unzip" && seg.some((t) => UNZIP_READ_FLAGS.test(t))) continue;
      const extracting = verb === "cpio" ||
        seg.some((t) => /^-.*x/.test(t) || t === "--extract" || (verb === "unzip" && !t.startsWith("-")));
      if (!extracting) continue;
      const dest = _flagValue(seg, ARCH_FLAG_DEST[verb] || []);
      if (!dest) {
        bad("ARCH_ARCHIVE_EXTRACT",
          `${verb} extraction without an explicit in-scope destination is blocked — the paths it ` +
          "writes come from the archive.");
      } else {
        check(verb, [dest]);
      }
    }

    // 4. In-place editors.
    for (const ed of ["sed", "perl"]) {
      const i = seg.findIndex((t) => _base(t) === ed);
      if (i === -1) continue;
      const rest = seg.slice(i + 1);
      if (!rest.some((t) => /^-i/.test(t) || /^--in-place(=|$)/.test(t))) continue;
      const operands = rest.filter((t) => t && !t.startsWith("-"));
      const files = operands.slice(1); // first non-flag operand is the SCRIPT
      if (files.length === 0) {
        bad("ARCH_WRITE_UNPARSED", `${ed} -i with no resolvable target is blocked (fail-closed).`);
        continue;
      }
      check(`${ed} -i`, files);
    }

    // 5. git working-tree writers — EVERY occurrence, not just the first.
    for (let i = 0; i < seg.length; i++) {
      if (_base(seg[i]) !== "git") continue;
      const sub = seg[i + 1];
      if (sub && ARCH_GIT_WRITE_SUBS.has(sub)) {
        bad("ARCH_GIT_WRITE",
          `git ${sub} is a forbidden Architect operation — the paths it writes are determined by ` +
          "the patch/index, not by an argument this gate can scope.");
      }
      if (sub === "stash" && seg[i + 2] && ["pop", "apply"].includes(seg[i + 2])) {
        bad("ARCH_GIT_WRITE",
          `git stash ${seg[i + 2]} is a forbidden Architect operation — it restores arbitrary ` +
          "working-tree paths.");
      }
    }

    // 6. Redirections — targets captured during the parse walk above, never re-parsed.
    for (const target of unit.redirects) {
      if (target === null) {
        bad("ARCH_REDIRECT_UNPARSED",
          "a shell redirection with an unresolvable target is blocked (fail-closed).");
        continue;
      }
      if (ARCH_NULL_SINKS.test(target)) continue;
      if (outOfScope(target)) {
        bad("ARCH_SHELL_WRITE",
          `redirecting into '${target}' writes outside .ai//plans/ — a forbidden Architect operation.`);
      }
    }
  }

  return violations;
}
