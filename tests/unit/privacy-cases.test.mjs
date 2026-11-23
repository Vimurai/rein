// privacy-cases.test.mjs — E-379 (D-130, open-source-release.md §Component 10): redact() and
// every automated writer into a project's tracked .ai/ or .claude/. Extends the E-372 rows of
// publish-scan.test.mjs (the scan classes) with the write-time side; a new file only because
// redact() counts under $HOME and the whole file runs with HOME pointed at a temp dir (rule 6).
// One row per class and one per wrapped writer: tests/fixtures/privacy-cases.json. The stop
// hook's row is a process boundary and lives in hooks_surface_test.sh. Every name, address,
// path and token below is invented.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { tcFixtureHome } = await import("../lib/toolchain-fixture.mjs");
const HOME = mkdtempSync(join(tmpdir(), "rein-t-privacy-home-"));
tcFixtureHome(HOME);   // E-345 (D-109 r1): the run's writers spawn git, node and the map CLI under this HOME
const _home = process.env.HOME;
process.env.HOME = HOME;
after(() => { process.env.HOME = _home; rmSync(HOME, { recursive: true, force: true }); });

const { redact, redactedToday, REDACT_WRITERS } = await import("../../src/shared/publish-scan.mjs");
const { getDbSeeded, addTask, completeTask, regenerateViews } = await import("../../src/mcp/shared/state-db.js");
const { insertStamp, setProject } = await import("../../src/mcp/shared/record-store.mjs");
const { appendLog, newTeam, writeTeam } = await import("../../src/mcp/shared/team.mjs");
const { writeCiRecord } = await import("../../src/mcp/shared/ci-evidence.mjs");
const { hosted, PROVIDERS } = await import("../../src/shared/hosted-ci.mjs");

const ROWS = JSON.parse(readFileSync(join(REPO, "tests/fixtures/privacy-cases.json"), "utf8"));
const LISTS = { client_names: ["Fabrikam"], operator_names: ["Ada Quill"] };
const lists = { clientNames: LISTS.client_names, operatorNames: LISTS.operator_names };
// Built from parts: the committed text never carries a planted value (the E-365 zero-hit scan).
const CAROL = "/ho" + "me/carol", DAVE = "/ho" + "me/dave", JANE = "jane@" + "corpmail.net";
const PAYLOAD = `see ${CAROL}/x, mail ${JANE}, by Ada Quill for Fabrikam`;
const NEEDLES = [CAROL, JANE, "Ada Quill", "Fabrikam"];
const quiet = () => {};

// ── the classes ─────────────────────────────────────────────────────────────
for (const r of ROWS.filter((x) => x.kind === "class")) {
  test(`E-379 class: ${r.label}`, () => {
    const input = r.input ?? r.input_parts.join("");
    const env = r.env || {};
    const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
    Object.assign(process.env, env);
    try {
      const l = r.lists === "none" ? { clientNames: [], operatorNames: [] }
        : r.lists === "nfd" ? { clientNames: [], operatorNames: ["An\u0303a Quill".normalize("NFC")] }
        : r.lists === "hyphen" ? { clientNames: [], operatorNames: ["Ada Quill", "Ana-Maria Quill"] } : lists;
      assert.equal(redact(input, { lists: l, log: quiet }), r.want ?? r.want_parts.join(""));
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });
}

test("E-379: long input stays linear (security P2-1: the address pattern, repeated hits)", () => {
  const t0 = Date.now();
  redact("a".repeat(200_000), { lists, log: quiet });
  redact(`${JANE} `.repeat(20_000), { lists, log: quiet, count: false });
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, `took ${ms} ms`);
});

test("E-379: a redaction logs one [PRIVACY_REDACTED] line per class and counts for rein doctor", () => {
  const before = redactedToday(HOME), lines = [];
  redact(`cd ${CAROL}; cd ${DAVE}; mail ${JANE}`, { file: ".ai/x", lists, log: (l) => lines.push(l) });
  assert.deepEqual(lines.sort(), ["[PRIVACY_REDACTED] home_path .ai/x", "[PRIVACY_REDACTED] personal_email .ai/x"]);
  assert.equal(redactedToday(HOME) - before, 3);
  assert.equal(redact(`cd ${CAROL}`, { lists, count: false, log: () => assert.fail("count:false logs nothing") }), "cd [redacted:home_path]");
  assert.equal(redactedToday(HOME) - before, 3, "count:false does not count");
});

// ── the writers ─────────────────────────────────────────────────────────────
const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function project(t) {
  const root = mkdtempSync(join(tmpdir(), "rein-t-privacy-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.email", "dev-a@example.com");
  git(root, "config", "user.name", "Dev A");
  git(root, "config", "commit.gpgsign", "false");
  mkdirSync(join(root, ".ai"));
  writeFileSync(join(root, ".ai", ".gitignore"), "state.sqlite*\npublish-scan.local.json\n");
  writeFileSync(join(root, ".ai", "publish-scan.local.json"), JSON.stringify(LISTS));
  return { root, ai: join(root, ".ai") };
}
const clean = (text, where) => {
  for (const n of NEEDLES) assert.ok(!text.toLowerCase().includes(n.toLowerCase()), `${where} still carries ${n}`);
  assert.match(text, /\[redacted:/, `${where} shows the redaction`);
};
const read = (...p) => readFileSync(join(...p), "utf8");

const WRITERS = {
  task_description(t) {
    const { ai } = project(t);
    const db = getDbSeeded(ai);
    addTask(ai, db, { owner: "Engineer (Claude)", description: PAYLOAD });
    regenerateViews(ai, db);
    clean(read(ai, "TASKS.md"), "TASKS.md");
    clean(read(ai, "state.json"), "state.json");
  },
  task_summary(t) {
    const { ai } = project(t);
    const db = getDbSeeded(ai);
    addTask(ai, db, { owner: "Engineer (Claude)", description: "build it" });
    completeTask(ai, db, "E-1", PAYLOAD);
    regenerateViews(ai, db);
    clean(read(ai, "TASKS.md"), "TASKS.md");
    clean(read(ai, "state.json"), "state.json");
  },
  stamp_summary(t) {
    const { ai } = project(t);
    const db = getDbSeeded(ai);
    insertStamp(ai, db, { type: "SEC_PASS", agent: "critic_security", task_id: null, timestamp: "2026-10-28T10:00:00.000Z", summary: PAYLOAD });
    regenerateViews(ai, db);
    clean(read(ai, "REVIEWS.md"), "REVIEWS.md");
    clean(read(ai, "state.json"), "state.json");
  },
  log_line(t) {
    const { ai } = project(t);
    writeFileSync(join(ai, "LOG.md"), "# LOG\n");
    appendLog(ai, `2026-10-28 | Claude | E-1 | ${PAYLOAD}`);
    clean(read(ai, "LOG.md"), "LOG.md");
  },
  ci_evidence(t) {
    const { ai } = project(t);
    writeTeam(ai, newTeam("dev-a@example.com", { E: [[1, 99]] }));
    const r = writeCiRecord(ai, { sha: "a".repeat(40), status: "PASS", started_at: "2026-10-28T10:00:00Z", finished_at: "2026-10-28T10:09:00Z" }, { host: "carol-at-Fabrikam" });
    assert.equal(r.written, true, JSON.stringify(r));
    const rec = JSON.parse(read(r.path));
    assert.equal(rec.host, "carol-at-[redacted:client_name]");
    assert.equal(rec.runner, "dev-a@example.com", "the runner is identity metadata and is kept");
  },
  hosted_ci(t) {
    const { root, ai } = project(t);
    git(root, "remote", "add", "origin", "https://github.com/acme/app.git");
    git(root, "commit", "-q", "--allow-empty", "-m", "seed");
    git(root, "update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(ai, "state.json"), JSON.stringify({ project: { rein_version: "4.0.0" }, tasks: [] }));
    writeTeam(ai, { ...newTeam("dev-a@example.com", { E: [[1, 99]] }, "main"),
      ci: { provider: "github", required_check: "rein ci run", rein_source: "https://git.example.com/Fabrikam/rein.git" } });
    const first = hosted(root, { provider: "github" });
    assert.equal(first.code, 0, first.out);
    const wrapper = read(root, PROVIDERS.github.path);
    assert.ok(!/fabrikam/i.test(wrapper), "the wrapper still names the client");
    assert.match(wrapper, /\[redacted:client_name\]/);
    assert.equal(hosted(root, { provider: "github", check: true, gh: () => null }).code, 0, "a redacted wrapper is the current rendering");  // E-407: no gh call
  },
  project_focus(t) {
    const { ai } = project(t);
    const db = getDbSeeded(ai);
    setProject(ai, db, { focus: PAYLOAD, release_verdict: `blocked by ${JANE}` });
    regenerateViews(ai, db);
    clean(read(ai, "state.json"), "state.json project");
  },
  // The LOG writer inside a CLI entry point is checked at its write line: the line it appends is
  // the redact() call's result (its process boundary is not the behaviour). E-467 (D-170 r5)
  // retired the handover, repo_map, instinct_stager, advisor_ruling and stop_hook writers.
  ai_clean_log() {
    assert.match(read(REPO, "src/shared/rein-clean.mjs"), /appendFileSync\(projLog, redact\(/);
  },
};

for (const r of ROWS.filter((x) => x.kind === "writer")) {
  test(`E-379 writer: ${r.label}`, (t) => {
    assert.ok(WRITERS[r.writer], `no runner for ${r.writer}`);
    WRITERS[r.writer](t);
  });
}

test("E-379: every writer row has a runner and rein doctor counts the wrapped writers", () => {
  const rows = ROWS.filter((x) => x.kind === "writer").map((x) => x.writer);
  assert.deepEqual(rows.sort(), Object.keys(WRITERS).sort());
  assert.equal(REDACT_WRITERS.length, 7);
});

test("E-379: what lives under the install directory is not tracked — telemetry, incidents", () => {
  // The readers and writers of these files resolve them under $HOME/.rein, never under a project.
  for (const [f, needle] of [["src/shared/telemetry.mjs", ".rein"], ["src/shared/incident-append.mjs", ".rein"]]) {
    assert.ok(read(REPO, f).includes(needle), `${f} resolves under the install directory`);
  }
  assert.deepEqual(readdirSync(HOME).filter((d) => d !== ".rein"), [], "the redactor writes nothing in HOME but its counter");
});
