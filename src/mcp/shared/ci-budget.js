// ci-budget.js — the test budget ratchet (E-303, D-088, test-economics.md §Component 7).
//
// Every green, non-dirty `ai ci run` records a budget block in its ci_runs row (budget_json):
//   { suites, test_lines, fast_tier_seconds, full_seconds, peak_rss_mb, peak_sum_rss_mb }
// The BEST value of a field is the lowest one recorded since the latest ruling. A run FAILS
// when a ratcheted field exceeds its best by more than its slack, so the numbers only move
// down. Equal or lower passes and, once recorded, is the new best. No flag or env var lifts
// it: raising a budget is a D-ruling, written into the record by `ai ci budget set --ruling
// D-###` (budgetSet), and the best is then computed from that row onward.
//
// Ratcheted (E-303's task text): suites +0, test_lines +2%, fast_tier_seconds +10%.
// full_seconds and the two peak-memory fields are RECORDED, not ratcheted: four full runs on
// one host on 2026-10-28 spread 466–514 s (10.3%), so a +10% wall-time ratchet on the best
// ever would fail on host load alone. §11's "ratchet full_seconds and peak_rss_mb" is put to
// the Architect with those numbers rather than shipped as a gate that fails on noise.

export const BUDGET_FIELDS = ["suites", "test_lines", "fast_tier_seconds", "full_seconds", "peak_rss_mb", "peak_sum_rss_mb"];

/** field → slack. `abs` is an absolute allowance, `pct` a fraction of the best. */
export const RATCHET = {
  suites: { abs: 0 },
  test_lines: { pct: 0.02 },
  fast_tier_seconds: { pct: 0.10 },
};

const RULING_RE = /^D-\d{3,}$/;

function _parse(json) {
  try { const v = JSON.parse(json || "null"); return v && typeof v === "object" ? v : null; } catch { return null; }
}

/** `[ci] budget suites=45 test_lines=39444 …` → { suites: 45, … } (a `-` value is absent). */
export function parseBudgetLine(line) {
  const out = {};
  for (const tok of String(line).replace(/^\[ci\] budget\s*/, "").split(/\s+/)) {
    const m = tok.match(/^([a-z_]+)=(\d+)$/);
    if (m && BUDGET_FIELDS.includes(m[1])) out[m[1]] = Number(m[2]);
  }
  return out;
}

/**
 * The current budget: per field the lowest value recorded by a PASS, non-dirty run since the
 * latest ruling (the ruling row itself included). → { best, ruling, rulingSha, runs }
 */
export function budgetBest(db) {
  const rows = db.prepare(
    "SELECT id, sha, budget_json, budget_ruling FROM ci_runs WHERE status = 'PASS' AND dirty = 0 AND budget_json IS NOT NULL ORDER BY id",
  ).all();
  let from = 0;
  rows.forEach((r, i) => { if (r.budget_ruling) from = i; });
  const since = rows.slice(from);
  const best = {};
  for (const r of since) {
    const b = _parse(r.budget_json);
    if (!b) continue;
    for (const f of BUDGET_FIELDS) {
      if (Number.isFinite(b[f]) && (best[f] == null || b[f] < best[f])) best[f] = b[f];
    }
  }
  const head = rows[from];
  return { best, ruling: head?.budget_ruling || null, rulingSha: head?.budget_ruling ? head.sha : null, runs: since.length };
}

/** The limit a measurement may reach for one field. */
export function budgetLimit(field, best) {
  const s = RATCHET[field];
  return s.abs != null ? best + s.abs : Math.floor(best * (1 + s.pct));
}

/** Regressions of `measured` against `best`, one per ratcheted field that exceeds its limit. */
export function budgetCheck(best, measured) {
  const out = [];
  for (const f of Object.keys(RATCHET)) {
    if (best[f] == null || measured[f] == null) continue;
    const limit = budgetLimit(f, best[f]);
    if (measured[f] > limit) {
      const s = RATCHET[f];
      out.push({ field: f, recorded: best[f], measured: measured[f], slack: s.abs != null ? `+${s.abs}` : `+${Math.round(s.pct * 100)}%`, limit });
    }
  }
  return out;
}

/** The one line a regression prints: recorded, measured and slack together. */
export function regressionLine(r) {
  return `[BUDGET_REGRESSION] ${r.field}: recorded ${r.recorded}, measured ${r.measured}, slack ${r.slack} (limit ${r.limit}) — the budget only moves down; raising it is a D-ruling: ai ci budget set --ruling D-### ${r.field}=<n>`;
}

/**
 * Raise (or set) budget fields by ruling. Writes the ruling id and the ruled values into the
 * newest PASS, non-dirty row that carries a budget, so the best is computed from it onward.
 * Throws on a missing or malformed ruling id, an unknown field or no such row.
 */
export function budgetSet(db, ruling, values) {
  if (!RULING_RE.test(String(ruling || ""))) throw new Error("a budget changes only by ruling: --ruling D-### (e.g. D-118)");
  const keys = Object.keys(values || {});
  if (!keys.length) throw new Error("name at least one field=value");
  for (const k of keys) {
    if (!BUDGET_FIELDS.includes(k)) throw new Error(`unknown budget field '${k}' (one of: ${BUDGET_FIELDS.join(", ")})`);
    if (!Number.isInteger(values[k]) || values[k] < 0) throw new Error(`${k} must be a whole number`);
  }
  const row = db.prepare(
    "SELECT id, sha, budget_json FROM ci_runs WHERE status = 'PASS' AND dirty = 0 AND budget_json IS NOT NULL ORDER BY id DESC LIMIT 1",
  ).get();
  if (!row) throw new Error("no green run with a budget is recorded yet — run: ai ci run");
  const merged = { ...(_parse(row.budget_json) || {}), ...values };
  db.prepare("UPDATE ci_runs SET budget_json = ?, budget_ruling = ? WHERE id = ?").run(JSON.stringify(merged), ruling, row.id);
  return { sha: row.sha, budget: merged };
}

/**
 * E-366 (D-118 r1): the recorded-only fields are watched, never ratcheted. When the latest green
 * run exceeds the median of the last five green runs by more than DRIFT_PCT on one of them, a
 * `[BUDGET_DRIFT]` line is printed — never a FAIL and never a ruling. Fewer than five green runs:
 * nothing. → [{ field, latest, median, pct }]
 */
export const DRIFT_FIELDS = ["full_seconds", "peak_rss_mb", "peak_sum_rss_mb"];
export const DRIFT_PCT = 0.25;

export function budgetDrift(db) {
  const rows = db.prepare(
    "SELECT budget_json FROM ci_runs WHERE status = 'PASS' AND dirty = 0 AND budget_json IS NOT NULL ORDER BY id DESC LIMIT 5",
  ).all().map((r) => _parse(r.budget_json)).filter(Boolean);
  if (rows.length < 5) return [];
  const out = [];
  for (const f of DRIFT_FIELDS) {
    const vals = rows.map((b) => b[f]).filter(Number.isFinite);
    if (vals.length < 5 || !Number.isFinite(rows[0][f])) continue;
    const median = [...vals].sort((a, b) => a - b)[2];
    const latest = rows[0][f];
    if (median > 0 && latest > median * (1 + DRIFT_PCT)) out.push({ field: f, latest, median, pct: Math.round((latest / median - 1) * 100) });
  }
  return out;
}

/** `[BUDGET_DRIFT] <field> <latest> vs median-of-5 <value> (+N%)` */
export const driftLine = (d) => `[BUDGET_DRIFT] ${d.field} ${d.latest} vs median-of-5 ${d.median} (+${d.pct}%)`;

/** One human line for `ai ci status` / `ai doctor`. */
export function budgetSummary({ best, ruling, rulingSha, runs }) {
  if (!runs) return "no budget recorded yet";
  const parts = BUDGET_FIELDS.filter((f) => best[f] != null).map((f) => `${f} ${best[f]}${RATCHET[f] ? "" : " (recorded)"}`);
  return `${parts.join(", ")}${ruling ? ` — ruled by ${ruling} at ${String(rulingSha).slice(0, 7)}` : ""}`;
}
