// waiting-signal.test.mjs — E-433 (D-160 + addendum 1; release-artifact.md §Component 7): the
// "waiting on the operator" pane signal. New file: no test covered pane options set by a hook.
// The event table is tests/fixtures/waiting-signal-cases.json, driven through rein_ws_dispatch
// (src/shared/waiting-signal.sh) with a stub tmux on PATH. The hook itself pins PATH (E-286), so
// the rows that run hooks/waiting-signal.sh use a fixture HOME (tcFixtureHome) and reach tmux
// only through the toolchain record — the D-160 addendum 1 rule this file also pins.
// Needs bash; the real-server row needs tmux (skipped without it).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tcFixtureHome } from "../lib/toolchain-fixture.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const HELPER = join(repo, "src/shared/waiting-signal.sh");
const HOOK = join(repo, "hooks/waiting-signal.sh");
const { rows } = JSON.parse(readFileSync(join(repo, "tests/fixtures/waiting-signal-cases.json"), "utf8"));
const PANE_OPTS = JSON.parse(readFileSync(join(repo, "tests/fixtures/release/pane-options.json"), "utf8")).options;
const PANE = "%7";

const tmp = mkdtempSync(join(tmpdir(), "rein-ws-"));
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

// A stub tmux that logs its argv, one call per line.
function stubTmux(dir) {
  mkdirSync(dir, { recursive: true });
  const log = join(dir, "calls.log");
  writeFileSync(join(dir, "tmux"), `#!/bin/bash\nprintf '%s\\n' "$*" >> '${log}'\n`);
  chmodSync(join(dir, "tmux"), 0o755);
  return { bin: join(dir, "tmux"), log, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : []) };
}
// Each call, read as the effect it has on the pane.
function effects(calls) {
  return calls.map((c) => {
    if (c.includes(`-pu -t ${PANE} @rein_signals`)) return "signals:off";
    if (c.includes(`-p -t ${PANE} @rein_signals waiting`)) return "signals:on";
    if (c.includes(`-pu -t ${PANE} @rein_waiting `) && c.includes("@rein_waiting_since")) return "clear";
    const m = new RegExp(`-p -t ${PANE} @rein_waiting (\\S+) ; set-option -p -t ${PANE} @rein_waiting_since \\d+$`).exec(c);
    return m ? `set:${m[1]}` : `UNEXPECTED:${c}`;
  });
}
const stateFile = (home) => join(home, ".rein", "run", "waiting", PANE.slice(1));

function dispatch(row, { env = {}, home } = {}) {
  const s = stubTmux(join(home, "stub"));
  const args = [row.event, row.nt || "", row.tool || "", row.id || ""];
  const r = spawnSync("bash", ["-c", '. "$1"; shift; rein_ws_dispatch "$@"', "_", HELPER, ...args], {
    encoding: "utf8",
    env: { PATH: `${dirname(s.bin)}:/usr/bin:/bin`, HOME: home, TMUX: join(home, "sock") + ",1,0", TMUX_PANE: PANE, ...env },
  });
  return { ...r, calls: s.calls() };
}

// ── (1)+(2): every row of the event table, through the helper with a stub tmux ──
test("the table covers every event of the Component 7 table (it cannot pass empty)", () => {
  const events = new Set(rows.map((r) => r.event));
  for (const ev of ["PermissionRequest", "Notification", "PreToolUse", "PostToolUse", "PostToolUseFailure",
    "UserPromptSubmit", "Stop", "SessionStart", "SessionEnd", "PermissionDenied"]) assert.ok(events.has(ev), ev);
});
for (const row of rows) test(`E-433.01: ${row.label}`, () => {
  const home = mkdtempSync(join(tmp, "h-"));
  if (row.state !== null) { mkdirSync(dirname(stateFile(home)), { recursive: true }); writeFileSync(stateFile(home), `${row.state}\n`); }
  const r = dispatch(row, { home });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, "", "nothing on stdout");
  assert.deepEqual(effects(r.calls), row.expect);
  if (row.after === null) assert.ok(!existsSync(stateFile(home)), "no waiting-call file");
  else assert.equal(readFileSync(stateFile(home), "utf8"), `${row.after}\n`);
});

// ── (2): no pane, a bad pane id, no tmux → no call, nothing on stdout, exit 0 ──
const QUIET = [
  ["no TMUX_PANE", { TMUX_PANE: "" }],
  ["a TMUX_PANE that is not %<digits>", { TMUX_PANE: "%7;kill-server" }],
  ["no $TMUX", { TMUX: "" }],
];
for (const [label, env] of QUIET) test(`E-433.02: ${label} — no tmux call, exit 0`, () => {
  const home = mkdtempSync(join(tmp, "q-"));
  for (const row of rows) {
    const r = dispatch(row, { env, home });
    assert.equal(r.status, 0); assert.equal(r.stdout, ""); assert.deepEqual(r.calls, [], row.label);
  }
});
test("E-433.02: no tmux on PATH — exit 0, nothing on stdout", () => {
  const home = mkdtempSync(join(tmp, "n-"));
  const r = spawnSync("/bin/bash", ["-c", '. "$1"; rein_ws_dispatch SessionStart; rein_ws_dispatch PermissionRequest "" Bash toolu_A', "_", HELPER],
    { encoding: "utf8", env: { PATH: join(home, "empty"), HOME: home, TMUX: "x,1,0", TMUX_PANE: PANE } });
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
});

// ── (5): the helper writes only names and values pane-options.json lists ──
test("E-433.05: every option name and value the helper can write is listed in pane-options.json", () => {
  const out = execFileSync("bash", ["-c", '. "$1"; printf "%s\\n" "${REIN_WS_OPTIONS[*]}" "${REIN_WS_SIGNALS[*]}" "${REIN_WS_VALUES[*]}"', "_", HELPER], { encoding: "utf8" }).split("\n");
  const [names, signals, values] = out.map((l) => l.split(" ").filter(Boolean));
  for (const n of names) assert.ok(PANE_OPTS[n], `${n} not in pane-options.json`);
  for (const v of signals) assert.ok(PANE_OPTS["@rein_signals"].values.includes(v), `@rein_signals ${v}`);
  for (const v of values) assert.ok(PANE_OPTS["@rein_waiting"].values.includes(v), `@rein_waiting ${v}`);
  // …and the literal written by each set call is one of those values (no other string reaches tmux).
  const src = readFileSync(HELPER, "utf8");
  assert.match(src, /rein_ws_listed "\$kind" "\$\{REIN_WS_VALUES\[@\]\}" \|\| return 0/);
});
test("E-433.05: a value outside the closed list makes no call", () => {
  const home = mkdtempSync(join(tmp, "v-"));
  const s = stubTmux(join(home, "stub"));
  spawnSync("bash", ["-c", '. "$1"; rein_ws_resolve; rein_ws_set "$(printf "x\\ny")"; rein_ws_set working', "_", HELPER],
    { env: { PATH: `${dirname(s.bin)}:/usr/bin:/bin`, HOME: home, TMUX: "x,1,0", TMUX_PANE: PANE } });
  assert.deepEqual(s.calls(), []);
});

// ── The hook: fixture HOME (the toolchain record), tmux reached only through the record ──
function hookHome(name, recordTmux) {
  const home = join(tmp, name);
  tcFixtureHome(home);
  const s = stubTmux(join(tmp, `${name}-stub`));   // outside the pinned PATH
  if (recordTmux) appendFileSync(join(home, ".rein/shared/toolchain.sh"), `REIN_TC_TMUX=${recordTmux === true ? s.bin : recordTmux}\n`);
  return { home, s };
}
const runHook = (home, payload, env = {}) => spawnSync("/bin/bash", ["-p", HOOK], {
  input: payload, encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin", TMUX: join(home, "sock") + ",1,0", TMUX_PANE: PANE, ...env },
});
const P = (o) => JSON.stringify(o);

test("E-433.09: under the pinned PATH the recorded tmux receives the call (D-160 addendum 1)", () => {
  const { home, s } = hookHome("rec", true);
  const r = runHook(home, P({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "toolu_A" }));
  assert.equal(r.status, 0); assert.equal(r.stdout, "");
  assert.deepEqual(effects(s.calls()), ["set:permission"]);
});
test("E-433.09: a recorded tmux that is not executable — no call, exit 0", () => {
  const { home, s } = hookHome("noexec", join(tmp, "not-exec"));
  writeFileSync(join(tmp, "not-exec"), "#!/bin/bash\nexit 0\n");   // mode 0644
  const r = runHook(home, P({ hook_event_name: "SessionStart" }));
  assert.equal(r.status, 0); assert.equal(r.stdout, ""); assert.deepEqual(s.calls(), []);
});
test("E-433.02: the hook prints nothing and exits 0 for every row, a malformed payload and a bad pane", () => {
  const { home, s } = hookHome("rows", true);
  for (const row of rows) {
    const r = runHook(home, P({ hook_event_name: row.event, notification_type: row.nt, tool_name: row.tool, tool_use_id: row.id || undefined }));
    assert.equal(r.status, 0, row.label); assert.equal(r.stdout, "", row.label);
  }
  for (const [payload, env] of [["{not json", {}], ["", {}], ["[]", {}], [P({ hook_event_name: "PermissionRequest" }), { TMUX_PANE: "" }],
    [P({ hook_event_name: "PermissionRequest" }), { TMUX_PANE: "%x" }]]) {
    const before = s.calls().length;
    const r = runHook(home, payload, env);
    assert.equal(r.status, 0); assert.equal(r.stdout, "");
    assert.equal(s.calls().length, before, `no call for ${payload || "(empty)"} ${JSON.stringify(env)}`);
  }
  // A payload value never reaches tmux: only the literals do.
  runHook(home, P({ hook_event_name: "PermissionRequest", tool_use_id: "a b; kill-server" }));
  assert.ok(!s.calls().some((c) => c.includes("kill-server")));
});

// ── (7): added time per PostToolUse with no wait pending — p95 under 30 ms (latency contract) ──
test("E-433.07: p95 of a PostToolUse with no wait pending is under 30 ms", () => {
  const { home } = hookHome("perf", true);
  const payload = P({ hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "toolu_Z" });
  const ms = [];
  for (let i = 0; i < 40; i++) {
    const t = process.hrtime.bigint();
    runHook(home, payload);
    ms.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  ms.sort((a, b) => a - b);
  const p95 = ms[Math.ceil(0.95 * ms.length) - 1];
  console.log(`  ⓘ E-433.07: PostToolUse, no wait pending: p50=${ms[19].toFixed(1)}ms p95=${p95.toFixed(1)}ms (ceiling 30 ms, hooks contract)`);
  assert.ok(p95 < 30, `p95 ${p95.toFixed(1)} ms`);
});

// ── (3): a real tmux server on a private socket ──
const realTmux = spawnSync("bash", ["-c", "command -v tmux"], { encoding: "utf8" }).stdout.trim();
test("E-433.03: a real tmux server shows permission, then empty after Stop", { skip: !realTmux && "tmux not installed" }, (t) => {
  const home = join(tmp, "real");
  tcFixtureHome(home);
  appendFileSync(join(home, ".rein/shared/toolchain.sh"), `REIN_TC_TMUX=${realTmux}\n`);
  const sock = join(tmp, "real.sock");
  const tm = (...a) => execFileSync(realTmux, ["-S", sock, ...a], { encoding: "utf8", env: { ...process.env, TMUX: "" } });
  t.after(() => { try { tm("kill-server"); } catch { /* already gone */ } });
  tm("-f", "/dev/null", "new-session", "-d", "-s", "ws", "sleep 300");
  const pane = tm("list-panes", "-F", "#{pane_id}").trim();
  const env = { TMUX: `${sock},0,0`, TMUX_PANE: pane };
  const read = () => tm("list-panes", "-F", "#{@rein_waiting}").replace(/\n$/, "");
  assert.equal(runHook(home, P({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_use_id: "toolu_R" }), env).status, 0);
  assert.equal(read(), "permission");
  assert.equal(runHook(home, P({ hook_event_name: "Stop" }), env).status, 0);
  assert.equal(read(), "");
});
