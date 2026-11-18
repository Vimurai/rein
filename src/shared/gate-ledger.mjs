// gate-ledger.mjs — E-432 (D-159 r7-r8, harness-fitness.md §Component 2): the control ledger.
//
// Read-only over the telemetry store (~/.rein/telemetry.sqlite, or AI_TELEMETRY_DB_PATH) and the
// project's .ai/state.json and .mcp.json. Three tables, one row shape:
//
//   { kind: "gate"|"critic"|"server", id, window_days, fires, overridden, fails, fails_then_pass,
//     calls, sessions, error_rate, p50_ms, first, last, flags: [] }
//
//   gate    one row per value of the closed list (gate-rules.mjs) plus UNLISTED. fires = REJECTED
//           hook rows with that rule; overridden = fires followed by a BYPASS row in the SAME real
//           session within 10 minutes (a NULL or "unknown" session never pairs — the ledger does
//           not guess, A2A ruling 2026-11-18 15:10). Rows with a NULL rule are not gate rows
//           (permission denials, or written before E-432): they are one separate count, never in
//           the table and never flagged.
//   critic  one row per stamp family (ARCH, SEC, TESTS, CLEAN, ALIGN, ACCEPT, and any other
//           <FAMILY>_PASS|FAIL seen). calls = tasks reviewed; fails = FAIL stamps;
//           fails_then_pass = FAILs followed later by a PASS of the family on the same task.
//   server  one row per MCP server in .mcp.json or seen in telemetry. calls, distinct sessions,
//           error_rate = (ERROR + TIMEOUT) / calls, p50_ms = median execution_time_ms.
//
// Flags, advisory only: [CONTROL_QUIET] — a rule with no fires, a critic with no FAILs, a server
// with no calls in the window; [CONTROL_NOISY] — a gate rule with overridden/fires >= 0.5 and at
// least 4 fires. A quiet seatbelt is kept by the Architect's reading, never retired by this file.
//
// CLI: node gate-ledger.mjs [--days N] [--json] [--db <path>] [--project <dir>] [--now <iso>]
//      exit 0; 2 on a bad option. `rein ledger` calls it. [LEDGER_EMPTY] when the store has no rows.

import { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GATE_RULES, UNLISTED } from "./gate-rules.mjs";
import { TELEMETRY_DB_PATH } from "./telemetry.mjs";
import { isMainModule } from "../mcp/shared/is-main.mjs";

export const DEFAULT_DAYS = 90;
const OVERRIDE_WINDOW_MS = 10 * 60 * 1000;
const KNOWN_CRITICS = ["ACCEPT", "ALIGN", "ARCH", "CLEAN", "SEC", "TESTS"];
const NOISY_RATIO = 0.5;
const NOISY_MIN_FIRES = 4;
const SERVER_RE = /^[A-Za-z0-9_-]{1,64}$/;   // the only server names the ledger prints

const row = (kind, id, days, extra = {}) => ({
  kind, id, window_days: days, fires: 0, overridden: 0, fails: 0, fails_then_pass: 0,
  calls: 0, sessions: 0, error_rate: null, p50_ms: null, first: null, last: null, flags: [], ...extra,
});
const realSession = (s) => typeof s === "string" && s !== "" && s !== "unknown";
const firstLast = (r, ts) => {
  if (!r.first || ts < r.first) r.first = ts;
  if (!r.last || ts > r.last) r.last = ts;
};

function hasColumn(db, col) {
  return db.prepare("PRAGMA table_info(tool_executions)").all().some((c) => c.name === col);
}

function gateRows(db, since, days) {
  const rows = new Map([...GATE_RULES, UNLISTED].map((id) => [id, row("gate", id, days)]));
  let unattributed = 0;
  if (!hasColumn(db, "rule")) {
    unattributed = db.prepare("SELECT COUNT(*) n FROM tool_executions WHERE status = 'REJECTED' AND source = 'hook' AND timestamp >= ?").get(since).n;
    return { rows: [...rows.values()], unattributed };
  }
  // BYPASS rows per real session, sorted, for the "followed within 10 minutes" pairing.
  const bypass = new Map();
  for (const b of db.prepare("SELECT session_id s, timestamp t FROM tool_executions WHERE status = 'BYPASS' AND timestamp >= ? ORDER BY timestamp").all(since)) {
    if (!realSession(b.s)) continue;
    if (!bypass.has(b.s)) bypass.set(b.s, []);
    bypass.get(b.s).push(Date.parse(b.t));
  }
  const overriddenAfter = (s, t) => {
    const list = realSession(s) ? bypass.get(s) : null;
    if (!list) return false;
    let lo = 0, hi = list.length;   // first bypass at or after t
    while (lo < hi) { const mid = (lo + hi) >> 1; if (list[mid] < t) lo = mid + 1; else hi = mid; }
    return lo < list.length && list[lo] - t <= OVERRIDE_WINDOW_MS;
  };
  const q = db.prepare("SELECT rule, session_id s, timestamp t FROM tool_executions WHERE status = 'REJECTED' AND source = 'hook' AND timestamp >= ?");
  for (const f of q.all(since)) {
    if (f.rule === null) { unattributed++; continue; }
    const r = rows.get(rows.has(f.rule) ? f.rule : UNLISTED);
    r.fires++;
    firstLast(r, f.t);
    if (overriddenAfter(f.s, Date.parse(f.t))) r.overridden++;
  }
  for (const r of rows.values()) {
    if (r.fires === 0) r.flags.push("CONTROL_QUIET");
    else if (r.fires >= NOISY_MIN_FIRES && r.overridden / r.fires >= NOISY_RATIO) r.flags.push("CONTROL_NOISY");
  }
  return { rows: [...rows.values()], unattributed };
}

function criticRows(stamps, since, days) {
  const fam = (type) => { const m = /^([A-Z]+)_(PASS|FAIL)$/.exec(type || ""); return m ? { f: m[1], v: m[2] } : null; };
  const rows = new Map(KNOWN_CRITICS.map((id) => [id, row("critic", id, days)]));
  const tasks = new Map();
  const inWindow = stamps.filter((s) => typeof s.timestamp === "string" && s.timestamp >= since);
  inWindow.forEach((s, i) => {
    const k = fam(s.type);
    if (!k) return;
    if (!rows.has(k.f)) rows.set(k.f, row("critic", k.f, days));
    const r = rows.get(k.f);
    firstLast(r, s.timestamp);
    if (s.task_id) {
      if (!tasks.has(k.f)) tasks.set(k.f, new Set());
      tasks.get(k.f).add(s.task_id);
    }
    if (k.v !== "FAIL") return;
    r.fails++;
    const later = s.task_id && inWindow.slice(i + 1).some((x) => x.task_id === s.task_id && fam(x.type)?.f === k.f && fam(x.type)?.v === "PASS");
    if (later) r.fails_then_pass++;
  });
  for (const r of rows.values()) {
    r.calls = tasks.get(r.id)?.size ?? 0;
    if (r.fails === 0) r.flags.push("CONTROL_QUIET");
  }
  return [...rows.values()];
}

function serverRows(db, servers, since, days) {
  const rows = new Map(servers.map((id) => [id, row("server", id, days)]));
  const per = new Map();
  const q = db.prepare("SELECT tool_name n, session_id s, status st, execution_time_ms ms, timestamp t FROM tool_executions WHERE tool_name LIKE 'mcp\\_\\_%' ESCAPE '\\' AND timestamp >= ?");
  for (const x of q.all(since)) {
    const m = /^mcp__(.+?)__/.exec(x.n);
    if (!m) continue;
    // security_engineer P2-2: a tool name is free text any local process can write; only a plain
    // server name is printed, anything else (escape sequences, spaces, brackets) counts as INVALID.
    const id = SERVER_RE.test(m[1]) ? m[1] : "INVALID";
    if (!rows.has(id)) rows.set(id, row("server", id, days));
    if (!per.has(id)) per.set(id, { sessions: new Set(), ms: [], errors: 0 });
    const p = per.get(id);
    const r = rows.get(id);
    r.calls++;
    firstLast(r, x.t);
    if (realSession(x.s)) p.sessions.add(x.s);
    p.ms.push(x.ms);
    if (x.st === "ERROR" || x.st === "TIMEOUT") p.errors++;
  }
  for (const r of rows.values()) {
    const p = per.get(r.id);
    if (p) {
      r.sessions = p.sessions.size;
      r.error_rate = Math.round((p.errors / r.calls) * 1000) / 1000;
      p.ms.sort((a, b) => a - b);
      r.p50_ms = p.ms[Math.floor((p.ms.length - 1) / 2)];
    }
    if (r.calls === 0) r.flags.push("CONTROL_QUIET");
  }
  return [...rows.values()];
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

/**
 * Build the ledger. Returns { empty: true } when the store is absent or holds no rows, else
 * { empty: false, window_days, since, rows: [...gate, ...critic, ...server], unattributed }.
 */
export function buildLedger({ dbPath = TELEMETRY_DB_PATH, projectRoot = process.cwd(), days = DEFAULT_DAYS, now = new Date() } = {}) {
  if (!existsSync(dbPath)) return { empty: true };
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const hasTable = db.prepare("SELECT 1 x FROM sqlite_master WHERE type = 'table' AND name = 'tool_executions'").get();
    if (!hasTable || !db.prepare("SELECT 1 x FROM tool_executions LIMIT 1").get()) return { empty: true };
    const since = new Date(now.getTime() - days * 86400000).toISOString();
    const state = readJson(join(projectRoot, ".ai", "state.json"));
    const mcp = readJson(join(projectRoot, ".mcp.json"));
    // security_engineer P3-6: a configured name is printed too — the same plain-name rule as telemetry's.
    const servers = [...new Set(Object.keys(mcp?.mcpServers ?? {}).map((s) => (SERVER_RE.test(s) ? s : "INVALID")))].sort();
    const gate = gateRows(db, since, days);
    return {
      empty: false, window_days: days, since,
      rows: [...gate.rows, ...criticRows(Array.isArray(state?.stamps) ? state.stamps : [], since, days), ...serverRows(db, servers, since, days)],
      unattributed: gate.unattributed,
    };
  } finally {
    db.close();
  }
}

// security_engineer P3-6: a stored timestamp is any text a local process wrote; a date is printed
// only when it is one.
const day = (ts) => (/^\d{4}-\d\d-\d\d/.test(ts ?? "") ? ts.slice(0, 10) : "?");

/** The human-readable ledger: fired rows in full, quiet rows of each kind on one line. */
export function renderLedger(l) {
  if (l.empty) return "[LEDGER_EMPTY] the telemetry store has no rows yet";
  const out = [`Control ledger — last ${l.window_days} days (since ${l.since.slice(0, 10)}) — advisory: ` +
    "telemetry rows are not authenticated; a retirement is a ruled E-task, never this output"];
  const flags = (r) => r.flags.map((f) => `[${f}]`).join(" ");
  const section = (title, kind, fmt, active) => {
    const rows = l.rows.filter((r) => r.kind === kind);
    out.push("", title);
    rows.filter(active).forEach((r) => out.push(`  ${fmt(r)} ${flags(r)}`.trimEnd()));
    const quiet = rows.filter((r) => !active(r)).map((r) => r.id);
    if (quiet.length) out.push(`  [CONTROL_QUIET] ${quiet.length}: ${quiet.join(", ")}`);
  };
  section("Gate rules (fires · overridden · first → last)", "gate",
    (r) => `${r.id}  ${r.fires} · ${r.overridden} · ${day(r.first)} → ${day(r.last)}`, (r) => r.fires > 0);
  out.push(`  not gate rows (permission denials) or pre-E-432: ${l.unattributed}`);
  section("Critics (tasks reviewed · FAILs · FAIL then PASS)", "critic",
    (r) => `${r.id}  ${r.calls} · ${r.fails} · ${r.fails_then_pass}`, (r) => r.fails > 0);
  section("MCP servers (calls · sessions · error rate · p50 ms)", "server",
    (r) => `${r.id}  ${r.calls} · ${r.sessions} · ${r.error_rate} · ${r.p50_ms}`, (r) => r.calls > 0);
  return out.join("\n");
}

function parseArgs(argv) {
  const o = { days: DEFAULT_DAYS, json: false, db: undefined, project: process.cwd(), now: new Date() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1];
    if (a === "--json") o.json = true;
    else if (a === "--days" && /^[1-9][0-9]{0,3}$/.test(v ?? "")) { o.days = Number(v); i++; }
    else if (a === "--db" && v) { o.db = resolve(v); i++; }
    else if (a === "--project" && v) { o.project = resolve(v); i++; }
    else if (a === "--now" && v && !Number.isNaN(Date.parse(v))) { o.now = new Date(v); i++; }
    else return { error: `bad option ${JSON.stringify(a)}` };
  }
  return o;
}

if (isMainModule(import.meta.url)) {
  const o = parseArgs(process.argv.slice(2));
  if (o.error) {
    process.stderr.write(`rein ledger: ${o.error} — usage: rein ledger [--days N] [--json]\n`);
    process.exit(2);
  }
  const l = buildLedger({ dbPath: o.db, projectRoot: o.project, days: o.days, now: o.now });
  if (o.json && !l.empty) process.stdout.write(JSON.stringify(l.rows, null, 1) + "\n");
  else process.stdout.write(renderLedger(l) + "\n");
}
