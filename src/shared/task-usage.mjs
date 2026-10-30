#!/usr/bin/env node
// task-usage.mjs — E-259 (D-077, meta-cognition.md §Task Velocity from the Transcript).
//
// Measures what a task cost from the Claude Code transcript, so nothing has to self-report.
// The transcript is the meter, hooks/post-tool-use.sh is the trigger, this module is the
// reader, and telemetry.mjs::recordTaskVelocity is the only writer.
//
// Public API:
//   measureTaskWindow(transcriptPath, taskId, opts?) → Promise<counters | null>, never throws.
//   confineTranscriptPath(p, opts?) → the realpath under <claude config>/projects/, or null.
//   CLI (for the hook): `node task-usage.mjs --record` reading ONE JSON object on stdin:
//     { transcript_path, task_id, tool_response }. Writes one task_velocity row or nothing;
//     exit 0 always. Stdin, not argv: argv is visible in `ps` and takes `-`-prefixed tricks.
//
// Window: from the tool_use of the previous SUCCESSFUL update_task_status(DONE) in this
// transcript (or its start) to the tool_use of this task's DONE. The cursor is the transcript
// itself — no state file. One assistant message spans several JSONL lines, each repeating the
// same `usage`, so messages are counted once by `message.id`, at their first line.
//
// Privacy (the transcript holds the whole conversation): only type, isSidechain, sessionId,
// message.id, message.usage.*, and — for the task-synchronizer tool only — tool_use
// name/id/input.id/input.status and the tool_result's is_error plus ONE boolean "is this a
// success line" are read. Message text is never copied, logged or returned; parse errors are
// swallowed without their message (V8 quotes the bad input in JSON.parse errors). Reading the
// tool_result for the success check goes one field beyond the blueprint's whitelist; it is
// reduced to a boolean at once (security_engineer E-259 P2-7).
//
// Security (security_engineer E-259 threat model):
//   - the confinement root comes from the passwd home (os.userInfo()), not $HOME: a project's
//     settings.json env block reaches hooks. CLAUDE_CONFIG_DIR is honoured only when owned by
//     this uid and not inside the project (cwd);
//   - the file is opened O_NOFOLLOW|O_NONBLOCK and checked on the DESCRIPTOR (regular file,
//     owned by this uid, size cap) — no TOCTOU between the realpath check and the read;
//   - caps: 256 MB file, 8 MB line (longer lines are skipped whole), lines that mention
//     neither "usage" nor update_task_status are never parsed, 10 s wall clock in the CLI.
//
// Rollback: REIN_TASK_USAGE=0 (checked by the hook and here); AI_TELEMETRY_DISABLE=1.

import { openSync, fstatSync, closeSync, createReadStream, realpathSync, statSync, constants as C } from "node:fs";
import { userInfo } from "node:os";
import { join, resolve, dirname, basename, isAbsolute, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const TASK_ID_RE = /^[EP]-\d{1,6}$/;
const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const MAX_FILE_BYTES = 256 * 1024 * 1024;
export const MAX_LINE_BYTES = 8 * 1024 * 1024;
const DONE_TOOL = "mcp__task-synchronizer-mcp__update_task_status";

function _uid() { try { return process.getuid(); } catch { return -1; } }
function _real(p) { try { return realpathSync(p); } catch { return null; } }
function _within(child, root) { return child === root || child.startsWith(root + sep); }

/** <claude config dir>/projects, resolved, or null. */
export function projectsRoot(env = process.env, cwd = process.cwd()) {
  let home;
  try { home = userInfo().homedir; } catch { return null; }
  let base = join(home, ".claude");
  const cfg = typeof env.CLAUDE_CONFIG_DIR === "string" ? env.CLAUDE_CONFIG_DIR.trim() : "";
  if (cfg && isAbsolute(cfg) && !cfg.includes("\0")) {
    const r = _real(cfg);
    const inProject = r && _real(cwd) && _within(r, _real(cwd));
    let owned = false;
    try { owned = r !== null && statSync(r).uid === _uid(); } catch { owned = false; }
    if (r && owned && !inProject) base = r;
  }
  return _real(join(base, "projects"));
}

/** The transcript's realpath if it is a .jsonl under projectsRoot(), else null. */
export function confineTranscriptPath(p, opts = {}) {
  if (typeof p !== "string" || !p || p.includes("\0") || !isAbsolute(p)) return null;
  if (!p.endsWith(".jsonl")) return null;
  const root = opts.root ?? projectsRoot(opts.env, opts.cwd);
  if (!root) return null;
  const real = _real(p);
  if (!real || !real.endsWith(".jsonl")) return null;
  return _within(dirname(real), root) && real !== root ? real : null;
}

// Open safely, then check what was actually opened.
function _openChecked(path) {
  let fd;
  try {
    fd = openSync(path, C.O_RDONLY | (C.O_NOFOLLOW ?? 0) | (C.O_NONBLOCK ?? 0));
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== _uid() || st.size > MAX_FILE_BYTES) { closeSync(fd); return null; }
    return fd;
  } catch {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
    return null;
  }
}

// Line scanner with a per-line cap: an over-long line (a base64 image) is skipped whole
// without ever being held in memory beyond the cap.
async function* _lines(fd) {
  const stream = createReadStream(null, { fd, autoClose: true, highWaterMark: 1 << 20 });
  let parts = []; let size = 0; let dropping = false;
  for await (const chunk of stream) {
    let start = 0;
    for (;;) {
      const nl = chunk.indexOf(10, start);
      const end = nl === -1 ? chunk.length : nl;
      if (!dropping) {
        size += end - start;
        if (size > MAX_LINE_BYTES) { dropping = true; parts = []; }
        else parts.push(chunk.subarray(start, end));
      }
      if (nl === -1) break;
      if (!dropping) yield Buffer.concat(parts).toString("utf8");
      parts = []; size = 0; dropping = false;
      start = nl + 1;
    }
  }
  if (!dropping && size > 0) yield Buffer.concat(parts).toString("utf8");
}

const _num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function _isDoneSuccess(content, isError) {
  if (isError === true) return false;
  let txt = "";
  if (typeof content === "string") txt = content;
  else if (Array.isArray(content)) {
    for (const c of content) if (c && typeof c.text === "string") { txt = c.text; break; }
  }
  const ok = txt.startsWith("✓") && txt.includes("→ DONE");
  txt = "";
  return ok;
}

/**
 * Counters for `taskId`'s window, or null (unmeasured). Never throws.
 * @returns {Promise<{turn_count:number,tokens_consumed:number,output_tokens:number,
 *   cache_read_tokens:number,session_id:string}|null>}
 */
export async function measureTaskWindow(transcriptPath, taskId, opts = {}) {
  try {
    if (process.env.REIN_TASK_USAGE === "0") return null;
    if (typeof taskId !== "string" || !TASK_ID_RE.test(taskId)) return null;
    const path = confineTranscriptPath(transcriptPath, opts);
    if (!path) return null;
    const fd = _openChecked(path);
    if (fd === null) return null;

    const firstSeen = new Map();   // message.id → { idx, usage }
    const doneUse = [];            // { idx, toolUseId, taskId }
    const doneOk = new Set();      // tool_use ids whose result was a success
    const doneIds = new Set();     // every DONE tool_use id — O(1) lookup per tool_result (critic_security P2)
    let sessionId = "";
    let idx = 0;
    for await (const line of _lines(fd)) {
      idx++;
      const hasUsage = line.includes('"usage"');
      const hasDone = line.includes("update_task_status") || line.includes('"tool_result"');
      if (!hasUsage && !hasDone) continue;
      let d;
      try { d = JSON.parse(line); } catch { continue; }
      if (!d || typeof d !== "object") continue;
      const m = d.message && typeof d.message === "object" ? d.message : null;
      if (!sessionId && typeof d.sessionId === "string" && SESSION_ID_RE.test(d.sessionId)) sessionId = d.sessionId;
      if (d.type === "assistant" && m) {
        if (typeof m.id === "string" && m.usage && typeof m.usage === "object" && !firstSeen.has(m.id)) {
          const u = m.usage;
          firstSeen.set(m.id, {
            idx,
            input: _num(u.input_tokens), cc: _num(u.cache_creation_input_tokens),
            out: _num(u.output_tokens), cr: _num(u.cache_read_input_tokens),
          });
        }
        if (Array.isArray(m.content)) {
          for (const c of m.content) {
            if (c && c.type === "tool_use" && c.name === DONE_TOOL && c.input && c.input.status === "DONE"
                && typeof c.id === "string" && typeof c.input.id === "string" && TASK_ID_RE.test(c.input.id)) {
              doneUse.push({ idx, toolUseId: c.id, taskId: c.input.id });
              doneIds.add(c.id);
            }
          }
        }
      } else if (d.type === "user" && m && Array.isArray(m.content)) {
        for (const c of m.content) {
          if (c && c.type === "tool_result" && typeof c.tool_use_id === "string"
              && doneIds.has(c.tool_use_id)
              && _isDoneSuccess(c.content, c.is_error)) {
            doneOk.add(c.tool_use_id);
          }
        }
      }
      d = null;
    }

    // End: this task's LAST DONE tool_use (the call that fired the hook).
    let end = -1;
    for (const u of doneUse) if (u.taskId === taskId) end = u.idx;
    if (end < 0) return null;
    // Start: the previous SUCCESSFUL DONE before it (any task), else the transcript start.
    let start = 0;
    for (const u of doneUse) if (u.idx < end && doneOk.has(u.toolUseId)) start = u.idx;

    let turns = 0, tokens = 0, out = 0, cr = 0;
    for (const v of firstSeen.values()) {
      if (v.idx <= start || v.idx > end) continue;
      turns++; tokens += v.input + v.cc + v.out; out += v.out; cr += v.cr;
    }
    if (turns === 0 || tokens + cr === 0) return null;
    return { turn_count: turns, tokens_consumed: tokens, output_tokens: out, cache_read_tokens: cr, session_id: sessionId };
  } catch {
    return null;
  }
}

/** The hook's own success check on the tool_response it received; unknown shape → false. */
export function responseIsDone(resp, taskId) {
  try {
    let content = resp, isError;
    if (resp && !Array.isArray(resp) && typeof resp === "object") { content = resp.content; isError = resp.isError; }
    if (!Array.isArray(content) && typeof content !== "string") return false;
    if (!_isDoneSuccess(content, isError)) return false;
    const first = typeof content === "string" ? content : (content.find((c) => c && typeof c.text === "string")?.text || "");
    return first.includes(`${taskId} → DONE`);
  } catch { return false; }
}

async function _readStdin(limit = 1 << 20) {
  const chunks = []; let n = 0;
  for await (const c of process.stdin) { n += c.length; if (n > limit) return null; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return null; }
}

async function _runCli() {
  if (!process.argv.includes("--record")) return;
  if (process.env.REIN_TASK_USAGE === "0" || process.env.AI_TELEMETRY_DISABLE === "1") return;
  const timer = setTimeout(() => process.exit(0), 15_000); timer.unref();
  const p = await _readStdin();
  if (!p || typeof p !== "object") return;
  const taskId = typeof p.task_id === "string" ? p.task_id : "";
  if (!TASK_ID_RE.test(taskId) || !responseIsDone(p.tool_response, taskId)) return;
  // Claude Code appends the assistant message — the DONE tool_use this window ENDS at — to the
  // transcript only AFTER the tool and its PostToolUse hooks have run (observed 2026-09-29: a
  // tool's own tool_use line is absent while it executes and present right after). Read at
  // hook time, the task has no DONE yet and measures as null. This process is detached, so it
  // waits for the line with a bounded backoff instead (≈ 7.5 s in all, under the 15 s cap).
  let r = null;
  for (const wait of [0, 500, 1000, 1500, 2000, 2500]) {
    if (wait) await new Promise((res) => setTimeout(res, wait));
    r = await measureTaskWindow(p.transcript_path, taskId);
    if (r) break;
  }
  if (!r) return;
  const { recordTaskVelocity } = await import("./telemetry.mjs");
  recordTaskVelocity({ task_id: taskId, ...r, source: "transcript" }, { sync: true });
}

function _isMain() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(resolve(process.argv[1] || "")); }
  catch { return false; }
}
if (_isMain()) _runCli().catch(() => {}).finally(() => process.exit(0));
