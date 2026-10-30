// tests/unit/footprint-recorder.test.mjs — the dynamic footprint recorder (E-297, D-088)
//
// tests/lib/footprint.sh turns node/bash/python3/rein into recording shell functions inside
// every suite. Its whole contract is that no suite can tell: exit status, stdin, stdout,
// stderr, `set -e`, PIPESTATUS and `command -v` must be what they were. That is a process
// boundary, so each case drives /bin/bash (3.2 on macOS — the shell the recorder must
// survive) from node:test rather than adding a bash suite. The last case runs a COPY of
// tests/run.sh over two fixture suites and checks where the census input lands.
//
// Run standalone: node --test tests/unit/footprint-recorder.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, cpSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FP = join(REPO, "tests", "lib", "footprint.sh");
const BASH = "/bin/bash";

function tmp(label) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `rein-t-fp-${label}-`)));
  return { d, done: () => rmSync(d, { recursive: true, force: true }) };
}

// Run a script with the recorder sourced. `rec` = the REIN_TEST_TMPDIR to record into, or
// null for the pass-through mode. REIN_TEST_TMPDIR is always set or removed EXPLICITLY:
// this file itself runs under tests/run.sh, which exports it.
function sh(script, { rec = null, input, env = {} } = {}) {
  const e = { ...process.env, ...env };
  delete e.REIN_TEST_TMPDIR;
  if (rec) e.REIN_TEST_TMPDIR = rec;
  const r = spawnSync(BASH, ["-c", `source '${FP}'\n${script}`, "probe_test.sh"], { encoding: "utf8", input, env: e });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const log = (d) => (existsSync(join(d, "footprint.log")) ? readFileSync(join(d, "footprint.log"), "utf8") : "");

test("exit status, stdout, stderr and stdin are the real binary's", () => {
  const t = tmp("io");
  try {
    const r = sh(`node -e 'process.stdout.write("OUT");process.stderr.write("ERR");process.exit(7)'; echo " rc=$?"`, { rec: t.d });
    assert.equal(r.out, "OUT rc=7\n");
    assert.equal(r.err, "ERR");
    const s = sh(`node -e 'process.stdin.on("data",d=>process.stdout.write(String(d).toUpperCase()))'`, { rec: t.d, input: "piped" });
    assert.equal(s.out, "PIPED");
    const p = sh(`python3 - <<'PY'\nprint("heredoc")\nPY`, { rec: t.d });
    assert.equal(p.out, "heredoc\n");
  } finally { t.done(); }
});

test("set -e: a failure in || / if context is still suppressed, a bare failure still exits", () => {
  // bash 3.2 bug this guards: `builtin command false || x` EXITS a set -e script.
  const r = sh(`set -e\nnode -e 'process.exit(3)' || echo "or:$?"\nif bash -c 'exit 4'; then :; else echo "if:$?"; fi\nnode -e 'process.exit(5)'\necho unreached`);
  assert.equal(r.out, "or:3\nif:4\n");
  assert.equal(r.code, 5);
});

test("PIPESTATUS, prefix assignments and a missing binary behave as without the recorder", () => {
  const r = sh(`node -e 'process.exit(6)' | cat; echo "ps=\${PIPESTATUS[*]}"
FOO=bar node -e 'console.log(process.env.FOO)'; echo "after=\${FOO-unset}"
PATH=/nonexistent node -e 1 2>/dev/null; echo "missing=$?"`);
  assert.equal(r.out, "ps=6 0\nbar\nafter=unset\nmissing=127\n");
});

test("command -v still answers with the PATH of the binary (suites build PATHs from it)", () => {
  const r = sh(`command -v node; command -v bash; type -t node; command -v no-such-cmd-xyz || echo "none:$?"; command printf 'via command\\n'`);
  const [nodePath, bashPath, kind, none, via] = r.out.trim().split("\n");
  assert.match(nodePath, /\/node$/);
  assert.match(bashPath, /\/bash$/);
  assert.equal(kind, "function", "the wrapper is in place…");
  assert.equal(none, "none:1");
  assert.equal(via, "via command");
});

test("records suite, command and a repo-relative target only when REIN_TEST_TMPDIR is set", () => {
  const t = tmp("rec");
  try {
    sh(`node '${REPO}/src/shared/ci-record.mjs' bogus >/dev/null 2>&1
node --input-type=module -e "import '${REPO}/src/shared/ci-record.mjs'" >/dev/null 2>&1
bash -c 'exit 0'
python3 -c 'pass'
node /tmp/elsewhere.mjs 2>/dev/null
[[ abc =~ (b) ]]; node -e 1; echo "\${BASH_REMATCH[1]}"`, { rec: t.d });
    assert.deepEqual(log(t.d).trim().split("\n"), [
      "probe_test.sh\tnode\tsrc/shared/ci-record.mjs",
      "probe_test.sh\tnode\t-e:src/shared/ci-record.mjs",
      "probe_test.sh\tbash\t-c",
      "probe_test.sh\tpython3\t-c",
      "probe_test.sh\tnode\t/tmp/elsewhere.mjs",
      "probe_test.sh\tnode\t-e",
    ]);
    const off = tmp("off");
    try {
      const r = sh(`node -e 1; echo done`, { rec: null, env: { TMPDIR: off.d } });
      assert.equal(r.out, "done\n");
      assert.deepEqual(readdirSync(off.d), [], "pass-through mode writes nothing anywhere");
    } finally { off.done(); }
  } finally { t.done(); }
});

// E-311 (D-092): extends the record test above — the two blind spots the installer survey hit.
test("env … <cmd> is recorded as the command; every installer / rein init run gets an installer line", () => {
  const t = tmp("inst");
  try {
    // NEVER the real src/bin/rein: `rein init` has no --help and would initialise the cwd. A path
    // that does not exist still exercises the recorder (it records before the binary runs).
    const AI = "/nonexistent/src/bin/rein";
    sh(`env -u CI HOME=/nonexistent FOO=1 bash -c 'exit 0'
env HOME=/nonexistent bash /nonexistent/install-rein.sh 2>/dev/null
bash /nonexistent/install-rein.sh 2>/dev/null
bash '${AI}' init >/dev/null 2>&1 </dev/null
bash -c "bash '${AI}' init >/dev/null 2>&1"
bash -c "echo run | grep -q 'rein init'"
bash -c "grep -q install-rein.sh /dev/null"
bash -c 'echo "run: bash install-rein.sh"; echo "then: rein init"'
bash -c "x=1; bash /nonexistent/install-rein.sh 2>/dev/null"
bash -c "cd /nonexistent 2>/dev/null || FOO=1 '${AI}' init 2>/dev/null"
env true
command -v env`, { rec: t.d });
    assert.deepEqual(log(t.d).trim().split("\n"), [
      "probe_test.sh\tbash\t-c",
      "probe_test.sh\tbash\t/nonexistent/install-rein.sh",
      "probe_test.sh\tinstaller\tinstall-rein.sh\tforeign:/nonexistent",
      "probe_test.sh\tbash\t/nonexistent/install-rein.sh",
      "probe_test.sh\tinstaller\tinstall-rein.sh\trun",
      "probe_test.sh\tbash\t/nonexistent/src/bin/rein",
      "probe_test.sh\tinstaller\trein init\trun",
      "probe_test.sh\tbash\t-c:src/bin/rein",
      "probe_test.sh\tinstaller\trein init\trun",
      "probe_test.sh\tbash\t-c",
      "probe_test.sh\tbash\t-c",
      // A stub that only PRINTS the installer's command line is not a run (ai_ci_gate, the
      // first E-311 census); a command after `;` / `||` or an assignment prefix is.
      "probe_test.sh\tbash\t-c",
      "probe_test.sh\tbash\t-c",
      "probe_test.sh\tinstaller\tinstall-rein.sh\trun",
      "probe_test.sh\tbash\t-c:src/bin/rein",
      "probe_test.sh\tinstaller\trein init\trun",
    ], "a grep or echo of the name is not an installer run; `env true` records nothing");
    assert.match(sh("command -v env").out, /^\/.*\/env\n$/, "command -v env still prints the binary's path");
  } finally { t.done(); }
});

// E-312 (D-093): extends the installer test above — every installer line carries the HOME
// class of its spawn, which decides whether the suite may share a lane.
test("an installer / rein init line carries its spawn's HOME class: tmp, run, unknown or foreign:<path>", () => {
  const t = tmp("home");
  try {
    const AI = "/nonexistent/src/bin/rein";   // never the real binary (see the test above)
    const th = join(t.d, "rein-t-home-x");  // a harness temp dir, by its prefix
    sh(`HOME='${th}' bash /nonexistent/install-rein.sh 2>/dev/null
env HOME='${th}' bash '${AI}' init >/dev/null 2>&1 </dev/null
bash -c "HOME='${th}' bash /nonexistent/install-rein.sh 2>/dev/null"
bash -c 'HOME="$H" bash /nonexistent/install-rein.sh 2>/dev/null'
env -i bash /nonexistent/install-rein.sh 2>/dev/null
env -u HOME bash '${AI}' init >/dev/null 2>&1 </dev/null
HOME=/srv/shared bash /nonexistent/install-rein.sh 2>/dev/null
bash /nonexistent/install-rein.sh 2>/dev/null`, { rec: t.d });
    const homes = log(t.d).trim().split("\n").filter((l) => l.includes("\tinstaller\t")).map((l) => l.split("\t")[3]);
    assert.deepEqual(homes, ["tmp", "tmp", "tmp", "unknown", "unknown", "unknown", "foreign:/srv/shared", "run"]);
  } finally { t.done(); }
});

test("overhead per recorded call is small next to the spawn it wraps (same-host baseline)", (ctx) => {
  // The clock is perl's (bash 3.2 has no sub-second time). Optional need → a recorded SKIP.
  if (spawnSync("perl", ["-MTime::HiRes", "-e", "1"]).status !== 0) { ctx.skip("perl with Time::HiRes is not installed"); return; }
  const t = tmp("perf");
  try {
    // Wrapper machinery only: `command true` resolves to the builtin, so no exec is timed.
    const N = 500;
    const r = sh(`w() { _rein_fp_record node '${REPO}/src/shared/ci-record.mjs' record --x; command true; }
s=$(perl -MTime::HiRes=time -e 'printf "%d", time()*1e6'); for ((i=0;i<${N};i++)); do w; done
e=$(perl -MTime::HiRes=time -e 'printf "%d", time()*1e6')
b0=$(perl -MTime::HiRes=time -e 'printf "%d", time()*1e6'); for ((i=0;i<5;i++)); do command node -e ''; done
b1=$(perl -MTime::HiRes=time -e 'printf "%d", time()*1e6')
echo "$(( (e - s) / ${N} )) $(( (b1 - b0) / 5 ))"`, { rec: t.d });
    const [perCallUs, spawnUs] = r.out.trim().split(" ").map(Number);
    console.log(`  recorder: ${perCallUs} µs per call; baseline node spawn: ${spawnUs} µs on this host`);
    assert.ok(Number.isFinite(perCallUs) && perCallUs > 0, r.out + r.err);
    assert.equal(log(t.d).trim().split("\n").length, N, "every call recorded");
    if (process.env.CI === "true") assert.ok(perCallUs < 1000, `${perCallUs} µs ≥ 1 ms budget (CI, absolute)`);
    else assert.ok(perCallUs <= 0.1 * spawnUs + 500, `${perCallUs} µs > 10% of a node spawn (${spawnUs} µs) + 0.5 ms`);
  } finally { t.done(); }
});

test("tests/run.sh: census input per suite, in the CI log block and a $TMPDIR copy; nested runs publish nothing", () => {
  const t = tmp("runner");
  try {
    const R = t.d;
    mkdirSync(join(R, "tests", "suites"), { recursive: true });
    mkdirSync(join(R, "src", "shared"), { recursive: true });
    mkdirSync(join(R, "tmp"));
    mkdirSync(join(R, "home"));
    cpSync(join(REPO, "tests", "run.sh"), join(R, "tests", "run.sh"));
    cpSync(join(REPO, "tests", "lib"), join(R, "tests", "lib"), { recursive: true });
    // E-345: run.sh refuses to start without its fixture-home census and exemptions.
    cpSync(join(REPO, "tests", "tools", "fixture-home-census.mjs"), join(R, "tests", "tools", "fixture-home-census.mjs"));
    cpSync(join(REPO, "tests", "fixtures", "fixture-home-exemptions.json"), join(R, "tests", "fixtures", "fixture-home-exemptions.json"));
    writeFileSync(join(R, "src", "shared", "x.mjs"), "export const x = 1;\n");
    const head = '#!/usr/bin/env bash\nR="$(cd "$(dirname "$0")/../.." && pwd)"\nsource "$R/tests/lib/assert.sh"\n';
    writeFileSync(join(R, "tests", "suites", "one_test.sh"),
      `${head}node "$R/src/shared/x.mjs"; node "$R/src/shared/x.mjs"\nassert_status 0 "ok" true\nassert_summary\n`);
    writeFileSync(join(R, "tests", "suites", "two_test.sh"), `${head}bash -c 'exit 0'\n_fail "deliberate"\nassert_summary\n`);
    const run = (extra) => {
      const e = { ...process.env, HOME: join(R, "home"), TMPDIR: join(R, "tmp"), REIN_TEST_NO_SWEEP: "1", AI_TELEMETRY_DISABLE: "1", ...extra };
      for (const k of ["REIN_TEST_TMPDIR", "REIN_TEST_SUITES_DIR", "CI"]) if (!(k in extra)) delete e[k];
      return spawnSync(BASH, [join(R, "tests", "run.sh")], { encoding: "utf8", env: e, cwd: R });
    };
    const ci = run({ REIN_CI: "local" });
    assert.equal(ci.status, 1, "two_test fails deliberately");
    const block = ci.stdout.slice(ci.stdout.indexOf("── census input"), ci.stdout.indexOf("━━ Results"));
    assert.match(block, /^CENSUS_SUITE\tone_test\.sh\t\d+\t1\t0\t0\t0$/m);
    assert.match(block, /^CENSUS_SUITE\ttwo_test\.sh\t\d+\t0\t1\t0\t0$/m);
    assert.match(block, /^CENSUS_FP\tone_test\.sh\t2\tnode\tsrc\/shared\/x\.mjs$/m, "attributed, counted, repo-relative");
    assert.match(block, /^CENSUS_FP\ttwo_test\.sh\t1\tbash\t-c$/m);
    assert.match(block, /^CENSUS_TOTAL\t2\t1\t1\t0$/m);
    const copies = readdirSync(join(R, "tmp")).filter((f) => /^rein-census-.*\.tsv$/.test(f));
    assert.equal(copies.length, 1);
    assert.match(ci.stdout, new RegExp(`Census input: .*${copies[0]}`));

    const plain = run({ REIN_CI: "" });
    assert.doesNotMatch(plain.stdout, /CENSUS_SUITE/, "a plain run prints only the path, not the block");
    assert.match(plain.stdout, /Census input: /);

    for (const f of readdirSync(join(R, "tmp"))) rmSync(join(R, "tmp", f), { recursive: true, force: true });
    const nested = run({ REIN_CI: "local", REIN_TEST_TMPDIR: join(R, "outer") });
    assert.doesNotMatch(nested.stdout, /CENSUS_|Census input/, "a runner started by a suite publishes nothing");
    assert.deepEqual(readdirSync(join(R, "tmp")).filter((f) => f.startsWith("rein-census-")), []);
  } finally { t.done(); }
});
