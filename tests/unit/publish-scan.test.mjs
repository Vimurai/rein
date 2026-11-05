// publish-scan.test.mjs — the four classes the public mirror refuses (E-364, D-117,
// licensing.md §Component 8), through scanText / scanFiles, the entry points E-362's audit and
// E-360's export call. New file: the scanner is new (nothing to extend). Every input below is
// invented — no real person, path or client.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync as _read, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname as _dirname, join, resolve as _resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ALLOWABLE_FILES, CLASSES, EXEMPT_FILES, checkAllow, decodedView, doctorLine, exportFiles, identityProblem, isExported, loadScanConfig, loginAdvisory, precommitProblems, scanFiles, scanText, treeGateProblems, treeProblems } from "../../src/shared/publish-scan.mjs";

const classes = (text, opts) => scanText(text, opts).map((h) => h.class);

const ROWS = [
  ["a personal address", "mail alice.smith@fastmail.fm today", ["personal_email"]],
  ["a reserved example domain is not personal", "dev-a@example.com t@sub.example.org x@y.test", []],
  ["the commit trailer's noreply address is allowed", "noreply@anthropic.com", []],
  ["a home path under /home", "cd /home/alice/projects/x", ["home_path"]],
  ["a home path under /Users", "open /Users/bob/Documents/y", ["home_path"]],
  ["a neutral placeholder user is not a person", "cd /Users/dev/x && ls /home/dev /home/runner", []],
  ["the literal /home/<user> pattern is documentation", "never commit /home/<user> paths", []],
  ["a session id", "session 3f2a9c10-4b7e-4d21-9a0f-1c2d3e4f5a6b ended", ["session_socket"]],
  ["the all-zero UUID is a placeholder", "id 00000000-0000-0000-0000-000000000000", []],
  ["a per-user runtime socket", "uds:/run/user/1000/cc-socks/1.sock", ["session_socket"]],
  ["a tmux socket path", "/tmp/tmux-501/default", ["session_socket"]],
  ["plain text has no finding", "the gate blocks rm -rf /", []],
  // E-365 (D-118 r5, audit O1): the false positives the audit found, and the H4 form it missed.
  ["SSH-remote userinfo is not mail", "git@github.com:a/b.git and ssh://git@ssh.github.com:443/a/b", []],
  ["URL userinfo is not mail", "https://ghp_FAKE0000@github.com/a/b.git", []],
  ["linuxbrew and username are placeholder users", "/home/linuxbrew/bin /Users/username/x", []],
  ["a placeholder UUID repeats one character per group", "sid 11111111-2222-3333-4444-555555555555", []],
  ["a ~login used as a shell path is a home path", "rm -rf ~carol/* && cd ~carol", ["home_path", "home_path"]],
  ["~ in prose or arithmetic is not a login", "~all expected, ~M tokens, (~sum, ~chars/4, ~minMs, rm -rf ~root", []],
  // critic_security on E-365: a prose address next to `:`, `/` or `//` is still mail; a ~login
  // operand of a shell verb counts whatever follows it, in any case.
  ["an address before `: ` in prose is mail", "contact: jane@corpmail.net: hi", ["personal_email"]],
  ["an address before a slash in prose is mail", "mail jane@corpmail.net/x", ["personal_email"]],
  ["an address after a bare // is mail", "//jane@corpmail.net", ["personal_email"]],
  ["a ~login operand of cd is a home path", "cd ~carol && ls", ["home_path"]],
  ["an uppercase ~Login path is a home path", "~Carol/x", ["home_path"]],
];
for (const [label, text, want] of ROWS) {
  test(`E-364: ${label}`, () => assert.deepEqual(classes(text), want));
}

test("E-364: a client name is found only when the operator's local list names it", () => {
  const text = "the vitest totals of Contoso-Portal recorded pass=0";
  assert.deepEqual(classes(text), [], "no list, no finding");
  assert.deepEqual(classes(text, { clientNames: ["contoso-portal"] }), ["client_name"], "case-insensitive");
  assert.deepEqual(classes("contosoportal", { clientNames: ["contoso"] }), [], "whole words only");
});

test("E-364: an allow-listed address passes; findings carry their line", () => {
  assert.deepEqual(classes("releases@vendor.io", { allowEmails: ["releases@vendor.io"] }), []);
  assert.deepEqual(scanText("ok\ncd /home/carol"), [{ class: "home_path", match: "/home/carol", line: 2 }]);
});

test("E-364: every class is reachable (the scanner cannot pass empty)", () => {
  const seen = new Set(ROWS.flatMap(([, t]) => classes(t)).concat(classes("Acme", { clientNames: ["Acme"] }), classes("Ada Quill", { operatorNames: ["Ada Quill"] })));
  assert.deepEqual([...seen].sort(), [...CLASSES].sort());
});

// D-145 r1 changed this row: binary is decided once, in blobText — a binary's printable runs are
// scanned (as the gate path always did), not skipped, so b.bin's `/home/eve` run is a hit now.
test("E-364: scanFiles reports per file; a binary is scanned by its printable runs", () => {
  const root = mkdtempSync(join(tmpdir(), "rein-t-pscan-"));
  try {
    mkdirSync(join(root, ".ai"));
    writeFileSync(join(root, "a.md"), "see /home/dave/x\n");
    writeFileSync(join(root, "b.bin"), "\u0000/home/eve");
    assert.deepEqual(scanFiles(root, ["a.md", "b.bin", "missing.txt"], { clientNames: [] }).map((h) => [h.file, h.class]), [["a.md", "home_path"], ["b.bin", "home_path"]]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// D-145 r1 (extends the E-364 row above): a UTF-16 file carrying U+0000 is text, not binary — the NUL
// is dropped (not a separator) and the file is scanned. On origin/main it was skipped whole.
test("a UTF-16LE file with a NUL is scanned, the NUL dropped", (t) => {
  const root = publicRepo(t);
  const u16 = (s) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(s, "utf16le")]);
  const read = (m) => ({ files: Object.keys(m), read: (f) => m[f], author: PUB_ID, committer: PUB_ID });
  assert.deepEqual(precommitProblems(root, read({ "w.txt": u16("Ada Quill\u0000\n") })), ["[PUBLISH_SCAN_HIT] operator_name w.txt:1"]);
  // E-413: the line of a NUL file's hit is where it first matches in its joined views.
  assert.deepEqual(precommitProblems(root, read({ "w.txt": u16("Ada Qu\u0000ill\n") })), ["[PUBLISH_SCAN_HIT] operator_name w.txt:3"], "joined in the NUL-removed view");
});

test("E-365: without .ai/publish-scan.local.json a tree scan FAILS CLOSED; with it the names are checked", () => {
  const root = mkdtempSync(join(tmpdir(), "rein-t-pscan-"));
  try {
    mkdirSync(join(root, ".ai"));
    writeFileSync(join(root, "a.md"), "built for Fabrikam\n");
    assert.throws(() => scanFiles(root, ["a.md"]), /^Error: \[SCAN_LIST_MISSING\]/);
    assert.throws(() => loadScanConfig(join(root, ".ai")), /SCAN_LIST_MISSING/);
    writeFileSync(join(root, ".ai", "publish-scan.local.json"), JSON.stringify({ client_names: ["Fabrikam"], operator_names: ["Ada Quill"] }));
    assert.deepEqual(loadScanConfig(join(root, ".ai")).clientNames, ["Fabrikam"]);
    assert.deepEqual(scanFiles(root, ["a.md"]).map((h) => h.class), ["client_name"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("E-365: the reviewed exemption covers this file's invented data — never client names", () => {
  // E-402 (D-139): the demo GIF is the second reviewed exemption — compressed pixels drawn from
  // docs/assets/demo.cast, which stays fully scanned (docs-links.test.mjs scans it clean).
  assert.deepEqual(Object.keys(EXEMPT_FILES), ["tests/unit/publish-scan.test.mjs", "docs/assets/demo.gif"]);
  for (const reason of Object.values(EXEMPT_FILES)) assert.ok(reason.length > 20);
  const root = mkdtempSync(join(tmpdir(), "rein-t-pscan-"));
  try {
    mkdirSync(join(root, "tests", "unit"), { recursive: true });
    mkdirSync(join(root, "docs", "assets"), { recursive: true });
    for (const f of ["tests/unit/publish-scan.test.mjs", "docs/assets/demo.gif"]) {
      writeFileSync(join(root, f), "cd /home/frank; Fabrikam\n");
      assert.deepEqual(scanFiles(root, [f], { clientNames: ["Fabrikam"] }).map((h) => h.class), ["client_name"], f);
    }
    // …and only by name: the same bytes anywhere else are a home_path finding.
    writeFileSync(join(root, "docs/assets/other.gif"), "cd /home/frank\n");
    assert.deepEqual(scanFiles(root, ["docs/assets/other.gif"], { clientNames: ["Fabrikam"] }).map((h) => h.class), ["home_path"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("E-365: an empty client list refuses like a missing one", () => {
  const root = mkdtempSync(join(tmpdir(), "rein-t-pscan-"));
  try {
    mkdirSync(join(root, ".ai"));
    for (const body of [{ client_names: [] }, {}, { client_names: [""] }]) {
      writeFileSync(join(root, ".ai", "publish-scan.local.json"), JSON.stringify(body));
      assert.throws(() => loadScanConfig(join(root, ".ai")), /SCAN_LIST_MISSING.*names no client/, JSON.stringify(body));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("E-365: the export list follows §Component 8 as amended by D-118 r3 and D-123", () => {
  for (const f of ["src/bin/rein", "scripts/standards.mjs", "package.json", "package-lock.json", ".gitignore", "CHANGELOG.md",
    "CONTRIBUTING.md", "README.md", "LICENSE", "NOTICE", ".ai/blueprints/open-source-release.md", ".claude/rules/x.md"]) {
    assert.ok(isExported(f), `${f} is exported`);
  }
  for (const f of [".github/workflows/ci.yml", ".ai/COMM.md", ".ai/LOG.md", ".ai/REVIEWS.md", ".ai/state.json", ".ai/TASKS.md",
    ".ai/AUDIT-PUBLIC.md", ".ai/publish-scan.local.json", ".mcp.json", "plans/x.md", ".ai/DECISIONS.md", ".ai/blueprints/licensing.md", "legal/TIERS.md"]) {
    assert.ok(!isExported(f), `${f} is not exported`);
  }
});

test("E-365/E-372: the exported tree carries no personal address, home path, session id, socket path or operator value outside D-124's files", () => {
  // Client names are the operator's list (gitignored): `ai release` checks them; here the other
  // three classes are pinned at zero so a regression shows up in CI, not at release time.
  // E-372 (D-124): the operator values this file may know without spelling them — the root
  // package.json author's name and address — are scanned as operator_name, allowed only where
  // D-124 allows them. The operator's full list (other forms, the former address) is local.
  const [, name, contact] = /^(.+?)\s*<([^>]+)>$/.exec(JSON.parse(_read(_resolve(REPO, "package.json"), "utf8")).author);
  const hits = scanFiles(REPO, exportFiles(REPO), {
    clientNames: [], operatorNames: [name, contact],
    allow: { [name]: ["LICENSE", "NOTICE", "README.md", "package.json"], [contact]: ["SECURITY.md", "package.json", "README.md"] },
  });
  assert.deepEqual(hits.map((h) => `${h.file}:${h.line} ${h.class} ${h.match}`), []);
});

// ── E-372 (D-123 §Component 3, D-124): the fifth class and the checks beyond content ──
// Extends the E-364/E-365 rows above. Every name and address below is invented.

test("E-372: an operator value is found in any form the list names, bounded, Unicode-aware", () => {
  const op = { operatorNames: ["Ada Quill", "Ađa Quillić", "ada.quill@corpmail.net"] };
  assert.deepEqual(classes("by ada quill, 2026", op), ["operator_name"], "case-insensitive");
  assert.deepEqual(classes("Ađa Quillić wrote it", op), ["operator_name"], "diacritics");
  assert.deepEqual(classes("Ada Quillson", op), [], "a longer word is not the name");
  assert.deepEqual(classes(`Ada${String.fromCharCode(0x200b)} Quill`, op), ["operator_name"], "a zero-width character does not split it");
  assert.deepEqual(classes("<ada.quill@corpmail.net>", op), ["personal_email", "operator_name"], "an address is both");
  assert.deepEqual(classes("Ada Quill", {}), [], "no list, no finding");
});

test("E-372: an allowed value passes only in its allowed file; everything else of the operator's refuses", () => {
  const root = mkdtempSync(join(tmpdir(), "rein-t-pscan-"));
  try {
    for (const [f, t] of [["NOTICE", "Copyright 2026 Ada Quill"], ["package.json", '"author": "Ada Quill <ada.quill@corpmail.net>"'],
      ["src/x.mjs", "// Ada Quill"], ["README.md", "old: aq@formerjob.biz"]]) {
      mkdirSync(join(root, f, ".."), { recursive: true });
      writeFileSync(join(root, f), t);
    }
    const opts = { clientNames: [], operatorNames: ["Ada Quill", "ada.quill@corpmail.net", "aq@formerjob.biz"],
      allow: { "Ada Quill": ["NOTICE", "package.json"], "ada.quill@corpmail.net": ["package.json"] } };
    assert.deepEqual(scanFiles(root, ["NOTICE", "package.json", "src/x.mjs", "README.md"], opts).map((h) => `${h.file} ${h.class}`),
      ["src/x.mjs operator_name", "README.md personal_email", "README.md operator_name"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("E-372: the operator list and its allow block fail closed", () => {
  assert.deepEqual(ALLOWABLE_FILES, ["LICENSE", "NOTICE", "SECURITY.md", "package.json", "README.md"]);
  assert.throws(() => checkAllow({ "Ada Quill": ["src/x.mjs"] }, ["Ada Quill"]), /\[SCAN_ALLOW_BAD\].*allowed files/);
  assert.throws(() => checkAllow({ "Bo Ray": ["NOTICE"] }, ["Ada Quill"]), /\[SCAN_ALLOW_BAD\].*not in operator_names/);
  assert.throws(() => checkAllow(["NOTICE"], ["Ada Quill"]), /\[SCAN_ALLOW_BAD\]/);
  const root = mkdtempSync(join(tmpdir(), "rein-t-pscan-"));
  try {
    mkdirSync(join(root, ".ai"));
    const write = (j) => writeFileSync(join(root, ".ai", "publish-scan.local.json"), JSON.stringify(j));
    for (const body of [{ client_names: ["Fabrikam"] }, { client_names: ["Fabrikam"], operator_names: [" "] }]) {
      write(body);
      assert.throws(() => loadScanConfig(join(root, ".ai")), /SCAN_LIST_MISSING.*names no operator/, JSON.stringify(body));
      assert.match(doctorLine(join(root, ".ai")), /^\[SCAN_LIST_MISSING\] .* names no operator value$/);
    }
    writeFileSync(join(root, ".ai", "publish-scan.local.json"), '{"operator_names": ["Ada Quill"');
    assert.equal(doctorLine(join(root, ".ai")), `[SCAN_CONFIG_UNREADABLE] ${join(root, ".ai", "publish-scan.local.json")} is not valid JSON`, "the file's text is never echoed");
    write({ client_names: ["Fabrikam", "Contoso"], operator_names: ["Ada Quill"], allow: { "ada quill": ["NOTICE"] } });
    assert.equal(doctorLine(join(root, ".ai")), "[PUBLISH_SCAN_OK] classes=5 lists=client:2,operator:1");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("E-372: the export tree refuses .git, .env*, *.local.json, off-registry lockfile URLs and absolute template paths", () => {
  const root = mkdtempSync(join(tmpdir(), "rein-t-pscan-"));
  try {
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, "package-lock.json"), JSON.stringify({ packages: { "": {}, "node_modules/a": { resolved: "https://registry.npmjs.org/a/-/a-1.tgz" },
      "node_modules/b": { resolved: "https://evil.example/b.tgz" }, "node_modules/c": { resolved: "git+ssh://git@github.com/x/c.git" },
      "node_modules/w": { resolved: "src/mcp/w", link: true }, "node_modules/x": { resolved: "../outside/x", link: true } } }));
    writeFileSync(join(root, ".claude", "settings.engineer.json"), JSON.stringify({ hooks: { a: [{ command: "~/.rein/hooks/x.sh" }, { command: "/opt/x/hook.sh" }] } }));
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { s: { args: ["C:\\tools\\s.js"] } } }));
    const files = ["package-lock.json", ".claude/settings.engineer.json", ".mcp.json", ".git/config", ".env.local", "x/.env", ".ai/publish-scan.local.json", "X/.ENV", ".env.example", "src/ok.mjs"];
    assert.deepEqual(treeProblems(root, files).map((h) => `${h.class} ${h.file}`), [
      "lockfile_url package-lock.json", "lockfile_url package-lock.json", "lockfile_url package-lock.json", "absolute_path .claude/settings.engineer.json",
      "absolute_path .mcp.json", "forbidden_file .git/config", "forbidden_file .env.local", "forbidden_file x/.env", "forbidden_file .ai/publish-scan.local.json", "forbidden_file X/.ENV"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("E-372: the export commit's author and committer must both be the public identity", () => {
  const id = { name: "Vimurai", email: "1+vimurai@users.noreply.github.com" };
  const ok = "Vimurai <1+vimurai@users.noreply.github.com>";
  assert.equal(identityProblem({ author: ok, committer: ok }, id), null);
  assert.match(identityProblem({ author: "Ada Quill <ada.quill@corpmail.net>", committer: ok }, id), /^\[PUBLISH_IDENTITY\] .*author/);
  assert.match(identityProblem({ author: ok, committer: "GitHub <noreply@github.com>" }, id), /^\[PUBLISH_IDENTITY\] .*committer/);
  assert.deepEqual(classes(ok), [], "the noreply identity is not a personal address");
});

test("E-372: today's export tree passes the checks beyond content", () => {
  assert.deepEqual(treeProblems(REPO, exportFiles(REPO)), []);
});

// ── E-378 (D-129 §Component 9): the public repository's commit and CI gates ──
// Extends the E-372 rows: the same scan, run on staged blobs and on the tracked tree, switched on
// by .ai/publish.json. Every name and address below is invented.
const PUBLIC = { name: "Vimurai", email: "1+vimurai@users.noreply.github.com" };
const PUB_ID = `${PUBLIC.name} <${PUBLIC.email}>`;
function publicRepo(t, { operatorList = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "rein-t-pscan-pub-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".ai"));
  writeFileSync(join(root, ".ai", "publish.json"), JSON.stringify({ author: PUBLIC }));
  if (operatorList) writeFileSync(join(root, ".ai", "publish-scan.local.json"),
    JSON.stringify({ client_names: ["Fabrikam"], operator_names: ["Ada Quill", "ada.quill@corpmail.net"], allow: { "Ada Quill": ["NOTICE"] } }));
  return root;
}
const staged = (map) => ({ files: Object.keys(map), read: (f) => map[f] });

test("E-378: without .ai/publish.json the commit gate does nothing (a private working clone)", (t) => {
  const root = publicRepo(t);
  rmSync(join(root, ".ai", "publish.json"));
  assert.deepEqual(precommitProblems(root, { ...staged({ "a.md": "by Ada Quill" }), author: "x <ada.quill@corpmail.net>", committer: "x" }), []);
});

test("E-378: on the operator's machine a commit under a personal identity is refused", (t) => {
  const root = publicRepo(t);
  const p = precommitProblems(root, { ...staged({ "a.md": "fine" }), author: "Ada Quill <ada.quill@corpmail.net>", committer: PUB_ID });
  assert.equal(p.length, 1);
  assert.match(p[0], /^\[PUBLISH_IDENTITY\] .*author/);
  assert.ok(!p[0].includes("corpmail"), "the refusal never prints the value");
  assert.deepEqual(precommitProblems(root, { ...staged({ "a.md": "fine" }), author: PUB_ID, committer: PUB_ID }), []);
});

test("E-378: staged content is scanned — classes, the D-124 allow-list, forbidden files; values never printed", (t) => {
  const root = publicRepo(t);
  const p = precommitProblems(root, { ...staged({ "NOTICE": "Copyright 2026 Ada Quill", "src/x.mjs": "// for Fabrikam\n// Ada Quill",
    "config/.env": "X=1", ".env.example": "X=" }), author: PUB_ID, committer: PUB_ID });
  assert.deepEqual(p.sort(), ["[PUBLISH_SCAN_HIT] client_name src/x.mjs:1", "[PUBLISH_SCAN_HIT] forbidden_file config/.env",
    "[PUBLISH_SCAN_HIT] operator_name src/x.mjs:2"]);
});

test("E-378: a contributor (no operator list) gets the structural classes and no identity rule", (t) => {
  const root = publicRepo(t, { operatorList: false });
  const home = "/ho" + "me/carol";
  const p = precommitProblems(root, { ...staged({ "a.md": `see ${home}/x; by Ada Quill` }), author: "Bo <bo@corpmail.net>", committer: "Bo <bo@corpmail.net>" });
  assert.deepEqual(p, ["[PUBLISH_SCAN_HIT] home_path a.md:1"]);
});

test("E-378: a list file that is present but invalid fails closed", (t) => {
  const root = publicRepo(t);
  writeFileSync(join(root, ".ai", "publish-scan.local.json"), "{");
  assert.throws(() => precommitProblems(root, { ...staged({ "a.md": "x" }), author: PUB_ID, committer: PUB_ID }), /SCAN_CONFIG_UNREADABLE/);
});

test("E-378: the public CI (no operator list) allows the package.json author's address in the contact files only", (t) => {
  const root = publicRepo(t, { operatorList: false });
  const c = "contact@" + "corpmail.net";
  const files = { ".ai/publish.json": "{}", "package.json": JSON.stringify({ author: `Ada Quill <${c}>` }),
    "SECURITY.md": `mail ${c}`, "README.md": `or ${c}`, "docs/x.md": `mail ${c}` };
  assert.deepEqual(treeGateProblems(root, Object.keys(files), (f) => files[f]), ["[PUBLISH_SCAN_HIT] personal_email docs/x.md:1"]);
});

test("E-378: the CI gate scans every tracked file and the tree checks", (t) => {
  const root = publicRepo(t, { operatorList: false });
  writeFileSync(join(root, "a.md"), `mail ${"jane@" + "corpmail.net"}`);
  writeFileSync(join(root, "b.md"), "clean");
  assert.deepEqual(treeGateProblems(root, [".ai/publish.json", "a.md", "b.md", ".env.local"]).sort(),
    ["[PUBLISH_SCAN_HIT] forbidden_file .env.local", "[PUBLISH_SCAN_HIT] personal_email a.md:1"]);
  assert.deepEqual(treeGateProblems(root, ["b.md"]), ["[PUBLISH_GATE] .ai/publish.json is missing — the public repository carries it"],
    "a public tree without its marker fails (security_engineer P1-4)");
});

test("E-378: the precommit CLI reads the STAGED blobs and git's identity, and exits 1 on a finding", (t) => {
  const root = publicRepo(t);
  const g = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q"); g("config", "user.name", PUBLIC.name); g("config", "user.email", PUBLIC.email);
  writeFileSync(join(root, "a.md"), "clean\n"); g("add", "a.md");
  writeFileSync(join(root, "a.md"), "by Ada Quill\n");   // the working tree differs; the staged blob is what is committed
  const cli = () => { try { execFileSync(process.execPath, [join(REPO, "src/shared/publish-scan.mjs"), "precommit", root], { stdio: ["ignore", "pipe", "pipe"] }); return { rc: 0, err: "" }; }
    catch (e) { return { rc: e.status, err: String(e.stderr) }; } };
  assert.equal(cli().rc, 0, "the staged blob is clean");
  assert.match(execFileSync(process.execPath, [join(REPO, "src/shared/publish-scan.mjs"), "precommit", root], { encoding: "utf8" }),
    /^\[PRIVACY_GATE_OK\] files=1$/m, "a clean run says so — the hook requires the line");
  g("add", "a.md");
  let r = cli();
  assert.equal(r.rc, 1);
  assert.match(r.err, /\[PUBLISH_SCAN_HIT\] operator_name a\.md:1/);
  assert.ok(!r.err.includes("Ada Quill"), "never prints the value");
  g("reset", "-q", "a.md"); writeFileSync(join(root, "a.md"), "clean\n"); g("add", "a.md");
  g("config", "user.email", "ada.quill@corpmail.net");
  r = cli();
  assert.equal(r.rc, 1);
  assert.match(r.err, /\[PUBLISH_IDENTITY\]/);
});

// ── security_engineer on E-378: each finding as a row ──
const _ps = (args, opts = {}) => { try { return { rc: 0, out: execFileSync(process.execPath, [join(REPO, "src/shared/publish-scan.mjs"), ...args], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }) }; }
  catch (e) { return { rc: e.status, out: String(e.stdout), err: String(e.stderr) }; } };

test("E-378 P0-3: an unknown subcommand is an error, never a silent success", () => {
  assert.equal(_ps(["scan-tre"]).rc, 2);
  assert.equal(_ps([]).rc, 2);
});

test("E-378 P1-4: deleting the marker does not turn the gate off — the index copy activates it, a staged deletion is refused", (t) => {
  const root = publicRepo(t);
  const marker = _read(join(root, ".ai", "publish.json"), "utf8");
  rmSync(join(root, ".ai", "publish.json"));
  const read = (f) => (f === ".ai/publish.json" ? marker : "by Ada Quill");
  const p = precommitProblems(root, { files: ["a.md"], read, deleted: [".ai/publish.json"], author: PUB_ID, committer: PUB_ID });
  assert.ok(p.includes("[PUBLISH_GATE] .ai/publish.json marks the public repository and cannot be deleted"));
  assert.ok(p.includes("[PUBLISH_SCAN_HIT] operator_name a.md:1"));
});

test("E-378 (critic_security): a staged deletion is refused even when no copy of the marker is readable; HEAD's copy activates", (t) => {
  const root = publicRepo(t);
  const marker = _read(join(root, ".ai", "publish.json"), "utf8");
  rmSync(join(root, ".ai", "publish.json"));
  const none = () => { throw new Error("not in the index"); };
  assert.deepEqual(precommitProblems(root, { files: [], read: none, deleted: [".ai/publish.json"], author: PUB_ID, committer: PUB_ID }),
    ["[PUBLISH_GATE] .ai/publish.json marks the public repository and cannot be deleted"]);
  const p = precommitProblems(root, { files: ["a.md"], read: (f) => (f === "a.md" ? "by Ada Quill" : none()),
    readHead: (f) => (f === ".ai/publish.json" ? marker : none()), author: PUB_ID, committer: PUB_ID });
  assert.deepEqual(p, ["[PUBLISH_SCAN_HIT] operator_name a.md:1"], "HEAD's marker keeps the gate on");
});

test("E-378 (critic_security): through the CLI, git rm of the marker is refused", (t) => {
  const root = publicRepo(t);
  const g = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q"); g("config", "user.name", PUBLIC.name); g("config", "user.email", PUBLIC.email);
  g("add", ".ai/publish.json"); g("commit", "-q", "--no-verify", "-m", "marker");
  g("rm", "-q", ".ai/publish.json");
  writeFileSync(join(root, "b.md"), "x\n"); g("add", "b.md");
  const r = _ps(["precommit", root]);
  assert.equal(r.rc, 1);
  assert.match(r.err, /cannot be deleted/);
});

test("E-378 P1-5: a vendor-format token is the gates' sixth class; tests/fixtures and a marked fake pass", (t) => {
  const root = publicRepo(t, { operatorList: false });
  const tok = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz0123456789AB";
  const files = { "a.sh": `TOKEN=${tok}`, "tests/fixtures/x-cases.json": `"${tok}"`,
    "b.sh": `# privacy:allow-fake-token\nrun \\\n  "${tok}"`, "c.md": "password = hunter2 is prose here" };
  assert.deepEqual(precommitProblems(root, { ...staged(files), author: PUB_ID, committer: PUB_ID }), ["[PUBLISH_SCAN_HIT] secret a.sh:1"]);
});

test("E-378 P1-7/P2-9: paths, UTF-16, binaries' printable runs and encoded values are scanned", (t) => {
  const root = publicRepo(t);
  const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("by Ada Quill", "utf16le")]);
  const bin = Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(" for Fabrikam "), Buffer.from([0, 0])]);
  const files = { "docs/Fabrikam-notes.md": "clean", "a.txt": utf16, "b.bin": bin,
    "c.json": '{"by": "Ada\\u0020Quill"}', "d.html": "Ada&#32;Quill", "e.txt": "x%2Fho" + "me%2Fcarol%2Fy" };
  const p = precommitProblems(root, { ...staged(files), author: PUB_ID, committer: PUB_ID }).sort();
  // E-413 / D-145 addendum 4: the separator view is NUL → space, so b.bin's hit stays on line 1.
  assert.deepEqual(p, ["[PUBLISH_SCAN_HIT] client_name b.bin:1", "[PUBLISH_SCAN_HIT] client_name docs/Fabrikam-notes.md:path",
    "[PUBLISH_SCAN_HIT] home_path e.txt:1", "[PUBLISH_SCAN_HIT] operator_name a.txt:1", "[PUBLISH_SCAN_HIT] operator_name c.json:1",
    "[PUBLISH_SCAN_HIT] operator_name d.html:1"]);
});

test("E-378 P1-7: a staged symlink is scanned as its target text (type changes included)", (t) => {
  const root = publicRepo(t, { operatorList: false });
  const g = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q"); g("config", "user.name", PUBLIC.name); g("config", "user.email", PUBLIC.email);
  writeFileSync(join(root, "a.md"), "x\n"); g("add", "a.md"); g("commit", "-q", "--no-verify", "-m", "a");
  rmSync(join(root, "a.md"));
  symlinkSync(join("/ho" + "me", "carol", "x"), join(root, "a.md"));
  g("add", "a.md");
  const r = _ps(["precommit", root]);
  assert.equal(r.rc, 1);
  assert.match(r.err, /\[PUBLISH_SCAN_HIT\] home_path a\.md:1/);
});

test("E-378: the pre-commit hook runs the gate where no env opt-out reaches it, and fails closed", () => {
  const hook = _read(_resolve(REPO, "hooks/pre-commit.sh"), "utf8");
  const gate = hook.indexOf("# ── E-378 (D-129 §Component 9): the public repository's privacy gate");
  const optOutEnd = hook.indexOf('fi\n', hook.indexOf('[GATE_SKIPPED] REIN_SKIP_CONFLICT_GATE=1'));
  assert.ok(gate > optOutEnd && optOutEnd > 0, "after the E-238 opt-out block, not inside it");
  const body = hook.slice(gate, hook.indexOf("\nfi\n", gate));
  assert.match(body, /precommit "\$\{AI_DIR%\/\.ai\}"/);
  assert.match(body, /\[PUBLISH_GATE\] shared\/publish-scan\.mjs or node unavailable/);
  assert.match(body, /"\$_e378_out" != "\[PRIVACY_GATE_OK\]"\*/, "the verdict line is required (P0-3)");
  assert.match(hook, /git cat-file -e :\.ai\/publish\.json/, "the index copy activates it (P1-4)");
  assert.doesNotMatch(body, /\$\{?REIN_[A-Z_]*/, "no env switch");
});

// ── E-370 (D-123, open-source-release.md §Component 1): the licence is Apache-2.0 ──
// Extends this file's publication checks: what the tree may say about its own licence
// (replaces the E-358 rows).

const REPO = _resolve(_dirname(fileURLToPath(import.meta.url)), "..", "..");
const tracked = () => execFileSync("git", ["-C", REPO, "ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
// sha256 of https://www.apache.org/licenses/LICENSE-2.0.txt — the licence is verbatim.
const APACHE_SHA256 = "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30";

test("E-370: LICENSE is the Apache License 2.0, verbatim", () => {
  const t = _read(_resolve(REPO, "LICENSE"));
  assert.match(t.toString("utf8"), /^\s+Apache License\n\s+Version 2\.0, January 2004\n/);
  assert.equal(createHash("sha256").update(t).digest("hex"), APACHE_SHA256);
});

test("E-370: NOTICE names the product and the root package.json author as copyright holder, and carries the grammars' MIT notices", () => {
  // D-124: the holder is the operator's real name. This file ships, so it never spells the name:
  // the copyright line must agree with the one place that declares the author.
  const t = _read(_resolve(REPO, "NOTICE"), "utf8");
  const author = JSON.parse(_read(_resolve(REPO, "package.json"), "utf8")).author.replace(/\s*<[^>]*>$/, "");
  assert.ok(author.length > 0);
  assert.ok(t.startsWith(`Rein\nCopyright 2026 ${author}\n`), "NOTICE opens with the product (D-125) and the author's copyright line");
  assert.equal(t.split(author).length - 1, 1, "the holder is named once; the rest are third-party");
  assert.equal((t.match(/The MIT License \(MIT\)/g) || []).length, 2, "tree-sitter-javascript and tree-sitter-typescript");
});

test("E-370: every package.json declares Apache-2.0", () => {
  const pkgs = tracked().filter((f) => /(^|\/)package\.json$/.test(f) && !f.includes("node_modules/"));
  assert.equal(pkgs.length, 18);
  for (const f of pkgs) assert.equal(JSON.parse(_read(_resolve(REPO, f), "utf8")).license, "Apache-2.0", f);
});

test("E-370: no exported file speaks of the withdrawn licensing terms", () => {
  // .ai/ ships as the init template only (D-123). This file carries the phrases itself.
  const WITHDRAWN = new RegExp(["All rights reserved", "Poly" + "Form", "Non" + "commercial", "commercial licen[cs]e", "licen[cs]e key"].join("|"), "i");
  const self = "tests/unit/publish-scan.test.mjs";
  const files = exportFiles(REPO).filter((f) => !f.startsWith(".ai/") && f !== self);
  const hits = [];
  for (const f of files) {
    let t; try { t = _read(_resolve(REPO, f), "utf8"); } catch { continue; }
    t.split("\n").forEach((l, i) => { if (WITHDRAWN.test(l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 100)}`); });
  }
  assert.deepEqual(hits, []);
  assert.ok(!tracked().some((f) => f.startsWith("legal/")), "legal/ is gone");
});

// E-374: the README and docs/ are the front door — every relative link and #anchor resolves.
// E-390 (D-136): docs/local-ci.md became docs/ci.md and docs/install.md is new; both are in the
// named list. The mermaid, HTML and size checks of the rewrite are tests/unit/docs-links.test.mjs.
const _slug = (h) => h.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");
const _anchors = (md) => new Set([...md.replace(/```[\s\S]*?```/g, "").matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => _slug(m[1])));
test("E-374: every relative link and anchor in README, CONTRIBUTING, SECURITY, CODE_OF_CONDUCT and docs/ resolves", () => {
  const pages = ["README.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", ...tracked().filter((f) => /^docs\/.*\.md$/.test(f))];
  for (const f of ["docs/README.md", "docs/install.md", "docs/getting-started.md", "docs/how-it-works.md", "docs/ci.md"]) assert.ok(pages.includes(f) || existsSync(_resolve(REPO, f)), f);
  const all = [...new Set([...pages, ...["docs/README.md", "docs/getting-started.md", "docs/how-it-works.md", "docs/gates-and-review.md",
    "docs/ci.md", "docs/install.md", "docs/team-mode.md", "docs/agents-and-skills.md", "docs/mcp-servers.md", "docs/configuration.md", "docs/troubleshooting.md"]])];
  const bad = [];
  for (const page of all) {
    const md = _read(_resolve(REPO, page), "utf8");
    const body = md.replace(/```[\s\S]*?```/g, "");
    const targets = [...body.matchAll(/\]\(([^)\s]+)\)/g), ...body.matchAll(/^\[[^\]]+\]:\s*(\S+)/gm), ...body.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const t of targets) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(t)) continue;   // http(s), mailto: not checked offline
      const [path, anchor] = t.split("#");
      const file = path ? _resolve(REPO, _dirname(page), path) : _resolve(REPO, page);
      if (!existsSync(file)) { bad.push(`${page}: ${t} (no such path)`); continue; }
      if (anchor && file.endsWith(".md") && !_anchors(_read(file, "utf8")).has(anchor)) bad.push(`${page}: ${t} (no such heading)`);
    }
  }
  assert.deepEqual(bad, []);
});

test("E-374: the public front door says nothing of licence keys, tiers of licence or a heartbeat", () => {
  const files = ["README.md", "SECURITY.md", "CODE_OF_CONDUCT.md", ...tracked().filter((f) => /^docs\/.*\.md$/.test(f))];
  const WITHDRAWN = new RegExp(["heart" + "beat", "licen[cs]e key", "(?:gold|platinum) tier", "commercial licen[cs]e"].join("|"), "i");
  assert.deepEqual(files.filter((f) => existsSync(_resolve(REPO, f)) && WITHDRAWN.test(_read(_resolve(REPO, f), "utf8"))), []);
});

test("E-370: README and CONTRIBUTING state the licence and the DCO", () => {
  const readme = _read(_resolve(REPO, "README.md"), "utf8");
  assert.match(readme, /badge\/license-Apache--2\.0/);
  assert.match(readme, /open source under the \[Apache License 2\.0\]\(LICENSE\)/);
  const contributing = _read(_resolve(REPO, "CONTRIBUTING.md"), "utf8");
  assert.match(contributing, /git commit -s/);
  assert.match(contributing, /Developer's Certificate of Origin 1\.1/);
});

// E-397 (CodeQL js/double-escaping): HTML entities decode in one pass — `&amp;lt;` is the text
// `&lt;`, not `<` — while every single entity, \u and % escape still decodes.
test("decodedView decodes each HTML entity once, and the \\u and % layers beneath it", () => {
  assert.equal(decodedView("&amp;lt; &#38;lt; &amp;#64;"), "&lt; &lt; &#64;");
  assert.equal(decodedView("&lt;&gt;&quot;&amp; &#64; &#x40; &#X40; %40 \\u0040 %26lt;"), '<>"& @ @ @ @ @ <');
});

// E-398 / D-144 addendum (extends the scanFiles skip test at the top, "missing.txt"): the read
// guard skips only a file that is gone (ENOENT/ENOTDIR) or a reader's null; any other read error
// propagates, so the gate's catch-all turns it into a block instead of a silently unscanned file.
test("scanFiles skips only a gone file or a null read; any other read error propagates", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rein-t-pscan-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const err = (code) => Object.assign(new Error(`${code}: simulated`), { code });
  const reader = (bad) => ({ clientNames: [], read: (f) => { if (f === "x.md") throw bad; return f === "n.md" ? null : "/home/somebody/x\n"; } });
  for (const code of ["ENOENT", "ENOTDIR"])
    assert.deepEqual(scanFiles(root, ["x.md", "n.md", "a.md"], reader(err(code))).map((h) => h.file), ["a.md"], code);
  assert.throws(() => scanFiles(root, ["x.md", "a.md"], reader(err("EACCES"))), /EACCES: simulated/);
  assert.throws(() => scanFiles(root, ["x.md"], reader(new RangeError("Invalid code point 1114112"))), /RangeError/);
});

// E-398 / D-144 r1 (extends the decodedView test above): a numeric entity outside 0..0x10FFFF — decimal, hex, or
// a digit run that overflows to Infinity — stays literal beside a decoded neighbour; no RangeError.
test("decodedView leaves an out-of-range numeric entity literal and never throws", () => {
  const big = "&#1114112; &#x110000; &#" + "9".repeat(400) + "; &#x" + "F".repeat(300) + ";";
  assert.equal(decodedView(`&#64; ${big} &#x10FFFF;`), `@ ${big} \u{10FFFF}`);
});

// E-398 / D-144 r1–r2 (extends the E-378 precommit CLI test): a staged file that names the entity
// commits with zero hits; and the CLI's catch-all is the fail-closed seam — a scan that throws (here:
// git cannot read the index, the root is no repository) is a [PUBLISH_GATE] reason and a block.
// The throw never reached that catch-all: scanFiles' read guard skipped the file's whole decoded
// pass, so the literal beside an entity-encoded name hid the name (fail open, found 2026-11-04).
test("precommit: a file naming the undecodable entity passes; a throwing scan is blocked with a reason", (t) => {
  const root = publicRepo(t);
  const run = () => { try { return { rc: 0, out: execFileSync(process.execPath, [join(REPO, "src/shared/publish-scan.mjs"), "precommit", root], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), err: "" }; }
    catch (e) { return { rc: e.status, out: String(e.stdout), err: String(e.stderr) }; } };
  let r = run();
  assert.equal(r.rc, 1, "no repository: the scan throws");
  assert.match(r.err, /^\[PUBLISH_GATE\] \S/m);
  assert.match(r.err, /\[COMMIT_BLOCKED\] privacy gate: 1 finding/);
  const g = (...a) => execFileSync("git", ["-C", root, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  g("init", "-q"); g("config", "user.name", PUBLIC.name); g("config", "user.email", PUBLIC.email);
  writeFileSync(join(root, "SECURITY.md"), "decodedView(\"&#1114112;\") used to throw RangeError\n"); g("add", "SECURITY.md");
  r = run();
  assert.equal(r.rc, 0, r.err);
  assert.match(r.out, /^\[PRIVACY_GATE_OK\] files=1$/m);
  assert.ok(!/RangeError|Invalid code point/.test(r.err), r.err);
  writeFileSync(join(root, "notes.md"), "&#1114112; by Ada&#32;Quill\n"); g("add", "notes.md");
  r = run();
  assert.equal(r.rc, 1, "the literal no longer hides an entity-encoded name beside it");
  assert.match(r.err, /\[PUBLISH_SCAN_HIT\] operator_name notes\.md:1/);
  g("reset", "-q", "notes.md");
  // D-144 addendum 3: a staged gitlink (submodule pointer, mode 160000) is not content — it is
  // dropped from the listing and the commit passes, though `git cat-file -p :sub` cannot read it.
  g("update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,sub");
  r = run();
  assert.equal(r.rc, 0, r.err);
  assert.match(r.out, /^\[PRIVACY_GATE_OK\] files=2$/m, "SECURITY.md scanned; the gitlink listed for its path, its content not read");
  // security_engineer E-398 (P1): a gitlink's PATH is still checked — only its content read is skipped.
  g("update-index", "--add", "--cacheinfo", "160000,1111111111111111111111111111111111111111,Fabrikam-portal");
  r = run();
  assert.equal(r.rc, 1, "a client name in a gitlink path is a hit");
  assert.match(r.err, /\[PUBLISH_SCAN_HIT\] client_name Fabrikam-portal:path/);
  g("update-index", "--force-remove", "Fabrikam-portal");
  // security_engineer E-398 (P1): `0:notes.md` is read as that path (`:0:<path>`), not as stage 0 of
  // `notes.md` — with or without a decoy `notes.md` beside it.
  writeFileSync(join(root, "0:notes.md"), "Fabrikam\n"); g("add", "--", "0:notes.md");
  r = run();
  assert.equal(r.rc, 1, "a stage-spec-shaped name is still scanned");
  assert.match(r.err, /\[PUBLISH_SCAN_HIT\] client_name 0:notes\.md:1/);
  writeFileSync(join(root, "notes.md"), "decoy\n"); g("add", "notes.md");
  r = run();
  assert.match(r.err, /\[PUBLISH_SCAN_HIT\] client_name 0:notes\.md:1/, "the decoy is not scanned in its place");
  g("rm", "-q", "--cached", "--", "0:notes.md", "notes.md");
  // D-144 addendum 2: a listed path whose blob git cannot read is blocked, never skipped — a
  // regular-file entry naming a blob that is not in the repository ("Not a valid object name").
  g("update-index", "--add", "--cacheinfo", "100644,2222222222222222222222222222222222222222,lost.md");
  r = run();
  assert.equal(r.rc, 1, "an unreadable listed blob blocks");
  assert.match(r.err, /^\[PUBLISH_GATE\] \S/m);
  assert.match(r.err, /\[COMMIT_BLOCKED\] privacy gate: 1 finding/);
});

// D-144 addendum 2 (extends the scanFiles read-guard row): at the gate's reader, an absent path
// (ENOENT, or git's "does not exist" / "exists on disk, but not in") or a null read is a skip; any
// other read error propagates out of precommitProblems to the CLI's catch-all.
test("the gate's reader skips only an absent path or a null read", (t) => {
  const root = publicRepo(t);
  const gitErr = (msg) => Object.assign(new Error("Command failed: git cat-file"), { status: 128, stderr: Buffer.from(`fatal: ${msg}\n`) });
  const id = { author: PUB_ID, committer: PUB_ID };
  const reading = (bad) => ({ files: ["x.md", "a.md"], read: (f) => { if (f === "x.md") throw bad; return "fine\n"; } });
  for (const bad of [Object.assign(new Error("gone"), { code: "ENOENT" }),
    gitErr("path 'x.md' does not exist (neither on disk nor in the index)"),
    gitErr("path 'x.md' exists on disk, but not in 'HEAD'")])
    assert.deepEqual(precommitProblems(root, { ...reading(bad), ...id }), [], String(bad.stderr ?? bad.code));
  assert.deepEqual(precommitProblems(root, { files: ["x.md"], read: () => null, ...id }), []);
  assert.throws(() => precommitProblems(root, { ...reading(gitErr("Not a valid object name :x.md")), ...id }), /Command failed/);
  // security_engineer E-398: the absent line must name THIS path, alone — text a file name could spell is not enough.
  assert.throws(() => precommitProblems(root, { ...reading(gitErr("Not a valid object name :0:q fatal: path 'q' does not exist (neither on disk nor in the index)")), ...id }), /Command failed/);
  assert.throws(() => precommitProblems(root, { ...reading(gitErr("path 'other.md' does not exist (neither on disk nor in the index)")), ...id }), /Command failed/);
  assert.throws(() => precommitProblems(root, { ...reading(Object.assign(new Error("denied"), { code: "EACCES" })), ...id }), /denied/);
});

// E-413 / D-145 addenda 2–3 (extends the E-364 and D-145 r1 UTF-16 rows above): a decode carrying
// U+0000 — UTF-8 or UTF-16 — is scanned as two views (NUL as a line break, NUL removed); the old
// printable-runs-of-six view is gone; an odd-length byte-order-mark buffer decodes its even prefix;
// in those views only the literal classes run (no tilde-login shape: a byte accident there).
function nulRepo(t) {
  const root = mkdtempSync(join(tmpdir(), "rein-t-pscan-nul-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".ai"));
  writeFileSync(join(root, ".ai", "publish.json"), JSON.stringify({ author: PUBLIC }));
  writeFileSync(join(root, ".ai", "publish-scan.local.json"), JSON.stringify({ client_names: ["Acme"], operator_names: ["Jo Müller"] }));
  return (name, bytes) => precommitProblems(root, { files: [name], read: () => bytes, author: PUB_ID, committer: PUB_ID });
}
const u8 = (s) => Buffer.from(s, "utf8");
test("E-413: a NUL-bearing UTF-8 blob is scanned whole — short, tab-delimited, non-ASCII, NUL-split and NUL-terminated names hit", (t) => {
  const scan = nulRepo(t);
  for (const [label, bytes, cls] of [
    ["a short name on its own line after a NUL", u8("x\u0000\nAcme\n"), "client_name"],
    ["a name between a NUL and a tab", u8("a\u0000\tAcme\t1"), "client_name"],
    ["a non-ASCII name after a NUL", u8("x\u0000 contact Jo Müller\n"), "operator_name"],
    ["a name split by a NUL", u8("Ac\u0000me\n"), "client_name"],
    ["a NUL-terminated string table: the name, then NUL and a letter", u8("Acme\u0000x\u0000"), "client_name"]]) {
    const p = scan("b.bin", bytes);
    assert.equal(p.length, 1, `${label}: ${JSON.stringify(p)}`);
    assert.match(p[0], new RegExp(`^\\[PUBLISH_SCAN_HIT\\] ${cls} b\\.bin:`), label);
  }
});
test("E-413: an odd-length byte-order-mark file decodes its even prefix and its name hits", (t) => {
  const scan = nulRepo(t);
  const be = Buffer.from(Buffer.from("Acme\n", "utf16le")).swap16();
  for (const bytes of [Buffer.concat([Buffer.from([0xfe, 0xff]), be, Buffer.from([0x41])]),
    Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Acme\n", "utf16le"), Buffer.from([0x41])])])
    assert.deepEqual(scan("w.txt", bytes).map((x) => x.replace(/:\d+$/, "")), ["[PUBLISH_SCAN_HIT] client_name w.txt"]);
});
test("E-413 / D-145 addendum 3: in a NUL blob's views the tilde shapes are off, every literal class still runs", (t) => {
  const scan = nulRepo(t);
  assert.deepEqual(scan("g.wasm", u8("\u0000x\f~ab/c\u0000")), [], "form feed + tilde + a letter is a byte accident");
  assert.deepEqual(scan("g.wasm", u8("\u0000x\f~ab/c /home/carol/src\u0000")).map((x) => x.replace(/:\d+$/, "")),
    ["[PUBLISH_SCAN_HIT] home_path g.wasm"], "a literal home path still hits");
  assert.deepEqual(scan("g.wasm", u8("\u0000 ~Jo Müller/x\u0000")).map((x) => x.replace(/:\d+$/, "")),
    ["[PUBLISH_SCAN_HIT] operator_name g.wasm"], "an operator name after a tilde still hits");
  assert.deepEqual(scan("n.md", u8("cd ~carol/src\n")), ["[PUBLISH_SCAN_HIT] home_path n.md:1"], "NUL-free text keeps the tilde-login rule");
});

// D-145 addendum 4 r1–r3 (extends the E-413 rows above): the separator view is NUL → space, so two
// NUL-separated fields read as the phrase they are; hits fold per (class, value), so two distinct
// addresses are both listed; rein doctor's login advisory never prints the login.
test("D-145 addendum 4: a two-field name hits; two distinct addresses are both listed", (t) => {
  const root = publicRepo(t);
  const run = (bytes) => precommitProblems(root, { files: ["b.bin"], read: () => bytes, author: PUB_ID, committer: PUB_ID });
  assert.deepEqual(run(Buffer.from("x\u0000Ada\u0000Quill\u0000y", "utf8")).map((x) => x.replace(/:\d+$/, "")), ["[PUBLISH_SCAN_HIT] operator_name b.bin"]);
  const two = run(Buffer.from("\u0000jo.rand@zentrocorp.io\u0000li.kas@nordwerk.de\u0000", "utf8"));
  assert.equal(two.filter((x) => x.includes("personal_email")).length, 2, JSON.stringify(two));
});
test("D-145 addendum 4 r3: the login advisory prints only for an unlisted real login, and never the login", (t) => {
  const root = mkdtempSync(join(tmpdir(), "rein-t-pscan-login-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ai = join(root, ".ai");
  mkdirSync(ai);
  assert.equal(loginAdvisory(ai, "/home/qzlogin"), "", "no local list (a clone) → silent");
  writeFileSync(join(ai, "publish-scan.local.json"), JSON.stringify({ client_names: ["Fabrikam"], operator_names: ["Ada Quill"] }));
  const line = loginAdvisory(ai, "/home/qzlogin");
  assert.match(line, /^\[SCAN_LOGIN_UNLISTED\] /);
  assert.ok(!line.toLowerCase().includes("qzlogin"), "never prints the login");
  assert.equal(loginAdvisory(ai, "/home/runner"), "", "a placeholder login → silent");
  writeFileSync(join(ai, "publish-scan.local.json"), JSON.stringify({ client_names: ["Fabrikam"], operator_names: ["Ada Quill", "QZLogin"] }));
  assert.equal(loginAdvisory(ai, "/home/qzlogin"), "", "a listed login (any case) → silent");
});

// security_engineer on the E-413 delta (extends the E-378 P1-5 sixth-class row): in a NUL-bearing
// blob the fake-token mark is not honoured — NUL → space put a distant mark on the token's "line".
test("a NUL-bearing blob: a real token is a secret even with the fake-token mark nearby", (t) => {
  const root = publicRepo(t, { operatorList: false });
  const tok = "gh" + "p_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
  const read = (s) => ({ files: ["u.bin"], read: () => Buffer.from(s, "utf8"), author: PUB_ID, committer: PUB_ID });
  const mark = "privacy:allow" + "-fake-token";
  assert.ok(precommitProblems(root, read(mark + "\u0000" + "x\u0000".repeat(50) + tok + "\u0000")).some((p) => p.includes("secret u.bin")));
  assert.ok(precommitProblems(root, read(mark + " " + tok + "\u0000")).some((p) => p.includes("secret u.bin")), "even on the same line");
});
