// task-quality.mjs — the task-planner checks, moved into add_task (E-461, D-169 r7,
// .ai/blueprints/lean-core.md §Component 4).
//
// A task is refused when it has no tier, when its description does not start with an
// imperative verb, or when its Acceptance text is missing or has no clause that names a
// command, a file or a count — the clauses critic_acceptance observes before DONE (E-431).
// task-synchronizer-mcp::add_task and `rein add-task` both call checkTaskQuality(); the schema
// (src/shared/schemas/state.json task_create) makes tier and an "Acceptance:" text required too,
// so the MCP tool answers those two with [SCHEMA_FAIL] before this runs.

// The verbs a task description starts with. A verb missing here is added here — never a
// heuristic that lets a noun phrase through ("The auth system", "Monorepo structure").
export const TASK_VERBS = new Set(`
  add adopt align allow apply archive audit automate block bring build bump change check clean
  close collapse collect compute configure consolidate convert correct create cut decide define
  delegate delete deliver deprecate design detect disable document drop emit enable enforce
  ensure establish evaluate expand export extend extract fix fold gate generate guard handle
  harden hold implement import improve inject install instrument integrate introduce keep land
  lift limit list load log make mark measure merge migrate mirror move name normalize normalise
  open package pin plan port probe prove prune publish record redact reduce refactor register
  release remove rename render reorder repair replace report require reroute reset resolve
  restore restrict retire return review rewrite route rule run scope seed separate ship show
  sign simplify skip split stamp standardize standardise start stop strip supersede surface
  switch sync tag teach test tighten trace track trim unblock unify update upgrade use validate
  verify wire write
  accept allocate annotate append assert assign attach attribute backfill backport batch
  benchmark bind bootstrap cache cap capture carry catch clear compare compress connect copy
  count declare dedupe defer deploy diagnose draft dump edit encode encrypt escalate exclude
  execute expose fetch filter find fingerprint flag flush forbid format gather give group
  hard-cut hide hook include index inline inspect invalidate isolate join label launch lint lock
  lower map match minimize monitor mount note notify observe optimise optimize order override
  parse patch pause perform persist point poll populate preserve prevent print process produce
  profile promote propagate protect provide provision pull push put query queue raise re-enable
  re-run rebase rebuild recover redesign redirect refresh refuse reinstall reinstate reject relax
  reload reopen reorganise reorganize replay reproduce request rerun reserve retry reuse revert
  revise rotate sanitise sanitize save scan schedule scrub search secure select send serve set
  share shorten shrink size sort specify spike stabilise stabilize stage store stream stub submit
  summarise summarize support suppress swap take treat throttle toggle translate trigger truncate
  tune turn undo uninstall unpin upload watch widen wrap
`.trim().split(/\s+/));

/** The Acceptance text: what follows the last "Acceptance:" up to a trailing "| Tier: N". */
export function acceptanceText(description) {
  const s = String(description || "");
  const i = s.search(/acceptance\s*:(?![\s\S]*acceptance\s*:)/i);
  if (i < 0) return null;
  return s.slice(i).replace(/^acceptance\s*:/i, "").replace(/\|\s*Tier\s*:\s*\d\s*$/i, "").trim();
}

// A clause names something to run or look at: a backticked command or path, a known command
// word, a path or file name, or a count.
const OBSERVABLE = [
  /`[^`]+`/,                                                          // `rein ci run`, `src/x.mjs`
  /\b(rein|git|npm|node|bash|gh|claude|tmux|python3?)\s+[\w-]/,       // a command line
  /(^|[\s(])[\w.@~-]*\/[\w.*-]+/,                                     // a path: .ai/COMM.md, src/
  /\b[\w-]+\.(md|json|mjs|cjs|js|ts|sh|py|ya?ml|toml|txt|sqlite|html|css|cast)\b/i,   // a file name
  /\d/,                                                               // a count or an exit code
];

/** Split the Acceptance text into clauses on ";" and sentence ends. */
export function acceptanceClauses(text) {
  return String(text || "").split(/;\s+|\.\s+(?=[A-Z`(])/).map((c) => c.trim()).filter(Boolean);
}

export function clauseIsObservable(clause) {
  return OBSERVABLE.some((re) => re.test(clause));
}

/**
 * @param {{description:string, tier?:number|null}} t
 * @returns {null | {code:string, error:string}} null when the task passes every check.
 */
export function checkTaskQuality({ description, tier } = {}) {
  if (tier == null || ![1, 2, 3].includes(Number(tier))) {
    return { code: "TASK_NO_TIER", error: "tier is required: 1 (no behaviour change), 2 (everything else) or 3 (role boundary, install, hooks, secrets, release signing)." };
  }
  const first = (/^[^A-Za-z]*([A-Za-z][A-Za-z-]*)/.exec(String(description || "").replace(/^\s*[EPT]-\d+\s*:\s*/, "")) || [])[1];
  if (!first || !TASK_VERBS.has(first.toLowerCase())) {
    return { code: "TASK_NO_VERB", error: `the description must start with an imperative verb ("Add …", "Replace …"), not ${JSON.stringify(first || "")}.` };
  }
  const acc = acceptanceText(description);
  if (!acc) {
    return { code: "TASK_NO_ACCEPTANCE", error: 'the description needs an "Acceptance:" text whose clauses name a command, a file or a count.' };
  }
  const clauses = acceptanceClauses(acc);
  if (!clauses.some(clauseIsObservable)) {
    return { code: "TASK_ACCEPTANCE_UNOBSERVABLE", error: `no Acceptance clause names a command, a file or a count to observe: ${JSON.stringify(acc.slice(0, 200))}.` };
  }
  return null;
}
