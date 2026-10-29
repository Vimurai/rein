// memory-batch-scanner.test.mjs — E-75 Batch Scanner (src/shared/memory-batch-scanner.mjs, per
// .ai/blueprints/multimodal-rag-batching.md §Components 1 + §Security). Moved from
// tests/suites/memory_batch_scanner_test.sh (E-302, D-088: a pure module is tested in the unit
// layer); the T-MBS-S* ids and every assertion are unchanged.
//
//   - Walk discovers PNG/SVG/PDF candidates and prunes node_modules/.git/.rein
//   - Path-rule rejects (/.env/, /secrets/, /credentials/, /.ssh/, /.aws/, /.gnupg/)
//   - Sensitive-name regex rejects (secret*, *credential*, *.pem, id_rsa, etc.)
//   - .gitignore enforcement via batched `git check-ignore --stdin`
//   - [NO_RAG] sidecar file + inline SVG marker both reject
//   - 5 MB size cap rejects oversize files
//   - SHA-256 hashing skips files whose hash already lives in the palette index
//   - Privacy: only basenames + reason codes in `skipped` (no full paths)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir, homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCANNER = resolve(repo, "src/shared/memory-batch-scanner.mjs");
const SRC = readFileSync(SCANNER, "utf8");
const m = await import(SCANNER);

// ── T-MBS-S01: Source exports the documented surface ──
const surface = [
  ["scanner has node shebang", /^#!.*node/],
  ["scanWorkspace exported", /export function scanWorkspace/],
  ["computeFileSha256 exported", /export function computeFileSha256/],
  ["batchGitignoreCheck exported", /export function batchGitignoreCheck/],
  ["hasNoRagTag exported", /export function hasNoRagTag/],
  ["isSensitiveName exported", /export function isSensitiveName/],
  ["isPathExcluded exported", /export function isPathExcluded/],
  ["isSkippableDir exported", /export function isSkippableDir/],
  ["loadIndexedHashes exported", /export function loadIndexedHashes/],
  ["DEFAULT_MAX_BYTES pinned to 5 MB", /DEFAULT_MAX_BYTES.*5 \* 1024 \* 1024/],
  ["DEFAULT_EXTENSIONS pinned", /DEFAULT_EXTENSIONS = \[".png", ".svg", ".pdf"\]/],
  ["blueprint reference in comments", /multimodal-rag-batching\.md/],
  ["node:crypto imported", /from "node:crypto"/],
  ["node:child_process imported", /from "node:child_process"/],
];
test("T-MBS-S01: scanner file exists", () => assert.ok(existsSync(SCANNER)));
for (const [label, re] of surface) {
  test(`T-MBS-S01: ${label}`, () => assert.match(label.includes("shebang") ? SRC.split("\n")[0] : SRC, re));
}

// ── T-MBS-S02: a synthetic project with eligible + ineligible files ──
let SBOX, PROJ, scan, h1;
const put = (rel, body) => { const p = join(PROJ, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
before(() => {
  SBOX = mkdtempSync(join(tmpdir(), "rein-t-mbs-"));
  PROJ = join(SBOX, "proj");
  mkdirSync(PROJ);
  // A real git repo so check-ignore works.
  execFileSync("git", ["-C", PROJ, "init", "-q"]);
  // Eligible: in-tree PNG/SVG/PDF.
  put("diagrams/c4-context.png", Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\nFAKE-PNG-1")]));
  put("ux/login-mockup.svg", '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
  put("docs/erd-overview.pdf", "%PDF-1.4\nFAKE-PDF");
  // Path-rule rejects: .env/, secrets/, credentials/, .ssh/, .aws/.
  put(".env/leaky.png", "PNG-IN-DOTENV");
  put("secrets/diagram.svg", "SVG-IN-SECRETS");
  put("credentials/badge.pdf", "PDF-IN-CREDENTIALS");
  put(".ssh/keymap.png", "PNG-IN-SSH");
  put(".aws/topology.svg", "SVG-IN-AWS");
  // Sensitive-name rejects (regardless of directory).
  put("diagrams/secret-handshake.png", "BAD-NAME-1");
  put("ux/password-reset-screen.svg", "BAD-NAME-2");
  put("docs/id_rsa-backup.pdf", "BAD-NAME-3");
  put("diagrams/staging.pem", "BAD-NAME-4");   // skipped by the extension filter anyway
  // .gitignore: ignore everything in private/.
  put(".gitignore", "private/\n");
  put("private/wireframe.png", "GITIGNORED-PNG");
  // [NO_RAG] sidecar PNG + inline SVG marker.
  put("diagrams/internal-only.png", "PNG-WITH-SIDECAR");
  put("diagrams/internal-only.png.norag", "marker");
  put("ux/internal-flow.svg", '<svg xmlns="http://www.w3.org/2000/svg"><!-- [NO_RAG] --><rect/></svg>');
  // Oversized file (> 5 MB).
  put("diagrams/oversize.png", Buffer.alloc(6 * 1024 * 1024));
  // The walker must NOT descend node_modules / .rein — a media file in each proves the prune.
  put("node_modules/some-pkg/diagram.png", "NM-PNG");
  put(".rein/cache/cached-render.svg", "REIN-SVG");
  // Outside the recognised extensions — never enters the scan.
  put("diagrams/README.md", "unrelated");
  put("docs/notes.txt", "unrelated");
  scan = m.scanWorkspace(PROJ);
  h1 = m.computeFileSha256(join(PROJ, "diagrams/c4-context.png"));
});
after(() => { if (SBOX) rmSync(SBOX, { recursive: true, force: true }); });

test("T-MBS-S02: fixture has the expected media-file footprint", () => {
  const out = execFileSync("find", [PROJ, "-type", "f", "(", "-name", "*.png", "-o", "-name", "*.svg", "-o", "-name", "*.pdf", ")"], { encoding: "utf8" });
  assert.ok(out.trim().split("\n").length >= 12);
});

// ── T-MBS-S03: scanWorkspace eligibility set ──
test("T-MBS-S03: exactly 3 eligible files (PNG + SVG + PDF)", () => assert.equal(scan.eligible.length, 3));
for (const name of ["c4-context.png", "login-mockup.svg", "erd-overview.pdf"]) {
  test(`T-MBS-S03: eligible includes ${name}`, () => assert.ok(scan.eligible.map((e) => basename(e.path)).includes(name)));
}

// ── T-MBS-S04: skipped entries carry the right reason codes ──
const reasons = [
  ["leaky.png", "path-rule"], ["diagram.svg", "path-rule"], ["badge.pdf", "path-rule"],
  ["keymap.png", "path-rule"], ["topology.svg", "path-rule"],
  ["secret-handshake.png", "sensitive-name"], ["password-reset-screen.svg", "sensitive-name"],
  ["id_rsa-backup.pdf", "sensitive-name"], ["wireframe.png", "gitignored"],
  ["internal-only.png", "no-rag-tag"], ["internal-flow.svg", "no-rag-tag"], ["oversize.png", "size-cap"],
];
for (const [fname, reason] of reasons) {
  test(`T-MBS-S04: skipped[basename=${fname}] reason=${reason}`, () =>
    assert.ok(scan.skipped.some((s) => s.basename === fname && s.reason === reason)));
}

// ── T-MBS-S05: privacy — skipped entries surface basename only (no full paths) ──
test("T-MBS-S05: no skipped entry contains a '/' character in basename", () =>
  assert.ok(!scan.skipped.some((s) => (s.basename || "").includes("/"))));
test("T-MBS-S05: no skipped entry includes the sandbox SBOX path", () =>
  assert.ok(!scan.skipped.some((s) => JSON.stringify(s).includes(SBOX))));

// ── T-MBS-S06: pruned directories never enter the candidate list ──
const allNames = () => [...scan.eligible.map((e) => basename(e.path)), ...scan.skipped.map((s) => s.basename || "")];
test("T-MBS-S06: node_modules diagram.png NOT in eligible+skipped", () => assert.ok(!allNames().includes("diagram.png")));
test("T-MBS-S06: .rein cached-render.svg NOT in scan output", () => assert.ok(!allNames().includes("cached-render.svg")));

// ── T-MBS-S07: computeFileSha256 is deterministic; already-indexed dedup works ──
const hashCli = (f) => spawnSync(process.execPath, [SCANNER, "--hash", f], { encoding: "utf8" });
test("T-MBS-S07: hash is non-empty + 64 hex chars", () =>
  assert.match(hashCli(join(PROJ, "diagrams/c4-context.png")).stdout.trim(), /^[0-9a-f]{64}$/));
test("T-MBS-S07: two reads produce identical hashes", () => {
  const f = join(PROJ, "diagrams/c4-context.png");
  assert.equal(hashCli(f).stdout, hashCli(f).stdout);
});
test("T-MBS-S07: c4-context.png moves to skipped[reason=already-indexed]", () => {
  const r = m.scanWorkspace(PROJ, { indexedHashes: new Set([h1]) });
  assert.ok(r.skipped.some((s) => s.basename === "c4-context.png" && s.reason === "already-indexed"));
});
test("T-MBS-S07: eligible count drops by exactly 1 after dedup", () =>
  assert.equal(m.scanWorkspace(PROJ, { indexedHashes: new Set([h1]) }).eligible.length, 2));

// ── T-MBS-S08: loadIndexedHashes round-trips entries[].id from JSON ──
test("T-MBS-S08: loaded 2 hashes from real embeddings JSON", () => {
  const f = join(SBOX, "embeddings.json");
  writeFileSync(f, JSON.stringify({ version: 2, model: "test-embedding-model", entries: [
    { id: h1, department: "Architecture", vector: [0, 0, 0], indexed_at: "2026-01-01T00:00:00Z" },
    { id: "deadbeef", department: "UX", vector: [0, 0, 0], indexed_at: "2026-01-02T00:00:00Z" },
  ] }));
  assert.equal(m.loadIndexedHashes(f).size, 2);
});
test("T-MBS-S08: missing embeddings file → empty set", () =>
  assert.equal(m.loadIndexedHashes(join(SBOX, "does-not-exist.json")).size, 0));
test("T-MBS-S08: garbage embeddings file → empty set + no throw", () => {
  writeFileSync(join(SBOX, "garbage.json"), "not json {{{\n");
  assert.equal(m.loadIndexedHashes(join(SBOX, "garbage.json")).size, 0);
});

// ── T-MBS-S09: CLI flags: --scan / --hash / usage ──
test("T-MBS-S09: --scan exit code 0 on valid project root", () =>
  assert.equal(spawnSync(process.execPath, [SCANNER, "--scan", PROJ]).status, 0));
test("T-MBS-S09: --hash exit code 0 on valid file", () =>
  assert.equal(hashCli(join(PROJ, "diagrams/c4-context.png")).status, 0));
const usage = () => spawnSync(process.execPath, [SCANNER, "--bogus"], { encoding: "utf8" }).stderr;
test("T-MBS-S09: usage mentions --scan", () => assert.match(usage(), /--scan/));
test("T-MBS-S09: usage mentions --hash", () => assert.match(usage(), /--hash/));

// ── T-MBS-S10: a non-git project still scans (the gitignore gate returns an empty Set) ──
test("T-MBS-S10: non-git project emits the eligible file", () => {
  const p2 = join(SBOX, "not-a-git-repo");
  mkdirSync(join(p2, "img"), { recursive: true });
  writeFileSync(join(p2, "img/clean.png"), "PNG");
  assert.match(JSON.stringify(m.scanWorkspace(p2)), /clean\.png/);
});

// ── T-MBS-S11: ~/.rein mirror matches src (read-only; absent → skip) ──
const MIRROR = join(homedir(), ".rein/shared/memory-batch-scanner.mjs");
test("T-MBS-S11: mirror is byte-identical to src", { skip: !existsSync(MIRROR) && "mirror absent" }, () =>
  assert.equal(readFileSync(MIRROR, "utf8"), SRC));
