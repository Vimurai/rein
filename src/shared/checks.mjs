// checks.mjs — E-478 (D-176, .ai/blueprints/acceptance-replay.md §Component 1, §Data Model):
// the grammar of a recorded acceptance check. A check is a stamp; this module parses its one-line
// summary and says why a malformed one is refused. add_stamp calls checkStampSummary for the
// types CHECK and CHECK_RETIRED; every other stamp type is untouched.
//
//   CHECK          <task>#<n> | <expect> | <command>
//   CHECK_RETIRED  <task>#<n> | <by> | <reason>
//
// The command is everything after the second " | " (it may itself contain "|"), one line, at
// most COMMAND_MAX characters. <expect> is exactly one of EXPECT_FORMS.

export const COMMAND_MAX = 400;
export const EXPECT_FORMS = ["exit=<n>", "empty", "lines=<n>", "lines>=<n>", "out=<text>"];
export const CHECK_ID_RE = /^([A-Z]+-\d+)#([1-9]\d*)$/;
export const RETIRED_BY_RE = /^[DEP]-\d+$/;

const SEP = " | ";
// E-479 security round (F-E479-1): a control, format or bidi character lets `--list` show one
// command while another runs (an ESC sequence redraws the line). Refused anywhere in a summary;
// liveSet re-parses every stored stamp, so one that reached the store another way drops out too.
export const UNSAFE_CHAR_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/;

/** "E-476#3" → { id, task: "E-476", n: 3 }, or null. */
export function parseCheckId(s) {
  const m = CHECK_ID_RE.exec(String(s ?? ""));
  return m ? { id: m[0], task: m[1], n: Number(m[2]) } : null;
}

/** "lines>=2" → { kind: "lines>=", value: 2 }, or null when it is none of EXPECT_FORMS. */
export function parseExpect(s) {
  s = String(s ?? "");
  if (s === "empty") return { kind: "empty", value: null };
  let m = /^exit=(\d{1,3})$/.exec(s);
  if (m && Number(m[1]) <= 255) return { kind: "exit", value: Number(m[1]) };
  m = /^lines(>=|=)(\d+)$/.exec(s);
  if (m) return { kind: m[1] === "=" ? "lines" : "lines>=", value: Number(m[2]) };
  m = /^out=(.+)$/.exec(s);
  if (m && m[1].trim() === m[1]) return { kind: "out", value: m[1] };
  return null;
}

/** The expect text of a parsed expect, for messages and --list. */
export function expectText(e) {
  return e.kind === "empty" ? "empty" : e.kind === "lines>=" ? `lines>=${e.value}` : `${e.kind}=${e.value}`;
}

// Split "<a> | <b> | <rest>" at the first two separators. → [a, b, rest] or null.
function _split3(summary) {
  const s = String(summary ?? "");
  const i = s.indexOf(SEP);
  const j = i < 0 ? -1 : s.indexOf(SEP, i + SEP.length);
  return j < 0 ? null : [s.slice(0, i), s.slice(i + SEP.length, j), s.slice(j + SEP.length)];
}

function _head(summary, taskId) {
  if (/[\r\n]/.test(String(summary ?? ""))) return { reason: "the summary must be one line" };
  const bad = UNSAFE_CHAR_RE.exec(String(summary ?? ""));
  if (bad) return { reason: `the summary carries a control or format character (U+${bad[0].codePointAt(0).toString(16).toUpperCase().padStart(4, "0")})` };
  const parts = _split3(summary);
  if (!parts) return { reason: `the summary must be "<task>#<n>${SEP}…${SEP}…"` };
  const id = parseCheckId(parts[0]);
  if (!id) return { reason: `"${parts[0]}" is not a check id like E-476#3` };
  if (taskId !== undefined && taskId !== id.task) {
    return { reason: `the check ${id.id} belongs to ${id.task}, but task_id is ${taskId ?? "(none)"}` };
  }
  return { id, parts };
}

/**
 * Parse a CHECK summary. → { ok: true, check: { id, task, n, expect, command } }
 * or { ok: false, reason }. `taskId`, when passed, must be the check's own task.
 */
export function parseCheck(summary, taskId) {
  const h = _head(summary, taskId);
  if (h.reason) return { ok: false, reason: h.reason };
  const expect = parseExpect(h.parts[1]);
  if (!expect) return { ok: false, reason: `"${h.parts[1]}" is not an expect form (${EXPECT_FORMS.join(", ")})` };
  const command = h.parts[2];
  if (!command.trim()) return { ok: false, reason: "the command is empty" };
  if (command.length > COMMAND_MAX) return { ok: false, reason: `the command is ${command.length} characters, at most ${COMMAND_MAX}` };
  return { ok: true, check: { id: h.id.id, task: h.id.task, n: h.id.n, expect, command } };
}

/** Parse a CHECK_RETIRED summary. → { ok: true, retire: { id, task, n, by, reason } } or { ok: false, reason }. */
export function parseRetire(summary, taskId) {
  const h = _head(summary, taskId);
  if (h.reason) return { ok: false, reason: h.reason };
  const by = h.parts[1];
  if (!RETIRED_BY_RE.test(by)) return { ok: false, reason: `"${by}" is not a decision or task id (D-###, E-###, P-##)` };
  const reason = h.parts[2].trim();
  if (!reason) return { ok: false, reason: "the reason is empty" };
  return { ok: true, retire: { id: h.id.id, task: h.id.task, n: h.id.n, by, reason } };
}

// D-176 addendum 1 r16: these types are written to the store by their own command only. Through
// add_stamp a retirement would skip the --by check, and a CHECKS_PASS would open the DONE gate in
// one tool call. CHECK stays open: critic_acceptance writes it.
export const RESERVED_STAMP_TYPES = Object.freeze(["CHECKS_PASS", "CHECKS_FAIL", "CHECK_RETIRED"]);

/** add_stamp's refusal of a reserved type, or null. The text names no command (E-479's src/mcp clause). */
export function reservedStampType(type) {
  return RESERVED_STAMP_TYPES.includes(type)
    ? `[STAMP_RESERVED] ${type} is written only by the command that runs the recorded checks, not by add_stamp`
    : null;
}

/**
 * add_stamp's check (E-478): null when `type` is not CHECK or CHECK_RETIRED or the summary is
 * well formed, else the one refusal line `[CHECK_MALFORMED] <type>: <reason>`.
 */
export function checkStampSummary(type, summary, taskId) {
  const parse = type === "CHECK" ? parseCheck : type === "CHECK_RETIRED" ? parseRetire : null;
  if (!parse) return null;
  const r = parse(summary, taskId ?? null);
  return r.ok ? null : `[CHECK_MALFORMED] ${type}: ${r.reason}`;
}

/**
 * E-479: compare one run with its expect. `run` is { code, stdout }. → { holds, got } where `got`
 * says what the run gave, in the expect's own terms (`exit 1`, `2 lines`, `out=…`).
 */
export function evaluate(expect, { code, stdout }) {
  const lines = String(stdout ?? "").split("\n").filter((l) => l.trim()).length;
  const nl = (n) => `${n} line${n === 1 ? "" : "s"}`;
  switch (expect.kind) {
    case "exit": return { holds: code === expect.value, got: `exit ${code}` };
    case "empty": return { holds: lines === 0, got: nl(lines) };
    case "lines": return { holds: lines === expect.value, got: nl(lines) };
    case "lines>=": return { holds: lines >= expect.value, got: nl(lines) };
    case "out": {
      const out = String(stdout ?? "").trim();
      return { holds: out === expect.value, got: `out=${out.length > 80 ? `${out.slice(0, 80)}…` : out.replace(/\n/g, "⏎")}` };
    }
    default: return { holds: false, got: `unknown expect ${expect.kind}` };
  }
}
