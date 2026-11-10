#!/usr/bin/env node
// release-manifest.mjs — `rein release manifest` and `rein release verify` (E-418; D-153 r2,
// D-153 addendum, D-155 r1-r2; .ai/blueprints/release-artifact.md §Component 2, §Data Model).
//
//   node release-manifest.mjs manifest <tree> [--out <dir>] [--no-tarball] --pubkey <file>
//   node release-manifest.mjs verify <tarball>
//
// `manifest` reads a stage (`rein release stage`) and writes manifest.json, schema 1 in its
// canonical form, and rein-<version>.tar.gz (ustar via release-tar.mjs, never the host tar).
// A path a release must not carry is refused, named, exit 3. `verify` checks a tarball
// against the manifest inside it: exit 0 match, 3 mismatch (first five paths), 2 usage.
// node: modules only; runnable from a checkout. The version is the checkout's package.json.

import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_GENERATED, MIRRORED, OPERATOR_OWNED, operatorOwned } from "./release-layout.mjs";
import { readTarGz, TarError, ustarSplit, writeTarGz } from "./release-tar.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export class ReleaseRefusal extends Error {
  constructor(refusals) {
    super(refusals.map((r) => (r.kind === "case" ? `${r.path} and ${r.other}: a case collision` : `${r.path}: ${r.reason}`)).join("\n"));
    this.refusals = refusals;
  }
}

/** The key id of a minisign public key file, as minisign prints it (16 upper-case hex). */
export function keyIdFromPubkey(text) {
  for (const line of String(text).split("\n")) {
    const s = line.trim();
    if (!/^[A-Za-z0-9+/]+=*$/.test(s)) continue;
    const b = Buffer.from(s, "base64");
    if (b.length === 42 && b[0] === 0x45 && b[1] === 0x64) {
      return Buffer.from(b.subarray(2, 10)).reverse().toString("hex").toUpperCase();
    }
  }
  throw new Error("not a minisign Ed25519 public key");
}

/** "22.5" → "22.5.0", from the tree's shared/node-version.sh (REIN_NODE_FLOOR). */
export function minNodeFromTree(tree) {
  let src;
  try {
    src = readFileSync(join(tree, "shared", "node-version.sh"), "utf8");
  } catch {
    throw new ReleaseRefusal([{ path: "shared/node-version.sh", reason: "missing — the stage is incomplete" }]);
  }
  const m = /^REIN_NODE_FLOOR="([0-9]+(?:\.[0-9]+){0,2})"/m.exec(src);
  if (!m) throw new ReleaseRefusal([{ path: "shared/node-version.sh", reason: "no REIN_NODE_FLOOR" }]);
  const parts = m[1].split(".");
  while (parts.length < 3) parts.push("0");
  return parts.join(".");
}

export function checkoutVersion(root = resolve(HERE, "..", "..")) {
  const v = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$/.test(String(v))) throw new Error(`package.json version '${v}' is not semver`);
  return v;
}

export function nameProblem(rel) {
  const segs = rel.split("/");
  if (segs.some((s) => s === ".." || s === "." || s === "")) return "a '..', '.' or empty path segment";
  if (rel.includes("\\")) return "a backslash in the name";
  if (/[\u0000-\u001f\u007f]/.test(rel)) return "a control character in the name";
  // D-155 addendum 3 r3: printable ASCII only, so a case fold is 26 letters in every reader.
  if (/[^\u0020-\u007e]/.test(rel)) return "a character outside printable ASCII (0x20-0x7E)";
  if (!ustarSplit(rel)) return "a name longer than a ustar header holds (100 + 155)";
  if (INSTALL_GENERATED.includes(rel)) return "install-generated on the installing host, never shipped";
  return null;
}

/**
 * D-155 addendum 3 r1-r2: pairs of names a case-insensitive volume (default macOS APFS) would hold
 * as one — equal after lowering A-Z, different in bytes. Every path and every directory prefix of
 * it is a name, so a file beside a directory of the same folded name, and two directories that
 * differ in case, collide too. → [[a, b], …], each pair once, in input order.
 */
export function caseCollisions(paths) {
  const seen = new Map();  // folded name → the first spelling met
  const pairs = [];
  const reported = new Set();
  for (const p of paths) {
    const segs = p.split("/");
    for (let i = 1; i <= segs.length; i++) {
      const name = segs.slice(0, i).join("/");
      const fold = name.replace(/[A-Z]/g, (c) => c.toLowerCase());
      const first = seen.get(fold);
      if (first === undefined) seen.set(fold, name);
      else if (first !== name && !reported.has(fold)) { reported.add(fold); pairs.push([first, name]); }
    }
  }
  return pairs;
}

/**
 * D-155 addendum 3 r8: a shipped path that matches a layout.operator_owned pattern only after
 * lowering A-Z in both would, on a case-insensitive home, overwrite (and a later release prune)
 * what the operator or the install owns — shared/Toolchain.sh over shared/toolchain.sh. An exact
 * match is unchanged (a shipped path wins over a pattern). → [[path, pattern], …]
 */
export function ownedCaseCollisions(paths, patterns = OPERATOR_OWNED) {
  const fold = (x) => x.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const out = [];
  for (const p of paths) {
    for (const pat of patterns) {
      if (!operatorOwned(p, [pat]) && operatorOwned(fold(p), [fold(pat)])) { out.push([p, pat]); break; }
    }
  }
  return out;
}

const byteOrder = (a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8"));

/** Every file under `tree` with its bytes, or ReleaseRefusal naming each path that cannot ship. */
export function collectTree(tree) {
  const refusals = [];
  const files = [];
  const walk = (abs, rel) => {
    for (const name of readdirSync(abs).sort()) {
      const r = `${rel}/${name}`;
      const p = join(abs, name);
      const bad = nameProblem(r);
      if (bad) { refusals.push({ path: r, reason: bad }); continue; }
      const st = lstatSync(p);
      if (st.isSymbolicLink()) refusals.push({ path: r, reason: "a symbolic link" });
      else if (st.isDirectory()) walk(p, r);
      else if (!st.isFile()) refusals.push({ path: r, reason: "not a regular file" });
      else if (st.nlink > 1) refusals.push({ path: r, reason: "a hard link (link count > 1)" });
      else {
        const exec = (st.mode & 0o100) !== 0 || r === "bin/rein" || /^hooks\/[^/]+\.sh$/.test(r);
        files.push({ path: r, mode: exec ? "0755" : "0644", data: readFileSync(p) });
      }
    }
  };
  for (const top of readdirSync(tree).sort()) {
    const st = lstatSync(join(tree, top));
    if (!MIRRORED.includes(top)) refusals.push({ path: top, reason: "a top-level entry outside layout.mirrored" });
    else if (st.isSymbolicLink() || !st.isDirectory()) refusals.push({ path: top, reason: "a mirrored entry that is not a directory" });
    else walk(join(tree, top), top);
  }
  for (const [a, b] of caseCollisions(files.map((f) => f.path))) refusals.push({ path: a, other: b, kind: "case" });
  for (const [a, pat] of ownedCaseCollisions(files.map((f) => f.path))) refusals.push({ path: a, other: pat, kind: "case" });
  if (refusals.length) throw new ReleaseRefusal(refusals);
  return files.sort(byteOrder);
}

/** The manifest object (schema 1, keys in canonical order) and its canonical text. */
export function buildManifest(files, { version, minNode, keyId }) {
  const manifest = {
    schema: 1,
    version,
    min_node: minNode,
    key_id: keyId,
    layout: { mirrored: [...MIRRORED], operator_owned: [...OPERATOR_OWNED] },
    files: files.map((f) => ({
      path: f.path,
      sha256: createHash("sha256").update(f.data).digest("hex"),
      size: f.data.length,
      mode: f.mode,
    })),
  };
  return { manifest, text: JSON.stringify(manifest, null, 2) + "\n" };
}

export function buildTarball(files, manifestText, mtime = 0) {
  const members = [{ path: "manifest.json", mode: 0o644, data: Buffer.from(manifestText, "utf8") }];
  for (const f of files) members.push({ path: f.path, mode: parseInt(f.mode, 8), data: f.data });
  return writeTarGz(members, mtime);
}

/** { findings: [{path, reason}], count } for a tarball's bytes; findings empty means match. */
export function verifyTarball(gz) {
  let members;
  try {
    members = readTarGz(gz);
  } catch (e) {
    if (e instanceof TarError) return { findings: [{ path: e.path, reason: e.reason }], count: 0 };
    throw e;
  }
  if (!members.length || members[0].path !== "manifest.json") {
    return { findings: [{ path: members[0]?.path ?? "<archive>", reason: "the first member is not manifest.json" }], count: 0 };
  }
  let manifest;
  try {
    manifest = JSON.parse(members[0].data.toString("utf8"));
  } catch {
    return { findings: [{ path: "manifest.json", reason: "not JSON" }], count: 0 };
  }
  if (manifest?.schema !== 1 || !Array.isArray(manifest.files)) {
    return { findings: [{ path: "manifest.json", reason: `schema ${manifest?.schema} is not 1` }], count: 0 };
  }
  const listed = new Map(manifest.files.map((f) => [f.path, f]));
  const seen = new Set();
  const findings = [];
  for (const m of members.slice(1)) {
    const f = listed.get(m.path);
    if (seen.has(m.path)) { findings.push({ path: m.path, reason: "a second member with this name" }); continue; }
    seen.add(m.path);
    if (!f) { findings.push({ path: m.path, reason: "a member the manifest does not list" }); continue; }
    const mode = m.mode.toString(8).padStart(4, "0");
    const sha = createHash("sha256").update(m.data).digest("hex");
    if (m.size !== f.size) findings.push({ path: m.path, reason: `size ${m.size}, manifest says ${f.size}` });
    else if (sha !== f.sha256) findings.push({ path: m.path, reason: "sha256 differs from the manifest" });
    else if (mode !== f.mode) findings.push({ path: m.path, reason: `mode ${mode}, manifest says ${f.mode}` });
  }
  for (const f of manifest.files) if (!seen.has(f.path)) findings.push({ path: f.path, reason: "listed in the manifest, missing from the tarball" });
  return { findings, count: members.length - 1 };
}

function writeAtomic(path, data) {
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, data);
  renameSync(tmp, path);
}

const USAGE =
  "usage: rein release manifest <tree> [--out <dir>] [--no-tarball] --pubkey <file>\n" +
  "       rein release verify <tarball>";

function usage(msg) {
  process.stderr.write(`${msg ? `rein release: ${msg}\n` : ""}${USAGE}\n`);
  return 2;
}

function cmdManifest(args) {
  let tree, out = ".", pubkey, tarball = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--out" || a === "--pubkey") {
      const v = args[++i];
      if (!v) return usage(`${a} needs a value`);
      if (a === "--out") out = v; else pubkey = v;
    } else if (a === "--no-tarball") tarball = false;
    else if (a.startsWith("-") || tree) return usage(`unexpected argument '${a}'`);
    else tree = a;
  }
  if (!tree || !pubkey) return usage(tree ? "--pubkey <file> is required" : "a staged tree is required");
  const sde = process.env.SOURCE_DATE_EPOCH;
  if (sde !== undefined && sde !== "" && !/^[0-9]+$/.test(sde)) return usage(`SOURCE_DATE_EPOCH '${sde}' is not an integer`);
  let keyId, version;
  try {
    keyId = keyIdFromPubkey(readFileSync(pubkey, "utf8"));
  } catch (e) {
    return usage(`${pubkey}: ${e.code === "ENOENT" ? "no such file" : e.message}`);
  }
  try {
    version = checkoutVersion();
  } catch (e) {
    return usage(`cannot read the version from this checkout's package.json (${e.message})`);
  }
  let files, minNode;
  try {
    tree = realpathSync(tree);
    if (!lstatSync(tree).isDirectory()) return usage(`${tree} is not a directory`);
    minNode = minNodeFromTree(tree);
    files = collectTree(tree);
  } catch (e) {
    if (!(e instanceof ReleaseRefusal)) return usage(`${tree}: ${e.message}`);
    for (const r of e.refusals) {
      process.stderr.write(r.kind === "case" ? `[RELEASE_CASE_COLLISION] ${r.path} and ${r.other}\n` : `[RELEASE_PATH_REFUSED] ${r.path}: ${r.reason}\n`);
    }
    return 3;
  }
  const { text } = buildManifest(files, { version, minNode, keyId });
  mkdirSync(out, { recursive: true });
  writeAtomic(join(out, "manifest.json"), text);
  console.log(`✓ manifest.json — ${files.length} files, version ${version}, key_id ${keyId}`);
  if (tarball) {
    const name = `rein-${version}.tar.gz`;
    const gz = buildTarball(files, text, sde ? Number(sde) : 0);
    writeAtomic(join(out, name), gz);
    console.log(`✓ ${name} — sha256 ${createHash("sha256").update(gz).digest("hex")}`);
  }
  return 0;
}

function cmdVerify(args) {
  if (args.includes("--pubkey")) return usage("--pubkey: signature checking is not built yet (E-419)");
  if (args.length !== 1 || args[0].startsWith("-")) return usage();
  let gz;
  try {
    gz = readFileSync(args[0]);
  } catch (e) {
    return usage(`${args[0]}: ${e.code === "ENOENT" ? "no such file" : e.message}`);
  }
  console.log("signature not checked");
  const { findings, count } = verifyTarball(gz);
  if (!findings.length) {
    console.log(`✓ ${count} files match the manifest`);
    return 0;
  }
  for (const f of findings.slice(0, 5)) process.stderr.write(`[RELEASE_VERIFY_MISMATCH] ${f.path}: ${f.reason}\n`);
  if (findings.length > 5) process.stderr.write(`  … and ${findings.length - 5} more\n`);
  return 3;
}

/**
 * E-420 (D-155 r4, addendum r2; release-artifact.md §Component 4): an unpacked artifact under
 * the Rein home against its manifest.json. "incomplete" when the manifest is unreadable, not
 * schema 1, or its version differs from VERSION (or there is none); "mismatch" when a listed
 * file is missing, not a regular file, or differs in size or sha256. With fixModes, a file
 * whose mode differs is chmod'ed to the manifest's mode (step 1). Read-only otherwise.
 */
// What artifact mode sources or runs before (or as) the gate: each must be listed and match
// (security_engineer E-420 F5). bin/ and hooks/ may hold nothing the manifest does not list.
export const INSTALL_REQUIRED = Object.freeze([
  "bin/rein", "shared/install-finalize.sh", "shared/node-version.sh", "shared/toolchain-record.sh",
  "shared/release-manifest.mjs", "shared/release-tar.mjs", "shared/release-layout.mjs", "shared/gate-pins.mjs",
  "hooks/pre-tool-use.sh", "hooks/session-start.sh", "hooks/pre-commit.sh",
]);
const SEALED_DIRS = ["bin", "hooks"];

export function checkInstalled(rein, { fixModes = false } = {}) {
  let manifest, version = null, base;
  try {
    version = readFileSync(join(rein, "VERSION"), "utf8").split("\n")[0].trim() || null;
  } catch { /* no VERSION */ }
  try {
    base = realpathSync(rein);
    manifest = JSON.parse(readFileSync(join(base, "manifest.json"), "utf8"));
  } catch {
    manifest = null;
  }
  const q = (v) => JSON.stringify(v ?? null);  // never print a manifest value raw (F3)
  const said = manifest ? (manifest.schema === 1 ? q(manifest.version) : `schema ${q(manifest.schema)}`) : "nothing readable";
  if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.files) || manifest.version !== version) {
    return { status: "incomplete", message: `manifest.json says ${said}, VERSION says ${q(version)} — the release was not fully unpacked; reinstall it` };
  }
  if (typeof manifest.key_id !== "string" || !/^[0-9A-F]{16}$/i.test(manifest.key_id)) {  // F2
    return { status: "incomplete", message: `manifest.json key_id ${q(manifest.key_id)} is not 16 hex digits — reinstall the release` };
  }
  const findings = [];
  const servers = new Set();
  const listed = new Set();
  const toChmod = [];
  for (const f of manifest.files) {
    const path = f?.path;
    if (typeof path !== "string" || nameProblem(path) || !MIRRORED.includes(path.split("/")[0])) {  // F4
      findings.push(`${q(path)}: not a path a release may carry`);
      continue;
    }
    listed.add(path);
    const m = /^mcp\/([^/]+)\//.exec(path);
    if (m) servers.add(m[1]);
    const p = join(base, path);
    let st;
    try { st = lstatSync(p); } catch { findings.push(`${path}: missing`); continue; }
    if (!st.isFile()) { findings.push(`${path}: not a regular file`); continue; }
    // F1: the file itself, under the home — no symlinked parent, no second name for the inode.
    let real;
    try { real = realpathSync(p); } catch { real = null; }
    if (real !== p) { findings.push(`${path}: reached through a symbolic link`); continue; }
    if (st.nlink !== 1) { findings.push(`${path}: a hard link (link count ${st.nlink})`); continue; }
    if (st.size !== f.size) { findings.push(`${path}: size ${st.size}, manifest says ${q(f.size)}`); continue; }
    if (createHash("sha256").update(readFileSync(p)).digest("hex") !== f.sha256) { findings.push(`${path}: sha256 differs from the manifest`); continue; }
    if ((f.mode === "0755" || f.mode === "0644") && (st.mode & 0o7777) !== parseInt(f.mode, 8)) toChmod.push({ p, st, mode: parseInt(f.mode, 8) });
  }
  for (const r of INSTALL_REQUIRED) if (!listed.has(r)) findings.push(`${r}: required by the install, not listed in the manifest`);
  for (const d of SEALED_DIRS) {
    let names = [];
    try { names = readdirSync(join(base, d)); } catch { /* absent: the required list says so */ }
    for (const n of names) if (!listed.has(`${d}/${n}`)) findings.push(`${d}/${n}: present but not listed in the manifest`);
  }
  // F6: modes only once everything matches; F1: through a no-follow fd that is the file checked.
  if (fixModes && !findings.length) {
    for (const { p, st, mode } of toChmod) {
      const fd = openSync(p, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const now = fstatSync(fd);
        if (now.ino !== st.ino || now.dev !== st.dev) { findings.push(`${p.slice(base.length + 1)}: replaced during the check`); continue; }
        fchmodSync(fd, mode);
      } finally {
        closeSync(fd);
      }
    }
  }
  const out = { version, keyId: manifest.key_id, count: manifest.files.length, servers: [...servers].sort(), findings };
  return { status: findings.length ? "mismatch" : "ok", ...out };
}

// `installed <rein> [--check-only]`: exit 0 and "version|key_id|count|server\t…" lines on
// stdout; 3 with [INSTALL_INCOMPLETE] or [INSTALL_TREE_MISMATCH] (first five named) on stderr.
function cmdInstalled(args) {
  const checkOnly = args.includes("--check-only");
  const rest = args.filter((a) => a !== "--check-only");
  if (rest.length !== 1) return usage("installed <rein-home> [--check-only]");
  const r = checkInstalled(rest[0], { fixModes: !checkOnly });
  if (r.status === "incomplete") {
    process.stderr.write(`[INSTALL_INCOMPLETE] ${r.message}\n`);
    return 3;
  }
  if (r.status === "mismatch") {
    process.stderr.write(`[INSTALL_TREE_MISMATCH] ${r.findings.length} file(s) differ from the manifest — reinstall the release\n`);
    for (const f of r.findings.slice(0, 5)) process.stderr.write(`  ${f}\n`);
    return 3;
  }
  console.log(`version\t${r.version}\nkey_id\t${r.keyId}\ncount\t${r.count}`);
  for (const s of r.servers) console.log(`server\t${s}`);
  return 0;
}

export function main(argv) {
  const [sub, ...rest] = argv;
  if (sub === "manifest") return cmdManifest(rest);
  if (sub === "verify") return cmdVerify(rest);
  if (sub === "installed") return cmdInstalled(rest);
  return usage(sub ? `unknown subcommand '${sub}'` : "");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
