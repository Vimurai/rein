---
name: ai-profile
description: In-context profiling workflow for Node.js performance measurement. Runs node --cpu-prof / --heap-prof under Bash in a throwaway temp directory and returns structured profiling data (plus the .cpuprofile/.heapprofile files) to the performance_engineer agent.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, Glob
context: default
agent: default
---

# AI-Profile — Node.js Performance Profiling Workflow

## Dynamic Context Injection
Target module/command: !echo "${TARGET:-(not set)}"
Profiling metric: !echo "${METRIC:-cpu}"
Baseline SHA (optional): !echo "${BASELINE_SHA:-(none)}"
Node version: !node --version 2>/dev/null || echo "(node not found — profiling unavailable)"

## Role

You are the **Profiling Workflow Engine**. Your job is to measure CPU, memory, and
bundle-size performance of a target module or command. CPU and memory run under the
**Bash tool** with Node's built-in V8 profilers (`--cpu-prof`, `--heap-prof`) in a
throwaway temp directory; bundle size and Web Vitals also use Bash (they need build
tools and a network). Parse the results and hand structured data back to the
`performance_engineer` agent.

D-075 (E-278) retired the Docker sandbox server, which was unavailable on
every host that ran AI-OS; the V8 profilers give real call stacks, which the sandbox's
`process.cpuUsage()` proxy never did.

You do **NOT** write OPTIMIZATION_REPORT.md or make code changes. You **ONLY** profile and return data.

## When to Invoke

- When the `performance_engineer` agent invokes it with the Skill tool (`skill: "ai-profile"`, args: target, metric, baseline_sha)
- From user CLI: `skill: ai-profile --target src/index.js --metric cpu`
- As part of a pre-deployment gate (Tier 3 tasks)

## Input Arguments

- **target** (required): A file path (`src/core/scheduler.js`), or command (`npm run build`)
- **metric** (required): One of `cpu`, `memory`, `bundle`, `vitals`
- **baseline_sha** (optional): A prior git commit hash to fetch baseline for delta calculation

## Step 1 — Preflight Validation

1. Verify Node is available: `command -v node || { echo "[PROFILER_UNAVAILABLE] node not found"; exit 1; }`
2. If target is a file, verify it exists:
   ```bash
   [ -f "<target>" ] || [ -f "src/<target>" ] || { echo "[TARGET_NOT_FOUND]"; exit 1; }
   ```
3. If metric is `vitals` or `bundle`, prepare to invoke the build tools directly (Lighthouse and npm need network access).

## Step 2 — Prepare the Harness

Write a minimal driver that exercises the hot path with a FINITE workload into a fresh
temp directory. Never profile an unbounded loop.

```bash
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cat > "$T/driver.mjs" <<'JS'
import { schedule } from "<absolute path to the target module>";
for (let i = 0; i < 10000; i++) schedule({ id: `task-${i}`, delay: i % 1000 });
JS
```

### For **cpu** metric (V8 CPU profile):
```bash
( cd "$T" && ulimit -t 30; exec node --cpu-prof --cpu-prof-dir="$T/prof" "$T/driver.mjs" )
ls "$T"/prof/*.cpuprofile
```
Summarise the profile: total samples, and the top 10 functions by self time.
```bash
node -e '
const p = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const dt = (p.endTime - p.startTime) / p.samples.length;          // µs per sample
const self = new Map(); for (const id of p.samples) self.set(id, (self.get(id) || 0) + 1);
const rows = p.nodes.map(n => ({ fn: n.callFrame.functionName || "(anonymous)",
  at: `${n.callFrame.url.split("/").pop()}:${n.callFrame.lineNumber + 1}`,
  self_us: Math.round((self.get(n.id) || 0) * dt) })).sort((a, b) => b.self_us - a.self_us);
console.log(JSON.stringify({ total_us: p.endTime - p.startTime, top: rows.slice(0, 10) }));
' "$T"/prof/*.cpuprofile
```

### For **memory** metric (V8 sampling heap profile + heap delta):
```bash
( cd "$T" && ulimit -t 30; exec node --heap-prof --heap-prof-dir="$T/prof" --expose-gc --input-type=module -e '
  global.gc(); const before = process.memoryUsage().heapUsed;
  await import("./driver.mjs");
  global.gc(); const after = process.memoryUsage().heapUsed;
  console.log(JSON.stringify({ metric: "heap_delta_bytes", before, after, delta: after - before }));
' )
ls "$T"/prof/*.heapprofile
```
`--expose-gc` is available here (it was not in the old sandbox), so measure after an
explicit `gc()` rather than a settling loop.

### For **bundle** metric (webpack/esbuild):
```bash
npm run build -- --analyze 2>&1 | grep -E "chunk|bundle|size" || du -sh dist/
```

### For **vitals** metric (Lighthouse via headless):
```bash
# Requires a running dev server on $PORT (default 3000)
npx lighthouse http://localhost:3000 --chrome-flags="--headless" --output=json --output-path="$T/lh.json" 2>&1
jq '.audits | {fcp: ."first-contentful-paint".numericValue, lcp: ."largest-contentful-paint".numericValue, cls: ."cumulative-layout-shift".numericValue}' "$T/lh.json"
```

## Step 3 — Keep the Profiles

Copy the `.cpuprofile` / `.heapprofile` out of `$T` before it is removed (e.g. into
`.ai/profiles/<date>-<metric>.cpuprofile`, and add `.ai/profiles/` to `.gitignore` — profiles embed absolute paths, including the username). They open
as a flame chart in Chrome DevTools (Performance → Load profile) or https://www.speedscope.app.

If the driver exits non-zero or hits the CPU cap, mark the run `[INCONCLUSIVE]` and
document the reason.

## Step 4 — Parse & Structurize Results

Return a JSON envelope:
```json
{
  "status": "OK" | "TIMEOUT" | "PROFILER_UNAVAILABLE",
  "target": "<input target>",
  "metric": "<input metric>",
  "measurement": {
    "value": <numeric>,
    "unit": "micros|bytes|KB|ms",
    "timestamp": "ISO8601"
  },
  "top_functions": [ { "fn": "...", "at": "file:line", "self_us": 0 } ],
  "profile_path": "<kept .cpuprofile/.heapprofile, if any>",
  "baseline": {
    "value": <numeric>,
    "sha": "<baseline_sha if provided>",
    "delta_percent": <((new - old) / old) * 100>
  },
  "raw_output": "<stdout from the run>"
}
```

## Step 5 — Return to Caller

Report the envelope back to the caller (typically `performance_engineer` agent):
- If called via the Skill tool, the JSON is captured in the agent's context
- If called via CLI, print the JSON to stdout
- Do NOT write to OPTIMIZATION_REPORT.md (that is the agent's responsibility)

## Safety Constraints

- **Finite workloads only**: every driver has a fixed iteration count; `ulimit -t 30`
  caps CPU seconds so a runaway driver dies instead of pinning the host
- **Temp dir only**: the driver and its profiles live in `mktemp -d`, removed on exit
- **No host side-effects (a rule, not enforced)**: the driver imports the real module with the full environment, at the same trust level as running its tests; do not profile code whose normal behaviour writes to host files or the network
- **Sequential only**: do not spawn parallel profiles; wait for one to complete before starting the next
- **Determinism**: run 3x when variance is >5% and report median + range

## Output

Upon completion, emit:
```
[PROFILE_COMPLETE] <target> | <metric> = <value> <unit> | status=<OK|TIMEOUT|OOM>
```

If the `performance_engineer` agent is listening, it will parse the JSON and synthesize OPTIMIZATION_REPORT.md. If called standalone (CLI), the user receives the raw data for manual analysis.

## Rollback & Recovery

- If node is unavailable: emit `[PROFILER_UNAVAILABLE]` and stop
- If target not found: emit `[TARGET_NOT_FOUND]` and suggest alternative paths to search
- If metric is unsupported: emit `[UNSUPPORTED_METRIC]` and list available metrics (cpu, memory, bundle, vitals)
