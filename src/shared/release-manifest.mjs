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
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { INSTALL_GENERATED, MIRRORED, OPERATOR_OWNED } from "./release-layout.mjs";
import { readTarGz, TarError, ustarSplit, writeTarGz } from "./release-tar.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export class ReleaseRefusal extends Error {
  constructor(refusals) {
    super(refusals.map((r) => `${r.path}: ${r.reason}`).join("\n"));
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
  if (!ustarSplit(rel)) return "a name longer than a ustar header holds (100 + 155)";
  if (INSTALL_GENERATED.includes(rel)) return "install-generated on the installing host, never shipped";
  return null;
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
    for (const r of e.refusals) process.stderr.write(`[RELEASE_PATH_REFUSED] ${r.path}: ${r.reason}\n`);
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

export function main(argv) {
  const [sub, ...rest] = argv;
  if (sub === "manifest") return cmdManifest(rest);
  if (sub === "verify") return cmdVerify(rest);
  return usage(sub ? `unknown subcommand '${sub}'` : "");
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
