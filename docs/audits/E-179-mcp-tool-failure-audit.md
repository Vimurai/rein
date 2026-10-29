# E-179 — MCP Tool Failure-Rate Audit

**Author:** Engineer (Claude) · **Tier:** 2 · **Date:** 2026-06-21
**Source signal:** `~/.ai-os/INSIGHTS.md` → *Tool Deprecation Candidates* (meta-cognition E-85)
**Verdict:** No tool deprecated. The aggregate was **measuring the wrong thing**.

---

## TL;DR

The INSIGHTS "Tool Deprecation Candidates" table flags 7 tools by **error %**, where
"error" = any CallTool result with `isError: true` (telemetry interceptor E-153/E-154,
`statusForResult`). But across all 7, the overwhelming majority of `isError` returns are
**expected, healthy rejections** — input validation, not-found, schema-fail, and
domain-negative results (e.g. sandboxed code exiting non-zero) — **not tool malfunctions.**
Genuine crashes already route through `withTelemetry`'s `catch` → ERROR, so a *returned*
`isError` is almost always an intentional, handled negative outcome.

This is an [E-168](../../.ai/DIGEST.md)-class finding: the audit's premise ("high-failure /
broken tools") is largely a **telemetry-classification artifact**. Verify-first beats the
audit.

## Fix shipped

A handler can now flag an `isError` result as an **expected rejection** via
`_meta.expected_rejection = true` (helpers `rejection()` / `markRejection()` in
`src/shared/mcp-telemetry.mjs`). `statusForResult()` books such results **SUCCESS** (the
tool worked correctly; the caller/precondition was the problem) while the result the model
receives is **unchanged** — `isError: true` still reaches the LLM so it reacts to the bad
input. Genuine handled errors are left **unmarked** and therefore still record **ERROR**.

`_meta` is a spec-sanctioned passthrough field; verified end-to-end through the real MCP
stdio transport (the SDK forwards it untouched and the server does not crash).

---

## Per-tool findings

| Tool | INSIGHTS error % | Dominant `isError` causes | Real category | Action |
| --- | ---: | --- | --- | --- |
| `code-execution-mcp::execute_code` | 100% | `[SANDBOX_UNAVAILABLE]` (Docker/image absent); sandboxed user code exits ≠ 0 | environmental + domain-negative | mark expected; Docker absence documented (fail-closed by design) |
| `task-synchronizer-mcp::add_topic_seed` | 85.7% | `[INVALID_TOPIC_TERM]` / `[INVALID_TARGET_VOLUME]` | input validation | mark expected |
| `task-synchronizer-mcp::report_performance` | 60% | `[INVALID_PAGE_ID]` / `[INVALID_METRICS]` / `[PAGE_NOT_FOUND]` | input validation + not-found | mark expected |
| `task-synchronizer-mcp::validate_payload` | 50% | `[SCHEMA_FAIL]` — the tool's entire purpose | domain-negative (working as designed) | mark expected |
| `task-synchronizer-mcp::get_topic_cluster` | 50% | `[INVALID_SEED_ID]` / `[SEED_NOT_FOUND]` | input validation + not-found | mark expected |
| `ast-parser-mcp::parse_workspace` | 33.7% | `[PATH_DENIED]` / `[NOT_FOUND]` (caller pointed at a bad/forbidden path) | target rejection | mark expected; genuine `catch` stays ERROR |
| `propose-patch-mcp::confirm_patch` | 33.3% | stale/already-applied patch id; clean dry-run refusal (safety guard) | expected lifecycle + safety | mark expected; apply-after-dry-run-fail & write-exception stay ERROR |

### Notes

- **`execute_code` 100%** is the only entry with a real environmental cause: in hosts
  without a reachable Docker daemon or the `python:3.12-slim` image, the sandbox is
  fail-closed and *correctly* refuses every call. This is the host missing a dependency,
  not a defect in the tool — it cannot and should not be "fixed" in code. (Matches the
  pre-existing DIGEST "3 code_execution Docker flakes" note; green in CI where Docker runs.)
- **`validate_payload`** is the clearest case: a validation tool reporting an invalid
  payload (`SCHEMA_FAIL`) is *succeeding at its job*. Counting that as an error is a
  category mistake.
- **`confirm_patch`** retains two **genuine** error paths (a `patch(1)` apply failing
  *after* a passing dry-run, and a write exception) — these are deliberately left unmarked
  so a real regression there still surfaces in the deprecation aggregate.

## What this does NOT change

- The schema/status taxonomy (`SUCCESS` / `ERROR` / `TIMEOUT`, E-154) — **no migration**.
- The MCP contract — `isError` semantics for the model are unchanged.
- Thrown-exception handling — still ERROR via `withTelemetry`'s `catch`.

## Tests

- `tests/suites/mcp_telemetry_test.sh` §179.01–179.07 — marker classification + end-to-end.
- Affected server suites (`ast_parser`, `propose_patch_apply`, `code_execution_mcp`,
  `seo_*`, `telemetry*`) — green, no regressions.

## Follow-up for the Architect (meta-cognition.md)

The deprecation aggregate is now honest about *malfunctions*, but the **expected-rejection
volume** (callers repeatedly sending invalid input) is still a useful "usage friction"
signal that is now folded into SUCCESS. If desired, a future enhancement could record
expected rejections under a distinct dimension (requires a `status` taxonomy change /
migration — Architect call). Flagged, not implemented (§35).
