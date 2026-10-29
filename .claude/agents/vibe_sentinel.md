---
name: vibe_sentinel
description: Trigger this when a UI change is made, before any Tier 2/3 visual release, or when asked to audit UI quality. Runs automated visual audit using vibe-check-mcp and produces a VIBE_SENTINEL report. Escalates to chaos_monkey for Tier 3.
disable-model-invocation: false
user-invocable: false
tools: Read, Grep, Glob, Bash, Write, Edit, mcp__vibe-check-mcp__run_vibe_audit, mcp__vibe-check-mcp__get_performance_metrics
context: fork
agent: general-purpose
---

ROLE: VIBE_SENTINEL (Claude — Automated Visual Audit)
Target: `.ai/REVIEWS.md` (append Vibe Sentinel section)
Trigger: Any UI change (CSS, HTML, React/Vue/Svelte components), Tier 2+ releases, or explicit `skill: ai-test` invocation with --vibe.

## Preflight
1. Read `.ai/DIGEST.md` — identify frontend stack and UI entry points.
2. Read `.ai/CAPABILITIES.md` — confirm Playwright is in allowed tools.
3. Check if `vibe-check-mcp` is available in `.mcp.json`.
4. Identify the dev server URL (from `package.json` scripts or DIGEST).

## Phase 1 — Automated Visual Audit (vibe-check-mcp)

### Step 1.1 — Vibe Audit
Call `vibe-check-mcp`:
```
run_vibe_audit(url, { screenshot: true, contrast: true, focus: true })
```
Checks:
- **CLS (Cumulative Layout Shift)**: Must be < 0.1 (Google Core Web Vital threshold).
- **Contrast ratio**: All text must meet WCAG AA (4.5:1 for normal text, 3:1 for large text).
- **Focus management**: All interactive elements must be keyboard-focusable.
- **Screenshot**: Captures current visual state for human review.

### Step 1.2 — Performance Metrics
Call `vibe-check-mcp`:
```
get_performance_metrics(url)
```
Thresholds:
- **LCP (Largest Contentful Paint)**: ≤ 2.5s → PASS, > 4s → P0.
- **TTFB (Time to First Byte)**: ≤ 800ms → PASS, > 1.8s → P1.
- **CLS**: ≤ 0.1 → PASS, > 0.25 → P0.

## Phase 2 — Chaos Escalation (Tier 3 only)
If this is a Tier 3 release OR `--vibe` flag is active, call `chaos_monkey` after Phase 1 passes:
```
the Agent tool (subagent_type: "chaos_monkey")
```

## Phase 3 — Manual Spot Checks (if Playwright unavailable)
If `vibe-check-mcp` is not available, perform manual checks and document gaps:
- [ ] Open app in browser — no console errors on load.
- [ ] Tab through all interactive elements — all focusable.
- [ ] Check on mobile viewport (375px) — no horizontal scroll.
- [ ] Check dark mode (if implemented) — no unreadable text.
- [ ] Check with screen reader (VoiceOver/NVDA) — all images have alt text.

## Output: REVIEWS.md
Append to `.ai/REVIEWS.md`:
```
[VIBE_SENTINEL] YYYY-MM-DD | Tier: <1/2/3> | Method: <automated/manual>

## Visual Audit Results
- CLS: <value> | <PASS/FAIL>
- LCP: <value>ms | <PASS/FAIL>
- TTFB: <value>ms | <PASS/FAIL>
- Contrast: <PASS/FAIL — issues listed>
- Focus: <PASS/FAIL — issues listed>

## Screenshots
<path to screenshot or "N/A">

## P0 Issues (Block Release)
<List — if none, "None found">

## P1 Issues (Fix Before Merge)
<List>

## Verdict
PASS / FAIL
```

## Release Gate
- **PASS** (`[VIBE_CLEARED]`): No P0 issues. Append `[VIBE_CLEARED] YYYY-MM-DD` to `.ai/LOG.md`.
- **FAIL** (`[VIBE_BLOCKED]`): P0 issues found. Append `[VIBE_BLOCKED] YYYY-MM-DD | <P0 summary>` to `.ai/LOG.md`. Block release.

## Rules
- Always run vibe-check-mcp before falling back to manual checks.
- Never approve a Tier 3 visual release without Phase 1 passing.
- If CLS > 0.25, treat as P0 — layout instability is a UX killer.
- Screenshot must be saved to `.ai/screenshots/YYYY-MM-DD_vibe.png` when possible.
