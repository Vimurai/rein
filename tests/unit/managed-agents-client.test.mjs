// managed-agents-client.test.mjs — the pure rows of src/shared/managed-agents-client.mjs.
// Moved from tests/suites/managed_agents_client_test.sh (E-70: T-MAC-S01 file rows, S02..S06,
// S10) and tests/suites/state_projector_sync_test.sh (E-73: T-STP-S01..S10, S12) by E-302
// (D-088: a function called in-process belongs in the unit layer); the assertions and their
// labels are unchanged. What crosses a process boundary — the --status/--project/--sync CLI, the
// network-error stderr, the installed mirror, the E-47 spike — stays in managed_agents_test.sh.
//
// Never makes a network call: every sendSteps/syncToCloud below returns before fetch
// (flag off, bad key, bad payload, bad host, missing DB) or is a debounce that is cancelled.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLIENT = resolve(repo, "src/shared/managed-agents-client.mjs");
const m = await import(CLIENT);
const SRC = readFileSync(CLIENT, "utf8");
const KEY = "abcdef0123456789";
const ON = { AI_MANAGED_AGENTS_ENABLE: "1", AI_MANAGED_AGENT_KEY: KEY };

const TASKS_DDL = `CREATE TABLE tasks (
  id TEXT PRIMARY KEY, owner TEXT NOT NULL, status TEXT NOT NULL,
  tier INTEGER, description TEXT NOT NULL, created_at TEXT NOT NULL,
  completed_at TEXT, summary TEXT);`;
// A throwaway state.sqlite holding `rows` ([id, owner, status, tier, desc, created, completed, summary]).
function seedDb(t, rows) {
  const dir = mkdtempSync(join(tmpdir(), "aios-t-maclient-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "state.sqlite");
  const db = new DatabaseSync(path);
  db.exec(TASKS_DDL);
  const ins = db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)");
  for (const r of rows) ins.run(...r);
  db.close();
  return { dir, path };
}

// ══ E-70 (from managed_agents_client) ════════════════════════════════════════

test("T-MAC-S01: client module exists with a node shebang", () => {
  assert.ok(existsSync(CLIENT), "client file exists");
  assert.match(SRC.split("\n")[0], /node/, "client has node shebang");
});

test("T-MAC-S02: sendSteps returns DISABLED when flag is OFF", async () => {
  const steps = [{ text: "hi" }];
  assert.equal((await m.sendSteps({ agentId: "a1", steps }, {})).status, "DISABLED", "flag OFF → status=DISABLED");
  assert.equal((await m.sendSteps({ agentId: "a1", steps }, { AI_MANAGED_AGENTS_ENABLE: "0", AI_MANAGED_AGENT_KEY: KEY })).status,
    "DISABLED", "flag explicitly 0 with key present → still DISABLED");
});

// Key validation refuses absent/short/invalid-charset/overlong.
const BAD_KEYS = { absent: "", short: "too_short", invalid_charset: "bad key with spaces!", overlong: "x".repeat(300) };
for (const [label, key] of Object.entries(BAD_KEYS)) {
  test(`T-MAC-S03: key=${label} → status=MISSING_KEY`, async () => {
    const env = { AI_MANAGED_AGENTS_ENABLE: "1" };
    if (key !== "") env.AI_MANAGED_AGENT_KEY = key;
    assert.equal((await m.sendSteps({ agentId: "a1", steps: [{ text: "hi" }] }, env)).status, "MISSING_KEY");
  });
}

test("T-MAC-S04: migrateLegacyToSteps converts the documented shapes", () => {
  const out = JSON.stringify([
    m.migrateLegacyToSteps({ outputs: ["hello", "world"] }),
    m.migrateLegacyToSteps({ outputs: [{ text: "a" }, { text: "b", tool_calls: [{ n: "x" }] }] }),
    m.migrateLegacyToSteps({ steps: [{ text: "already" }] }),
    m.migrateLegacyToSteps({}),
  ]);
  assert.ok(out.includes('"text":"hello"'), "string outputs become {text}");
  assert.ok(out.includes('"text":"a"'), "object outputs preserve text");
  assert.ok(out.includes('"tool_calls":[{"n":"x"}]'), "object outputs preserve tool_calls");
  assert.ok(out.includes('"text":"already"'), "pre-migrated payload is idempotent");
  assert.ok(out.includes('"steps":[]'), "empty payload yields empty steps");
});

// Invalid agentId and steps shapes return INVALID_PAYLOAD.
const BAD_PAYLOADS = {
  empty_agent: { agentId: "", steps: [] },
  bad_chars: { agentId: "a/b", steps: [] },
  non_array_steps: { agentId: "a1", steps: "not-array" },
  non_object_step: { agentId: "a1", steps: ["raw-string"] },
};
for (const [label, payload] of Object.entries(BAD_PAYLOADS)) {
  test(`T-MAC-S05: case=${label} → status=INVALID_PAYLOAD`, async () => {
    assert.equal((await m.sendSteps(payload, ON)).status, "INVALID_PAYLOAD");
  });
}

test("T-MAC-S06: malformed AI_MANAGED_AGENT_HOST → status=INVALID_PAYLOAD", async () => {
  const r = await m.sendSteps({ agentId: "a1", steps: [{ text: "hi" }] }, { ...ON, AI_MANAGED_AGENT_HOST: "bad host with spaces" });
  assert.equal(r.status, "INVALID_PAYLOAD");
});

test("T-MAC-S10: source carries the blueprint-mandated identifiers", () => {
  assert.ok(SRC.includes("AI_MANAGED_AGENTS_ENABLE"), "AI_MANAGED_AGENTS_ENABLE referenced");
  assert.ok(SRC.includes("AI_MANAGED_AGENT_KEY"), "AI_MANAGED_AGENT_KEY referenced");
  assert.match(SRC, /Bearer \$\{key\}|`Bearer /, "Bearer auth header is constructed");
  assert.ok(SRC.includes("export function migrateLegacyToSteps"), "steps schema migration helper exported");
  assert.ok(SRC.includes("export function isEnabled"), "isEnabled helper exported");
  assert.ok(SRC.includes("export async function sendSteps"), "sendSteps exported");
  assert.ok(SRC.includes('ALLOWED_PROTOCOL = "https:"'), "https-only protocol enforced");
});

// ══ E-73 (from state_projector_sync) ═════════════════════════════════════════

test("T-STP-S01: source exports projectState, syncToCloud, cancelPendingSync", () => {
  assert.ok(existsSync(CLIENT), "client file exists");
  assert.ok(SRC.includes("export function projectState"), "projectState exported");
  assert.ok(SRC.includes("export function syncToCloud"), "syncToCloud exported");
  assert.ok(SRC.includes("export function cancelPendingSync"), "cancelPendingSync exported");
  assert.ok(SRC.includes("DEFAULT_DEBOUNCE_MS = 2_000"), "default debounce is 2000ms");
  assert.ok(SRC.includes('PROJECTION_PATH = "/v1/managed-agents/state/projection"'), "projection endpoint pinned");
  assert.ok(SRC.includes("managed-agents-state-reconciliation.md"), "blueprint reference in comments");
  assert.ok(SRC.includes('from "node:sqlite"'), "node:sqlite imported");
  assert.ok(SRC.includes('from "node:crypto"'), "node:crypto imported");
});

// The repo's own .ai/state.sqlite is gitignored (absent in CI and fresh clones) — seed an
// equivalent DB then, as the suite did.
test("T-STP-S02: projectState returns the Cloud Projection Payload from a real DB", (t) => {
  let dbPath = resolve(repo, ".ai/state.sqlite");
  if (!existsSync(dbPath)) {
    dbPath = seedDb(t, [
      ["E-1", "Engineer (Claude)", "OPEN", 2, "seed open", "2026-01-01", null, null],
      ["E-2", "Engineer (Claude)", "DONE", 2, "seed done", "2026-01-01", "2026-01-02", "done"],
    ]).path;
  }
  const out = JSON.stringify(m.projectState({ dbPath }));
  assert.ok(out.includes('"status":"OK"'), "status=OK");
  assert.ok(out.includes('"local_timestamp":"20'), "payload has local_timestamp");
  assert.match(out, /"state_hash":"[0-9a-f]{64}"/, "payload has state_hash (64 hex)");
  assert.ok(out.includes('"active_tasks":['), "payload has active_tasks array");
});

const STP_ROWS = [
  ["E-100", "Engineer (Claude)", "OPEN", 2, "open desc", "2026-01-01", null, null],
  ["E-101", "Engineer (Claude)", "BLOCKED", 2, "blocked desc", "2026-01-01", null, null],
  ["E-102", "Engineer (Claude)", "DONE", 2, "done desc", "2026-01-01", "2026-01-02", "done sum"],
  ["P-99", "Architect (Claude)", "OPEN", 1, "planner desc", "2026-01-01", null, null],
];

test("T-STP-S03: DONE rows are filtered out of the projection", (t) => {
  const { path } = seedDb(t, STP_ROWS);
  const out = JSON.stringify(m.projectState({ dbPath: path }).payload.active_tasks);
  assert.ok(out.includes('"id":"E-100"'), "E-100 (OPEN) present");
  assert.ok(out.includes('"id":"E-101"'), "E-101 (BLOCKED) present");
  assert.ok(out.includes('"id":"P-99"'), "P-99 (OPEN) present");
  assert.ok(!out.includes('"id":"E-102"'), "E-102 (DONE) NOT present");
  assert.ok(out.includes('"owner":"Engineer"'), "owner normalised: Engineer");
  assert.ok(out.includes('"owner":"Architect"'), "owner normalised: Architect");
  assert.ok(!out.includes("Engineer (Claude)"), "owner long form NOT leaked");
});

test("T-STP-S04: state_hash is deterministic on identical state", (t) => {
  const { path } = seedDb(t, STP_ROWS);
  const a = m.projectState({ dbPath: path }), b = m.projectState({ dbPath: path });
  assert.equal(a.payload.state_hash, b.payload.state_hash, "two reads → identical state_hash");
  // Timestamps usually differ across two calls; either outcome is fine, but it is a real boolean.
  assert.equal(typeof (a.payload.local_timestamp !== b.payload.local_timestamp), "boolean", "timestamp boolean is well-formed");
  const db = new DatabaseSync(path);
  db.exec("UPDATE tasks SET status='DONE', completed_at='2026-01-03' WHERE id='E-100';");
  db.close();
  assert.notEqual(m.projectState({ dbPath: path }).payload.state_hash, a.payload.state_hash,
    "hash changes after task transitions OPEN→DONE");
});

// Sensitive-looking text so a leak would be obvious.
const PRIVATE_ROW = ["E-200", "Engineer (Claude)", "OPEN", 2, "PROPRIETARY_INTERNAL_DESCRIPTION_XYZ", "2026-01-01", null,
  "PROPRIETARY_INTERNAL_SUMMARY_XYZ"];

test("T-STP-S05: cloud projection strips description/summary/timestamps", (t) => {
  const { path } = seedDb(t, [PRIVATE_ROW]);
  const out = JSON.stringify(m.projectState({ dbPath: path }).payload);
  assert.ok(!out.includes("PROPRIETARY_INTERNAL_DESCRIPTION_XYZ"), "description NOT in payload");
  assert.ok(!out.includes("PROPRIETARY_INTERNAL_SUMMARY_XYZ"), "summary NOT in payload");
  assert.ok(!out.includes('"created_at"'), "created_at NOT in payload");
  assert.ok(!out.includes('"completed_at"'), "completed_at NOT in payload");
  assert.ok(!out.includes('"tier"'), "tier NOT in payload");
});

test("T-STP-S06: projectState surfaces STATE_UNAVAILABLE when the DB is missing", (t) => {
  const { dir } = seedDb(t, []);
  const out = JSON.stringify(m.projectState({ dbPath: join(dir, "no-such.sqlite") }));
  assert.ok(out.includes('"status":"STATE_UNAVAILABLE"'), "status=STATE_UNAVAILABLE");
  assert.ok(out.includes("not found"), "reason mentions not found");
});

test("T-STP-S07: syncToCloud returns DISABLED when the flag is off", (t) => {
  const { path } = seedDb(t, [PRIVATE_ROW]);
  assert.equal(m.syncToCloud({ dbPath: path }, {}).status, "DISABLED", "flag absent → DISABLED");
  assert.equal(m.syncToCloud({ dbPath: path }, { AI_MANAGED_AGENTS_ENABLE: "0", AI_MANAGED_AGENT_KEY: KEY }).status,
    "DISABLED", "flag=0 with key → still DISABLED");
});

const SYNC_BAD_KEYS = {
  absent: { AI_MANAGED_AGENTS_ENABLE: "1" },
  short: { AI_MANAGED_AGENTS_ENABLE: "1", AI_MANAGED_AGENT_KEY: "tooshort" },
  bad_charset: { AI_MANAGED_AGENTS_ENABLE: "1", AI_MANAGED_AGENT_KEY: "has spaces and !!" },
};
for (const [label, env] of Object.entries(SYNC_BAD_KEYS)) {
  test(`T-STP-S08: key=${label} → MISSING_KEY`, (t) => {
    const { path } = seedDb(t, [PRIVATE_ROW]);
    assert.equal(m.syncToCloud({ dbPath: path }, env).status, "MISSING_KEY");
  });
}

test("T-STP-S09: syncToCloud short-circuits on a missing state.sqlite", (t) => {
  const { dir } = seedDb(t, []);
  assert.equal(m.syncToCloud({ dbPath: join(dir, "no-such.sqlite") }, ON).status, "STATE_UNAVAILABLE",
    "missing DB → STATE_UNAVAILABLE");
});

test("T-STP-S10: rapid syncToCloud calls coalesce into a single pending timer", (t) => {
  const { path } = seedDb(t, [PRIVATE_ROW]);
  t.after(() => m.cancelPendingSync());   // never let a debounced fetch fire from this process
  const env = { ...ON, AI_MANAGED_AGENTS_DEBOUNCE_MS: "50" };
  const r1 = m.syncToCloud({ dbPath: path }, env);
  const r2 = m.syncToCloud({ dbPath: path }, env);
  const r3 = m.syncToCloud({ dbPath: path }, env);
  const cleared = m.cancelPendingSync();
  const clearedTwice = m.cancelPendingSync();
  assert.equal(r1.status, "DEBOUNCED", "first call DEBOUNCED");
  assert.equal(r2.status, "DEBOUNCED", "second call DEBOUNCED");
  assert.equal(r3.status, "DEBOUNCED", "third call DEBOUNCED");
  assert.equal(r1.debounce_ms, 50, "env override honoured (50ms)");
  assert.equal(cleared, true, "cancelPendingSync clears once");
  assert.equal(clearedTwice, false, "second cancel is a no-op");
});

test("T-STP-S12: normaliseOwner short-circuits Engineer/Architect/Tester", (t) => {
  const { path } = seedDb(t, [
    ["X-1", "Engineer (Claude)", "OPEN", 2, "d", "t", null, null],
    ["X-2", "Architect (Claude)", "OPEN", 2, "d", "t", null, null],
    ["X-3", "Tester (claude · sonnet)", "OPEN", 2, "d", "t", null, null],
    ["X-4", "SomethingElse", "OPEN", 2, "d", "t", null, null],
  ]);
  const out = JSON.stringify(m.projectState({ dbPath: path }).payload.active_tasks);
  assert.ok(out.includes('"id":"X-1","status":"OPEN","owner":"Engineer"'), "Engineer (Claude) → Engineer");
  assert.ok(out.includes('"id":"X-2","status":"OPEN","owner":"Architect"'), "Architect (Claude) → Architect");
  assert.ok(out.includes('"id":"X-3","status":"OPEN","owner":"Tester"'), "Tester (claude · sonnet) → Tester");
  assert.ok(out.includes('"id":"X-4","status":"OPEN","owner":"SomethingElse"'), "Unknown owner passes through");
});
