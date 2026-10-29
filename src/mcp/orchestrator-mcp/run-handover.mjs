// run-handover.mjs — orchestrator-mcp's run_handover (E-320 moved it out of index.js, D-098 r2).
//
// Marks a task DONE, records the implementation delta and appends the LOG line — after the
// completion gates (src/shared/completion-gates.mjs) that update_task_status applies too.

import { existsSync } from "fs";
import { resolve } from "path";
import { spawnSync } from "child_process";
import { getDbSeeded, regenerateViews, withTransaction } from "../shared/state-db.js";
import { updateTask } from "../shared/record-store.mjs"; // E-325: the single writer
import { publishDone } from "../shared/task-claims.mjs";
import { completionGates } from "../../shared/completion-gates.mjs";
import { appendLog } from "../shared/team.mjs"; // E-333: the shared log when team.json says so
import { redact } from "../../shared/publish-scan.mjs"; // E-379 (D-130)

export function today() {
  return new Date().toISOString().split("T")[0];
}

function gitRead(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 10000, maxBuffer: 10 * 1024 * 1024 });
  return r.error ? "" : (r.stdout || "");
}

export function getDiff(cwd) {
  let d = gitRead(["diff", "--staged"], cwd);
  if (!d.trim()) d = gitRead(["diff", "HEAD"], cwd);
  return d;
}

// `gateOpts` passes fixture mirror/run directories to the build gate and `env` the CI gate's
// environment — for tests/unit; production calls it with neither.
export function runHandover(cwd, args, gateOpts = {}, env = process.env) {
  const ai = resolve(cwd, ".ai");
  const taskId = (args.task_id || "").trim().toUpperCase();
  const summary = args.summary || "Implementation complete";

  if (!/^[EPT]-\d+$/.test(taskId)) {
    return {
      content: [{ type: "text", text: `✗ Invalid task ID: '${taskId}'. Expected format: E-##, P-##, or T-##` }],
      isError: true,
    };
  }

  const results = [];

  // Unified transaction: task DONE + implementation delta + meta (P-26)
  const dbPath = resolve(ai, "state.sqlite");
  if (!existsSync(dbPath)) {
    results.push(`⚠ state.sqlite missing — run: ai init`);
  } else {
    try {
      const db  = getDbSeeded(ai);
      const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId);
      if (!row) {
        results.push(`⚠ ${taskId} not found in state.sqlite`);
      } else if (row.status === "DONE") {
        results.push(`⚠ ${taskId} already marked DONE`);
      } else {
        // E-319/E-320 (D-097 r5, D-098 r2): the same completion gates as task-synchronizer's
        // update_task_status, from the one shared list. Without them this path marked E-314
        // DONE past a [BUILD_STALE] refusal from the other — two doors to one state, one of
        // them unlocked. Before any write: a refusal leaves state.sqlite and LOG.md untouched.
        const refused = completionGates({ cwd, db, id: taskId, buildOpts: gateOpts, env });
        if (refused) return refused;
        // Gather diff data BEFORE the transaction (no I/O inside transactions)
        const diff = getDiff(cwd);
        const changedFiles = diff.trim()
          ? [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map(m => m[1])
          : [];
        const deltaText = changedFiles.length > 0
          ? redact(`${taskId}: ${summary} | Files: ${changedFiles.slice(0, 5).join(", ")}`, { file: ".ai delta", aiDir: ai })
          : null;

        withTransaction(db, () => {
          // E-331: DONE clears the claim, as completeTask does.
          updateTask(ai, db, taskId, {
            status: "DONE", completed_at: new Date().toISOString(), summary,
            assignee: null, claimed_at: null, claim_sha: null, claim_prev: null,
          });
          if (deltaText) {
            db.prepare("INSERT INTO deltas(task_id, summary, files, read) VALUES (?, ?, ?, 0)")
              .run(taskId, deltaText, JSON.stringify(changedFiles.slice(0, 10)));
            db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('digest_stale', 'true')").run();
            db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES ('digest_stale_reason', ?)")
              .run(redact(`${taskId} marked DONE — ${summary}`, { file: ".ai digest_stale_reason", aiDir: ai }));
          }
        });
        regenerateViews(ai, db);
        results.push(`✓ ${taskId} marked DONE in state.sqlite (views regenerated)`);
        // E-331: clear this user's claim on origin/<trunk> (team projects only).
        const pub = publishDone(ai, taskId);
        if (pub) results.push(`${pub.ok ? "✓" : "⚠"} ${pub.message}`);
        if (deltaText) {
          results.push(`✓ Implementation delta saved to state.sqlite`);
          results.push(`✓ digest_stale=true set in state.sqlite (Reactive Memory §24)`);
        }
      }
    } catch (e) {
      results.push(`⚠ SQLite error: ${e.message}`);
    }
  }

  // Append LOG entry (outside transaction — file I/O)
  const logged = appendLog(ai, `${today()} | Claude | ${taskId} | ${summary}`);
  if (logged) results.push(`✓ ${logged.slice(resolve(ai).length + 1)} updated`);

  results.push("");
  results.push(
    "## Reactive Memory — DIGEST Update Required\n" +
    `Task ${taskId} is complete. DIGEST.md is now stale.\n\n` +
    "**Action required**: Run the digest_updater agent to refresh DIGEST.md:\n" +
    "  skill: 'digest_updater'\n\n" +
    "Or use the skill: `skill: \"ai-digest\"`"
  );

  return { content: [{ type: "text", text: results.join("\n") }] };
}
