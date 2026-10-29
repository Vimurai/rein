/**
 * tool-schemas.mjs — MCP tool inputSchema definitions for task-synchronizer-mcp.
 *
 * Extracted from index.js (E-91, ecc-integrations.md) to keep index.js within
 * the 1000-line engineering-standards cap and give the tool surface one
 * scannable home. The archive tool's description interpolates the live
 * thresholds, so they are passed in by the caller rather than imported here.
 */
export function buildToolSchemas({ DONE_KEEP_RECENT, DONE_ARCHIVE_THRESHOLD }) {
  return [
    {
      name: "get_state",
      description: "Returns state.json. Use filters to avoid large responses. summary:true returns counts only (~200 tokens). status/owner/tier filter the task list.",
      inputSchema: {
        type: "object",
        properties: {
          summary: { type: "boolean",  description: "Return counts + project info only (no task list). Use this by default." },
          status:  { type: "string",   enum: ["OPEN", "BLOCKED", "IN_PROGRESS", "DONE"], description: "Filter tasks by status" },
          owner:   { type: "string",   description: "Filter tasks by owner substring (e.g. 'Architect', 'Engineer')" },
          tier:    { type: "number",   enum: [1, 2, 3], description: "Filter tasks by tier" },
        },
      },
    },
    {
      name: "add_task",
      description: "Adds a new task to state with auto-assigned ID. Returns the new task. Set is_framework_task: true (E-63) to route the task to the canonical Rein clone at $REIN_WORKSPACE instead of the local project's .ai/.",
      inputSchema: {
        type: "object",
        properties: {
          owner:             { type: "string",  description: "Task owner label, derived from .ai/roles.json: e.g. 'Architect (Claude)', 'Engineer (Claude)', 'Tester (claude · sonnet)'" },
          description:       { type: "string",  description: "Task description" },
          tier:              { type: "number",  description: "Risk tier (1, 2, or 3)", enum: [1, 2, 3] },
          prefix:            { type: "string",  description: "ID prefix: P (architect), E (engineer), T (tester)", enum: ["P", "E", "T"], default: "E" },
          is_framework_task: { type: "boolean", description: "If true, persist into $REIN_WORKSPACE/.ai (canonical Rein clone) instead of local .ai/. Errors with [WORKSPACE_NOT_FOUND] when REIN_WORKSPACE is unset/invalid. (E-63)", default: false },
          depends_on:        { type: "array", items: { type: "string" }, description: "E-91: task IDs this task depends on. Starts BLOCKED until all are DONE, then auto-OPENs. Self-references, cycles, unknown deps, and chains deeper than 5 are rejected with [DAG_FAIL]." },
        },
        required: ["owner", "description"],
      },
    },
    {
      name: "update_task_status",
      description: "Updates a task's status (OPEN, BLOCKED, IN_PROGRESS, DONE). In a team project (.ai/team.json) IN_PROGRESS is set only by claim_task. Marks completed_at for DONE and clears the claim. Completing a task auto-unblocks any dependents whose dependencies are now all DONE. E-101: DONE tasks are locked — pass reopen:true to mutate one, else returns [TASK_LOCKED].",
      inputSchema: {
        type: "object",
        properties: {
          id:         { type: "string", description: "Task ID (e.g. 'E-78')" },
          status:     { type: "string", description: "New status", enum: ["OPEN", "BLOCKED", "IN_PROGRESS", "DONE"] },
          summary:    { type: "string", description: "Completion summary (for DONE status)" },
          reopen:     { type: "boolean", description: "E-101 (sovereignty-hardening.md §Components 2): required to mutate a task already in DONE status. Without it, a DONE task returns [TASK_LOCKED] to protect completed implementation history." },
          depends_on: { type: "array", items: { type: "string" }, description: "E-91: optionally revise this task's dependency list. Validated for existence, cycles, and depth (<=5) before write." },
        },
        required: ["id", "status"],
      },
    },
    {
      name: "claim_task",
      description: "E-331 (D-102 §4): claim a task in a team project — fetches the trunk (origin/<trunk>: team.json trunk, else origin/HEAD, else main|master — see `rein trunk`) and pushes one bookkeeping commit there setting the task IN_PROGRESS with you (git user.email) as assignee. Refuses [CLAIM_HELD] when someone else holds a claim younger than team.json claim_ttl_days; [CLAIM_LOST] when another push won the race; [OFFLINE] when origin is unreachable (the claim is pending: nothing published, the claim gate is not satisfied); [CLAIM_PENDING] when the push is refused. Required before writing source on an engineer/e<N>-* branch.",
      inputSchema: {
        type: "object",
        properties: { id: { type: "string", description: "Task ID (e.g. 'E-331')" } },
        required: ["id"],
      },
    },
    {
      name: "release_task",
      description: "E-331: release your claim on a task (abandon) — pushes a bookkeeping commit to origin/<trunk> setting it OPEN again. Only the holder can release.",
      inputSchema: {
        type: "object",
        properties: {
          id:     { type: "string", description: "Task ID" },
          reason: { type: "string", description: "Why the task is released (one line, goes into the commit message)" },
        },
        required: ["id"],
      },
    },
    {
      name: "add_stamp",
      description: "Writes an atomic audit stamp. Used by critic agents and review synthesizer.",
      inputSchema: {
        type: "object",
        properties: {
          task_id: { type: "string", description: "Related task ID (e.g. 'E-78')" },
          type:    { type: "string", description: "Stamp type (e.g. 'ARCH_PASS', 'SEC_FAIL', 'CRITIC_STAMP')" },
          agent:   { type: "string", description: "Agent that produced this stamp" },
          summary: { type: "string", description: "One-line summary of the finding" },
        },
        required: ["type", "agent", "summary"],
      },
    },
    {
      name: "set_project_focus",
      description: "Updates the project's current focus and tier.",
      inputSchema: {
        type: "object",
        properties: {
          focus:        { type: "string", description: "Current focus description" },
          current_tier: { type: "number", description: "Current risk tier", enum: [1, 2, 3] },
        },
        required: ["focus"],
      },
    },
    {
      name: "archive_done_tasks",
      description: `State-hygiene rotation (token-optimization.md). Moves old DONE tasks (beyond the last ${DONE_KEEP_RECENT}) to .ai/archive/state-done-YYYYMM.json (a team project: the tracked .ai/tasks/archive/YYYY-MM/ — E-330) when DONE count exceeds ${DONE_ARCHIVE_THRESHOLD}, AND rotates old audit stamps (beyond the last 10) to .ai/archive/stamps-YYYYMM.json when the stamp count exceeds 50. Returns { archived_tasks, archived_stamps, archivePath }.`,
      inputSchema: { type: "object", properties: {} },
    },
    // append_tasks intentionally removed from tool list — disabled (bypasses SQLite).
    // Call add_task instead.
    {
      name: "get_ci_status",
      description: "E-266 (D-072): the newest local CI run (rein ci run) recorded for a commit — default HEAD. Returns the ci_runs row plus `verdict` (PASS|FAIL|ERROR|SKIPPED|DIRTY|SHARD|NONE; only a non-dirty, unsharded PASS certifies a commit) and a one-line `summary`, or { status: \"NONE\" }. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          sha: { type: "string", description: "Commit sha (7-40 hex). Defaults to the project's HEAD." },
        },
      },
    },
    {
      name: "verify_markdown_sync",
      description: "Checks that TASKS.md and REVIEWS.md are in sync with state. Returns PASS or FAIL.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "validate_payload",
      description:
        "Validate a payload against a named Rein state transition schema before submitting it. " +
        "Schemas: task_create, task_update, stamp_add, project_update. " +
        "Returns SCHEMA_PASS or SCHEMA_FAIL with per-field error details. " +
        "Use before calling add_task, update_task_status, add_stamp, or set_project_focus to catch type errors early.",
      inputSchema: {
        type: "object",
        properties: {
          schema_name: {
            type: "string",
            enum: ["task_create", "task_update", "stamp_add", "project_update"],
            description: "Name of the schema to validate against.",
          },
          payload: {
            type: "object",
            description: "The JSON payload to validate.",
          },
        },
        required: ["schema_name", "payload"],
        additionalProperties: false,
      },
    },
    {
      name: "mark_deltas_read",
      description: "Marks implementation deltas as read after the Architect has incorporated them into architect.md. Pass specific task_ids to acknowledge selectively, or omit to acknowledge all unread deltas.",
      inputSchema: {
        type: "object",
        properties: {
          task_ids: {
            type: "array",
            items: { type: "string" },
            description: "Task IDs whose deltas to acknowledge (e.g. ['E-78', 'E-79']). Omit to acknowledge all unread.",
          },
        },
      },
    },
    // ── E-88: Multi-Variation-State-Tracker tools (SEO Topic Cluster Engine) ──
    // Backing tables (topic_seeds, cluster_pages) live in state-db.js. Wired
    // here per .ai/blueprints/seo-keyword-multiplier.md §Components 3 + §API.
    // Cloud sync hook does NOT fire from these — the managed-agents
    // projection contract (E-73 §Data Privacy) covers only tasks, not SEO
    // state.
    {
      name: "add_topic_seed",
      description: "Register a new TopicSeed (E-88). Returns an auto-assigned TS-N id. Use this once at the start of a generateTopicCluster(term) expansion in src/claude/agents/seo_manager.md; the SEO-Content-Generator then attaches one Pillar + up to MAX_CLUSTER_PAGES_PER_SEED Cluster pages to it.",
      inputSchema: {
        type: "object",
        properties: {
          term:          { type: "string", description: "The topic seed term (1..256 chars, no shell metachars)" },
          target_volume: { type: "number", description: "Target number of Cluster pages to generate (1..10, default 10)", default: 10 },
        },
        required: ["term"],
      },
    },
    {
      name: "add_cluster_page",
      description: "Register a ClusterPage against an existing TopicSeed (E-88). Refuses intent_type values outside the canonical set (1 Pillar + Cluster intents) defined in src/shared/seo-cluster-intents.mjs. Enforces the cannibalization guard (unique intent per seed) and the lifted cluster-page cap (defence-in-depth on blueprint §Execution Constraints/Generation Limits).",
      inputSchema: {
        type: "object",
        properties: {
          seed_id:      { type: "string", description: "TopicSeed id (e.g. 'TS-1')" },
          intent_type:  { type: "string", description: "One of the canonical intents (pillar-overview, cost, comparison, how-to, …, faq)" },
          content_blob: { type: "string", description: "Optional inline markdown body, or a relative repo path if content lives on disk" },
        },
        required: ["seed_id", "intent_type"],
      },
    },
    {
      name: "report_performance",
      description: "Update a ClusterPage.performance_metrics with new SEO metrics (E-88 reportPerformance API). Merges supplied keys into the existing JSON object — pass only the fields that changed.",
      inputSchema: {
        type: "object",
        properties: {
          page_id: { type: "string", description: "ClusterPage id (e.g. 'CP-1')" },
          metrics: { type: "object", description: "JSON merge patch — e.g. { clicks: 120, impressions: 4500, ctr: 0.027, position: 8.4 }" },
        },
        required: ["page_id", "metrics"],
      },
    },
    {
      name: "get_topic_cluster",
      description: "Return a TopicSeed plus every ClusterPage attached to it (E-88). Used by the SEO-Content-Generator duplicate-content gate and by the Architect to audit a cluster's progress toward its target.",
      inputSchema: {
        type: "object",
        properties: {
          seed_id: { type: "string", description: "TopicSeed id (e.g. 'TS-1')" },
        },
        required: ["seed_id"],
      },
    },
  ];
}
