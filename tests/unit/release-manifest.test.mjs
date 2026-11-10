// release-manifest.test.mjs — the release manifest, the ustar writer/reader and the keyless
// verify (E-418; D-153 r2, D-153 addendum, D-155 r1-r2; release-artifact.md §Component 2,
// §Data Model). New: there was no release artifact before E-418. The operator_owned matcher
// runs over tests/fixtures/release/operator-owned-cases.json (one table, D-088). The process
// boundary (stage → manifest → verify, determinism) is the E-418.03 contract row in
// mirror_hygiene_test.sh, beside the E-417 stage rows it extends.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const { installerAction, operatorOwned } = await import(resolve(repo, "src/shared/release-layout.mjs"));
const { readTarGz, writeTarGz } = await import(resolve(repo, "src/shared/release-tar.mjs"));
const M = await import(resolve(repo, "src/shared/release-manifest.mjs"));
const table = JSON.parse(readFileSync(resolve(repo, "tests/fixtures/release/operator-owned-cases.json"), "utf8"));

const tmp = mkdtempSync(join(tmpdir(), "rein-t-release-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));
let n = 0;
function tree(files) {  // { "bin/rein": "x", … } → a fresh tree dir
  const root = join(tmp, `t${n++}`);
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}
const refusedPaths = (root) => {
  try { M.collectTree(root); return []; } catch (e) { assert.ok(e instanceof M.ReleaseRefusal, e.message); return e.refusals.map((r) => r.path); }
};

test("E-418.01: operator_owned decides kept / replaced / deleted over the fixture table", () => {
  assert.ok(table.cases.length >= 20, "the table is not empty");
  for (const c of table.cases) {
    assert.equal(installerAction(c.path, c.shipped === "yes"), c.expected, `${c.path} (${c.label})`);
  }
  for (const g of table.glob_cases) assert.equal(operatorOwned(g.path, [g.pattern]), g.match, `${g.pattern} ~ ${g.path} (${g.label})`);
});

test("E-418.02: each path a release must not carry is refused, named", () => {
  const ok = { "bin/rein": "#!/bin/bash\n", "shared/node-version.sh": 'REIN_NODE_FLOOR="22.5"\n' };
  assert.deepEqual(refusedPaths(tree(ok)), [], "a clean tree is not refused");
  assert.deepEqual(refusedPaths(tree({ ...ok, "notes.txt": "x" })), ["notes.txt"], "top-level entry outside layout.mirrored");
  assert.deepEqual(refusedPaths(tree({ ...ok, "config/rein-workspace.txt": "/x\n" })), ["config/rein-workspace.txt"]);
  assert.deepEqual(refusedPaths(tree({ ...ok, "config/install-stamp.json": "{}" })), ["config/install-stamp.json"]);
  assert.deepEqual(refusedPaths(tree({ ...ok, "shared/toolchain.sh": "x" })), ["shared/toolchain.sh"]);
  assert.deepEqual(refusedPaths(tree({ ...ok, "shared/a\\b": "x" })), ["shared/a\\b"], "backslash");
  assert.deepEqual(refusedPaths(tree({ ...ok, "shared/a\u0001b": "x" })), ["shared/a\u0001b"], "control character");
  const long = `shared/${"n".repeat(101)}`;
  assert.deepEqual(refusedPaths(tree({ ...ok, [long]: "x" })), [long], "a segment no ustar split holds");
  const sym = tree(ok); symlinkSync("rein", join(sym, "bin", "link"));
  assert.deepEqual(refusedPaths(sym), ["bin/link"], "symlink");
  const hard = tree(ok); linkSync(join(hard, "bin", "rein"), join(hard, "bin", "rein2"));
  assert.deepEqual(refusedPaths(hard).sort(), ["bin/rein", "bin/rein2"], "hard link pair");
  assert.match(M.nameProblem(["shared", "..", "x"].join("/")), /'\.\.'/, "a dot-dot segment");
});

test("E-418.03: the manifest is schema 1 in canonical form; mode by the stated rule; key_id from the key file", () => {
  // C, not B beside b: a macOS volume is case-insensitive and would hold one file.
  const root = tree({
    "shared/b.mjs": "b", "shared/a.mjs": "a", "shared/C.mjs": "C", "hooks/x.sh": "h", "bin/rein": "r",
    "shared/node-version.sh": 'REIN_NODE_FLOOR="22.5"\n',
  });
  const files = M.collectTree(root);
  const keyId = M.keyIdFromPubkey(readFileSync(resolve(repo, "docs/contract/release-key.pub"), "utf8"));
  assert.equal(keyId, "5C9C75A7C8FA8056", "as minisign prints it in the key file's comment");
  const { manifest, text } = M.buildManifest(files, { version: "0.5.0", minNode: M.minNodeFromTree(root), keyId });
  assert.deepEqual(Object.keys(manifest), ["schema", "version", "min_node", "key_id", "layout", "files"]);
  assert.equal(manifest.min_node, "22.5.0");
  assert.equal(manifest.layout.operator_owned.length, 14);
  assert.deepEqual(manifest.files.map((f) => f.path), ["bin/rein", "hooks/x.sh", "shared/C.mjs", "shared/a.mjs", "shared/b.mjs", "shared/node-version.sh"], "bytewise order (upper case first)");
  assert.deepEqual(Object.keys(manifest.files[0]), ["path", "sha256", "size", "mode"]);
  assert.equal(manifest.files.find((f) => f.path === "bin/rein").mode, "0755");
  assert.equal(manifest.files.find((f) => f.path === "hooks/x.sh").mode, "0755");
  assert.equal(manifest.files.find((f) => f.path === "shared/a.mjs").mode, "0644");
  assert.ok(text.endsWith("}\n") && !text.endsWith("\n\n") && text.startsWith('{\n  "schema": 1,'), "two-space indent, one trailing newline");
  assert.equal(M.buildTarball(files, text).compare(M.buildTarball(files, text)), 0, "the same input gives the same bytes");
});

// A good tarball, then each way verify must catch.
const goodFiles = M.collectTree(tree({ "bin/rein": "#!/bin/bash\necho rein\n", "shared/x.mjs": "x\n", "shared/node-version.sh": 'REIN_NODE_FLOOR="22.5"\n' }));
const goodText = M.buildManifest(goodFiles, { version: "0.5.0", minNode: "22.5.0", keyId: "0000000000000000" }).text;
const members = () => [{ path: "manifest.json", mode: 0o644, data: Buffer.from(goodText) },
  ...goodFiles.map((f) => ({ path: f.path, mode: parseInt(f.mode, 8), data: f.data }))];
const reasons = (gz) => M.verifyTarball(gz).findings.map((f) => `${f.path}: ${f.reason}`);

test("E-418.04: verify — a matching tarball passes; tampered, extra, missing and symlink members fail", () => {
  const good = writeTarGz(members());
  assert.deepEqual(reasons(good), []);
  assert.equal(M.verifyTarball(good).count, goodFiles.length);
  const tampered = members().map((m) => (m.path === "shared/x.mjs" ? { ...m, data: Buffer.from("y\n") } : m));
  assert.match(reasons(writeTarGz(tampered)).join("\n"), /^shared\/x\.mjs: sha256 differs/m, "tampered member");
  assert.match(reasons(writeTarGz([...members(), { path: "shared/extra.mjs", mode: 0o644, data: Buffer.from("e") }])).join("\n"),
    /^shared\/extra\.mjs: a member the manifest does not list/m, "extra member");
  assert.match(reasons(writeTarGz(members().filter((m) => m.path !== "shared/x.mjs"))).join("\n"),
    /^shared\/x\.mjs: listed in the manifest, missing/m, "missing member");
  const chmod = members().map((m) => (m.path === "bin/rein" ? { ...m, mode: 0o644 } : m));
  assert.match(reasons(writeTarGz(chmod)).join("\n"), /^bin\/rein: mode 0644, manifest says 0755/m, "mode");
  // A symlink member: the writer cannot emit one, so flip a header's typeflag to "2".
  const tar = Buffer.from(gunzipSync(good));
  const second = 512 + Math.ceil(goodText.length / 512) * 512;
  tar[second + 156] = 0x32;
  tar.fill(0x20, second + 148, second + 156);
  let sum = 0; for (let i = second; i < second + 512; i++) sum += tar[i];
  tar.write(sum.toString(8).padStart(6, "0") + "\0 ", second + 148, "ascii");
  assert.match(reasons(gzipSync(tar)).join("\n"), /^bin\/rein: member type '2' is not a regular file/m, "symlink member");
  const reordered = members(); reordered.push(reordered.shift());
  assert.match(reasons(writeTarGz(reordered)).join("\n"), /the first member is not manifest\.json/, "manifest.json first");
});

test("E-418.05: the reader returns exactly what the writer wrote", () => {
  const read = readTarGz(writeTarGz(members(), 1700000000));
  assert.deepEqual(read.map((m) => [m.path, m.mode, m.mtime, m.data.toString()]),
    members().map((m) => [m.path, m.mode, 1700000000, m.data.toString()]));
  const longPath = `shared/${"d".repeat(120)}/${"f".repeat(90)}`;
  assert.equal(readTarGz(writeTarGz([{ path: longPath, mode: 0o644, data: Buffer.from("z") }]))[0].path, longPath, "prefix + name split");
});
