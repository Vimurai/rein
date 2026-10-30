#!/usr/bin/env node
// sync-manifest.mjs — record what `rein sync` wrote, so a later sync can remove ONLY
// what it put there and nothing else.
//
// WHY THIS EXISTS (E-220, D-056 R2):
//   `rein sync` has always been purely additive. That is safe but leaky: after E-217
//   renamed the Architect's task skill to `arch-task`, the old directories survived in
//   every workspace forever, holding whichever version happened to win the last copy.
//   A renamed-away skill lingers until someone deletes it by hand.
//
//   The obvious fix — "delete anything in the target that is not in the source" — is
//   the dangerous one: a user's own skill sitting beside the synced ones is exactly
//   "not in the source", and deleting it would be data loss caused by a housekeeping
//   feature. So pruning is scoped by EVIDENCE rather than by absence.
//
// A path is deleted only when ALL THREE hold:
//   1. it is in this directory's manifest — sync itself wrote it;
//   2. its content still hashes to what sync recorded — nobody has edited it since;
//   3. it is no longer in the current source set — it is genuinely gone upstream.
// Anything else is reported as `orphan (kept)` and left alone. A first run, with no
// manifest, therefore prunes nothing at all — there is no evidence yet.
//
// `--prune-known` additionally removes an orphan that is BYTE-IDENTICAL to a current
// canonical skill under a different name. That is the E-217 leftover shape specifically
// (a `.agents/skills/` directory holding an exact copy of a skill that now lives elsewhere),
// and identity is the evidence: a file that matches a current skill byte for byte
// carries nothing a user could lose.

import { createHash } from "node:crypto";
import {
  existsSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync, realpathSync,
  mkdirSync, copyFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MANIFEST = "_SYNC_MANIFEST.json";
// v2 (E-273): v1 manifests were written by an `apply` that recorded EVERY entry present,
// user-authored skills included, so a v1 manifest is not evidence of what sync wrote.
// readManifest treats any other version as absent: the first v2 run prunes nothing and
// writes a clean manifest (critic_security P1 — a poisoned v1 manifest would otherwise
// delete a user skill on the first upgraded sync).
const VERSION = 2;

/** sha256 of a skill directory's SKILL.md, or of a flat file. */
function hashEntry(dir, name) {
  const p = join(dir, name);
  try {
    const st = statSync(p);
    const target = st.isDirectory() ? join(p, "SKILL.md") : p;
    if (!existsSync(target)) return null;
    return createHash("sha256").update(readFileSync(target)).digest("hex");
  } catch {
    return null;
  }
}

/** Entries sync manages in `dir`: skill directories (with a SKILL.md) and flat .md files. */
export function listManaged(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === MANIFEST || name === "_SKILLS_INDEX.md") continue;
    const p = join(dir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) {
      if (existsSync(join(p, "SKILL.md"))) out.push(name);
    } else if (name.endsWith(".md")) {
      out.push(name);
    }
  }
  return out.sort();
}

export function readManifest(dir) {
  const p = join(dir, MANIFEST);
  if (!existsSync(p)) return null;
  try {
    const m = JSON.parse(readFileSync(p, "utf8"));
    return m && m.version === VERSION && m.entries ? m : null;
  } catch {
    return null; // corrupt manifest → treated as absent, so nothing is pruned
  }
}

/** Record every managed entry currently in `dir` as sync-written. */
export function writeManifest(dir, names) {
  const entries = {};
  for (const n of names) {
    const h = hashEntry(dir, n);
    if (h) entries[n] = h;
  }
  writeFileSync(
    join(dir, MANIFEST),
    JSON.stringify({ version: VERSION, written_at: new Date().toISOString(), entries }, null, 2) + "\n",
  );
  return Object.keys(entries).length;
}

/**
 * Decide what may be removed from `dir`.
 * @param {string[]} sourceNames names the current sources provide
 * @param {string[]} canonicalHashes hashes of every current canonical skill (for --prune-known)
 */
export function planPrune(dir, sourceNames, { pruneKnown = false, canonicalHashes = [] } = {}) {
  const manifest = readManifest(dir);
  const present = listManaged(dir);
  const source = new Set(sourceNames);
  const canon = new Set(canonicalHashes);

  const prune = [];
  const kept = [];

  for (const name of present) {
    if (source.has(name)) continue; // still provided upstream

    const recorded = manifest?.entries?.[name];
    const current = hashEntry(dir, name);

    if (!manifest) {
      // --prune-known does not need a manifest: byte-identity with a CURRENT canonical
      // skill is itself the evidence, and the leftovers this flag exists for (the E-217
      // rename) sit in workspaces that have never been recorded. Without this the flag
      // could never do its job on a first run, which is the only run that matters.
      if (pruneKnown && current && canon.has(current)) {
        prune.push({ name, why: "byte-identical to a current canonical skill (--prune-known)" });
      } else {
        kept.push({ name, reason: "no manifest yet — first run prunes nothing" });
      }
      continue;
    }
    if (!recorded) {
      // Never written by sync: a user-authored skill. The case this design exists to
      // protect; absence from the source set is NOT evidence it is disposable.
      if (pruneKnown && current && canon.has(current)) {
        prune.push({ name, why: "byte-identical to a current canonical skill (--prune-known)" });
      } else {
        kept.push({ name, reason: "not written by sync (user-authored)" });
      }
      continue;
    }
    if (current !== recorded) {
      // Sync wrote it, but someone has edited it since. Their edit outranks our
      // bookkeeping — report it and move on.
      if (pruneKnown && current && canon.has(current)) {
        prune.push({ name, why: "byte-identical to a current canonical skill (--prune-known)" });
      } else {
        kept.push({ name, reason: "modified since sync wrote it" });
      }
      continue;
    }
    prune.push({ name, why: "written by sync, unmodified, no longer in the source set" });
  }
  return { prune, kept };
}

/** Managed entries in `dir` that sync provides (and therefore wrote) this run. */
export function recordableNames(dir, sourceNames) {
  const source = new Set(sourceNames);
  return listManaged(dir).filter((n) => source.has(n));
}

/**
 * E-282 (D-075 §Component 2): provision flat `.md` files (the `.claude/rules/` kind) from
 * `srcDir` into `dstDir` WITHOUT ever overwriting a file sync cannot prove it wrote.
 *
 * The agents copy is a plain `cp -f`, so a user's own `agents/foo.md` that shares a name
 * with a shipped one is replaced. Rules are user-authored by design (the docs invite a
 * team to write its own), so a same-named user rule must survive. A destination is
 * written only when it is ABSENT, already BYTE-IDENTICAL to the source, or still carries
 * the hash sync recorded for it (sync wrote it and nobody edited it since). Anything else
 * is kept and reported. Pruning then applies the E-220 evidence rules unchanged, and the
 * manifest records ONLY the names this call wrote — recording a kept user file would make
 * it prunable on the next run, the E-273 bug.
 */
export function provisionFlat(srcDir, dstDir, { prune = true } = {}) {
  mkdirSync(dstDir, { recursive: true });
  const manifest = readManifest(dstDir);
  const names = existsSync(srcDir) ? listManaged(srcDir).filter((n) => n.endsWith(".md")) : [];
  const written = [];
  const kept = [];
  for (const name of names) {
    const src = join(srcDir, name);
    const dst = join(dstDir, name);
    const want = hashEntry(srcDir, name);
    const cur = existsSync(dst) ? hashEntry(dstDir, name) : null;
    const ours = cur !== null && manifest?.entries?.[name] === cur;
    if (!existsSync(dst) || cur === want || ours) {
      if (cur !== want) copyFileSync(src, dst);
      written.push(name);
      continue;
    }
    kept.push({
      name,
      reason: manifest?.entries?.[name] ? "modified since sync wrote it" : "not written by sync (user-authored)",
    });
  }
  let pruned = [];
  if (prune) {
    const plan = planPrune(dstDir, names);
    pruned = plan.prune;
    for (const p of pruned) {
      try { rmSync(join(dstDir, p.name), { recursive: true, force: true }); } catch { /* best effort */ }
    }
    kept.push(...plan.kept);
  }
  writeManifest(dstDir, written);
  return { written, kept, pruned };
}

/** Hash of every current canonical skill across the given source dirs. */
export function canonicalHashSet(sourceDirs) {
  const hashes = [];
  for (const d of sourceDirs) {
    for (const n of listManaged(d)) {
      const h = hashEntry(d, n);
      if (h) hashes.push(h);
    }
  }
  return hashes;
}

// ── CLI: node sync-manifest.mjs <mode> <dir> [args] ──────────────────────────
// Modes:
//   record <dir>                                  — write the manifest for what is there now
//   plan   <dir> <sources.json> [--prune-known] [--canon <dirs.json>]
//   apply  <dir> <sources.json> [--prune-known] [--canon <dirs.json>]
// `plan` prints what would happen; `apply` performs the deletions. Both print one
// `PRUNE <name>` / `KEEP <name> — <reason>` line per entry so the shell caller can
// surface them without re-deriving anything.
// Compared on REAL paths (E-265): argv[1] may be spelled through a symlink (macOS
// /var → /private/var) while import.meta.url is resolved, and a raw comparison made this
// helper silently do nothing — no pruning, no manifest — under such a path.
const _isMain = (() => {
  try {
    if (!process.argv[1]) return false;
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (_isMain) {
  const [, , mode, dir, ...rest] = process.argv;
  if (!mode || !dir) {
    process.stderr.write("usage: sync-manifest.mjs <record|plan|apply> <dir> [sources.json] [--prune-known] [--canon <dirs.json>]\n");
    process.exit(2);
  }
  // provision <srcDir> <dstDir> [--no-prune] — E-282 flat-file provisioning (see provisionFlat).
  if (mode === "provision") {
    const dst = rest.find((a) => !a.startsWith("--"));
    if (!dst) {
      process.stderr.write("usage: sync-manifest.mjs provision <srcDir> <dstDir> [--no-prune]\n");
      process.exit(2);
    }
    const r = provisionFlat(dir, dst, { prune: !rest.includes("--no-prune") });
    for (const n of r.written) process.stdout.write(`WROTE ${n}\n`);
    for (const k of r.kept) process.stdout.write(`KEEP ${k.name} — ${k.reason}\n`);
    for (const p of r.pruned) process.stdout.write(`PRUNE ${p.name} — ${p.why}\n`);
    process.exit(0);
  }
  if (mode === "record") {
    const n = writeManifest(dir, listManaged(dir));
    process.stdout.write(`RECORDED ${n}\n`);
    process.exit(0);
  }
  // Parse positionally rather than by exclusion. The first cut used a `find` that tried
  // to skip the --canon VALUE and, when --canon was absent, excluded the sources file
  // itself — so sourceNames came back EMPTY and every managed entry looked "no longer in
  // the source set". That is the one bug this feature must never have: it pruned skills
  // that were still canonical. Caught by the acceptance probe asserting a present skill
  // survives, which is why that assertion exists alongside the deletion ones.
  let sourcesFile = null;
  let pruneKnown = false;
  let canonFile = null;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === "--prune-known") { pruneKnown = true; continue; }
    if (a === "--canon") { canonFile = rest[++i] ?? null; continue; }
    if (a.startsWith("--")) continue;
    if (sourcesFile === null) sourcesFile = a;
  }
  let sourceNames = [];
  if (sourcesFile && existsSync(sourcesFile)) {
    try {
      const parsed = JSON.parse(readFileSync(sourcesFile, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("source list must be an array");
      sourceNames = parsed;
    } catch (e) {
      // An unreadable source list means we cannot tell what is still canonical. Refuse
      // rather than prune against an empty set.
      process.stderr.write(`sync-manifest: unreadable source list (${e.message}) — refusing to prune.\n`);
      process.exit(3);
    }
  } else if (mode === "apply" || mode === "plan") {
    process.stderr.write("sync-manifest: no source list given — refusing to prune.\n");
    process.exit(3);
  }
  let canonicalHashes = [];
  if (canonFile && existsSync(canonFile)) {
    canonicalHashes = canonicalHashSet(JSON.parse(readFileSync(canonFile, "utf8")));
  }
  const { prune, kept } = planPrune(dir, sourceNames, { pruneKnown, canonicalHashes });
  for (const k of kept) process.stdout.write(`KEEP ${k.name} — ${k.reason}\n`);
  for (const p of prune) {
    process.stdout.write(`PRUNE ${p.name} — ${p.why}\n`);
    if (mode === "apply") {
      try { rmSync(join(dir, p.name), { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  // Record only what sync WROTE — the entries the current sources provide. Recording
  // everything present (as this did until E-273) put a user-authored skill into the
  // manifest on the first run, and on the SECOND run it satisfied all three conditions
  // ("in the manifest, unmodified, not in the source set") and was deleted: the exact
  // data loss this file exists to prevent, one sync late.
  if (mode === "apply") writeManifest(dir, recordableNames(dir, sourceNames));
  process.exit(0);
}
