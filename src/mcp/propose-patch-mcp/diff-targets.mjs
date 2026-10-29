// diff-targets.mjs — decide which files a `diff_content` blob would write (E-221, audit H3).
//
// WHY THIS EXISTS:
//   `patch` consumes the `-f <operand>` file for the FIRST patch section in its input
//   only. Every later section derives its own target from its own `---`/`+++` headers,
//   resolved against patch's cwd. So a blob proposed for `src/target.txt` could carry a
//   second section headed `--- ../outside/victim.txt` and write outside the project —
//   exit 0, dry-run clean, tool reporting "✓ Patch applied", and the rendered preview
//   naming only the benign file.
//
//   E-221 validated the PATH argument three ways: `projectPathVerdict`, the `project_root`
//   equality check, and the `rel_path` re-resolution. All three were correct and all three
//   were irrelevant, because the set of files `patch` writes is not the operand. The
//   predicate was right; it was applied to the wrong thing.
//
//   Verified on this host: a single-section blob IS operand-governed (a header naming
//   `../outside/victim.txt` still wrote the operand), and a two-section blob escaped.
//
//   "At most one file section" was my first rule and it was NOT enough. An ed-style
//   prelude (`1c` … `.` … `w`) carries no `---` header, so it is invisible to a section
//   count — and a blob combining one with a single unified section wrote BOTH the operand
//   and a second file, exit 0, reported as "✓ Patch applied". The rule is therefore
//   "unified diff and NOTHING ELSE": every line outside a hunk must belong to the diff
//   grammar. Anything unaccounted for is an instruction to patch(1) that we did not read.
//
// THE PARSE IS STRUCTURAL, NOT LINE-COUNTING.
//   A removed line inside a hunk that begins with `-- foo` appears in the blob as
//   `--- foo`, indistinguishable by regex from a section header. Counting `^--- ` would
//   read hunk DATA as SYNTAX — the same mistake E-216 spent seven rounds removing from
//   the shell gate. Hunk bodies are therefore consumed by their declared line counts, and
//   only what remains outside them can be a header. Anything the parse cannot account for
//   is rejected rather than guessed at.

import { isAbsolute } from "node:path";

/** Section-start markers, outside a hunk body. */
const SECTION_START = /^(--- |\*\*\* |Index: )/;

/**
 * Lines that may legitimately sit OUTSIDE a hunk in a unified diff. Everything else is
 * unaccounted content, and unaccounted content is what `patch` interprets as another
 * instruction — an ed script (`1c` … `.` … `w`) carries no `---` header at all, so it is
 * invisible to a section count while still writing a file. Proven live: an ed prelude
 * plus one unified section wrote BOTH the operand and a second file, exit 0, reported as
 * "✓ Patch applied". So the rule is not "at most one section" but "nothing but diff".
 */
const DIFF_PREAMBLE = /^(--- |\+\+\+ |\*\*\* |Index: |diff |index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename from |rename to |copy from |copy to |GIT binary patch|=+$|$)/;
// NOTE: `GIT binary patch` is allowed as a PREAMBLE line, but its base85 payload lines are
// not in this grammar, so such a blob is refused as carrying stray content. That is the
// outcome we want — we cannot validate what a binary payload would write — and it is
// recorded here so the next reader does not "fix" the allowlist and accidentally admit it.
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Walk a unified-diff blob and return the section header names found OUTSIDE hunk bodies.
 * @returns {{ sections: string[], unparsed: string|null, stray: string|null }} `unparsed`
 *   names a hunk body line in no legal shape; `stray` names the first line outside a hunk
 *   that is not part of the diff grammar. Callers must treat either as a refusal.
 */
export function diffFileSections(blob) {
  const lines = String(blob ?? "").split("\n");
  const sections = [];
  let stray = null;
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const hunk = HUNK_HEADER.exec(line);

    if (hunk) {
      // Consume exactly the declared number of old/new lines. Everything in here is DATA.
      let oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      let newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      i++;
      while (i < lines.length && (oldLeft > 0 || newLeft > 0)) {
        const b = lines[i];
        if (b.startsWith("\\")) { i++; continue; }          // "\ No newline at end of file"
        if (b.startsWith("-")) { oldLeft--; }
        else if (b.startsWith("+")) { newLeft--; }
        else if (b.startsWith(" ") || b === "") { oldLeft--; newLeft--; }
        else {
          // A body line in none of the legal shapes means our idea of the hunk and
          // patch's have diverged. Refuse rather than continue with a parse we no
          // longer trust — a disagreement here is exactly how a section hides.
          return { sections, unparsed: b.slice(0, 80), stray };
        }
        i++;
      }
      // The hunk must actually have been SATISFIED. An inflated or truncated count runs
      // the loop off the end of the blob with counters still positive, silently swallowing
      // whatever followed — including a second `--- victim` header — and the walk would
      // then report a clean single-section parse having never seen it. On this host
      // patch(1) rejects those blobs as malformed, but "the binary happens to be strict"
      // is the reasoning that hid H3 in the first place. The parse now holds on its own
      // terms.
      if (oldLeft > 0 || newLeft > 0) {
        return { sections, unparsed: `hunk declares more lines than the diff contains (${oldLeft} old, ${newLeft} new unaccounted)`, stray };
      }
      // A "\ No newline at end of file" marker sits AFTER the last counted line, so the
      // loop has already exited by the time it appears. Consumed here, still bound to its
      // hunk — rather than allowlisted globally, which would let a `\`-line sit anywhere
      // and `\`-padding is itself part of the count-lie family. Without this, every diff
      // of a file lacking a trailing newline was refused, which is the single most likely
      // diff a model produces: real `git diff --cached` output failed.
      while (i < lines.length && lines[i].startsWith("\\")) i++;
      continue;
    }

    if (SECTION_START.test(line)) {
      sections.push(line.replace(SECTION_START, "").trim());
    } else if (stray === null && !DIFF_PREAMBLE.test(line)) {
      stray = line.slice(0, 80);
    }
    i++;
  }
  return { sections, unparsed: null, stray };
}

/** Strip a diff's `a/`/`b/` prefix and any trailing timestamp column. */
export function headerName(raw) {
  return String(raw ?? "").split("\t")[0].trim().replace(/^[ab]\//, "");
}

/** Does this blob carry a unified hunk header — i.e. will it be fed to `patch(1)`? */
export function isUnifiedDiff(blob) {
  return /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(String(blob ?? ""));
}

/**
 * Is this blob safe to hand to `patch` with a single validated operand?
 *
 * A blob with no hunk header is never given to `patch` — it is written verbatim by
 * `writeFileSync` to the one validated path — so it needs no diff grammar at all.
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateDiffContent(blob) {
  if (!isUnifiedDiff(blob)) return { ok: true };

  const { sections, unparsed, stray } = diffFileSections(blob);
  if (unparsed !== null) {
    return { ok: false, reason: `diff could not be parsed structurally near: ${unparsed}` };
  }
  if (stray !== null) {
    return {
      ok: false,
      reason:
        `diff carries content outside any hunk: '${stray}'. patch(1) reads such lines as ` +
        `further instructions — an ed script needs no '---' header and still writes a file ` +
        `— so a proposed patch must contain unified diff and nothing else.`,
    };
  }
  if (sections.length > 1) {
    return {
      ok: false,
      reason:
        `diff contains ${sections.length} file sections (${sections.slice(0, 3).map(headerName).join(", ")}…). ` +
        `A proposed patch names ONE file, and patch(1) applies the validated path to the first ` +
        `section only — later sections would choose their own targets. Propose one patch per file.`,
    };
  }
  // Defence in depth: the single section is operand-governed today, but a header that
  // escapes the project has no legitimate purpose, and relying on one binary's argument
  // precedence for a security property is how this was missed in the first place.
  for (const raw of sections) {
    const name = headerName(raw);
    if (name === "/dev/null") continue;
    // Absolute as well as relative: defence in depth that covers only relative traversal
    // is half a check, and the cost of the other half is one call.
    if (isAbsolute(name) || name.split(/[\\/]+/).some((seg) => seg === "..")) {
      return { ok: false, reason: `diff header '${name}' names a path outside the proposed one` };
    }
  }
  return { ok: true };
}
