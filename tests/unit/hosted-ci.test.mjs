// hosted-ci.test.mjs — `rein ci hosted`: provider detection, the bootstrap variant, --check /
// --force, team.json ci (E-335, D-103 rulings 2-5).
//
// New module, new file. The wrapper CONTENT (two run steps, no copied recipe command, the
// contract clauses) is tests/unit/hosted-ci-workflow.test.mjs; this file covers the generator
// against throwaway git repositories.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { detectProvider, remoteHost, hosted, doctorLine, bootstrapFor, PROVIDERS, matrixFor, requiredChecks, profileFor, INFORMATIVE_LEGS } from "../../src/shared/hosted-ci.mjs";
import { newTeam, writeTeam, readTeam, validateTeam } from "../../src/mcp/shared/team.mjs";

const PLANNER = "planner@example.com", OTHER = "dev@example.com";
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * A downstream project: git repo, origin <url>, .ai/<pinFile> pinning <version>, and
 * refs/remotes/origin/<trunk> (E-341: the rendered trunk; null leaves none, so it resolves to nothing).
 */
function project(t, { origin = "https://github.com/acme/app.git", version = "4.0.0", pinFile = "state.json", email = PLANNER, trunk = "main" } = {}) {
  const d = mkdtempSync(join(tmpdir(), "rein-hosted-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  git(d, "init", "-q");
  git(d, "config", "user.email", email);
  if (origin) git(d, "remote", "add", "origin", origin);
  if (trunk) {
    git(d, "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "seed");
    git(d, "update-ref", `refs/remotes/origin/${trunk}`, "HEAD");
  }
  mkdirSync(join(d, ".ai"));
  if (version !== null) {
    const body = pinFile === "project.json" ? { rein_version: version } : { project: { rein_version: version }, tasks: [] };
    writeFileSync(join(d, ".ai", pinFile), JSON.stringify(body));
  }
  return d;
}
const wrapper = (d) => join(d, PROVIDERS.github.path);

test("detectProvider: cloud hosts in https, ssh and scp form; anything else is not guessed", () => {
  const rows = [
    ["https://github.com/a/b.git", "github"], ["git@github.com:a/b.git", "github"], ["ssh://git@ssh.github.com:443/a/b.git", "github"],
    ["https://dev.azure.com/org/proj/_git/repo", "azure"], ["git@ssh.dev.azure.com:v3/org/proj/repo", "azure"],
    ["https://org.visualstudio.com/proj/_git/repo", "azure"], ["org@vs-ssh.visualstudio.com:v3/org/proj/repo", "azure"],
    ["https://gitlab.com/a/b.git", "gitlab"], ["git@bitbucket.org:a/b.git", "bitbucket"],
    ["https://gitlab.example.com/a/b.git", null], ["https://tfs.corp.local/tfs/DefaultCollection/_git/r", null],
    ["https://github.com.evil.io/a/b.git", null], ["/srv/git/b.git", null], ["", null],
  ];
  for (const [url, want] of rows) assert.equal(detectProvider(url), want, url);
  assert.equal(remoteHost("git@GitHub.com:a/b.git"), "github.com");
});

test("a downstream project renders the clone-at-tag bootstrap naming its pinned version", (t) => {
  const d = project(t, { version: "4.0.0" });
  const r = hosted(d);
  assert.equal(r.code, 0, r.out);
  const yml = readFileSync(wrapper(d), "utf8");
  assert.match(yml, /run: git clone --quiet --depth 1 --branch v4\.0\.0 https:\/\/github\.com\/Vimurai\/rein\.git "\$\{TMPDIR:-\/tmp\}\/rein-src" && bash "\$\{TMPDIR:-\/tmp\}\/rein-src"\/install-rein\.sh\n/);
  assert.doesNotMatch(yml, /^\s+run: bash install-rein\.sh$/m, "the self bootstrap belongs to the Rein repository only");
  assert.match(r.out, /Branch policy \(D-103 r5\): GitHub → Settings → Branches → main: .*do NOT restrict pushes .*claims push \.ai\/\*\* to main\./);
  assert.doesNotMatch(r.out, /CI_PROVIDER_UNVERIFIED/, "github is ready: no unverified notice");
  // E-341 (D-105 r5): the project's trunk (here origin/main), not a literal master.
  assert.match(yml, /^  pull_request:\n    branches: \[main\]$/m);
  assert.doesNotMatch(yml, /\bmaster\b/);
});

// E-341 (D-105 r2, r5): no resolvable trunk renders nothing; a name YAML cannot carry is refused.
test("an unresolved trunk is [NO_TRUNK] and a trunk outside the plain charset is [CI_TRUNK_INVALID]; nothing is written", (t) => {
  const none = project(t, { trunk: null });
  let r = hosted(none);
  assert.equal(r.code, 1);
  assert.match(r.out, /^\[NO_TRUNK\] NO_TRUNK: no origin\/HEAD and neither origin\/main nor origin\/master — set "trunk"/);
  assert.equal(existsSync(wrapper(none)), false);
  const odd = project(t, { trunk: "rel]x" });
  r = hosted(odd);
  assert.equal(r.code, 1);
  assert.match(r.out, /^\[NO_TRUNK\] NO_TRUNK/, "rel]x is neither main nor master, so it does not resolve");
  writeFileSync(join(odd, ".ai", "team.json"), JSON.stringify({ schema: 1, planner: PLANNER, claim_ttl_days: 7, shared_log: false, members: {}, trunk: "rel#x" }));
  r = hosted(odd);
  assert.match(r.out, /^\[CI_TRUNK_INVALID\] trunk "rel#x" \(from team\.json\)/);
  assert.equal(existsSync(wrapper(odd)), false);
});

test("the pin comes from project.json in a team store, else state.json (pre-field projects)", (t) => {
  assert.match(bootstrapFor(project(t, { version: "4.1.0", pinFile: "project.json" })).command, /--branch v4\.1\.0 /);
  assert.match(bootstrapFor(project(t, { version: "3.9.2", pinFile: "state.json" })).command, /--branch v3\.9\.2 /);
  const none = hosted(project(t, { version: null }));
  assert.equal(none.code, 1);
  assert.match(none.out, /^\[CI_REIN_VERSION_UNKNOWN\]/);
  assert.match(hosted(project(t, { version: "4.0.0; rm -rf ~" })).out, /^\[CI_REIN_VERSION_UNKNOWN\]/);
});

test("--check passes on the rendering, fails on a hand edit; an edit needs --force to replace", (t) => {
  const d = project(t);
  assert.equal(hosted(d, { check: true }).code, 1, "missing wrapper fails --check");
  hosted(d);
  assert.equal(hosted(d, { check: true }).code, 0);
  writeFileSync(wrapper(d), readFileSync(wrapper(d), "utf8").replace("timeout-minutes: 60", "timeout-minutes: 5"));
  const chk = hosted(d, { check: true });
  assert.equal(chk.code, 1);
  assert.match(chk.out, /differs from the current github rendering — run: rein ci hosted github --force/);
  const refused = hosted(d);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /^\[WRAPPER_DIFFERS\]/);
  assert.match(readFileSync(wrapper(d), "utf8"), /timeout-minutes: 5/, "a refusal writes nothing");
  assert.equal(hosted(d, { force: true }).code, 0);
  assert.equal(hosted(d, { check: true }).code, 0);
});

test("an unrecognised host without an argument fails with [CI_PROVIDER_UNKNOWN] and writes nothing", (t) => {
  for (const origin of ["https://gitlab.example.com/a/b.git", null]) {
    const d = project(t, { origin });
    const r = hosted(d);
    assert.equal(r.code, 2);
    assert.match(r.out, /^\[CI_PROVIDER_UNKNOWN\] .*name the provider: rein ci hosted </);
    assert.equal(existsSync(wrapper(d)), false);
  }
  const named = project(t, { origin: "https://gitlab.example.com/a/b.git" });
  assert.equal(hosted(named, { provider: "github" }).code, 0, "an explicit provider is never guessed");
});

test("gitlab and bitbucket are [CI_PROVIDER_PLANNED] until their task ships a documented run", (t) => {
  for (const [provider, origin] of [["gitlab", "https://gitlab.com/a/b.git"], ["bitbucket", "git@bitbucket.org:a/b.git"]]) {
    const d = project(t, { origin });
    const r = hosted(d);
    assert.equal(r.code, 1, provider);
    assert.match(r.out, new RegExp(`^\\[CI_PROVIDER_PLANNED\\] ${provider} `));
    assert.equal(existsSync(join(d, PROVIDERS[provider].path)), false);
  }
});

test("team.json ci: the planner records it; anyone else renders but is told, and the file is untouched", (t) => {
  const d = project(t, { email: PLANNER });
  writeTeam(join(d, ".ai"), newTeam(PLANNER, { E: [[1, 99]] }));
  assert.match(hosted(d).out, /✓ \.ai\/team\.json ci = github/);
  assert.deepEqual(readTeam(join(d, ".ai")).ci, { provider: "github", required_check: "rein ci run" });

  const e = project(t, { email: OTHER });
  writeTeam(join(e, ".ai"), newTeam(PLANNER, { E: [[1, 99]] }));
  const before = readFileSync(join(e, ".ai", "team.json"), "utf8");
  const r = hosted(e);
  assert.equal(r.code, 0);
  assert.match(r.out, /\[NOT_PLANNER\] dev@example\.com is not the planner/);
  assert.equal(readFileSync(join(e, ".ai", "team.json"), "utf8"), before);
  assert.equal(existsSync(wrapper(e)), true, "the wrapper is still rendered");
});

test("team.json ci.provider wins over the origin host; rein_source is held to a plain https URL", (t) => {
  const d = project(t, { origin: "https://gitlab.example.com/a/b.git" });
  writeTeam(join(d, ".ai"), { ...newTeam(PLANNER, { E: [[1, 99]] }), ci: { provider: "github", required_check: "rein ci run", rein_source: "https://git.corp.example/mirror/rein.git" } });
  const r = hosted(d);
  assert.equal(r.code, 0, r.out);
  assert.match(readFileSync(wrapper(d), "utf8"), / https:\/\/git\.corp\.example\/mirror\/rein\.git "/);
  for (const bad of ["http://plain.example/x.git", "https://x.example/a b.git", "https://x.example/a.git;id", "file:///etc/x"]) {
    assert.throws(() => validateTeam({ ...newTeam(PLANNER, { E: [[1, 9]] }), ci: { provider: "github", required_check: "rein ci run", rein_source: bad } }), /rein_source/, bad);
  }
  assert.throws(() => validateTeam({ ...newTeam(PLANNER, { E: [[1, 9]] }), ci: { provider: "jenkins", required_check: "x" } }), /ci\.provider/);
  assert.throws(() => validateTeam({ ...newTeam(PLANNER, { E: [[1, 9]] }), ci: { provider: "github", required_check: "x\n- run: id" } }), /ci\.required_check/);
});

test("doctor: none, current, differs, and an origin/team.json mismatch is a warning", (t) => {
  const d = project(t);
  assert.equal(doctorLine(d), "  - hosted check: none (optional — rein ci hosted)");
  hosted(d);
  assert.match(doctorLine(d), /^  ✓ hosted check: github — .* is the current github rendering/);
  writeFileSync(wrapper(d), "edited\n");
  assert.match(doctorLine(d), /^  ✗ hosted check: github — .* differs/);
  const m = project(t, { origin: "https://gitlab.com/o/r.git" });
  writeTeam(join(m, ".ai"), { ...newTeam(PLANNER, { E: [[1, 99]] }), ci: { provider: "github", required_check: "rein ci run" } });
  hosted(m);
  assert.match(doctorLine(m), /\(origin is gitlab, team\.json\.ci says github\)$/);
});

test("a symlinked .github leading outside the repository is refused, nothing written there", (t) => {
  const d = project(t);
  const outside = mkdtempSync(join(tmpdir(), "rein-hosted-out-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  symlinkSync(outside, join(d, ".github"));
  const r = hosted(d);
  assert.equal(r.code, 1);
  assert.match(r.out, /^\[WRAPPER_OUTSIDE_REPO\]/);
  assert.equal(existsSync(join(outside, "workflows", "ci.yml")), false);
});

test("the CLI: --root is required, an unknown argument exits 2, --check's exit is the verdict", (t) => {
  const cli = join(dirname(fileURLToPath(import.meta.url)), "../../src/shared/hosted-ci.mjs");
  const run = (...a) => spawnSync(process.execPath, ["--no-warnings", cli, ...a], { encoding: "utf8" });
  assert.equal(run("--check").status, 2);
  const d = project(t);
  assert.equal(run("--root", d, "--bogus").status, 2);
  assert.equal(run("--root", d, "--check").status, 1, "missing wrapper");
  const w = run("--root", d, "github");
  assert.equal(w.status, 0, w.stdout + w.stderr);
  assert.equal(run("--root", d, "--check").status, 0);
  assert.match(run("--root", d, "--doctor").stdout, /^  ✓ hosted check: github/);
});

test("azure: a dev.azure.com origin is detected, writes azure-pipelines.yml + team.json ci, prints the policy — UNVERIFIED", (t) => {
  const d = project(t, { origin: "https://dev.azure.com/acme/app/_git/app" });
  writeTeam(join(d, ".ai"), newTeam(PLANNER, { E: [[1, 99]] }));
  const r = hosted(d);                                   // no argument: detected from origin
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /✓ azure-pipelines\.yml written \(azure, pinned bootstrap\)/);
  assert.match(r.out, /Branch policy \(D-103 r5\): Azure DevOps .*Build Validation .*Required.*Bypass policies when pushing/);
  assert.match(r.out, /\[CI_PROVIDER_UNVERIFIED\] the azure wrapper has not had a documented run/);
  assert.deepEqual(readTeam(join(d, ".ai")).ci, { provider: "azure", required_check: "rein ci run" });
  const yml = readFileSync(join(d, "azure-pipelines.yml"), "utf8");
  assert.match(yml, /^  - bash: git clone --quiet --depth 1 --branch v4\.0\.0 /m);
  assert.equal(existsSync(wrapper(d)), false, "no GitHub workflow for an Azure project");
  assert.equal(hosted(d, { check: true }).code, 0);
  assert.match(doctorLine(d), /^  ✓ hosted check: azure — azure-pipelines\.yml is the current azure rendering/);
});

// E-384 (D-135 r3, r5, r7): extends the render tests above — what the project's runner
// advertises and its marker decide the jobs, and the branch policy names every leg.
test("the matrix follows the project: --tier → a fast job, --shard → team.json ci.shards (default 4), publish.json → the public legs", (t) => {
  const d = project(t);
  mkdirSync(join(d, "tests"));
  writeFileSync(join(d, "tests", "run.sh"), "#!/usr/bin/env bash\n# no flags\n");
  assert.deepEqual(matrixFor(d, null), { fast: false, shards: 1, profile: "team" });
  assert.deepEqual(requiredChecks(d, null), ["rein ci run (ubuntu-latest, node 22)"]);
  writeFileSync(join(d, "tests", "run.sh"), "#!/usr/bin/env bash\n# --tier fast|full, --shard i/N\n");
  assert.deepEqual(matrixFor(d, null), { fast: true, shards: 4, profile: "team" });
  const team = { ...newTeam(PLANNER, { E: [[1, 9]] }), ci: { provider: "github", required_check: "rein ci run", shards: 2 } };
  assert.deepEqual(requiredChecks(d, team), ["fast", "rein ci run (ubuntu-latest, node 22, 1/2)", "rein ci run (ubuntu-latest, node 22, 2/2)"]);
  writeFileSync(join(d, ".ai", "publish.json"), "{}");
  assert.equal(profileFor(d), "public");
  // D-137 r1–r3 (E-399): the exact required set. E-388/E-396 emptied INFORMATIVE_LEGS
  // (DEVOPS-017): fast + the eight Ubuntu legs + the four macOS × 22 legs.
  const legs = [["ubuntu-latest", "22"], ["ubuntu-latest", "24"], ["macos-latest", "22"]]
    .flatMap(([os, n]) => [1, 2, 3, 4].map((i) => `rein ci run (${os}, node ${n}, ${i}/4)`));
  assert.deepEqual(requiredChecks(d, null), ["fast", ...legs]);
  assert.deepEqual(INFORMATIVE_LEGS, []);
  const r = hosted(d, { provider: "github" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /^Required checks \(D-135 r7, public profile\): "fast", "rein ci run \(ubuntu-latest, node 22, 1\/4\)", /m);
  assert.match(readFileSync(wrapper(d), "utf8"), /^  fast:\n    name: fast\n/m);
  assert.match(readFileSync(wrapper(d), "utf8"), /^        os: \[ubuntu-latest, macos-latest\]$/m, "the macOS leg runs");
});

test("team.json ci.shards is a whole number 1..8", () => {
  const base = { ...newTeam(PLANNER, { E: [[1, 9]] }) };
  for (const shards of [1, 4, 8]) validateTeam({ ...base, ci: { provider: "github", required_check: "rein ci run", shards } });
  for (const shards of [0, 9, 2.5, "4"]) {
    assert.throws(() => validateTeam({ ...base, ci: { provider: "github", required_check: "rein ci run", shards } }), /ci\.shards/, String(shards));
  }
});
