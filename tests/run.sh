#!/usr/bin/env bash
# run.sh — Rein Master Test Runner (P-15 / §22)
# Usage: bash tests/run.sh [--sweep] [--tier fast|full] [--changed <ref>] [--lanes N] [--shard i/N] [suite_pattern]
#   --lanes N (REIN_TEST_LANES, default 1): shared suites in N parallel lanes, exclusive ones
#     after them serially (E-309, D-091); refused above free memory / 1.5 GB.
#   --tier full (default): every suite — today's matrix; `rein ci run` and pre-push use it.
#   --tier fast: the node unit layer + every contract-table suite (E-298, D-088; budget 60 s).
#   --changed <ref>: fast + the suites whose census footprint touches a file changed since <ref>
#     (tests/tools/select-suites.mjs); with no census it runs the full matrix and says so.
#   --shard i/N (REIN_TEST_SHARD): only shard i of N — a deterministic partition by wall hint
#     (tests/tools/shard-plan.mjs; E-386, D-135 r3). Not with --tier fast or --changed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# REIN_TEST_SUITES_DIR: a fixture suites directory, so the runner's own gates (the leak
# and telemetry checks) can be tested by running it over a known-bad suite (E-257).
SUITES_DIR="${REIN_TEST_SUITES_DIR:-${SCRIPT_DIR}/suites}"
# E-240: --sweep removes what a run leaked (locally; on CI a leak FAILS the run instead,
# because CI has no operator to run a sweep and a green run that leaks is a lie).
REIN_SWEEP=0
REIN_TIER="full"
REIN_CHANGED=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --sweep) REIN_SWEEP=1; shift ;;
    --tier)
      [[ "${2:-}" == "fast" || "${2:-}" == "full" ]] || { echo "run.sh: --tier needs fast|full" >&2; exit 2; }
      REIN_TIER="$2"; shift 2 ;;
    --changed)
      [[ -n "${2:-}" ]] || { echo "run.sh: --changed needs a ref" >&2; exit 2; }
      REIN_CHANGED="$2"; shift 2 ;;
    --lanes)
      [[ "${2:-}" =~ ^[1-9][0-9]*$ ]] || { echo "run.sh: --lanes needs a positive integer" >&2; exit 2; }
      REIN_TEST_LANES="$2"; shift 2 ;;
    --shard)
      [[ -n "${2:-}" ]] || { echo "run.sh: --shard needs i/N" >&2; exit 2; }
      REIN_TEST_SHARD="$2"; shift 2 ;;
    *) break ;;
  esac
done
PATTERN="${1:-*_test.sh}"
# E-309 (D-091): --lanes N / REIN_TEST_LANES; 1 (the default) is today's serial run. The lane
# markers are this process's own; a value in the environment never makes a run a lane.
unset REIN_LANE_LABEL
# The lane settings configure THIS run only: a runner a suite starts (the fixture runs in
# harness_isolation_test's leaked-state and telemetry-isolation sections) is serial unless it asks — so they are read
# here and kept, but no longer exported to the suites.
export -n REIN_TEST_LANES REIN_TEST_LANES_AUTO REIN_TEST_WALL_HINTS REIN_TEST_FREE_MB REIN_TEST_SHARD 2>/dev/null || true
REIN_LANES="${REIN_TEST_LANES:-1}"
[[ "$REIN_LANES" =~ ^[1-9][0-9]*$ ]] || { echo "run.sh: REIN_TEST_LANES must be a positive integer" >&2; exit 2; }
# E-386 (D-135 r3): one shard of the run. The fast job is one leg, so a shard of the fast tier
# or of a change selection has no meaning — refused, like a bad spec.
REIN_SHARD="${REIN_TEST_SHARD:-}"
if [[ -n "$REIN_SHARD" ]]; then
  if [[ ! "$REIN_SHARD" =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || (( BASH_REMATCH[1] > BASH_REMATCH[2] )); then
    echo "run.sh: --shard needs i/N with 1 ≤ i ≤ N (got '${REIN_SHARD}')" >&2; exit 2
  fi
  if [[ "$REIN_TIER" == "fast" || -n "$REIN_CHANGED" ]]; then
    echo "run.sh: --shard cannot be combined with --tier fast or --changed (the fast job is one leg)" >&2; exit 2
  fi
fi
# ── E-240 (D-063 §2): leaked external state ─────────────────────────────────
#
# A suite that fails halfway used to leave tmux servers behind — 50 of them accumulated
# before anyone noticed, and a recycled PID then made a later run attach to one. The leak
# was found BY HAND. The runner should find the next one.
#
# THE SAFETY PROPERTY, and it is the important one: the sweep only ever touches names
# carrying the TEST PREFIX. A developer's own tmux session must survive a test run
# untouched, and a cleanup tool that can kill the operator's work is worse than the leak it
# fixes. There is a negative test for exactly this.
REIN_TEST_SOCK_PREFIX="${REIN_TEST_SOCK_PREFIX:-rein-test-}"
REIN_TEST_TMP_PREFIX="${REIN_TEST_TMP_PREFIX:-rein-t-}"
TOTAL_LEAKED=0
LEAK_REPORTS=()

# _leak_snapshot → lines of "<kind>|<id>", the external state a test run could leave.
_leak_snapshot() {
  local sockdir="${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)"
  if [[ -d "$sockdir" ]]; then
    ls -1 "$sockdir" 2>/dev/null | grep "^${REIN_TEST_SOCK_PREFIX}" \
      | sed 's|^|tmux-server\||' || true
  fi
  ls -1d "${TMPDIR:-/tmp}/${REIN_TEST_TMP_PREFIX}"* 2>/dev/null \
    | sed 's|^|temp-dir\||' || true
  # Background processes whose argv names a harness sandbox (attribution key: argv).
  ps -axo pid=,command= 2>/dev/null \
    | grep -E "${REIN_TEST_TMP_PREFIX}|${REIN_TEST_SOCK_PREFIX}" \
    | grep -v 'grep' \
    | awk '{print "process|" $1 "|argv"}' || true
  return 0
}

# _leak_diff <before-file> <after-file> → lines present only in "after"
_leak_diff() {
  comm -13 <(sort -u "$1") <(sort -u "$2") 2>/dev/null || true
}

# _leak_sweep <lines> — remove ONLY what carries the test prefix.
_leak_sweep() {
  local line kind id
  while IFS='|' read -r kind id _key; do   # the third field is the attribution key
    [[ -z "$kind" ]] && continue
    case "$kind" in
      tmux-server)
        # Belt and braces: re-check the prefix here as well as at snapshot time, because
        # this is the branch that can destroy someone's session.
        [[ "$id" == "${REIN_TEST_SOCK_PREFIX}"* ]] || continue
        tmux -L "$id" kill-server 2>/dev/null || true
        rm -f "${TMUX_TMPDIR:-/tmp}/tmux-$(id -u)/${id}" 2>/dev/null || true ;;
      temp-dir)
        [[ "$id" == *"/${REIN_TEST_TMP_PREFIX}"* ]] || continue
        rm -rf "$id" 2>/dev/null || true ;;
      process)
        [[ "$id" =~ ^[0-9]+$ ]] || continue
        kill -TERM "$id" 2>/dev/null || true ;;
    esac
  done <<< "$1"
}



TOTAL_PASS=0
TOTAL_FAIL=0
TOTAL_SKIP=0
SUITE_RESULTS=()

# Colour control — only emit ANSI escapes when stdout is an interactive TTY.
if [[ -t 1 ]]; then
  C_OK="\033[32m"; C_FAIL="\033[31m"; C_RESET="\033[0m"
else
  C_OK=""; C_FAIL=""; C_RESET=""
fi

# ── E-156 / E-157: Test harness isolation ────────────────────────────────────
# Generate an ephemeral .mcp.test.json inside a private temp dir so suites never
# read or mutate the tracked production .mcp.json, and expose it via
# MCP_CONFIG_PATH (respected by MCP loaders that opt in). A trap tears the temp
# dir down on ANY exit — success, failure, or interrupt (EXIT/INT/TERM) — so the
# git working tree is left clean.
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# E-297: a runner started BY a suite (harness_isolation_test's leaked-state and launch-vars sections) inherits the outer
# run's REIN_TEST_TMPDIR. Such a nested run records its own footprint but never publishes a
# census input — its suites are fixtures or a subset, not this commit's suite.
REIN_CENSUS_NESTED=0
[[ -n "${REIN_TEST_TMPDIR:-}" || -n "${REIN_TEST_SUITES_DIR:-}" ]] && REIN_CENSUS_NESTED=1
TEST_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/rein-test.XXXXXX")"
MCP_TEST_CONFIG="${TEST_TMPDIR}/.mcp.test.json"

REIN_LANE_PIDS=(); REIN_RSS_SAMPLER_PID=""
_rein_test_cleanup() {
  [[ -n "${REIN_RSS_SAMPLER_PID:-}" ]] && kill -TERM "$REIN_RSS_SAMPLER_PID" 2>/dev/null || true
  # E-309: an interrupted --lanes run stops its lane workers before their directory goes.
  local _lp
  for _lp in "${REIN_LANE_PIDS[@]+"${REIN_LANE_PIDS[@]}"}"; do kill -TERM "$_lp" 2>/dev/null || true; done
  rm -rf "$TEST_TMPDIR" 2>/dev/null || true
  rm -f "${REPO_ROOT}/.mcp.test.json" 2>/dev/null || true  # belt-and-suspenders
}
trap _rein_test_cleanup EXIT INT TERM

# Base the test config on the current .mcp.json (a sandbox copy). Skip silently
# when no production config exists yet (e.g. CI before `rein mcp-setup`).
if [[ -f "${REPO_ROOT}/.mcp.json" ]]; then
  cp "${REPO_ROOT}/.mcp.json" "$MCP_TEST_CONFIG"
  export MCP_CONFIG_PATH="$MCP_TEST_CONFIG"
fi
export REIN_TEST_TMPDIR="$TEST_TMPDIR"

# ── E-257 (D-070 §1): the suite must not be recorded as operator behaviour ────
# Every MCP call a suite makes used to be telemetered into the operator's
# ~/.rein/telemetry.sqlite: 47,391 of 51,382 in-window rows were fixtures on 2026-09-11,
# and two rein-insights reports read them as the operator's habits. The whole run writes to
# a per-run temp store instead (telemetry.mjs honours AI_TELEMETRY_DB_PATH; the
# interceptor and the post-tool-use hook both go through it). AI_TELEMETRY_DISABLE=1 is
# the other accepted form and is left alone.
#
# The live store is then checked like any other leaked external state (E-240 lineage).
# NOT by "did it grow": the operator's other sessions write to it continuously, so growth
# during a 13-minute run is normal and says nothing about this run. Every process the run
# spawns carries a per-run session marker instead, and the check counts live rows carrying
# THAT marker — exact, and immune to concurrent sessions. (A synthetic session id also
# means no suite can verify the operator's real E-129 role token: an unknown id takes the
# same path as an unset one, which is what CI always had.)
# ── E-264 (D-071 §4): strip inherited launch variables before any suite is spawned ──
# A run started from a bound tmux pane inherits REIN_PANE_ROLE & co., which the hooks rank
# above the test's own inputs. See tests/lib/launch-vars.sh.
source "${SCRIPT_DIR}/lib/launch-vars.sh"
strip_launch_vars

REIN_TELEMETRY_LIVE="${HOME}/.rein/telemetry.sqlite"
REIN_TELEMETRY_MARKER="rein-test-run-$$-$(date +%s)"
export CLAUDE_CODE_SESSION_ID="$REIN_TELEMETRY_MARKER"
if [[ "${AI_TELEMETRY_DISABLE:-0}" != "1" ]]; then
  export AI_TELEMETRY_DB_PATH="${TEST_TMPDIR}/telemetry.sqlite"
fi
# _live_telemetry_counts → "<total rows> <rows carrying this run's marker>" (or "0 0").
_live_telemetry_counts() {
  [[ -f "$REIN_TELEMETRY_LIVE" ]] || { echo "0 0"; return 0; }
  node --no-warnings -e '
    const { DatabaseSync } = require("node:sqlite");
    try {
      const db = new DatabaseSync(process.argv[1], { readOnly: true });
      const t = db.prepare("SELECT count(*) AS n FROM tool_executions").get().n +
        (() => { try { return db.prepare("SELECT count(*) AS n FROM task_velocity").get().n; } catch { return 0; } })();
      const m = db.prepare("SELECT count(*) AS n FROM tool_executions WHERE session_id = ?").get(process.argv[2]).n;
      console.log(`${t} ${m}`);
    } catch { console.log("0 0"); }
  ' "$REIN_TELEMETRY_LIVE" "$REIN_TELEMETRY_MARKER" 2>/dev/null || echo "0 0"
}
read -r REIN_TELEMETRY_BEFORE _ <<< "$(_live_telemetry_counts)"
# _store_rows <db> → its total row count (E-309: a lane's HOME clone is checked like the run's).
_store_rows() { REIN_TELEMETRY_LIVE="$1" _live_telemetry_counts | cut -d' ' -f1; }

# ── Discovery (bash 3 compatible) ────────────────────────────────────────────
SUITES=()
if [[ "$REIN_TIER" == "full" && -z "$REIN_CHANGED" ]]; then
  while IFS= read -r f; do SUITES+=("$f"); done < <(find "$SUITES_DIR" -name "$PATTERN" | sort)
else
  # E-298: the selection is a pure function in tests/tools/select-suites.mjs (unit-tested);
  # "#NOTE" lines are decisions the runner prints (e.g. the --changed fallback to full).
  _sel_args=(--suites-dir "$SUITES_DIR" --tier "$REIN_TIER" --pattern "$PATTERN")
  [[ -n "$REIN_CHANGED" ]] && _sel_args+=(--changed "$REIN_CHANGED")
  _sel_out="$(node --no-warnings "${SCRIPT_DIR}/tools/select-suites.mjs" "${_sel_args[@]}")" || { echo "run.sh: suite selection failed" >&2; exit 2; }
  while IFS= read -r f; do
    case "$f" in "#NOTE "*) echo "   ${f#\#NOTE }" ;; "") ;; *) SUITES+=("$f") ;; esac
  done <<< "$_sel_out"
fi
REIN_RUN_STARTED="$(date +%s)"

if [[ ${#SUITES[@]} -eq 0 ]]; then
  echo "No test suites found matching: $PATTERN"
  exit 1
fi

# ── E-345 (D-109 r1): every fixture HOME a hook runs under carries the toolchain record ──
# A suite that sets HOME and runs a hook or `rein` without tc_fixture_home passes only on hosts
# whose node sits in the pin's fallback list. Static, before any suite starts; exemptions are
# per rule, with a reason, in tests/fixtures/fixture-home-exemptions.json.
# The node unit tests spawn hooks too (tcFixtureHome); they are scanned with the suites.
_census_files=("${SUITES[@]}")
for _f in "${SCRIPT_DIR}"/unit/*.test.mjs; do [[ -f "$_f" ]] && _census_files+=("$_f"); done
if ! _census_out="$(node --no-warnings "${SCRIPT_DIR}/tools/fixture-home-census.mjs" \
      --exemptions "${REIN_TEST_FIXTURE_HOME_EXEMPTIONS:-${SCRIPT_DIR}/fixtures/fixture-home-exemptions.json}" "${_census_files[@]}" 2>&1)"; then
  echo "$_census_out"
  echo "[TEST_FAILED] fixture-home census: use tc_fixture_home (tests/lib/toolchain-fixture.sh), or list the suite with a reason"
  exit 1
fi

echo ""
echo "━━ Rein Test Runner ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "   Suites found: ${#SUITES[@]}"
echo ""

# ── E-297 (D-088): census input — per-suite wall time, counts and footprint ──
# tests/lib/footprint.sh appends one line per node/bash/python3/rein spawn to
# ${TEST_TMPDIR}/footprint.log. After each suite the runner folds those lines into the census
# input under THIS suite's name (exact attribution, whatever $0 the spawning script had),
# with a count, and empties the log. tests/tools/census.mjs reads the result.
CENSUS_INPUT="${TEST_TMPDIR}/census-input.tsv"
FOOTPRINT_LOG="${TEST_TMPDIR}/footprint.log"
: > "$CENSUS_INPUT"; : > "$FOOTPRINT_LOG"
printf 'CENSUS_RUN\t%s\t%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  "$(git -C "$REPO_ROOT" rev-parse HEAD 2>/dev/null || echo unknown)" "$PATTERN" >> "$CENSUS_INPUT"
# _now_ms → wall clock in ms. bash 5 has EPOCHREALTIME; /bin/bash 3.2 (what `rein ci run`
# uses on macOS) does not, so perl (~3 ms, part of the base system) and, last, whole seconds.
_now_ms() {
  if [[ -n "${EPOCHREALTIME:-}" ]]; then
    local _t="${EPOCHREALTIME/[.,]/}"; echo "${_t:0:${#_t}-3}"
  elif command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%d\n", time()*1000' 2>/dev/null || echo "$(( $(date +%s) * 1000 ))"
  else
    echo "$(( $(date +%s) * 1000 ))"
  fi
}

# ── E-309 (D-091): lanes by resource class ───────────────────────────────────
# A suite is EXCLUSIVE when it uses tmux, has the installer or `rein init` as its
# subject (# REIN_INSTALLER_SUBJECT), binds a port, measures host-load-sensitive ratios
# (assert_perf, E-239), or declares `# REIN_EXCLUSIVE: tmux|installer|port|perf` in its
# first 10 lines. Exclusive suites run serially AFTER the shared lanes, under the run's
# own prefixes and the machine-wide snapshot exactly as today. A false "exclusive" only
# costs time; a false "shared" can leak across lanes, so the match is deliberately broad.
# _lane_class <suite> → "shared" or "exclusive <reason>" (data on stdout, no state — D-064 §2).
# E-312 (D-093): an installer-subject suite is no longer exclusive by its header alone. It
# shares a lane when its last measured footprint shows every installer / `rein init` spawn with
# a HOME of its own — "tmp" (a harness temp dir), or "run" (the suite's starting HOME) when the
# lanes clone HOME — the rule tests/tools/census.mjs installerLane() prints. `# REIN_EXCLUSIVE:`
# and the tmux / port / perf rule still win.
_lane_class() {
  local f="$1" name homes bad
  if sed -n '1,10p' "$f" | grep -qE '^# REIN_EXCLUSIVE:'; then
    echo "exclusive # REIN_EXCLUSIVE: $(sed -n '1,10s/^# REIN_EXCLUSIVE:[[:space:]]*//p' "$f" | head -1)"; return 0
  fi
  if grep -qE 'tmux|assert_perf|nc -l|\.listen\(|createServer' "$f"; then
    echo "exclusive tmux / port / perf"; return 0
  fi
  sed -n '1,10p' "$f" | grep -qE '^# REIN_INSTALLER_SUBJECT' || { echo "shared"; return 0; }
  name="$(basename "$f")"
  homes="$(awk -F'\t' -v s="$name" '$1==s {print $2}' "${TEST_TMPDIR}/installer-homes.tsv" 2>/dev/null | sort -u)"
  [[ -n "$homes" ]] || { echo "exclusive no measured installer footprint"; return 0; }
  bad="$(printf '%s\n' "$homes" | grep -vxE 'tmp|run' | tr '\n' ' ' | sed 's/ $//')"
  [[ -z "$bad" ]] || { echo "exclusive installer HOME ${bad}"; return 0; }
  if printf '%s\n' "$homes" | grep -qx run && [[ "${_lane_clone_home:-0}" -ne 1 ]]; then
    echo "exclusive installer HOME run, and lanes do not clone HOME outside CI"; return 0
  fi
  echo "shared"
}

# _mem_cap [per_lane_mb] → how many lanes available memory allows (per_lane_mb each, default
# 1536), its MB figure and its source, or nothing when unknown.
_mem_cap() {
  local avail="" src=""
  # REIN_TEST_FREE_MB stands in for the host's reading (the lane fixture in harness_isolation_test,
  # whose verdicts must not depend on what this machine has free right now).
  if [[ "${REIN_TEST_FREE_MB:-}" =~ ^[0-9]+$ ]]; then
    avail=$(( REIN_TEST_FREE_MB * 1048576 )); src="REIN_TEST_FREE_MB"
  elif [[ -r /proc/meminfo ]]; then
    avail="$(awk '/^MemAvailable:/ {print $2 * 1024}' /proc/meminfo)"; src="MemAvailable"
  else
    # E-312 (D-093): the kernel's own figure — memorystatus_level is the percentage of memory
    # it considers available (reclaimable included); the vm_stat page sum under-counted 2×.
    local _lvl _mem
    _lvl="$(sysctl -n kern.memorystatus_level 2>/dev/null)"; _mem="$(sysctl -n hw.memsize 2>/dev/null)"
    [[ "$_lvl" =~ ^[0-9]+$ && "$_mem" =~ ^[0-9]+$ ]] && { avail=$(( _mem / 100 * _lvl ))
      src="kern.memorystatus_level ${_lvl}% of $(( _mem / 1048576 )) MB"; }
  fi
  [[ -n "$avail" && "$avail" -gt 0 ]] || return 0
  local cap=$(( avail / (${1:-1536} * 1024 * 1024) ))
  echo $(( cap < 1 ? 1 : cap )) "$(( avail / 1048576 ))" "$src"
}

# ── E-313 (D-094): the run's concurrent memory ───────────────────────────────
# _rss_sampler <out> <stop> — once per second, the summed RSS of every process group a suite
# is running in (PG_DIR holds one pgid per running suite, from any lane), keeping the maximum.
# One `ps` + one `awk` per sample; reading PG_DIR is builtins only. On macOS `ps -g <list>`
# asks the kernel for those groups only (~4 ms of CPU); `ps -axo` reads every process on the
# machine (~29 ms, measured — 3% of a run). Linux procps gives -g another meaning, and its
# /proc listing is cheap, so it keeps the full listing filtered by pgid. Writes
# "<peak_kb> <samples> <cpu_ms>" to <out> when <stop> appears (cpu_ms = its children's
# user+sys from `times`, the sampler's own cost). Approximate between samples (D-094).
_rss_sampler() {
  local out="$1" stop="$2" peak=0 n=0 kb pg f p darwin=0
  # A background subshell inherits run.sh's `set -euo pipefail`: a suite that exits between
  # the PG_DIR read and `ps -g` makes ps return 1, and pipefail + errexit killed the sampler
  # mid-run before it wrote its result (the first E-313 CI run recorded samples=0).
  set +e +o pipefail
  [[ "$(uname -s)" == Darwin ]] && darwin=1
  while [[ ! -e "$stop" ]]; do
    pg=""
    for f in "$PG_DIR"/*; do [[ -f "$f" ]] && read -r p < "$f" && pg="${pg:+${pg},}${p}"; done
    if [[ -n "$pg" ]]; then
      if [[ "$darwin" -eq 1 ]]; then
        kb="$(ps -o rss= -g "$pg" 2>/dev/null | awk '{ s += $1 } END { print s + 0 }')"
      else
        kb="$(ps -e -o pgid=,rss= 2>/dev/null | awk -v want="$pg" '
          BEGIN { n = split(want, a, ","); for (i = 1; i <= n; i++) W[a[i]] = 1 }
          ($1 in W) { s += $2 } END { print s + 0 }')"
      fi
      [[ "$kb" =~ ^[0-9]+$ ]] && (( kb > peak )) && peak=$kb
      n=$((n + 1))
    fi
    sleep 1
  done
  # `times` prints the shell's then its children's user/sys as "XmY.ZZZs" pairs. Redirected,
  # never piped: a pipeline would run it in a subshell, which has no children of its own.
  local cpu; times > "${out}.times"
  cpu="$(tail -1 "${out}.times" | awk '{ t = 0; for (i = 1; i <= NF; i++) { split($i, m, "m"); t += m[1] * 60 + m[2] } printf "%d", t * 1000 }')"
  rm -f "${out}.times"
  echo "${peak} ${n} ${cpu:-0}" > "$out"
}

# _lane_mem_mb → the per-lane memory figure and its source, from the hints log (the newest CI
# record of this project, as for the wall hints): last peak_sum_rss_mb / its lanes × 1.25,
# floor 512 MB; 1536 MB when no record carries the field.
_lane_mem_mb() {
  local sum lanes per
  sum="$(sed -nE 's/^\[run\] peak_sum_rss_mb=([0-9]+).*/\1/p' "${TEST_TMPDIR}/hints-src.log" 2>/dev/null | tail -1)"
  lanes="$(sed -nE 's/^\[ci\] resources lanes=([0-9]+).*/\1/p' "${TEST_TMPDIR}/hints-src.log" 2>/dev/null | tail -1)"
  if [[ "$sum" =~ ^[0-9]+$ && "$lanes" =~ ^[1-9][0-9]*$ ]]; then
    per=$(( sum * 125 / 100 / lanes )); (( per < 512 )) && per=512
    echo "${per} last peak_sum_rss_mb ${sum} at ${lanes} lane(s) × 1.25"
  else
    echo "1536 fallback: no recorded peak_sum_rss_mb"
  fi
}

# _wall_hint <suite name> → its last measured wall time in ms (the newest CENSUS_SUITE line
# in REIN_TEST_WALL_HINTS, or in the newest ~/.rein/ci log, or — E-386 — in the committed
# tests/census-baseline.tsv), else 30000. Longest-first placement needs only an order of
# magnitude; a missing hint is not an error. REIN_HINTS_FROM says which source answered
# ("log <path>" / "baseline" / "none"); the run prints it once as its `Lane: hints:` line.
REIN_HINTS_FROM=""
_wall_hints_load() {
  [[ -n "$REIN_HINTS_FROM" ]] && return 0   # once per run: the lanes and the shard read the same
  local src="${REIN_TEST_WALL_HINTS:-}"
  if [[ -z "$src" ]]; then
    # No log with CENSUS lines → the loop's last status is a failed grep, which under
    # pipefail + set -e killed the run silently (E-332). Not finding a hint is not an error.
    src="$(ls -1t "${HOME}/.rein/ci/logs/"*.log 2>/dev/null | head -20 | while IFS= read -r f; do
      grep -q '^CENSUS_SUITE' "$f" 2>/dev/null && { echo "$f"; break; }; done || :)"
  fi
  # E-386 (D-135 r2): a fresh hosted runner has no log; the baseline is the last full PASS's rows.
  if [[ -n "$src" && -r "$src" ]]; then
    REIN_HINTS_FROM="log ${src}"
  elif grep -q '^CENSUS_SUITE' "${SCRIPT_DIR}/census-baseline.tsv" 2>/dev/null; then
    src="${SCRIPT_DIR}/census-baseline.tsv"; REIN_HINTS_FROM="baseline"
  else
    src=""; REIN_HINTS_FROM="none"
  fi
  echo "   Lane: hints: ${REIN_HINTS_FROM}"
  [[ -n "$src" && -r "$src" ]] && grep '^CENSUS_SUITE' "$src" | cut -f2,3 > "${TEST_TMPDIR}/wall-hints.tsv" || : > "${TEST_TMPDIR}/wall-hints.tsv"
  { [[ -n "$src" && -r "$src" ]] && grep -E '^\[(run|ci)\] (peak_sum_rss_mb|resources)' "$src"; } > "${TEST_TMPDIR}/hints-src.log" 2>/dev/null || :
  # E-312: the same log's installer lines, "<suite>\t<HOME class>" (CENSUS_FP … installer
  # <target> <home>; a line from before E-312 has no home and classifies as unrecorded).
  { [[ -n "$src" && -r "$src" ]] && awk -F'\t' '$1=="CENSUS_FP" && $4=="installer" {print $2 "\t" ($6 == "" ? "unrecorded" : $6)}' "$src"; } \
    > "${TEST_TMPDIR}/installer-homes.tsv" 2>/dev/null || : > "${TEST_TMPDIR}/installer-homes.tsv"
}
_wall_hint() {
  local ms; ms="$(awk -F'\t' -v s="$1" '$1==s {v=$2} END {print v}' "${TEST_TMPDIR}/wall-hints.tsv")"
  echo "${ms:-30000}"
}

# _lanes_run — run SUITES[] into $RUN_DIR: shared suites longest-first across REIN_LANES
# workers, then the exclusive ones serially in this shell. Each lane owns its prefixes
# (rein-test-L<n>-, rein-t-L<n>-), its REIN_TEST_TMPDIR (footprint log) and telemetry store,
# and — under `rein ci run`, whose HOME is the run's throwaway one — a HOME clone.
# _lane_clone_home_set — clone HOME per lane only under CI, and NEVER the account's real home
# (the user record, not $HOME): a local `REIN_CI=local bash tests/run.sh --lanes 4` must not
# copy it. Sets _lane_clone_home, which _lane_class reads (E-386: the shard pass classes too).
_lane_clone_home_set() {
  _lane_clone_home=0
  if [[ -n "${REIN_CI:-}" || "${CI:-}" == "true" ]] \
     && [[ "$HOME" != "$(node -p 'require("os").userInfo().homedir' 2>/dev/null)" ]]; then
    _lane_clone_home=1
  fi
}

_lanes_run() {
  local i=0 suite n l best shared=() excl=() lane_of=() load=() order
  _wall_hints_load
  _lane_clone_home_set
  local _cls
  for suite in "${SUITES[@]}"; do
    _cls="$(_lane_class "$suite")"
    if [[ "$_cls" == shared ]]; then shared+=("$i"); else excl+=("$i"); fi
    # The installer-subject verdicts are printed: the classification moves with the data.
    if sed -n '1,10p' "$suite" | grep -qE '^# REIN_INSTALLER_SUBJECT'; then
      echo "   Lane: $(basename "$suite") ${_cls/exclusive /exclusive — }"
    fi
    i=$((i + 1))
  done
  for ((l = 1; l <= REIN_LANES; l++)); do load[l]=0; done
  # Longest-first: sort the shared indexes by wall hint, descending; each goes to the
  # least-loaded lane.
  order="$(for i in "${shared[@]+"${shared[@]}"}"; do
    printf '%s\t%s\n' "$(_wall_hint "$(basename "${SUITES[$i]}")")" "$i"; done | sort -t$'\t' -k1,1nr | cut -f2)"
  for i in $order; do
    best=1
    for ((l = 2; l <= REIN_LANES; l++)); do (( load[l] < load[best] )) && best=$l; done
    lane_of[i]=$best
    load[best]=$(( load[best] + $(_wall_hint "$(basename "${SUITES[$i]}")") ))
  done
  echo "   Lanes: ${#shared[@]} shared suite(s) in ${REIN_LANES} lanes, then ${#excl[@]} exclusive suite(s) serially"

  local pids=() ldir
  for ((l = 1; l <= REIN_LANES; l++)); do
    ldir="${TEST_TMPDIR}/lane${l}"; mkdir -p "$ldir"
    (
      # The lane prefix EXTENDS the run's own (rein-t- → rein-t-L1-), so a runner started by
      # a suite in this lane (harness_isolation_test's leaked-state fixtures) names its own lanes inside it.
      export REIN_TEST_SOCK_PREFIX="${REIN_TEST_SOCK_PREFIX}L${l}-" REIN_TEST_TMP_PREFIX="${REIN_TEST_TMP_PREFIX}L${l}-"
      export REIN_TEST_TMPDIR="$ldir"
      # This shell's own state, NOT exported: a nested runner is a run, not a lane.
      REIN_LANE_LABEL="lane ${l}"
      [[ "${AI_TELEMETRY_DISABLE:-0}" != "1" ]] && export AI_TELEMETRY_DB_PATH="${ldir}/telemetry.sqlite"
      if [[ "$_lane_clone_home" -eq 1 ]]; then
        # The throwaway HOME, cloned (APFS clonefile when available) so lanes never share
        # ~/.rein/run tokens, locks or stores.
        cp -c -R "$HOME" "${ldir}/home" 2>/dev/null || cp -R "$HOME" "${ldir}/home"
        # PHYSICAL, as rein ci run's own HOME is (E-265): TMPDIR ends in "/" on macOS, and a
        # "tmp//rein-test…" spelling is one node normalises and the shell does not.
        HOME="$(cd "${ldir}/home" && pwd -P)"; export HOME
      fi
      for i in "${shared[@]+"${shared[@]}"}"; do
        [[ "${lane_of[i]}" -eq "$l" ]] && _run_suite "$i" "${SUITES[$i]}"
      done
      exit 0
    ) &
    pids+=("$!"); REIN_LANE_PIDS+=("$!")
  done
  for n in "${pids[@]}"; do wait "$n" || true; done
  REIN_LANE_PIDS=()
  # E-257 under CI: a lane's HOME clone is a throwaway store too — any growth is the run's.
  if [[ "$_lane_clone_home" -eq 1 ]]; then
    for ((l = 1; l <= REIN_LANES; l++)); do
      n=$(( $(_store_rows "${TEST_TMPDIR}/lane${l}/home/.rein/telemetry.sqlite") - REIN_TELEMETRY_BEFORE ))
      REIN_LANE_TEL_GREW=$(( ${REIN_LANE_TEL_GREW:-0} + (n > 0 ? n : 0) ))
    done
  fi
  # E-386 (D-135 r6): the serial tail, measured — `rein ci run` records it as exclusive_seconds.
  local _ex0; _ex0="$(_now_ms)"
  for i in "${excl[@]+"${excl[@]}"}"; do _run_suite "$i" "${SUITES[$i]}"; done
  echo "[run] exclusive_seconds=$(( ($(_now_ms) - _ex0) / 1000 )) exclusive_suites=${#excl[@]}"
}

# ── One suite, run and recorded (E-309: shared by the serial path and every lane) ──
# _run_suite <idx> <suite> — runs one suite under the watchdog and the leak diff and writes
# ONLY files under $RUN_DIR (D-064 §2: it runs in this shell for --lanes 1 and in a lane
# worker's subshell otherwise, and must behave the same in both):
#   <idx>.out     its output, plus the LEAKED / swept / SUITE_TIMEOUT lines
#   <idx>.res     "passes fails skips exit leaked_n kinds"
#   <idx>.census  its CENSUS_SUITE / CENSUS_FP lines
_run_suite() {
  local idx="$1" suite="$2" suite_name _budget _out _t0 _spid _timed_out _s0 _g _wall_ms
  local suite_exit=0 output summary passes fails skips _leaked _n=0 _kinds="" _keys
  local _leak_before _leak_after _fp="${REIN_TEST_TMPDIR}/footprint.log"
  suite_name="$(basename "$suite")"

  # E-240: snapshot the external state before and after, so a leak is attributed to the
  # SUITE that caused it rather than discovered days later by hand. In a lane the snapshot
  # holds only names carrying the lane's own prefixes (E-309).
  _leak_before="$(mktemp)"; _leak_after="$(mktemp)"
  if [[ "${REIN_TEST_NO_SWEEP:-0}" != "1" ]]; then _leak_snapshot > "$_leak_before" 2>/dev/null; fi

  # Run the suite under a watchdog (E-307, D-091): its own process group (set -m), so a hung
  # suite is killed WITH everything it started; the leak diff and cleanup below still run.
  # Budget: REIN_SUITE_TIMEOUT (default 180 s), or the suite's `# REIN_SUITE_TIMEOUT=<s>` HEADER
  # line — the first 10 lines only, so a fixture suite written by a heredoc further down
  # (harness_isolation_test's hang fixture) does not set the budget of the suite that writes it.
  _budget="$(sed -n '1,10s/^# REIN_SUITE_TIMEOUT=\([0-9][0-9]*\).*/\1/p' "$suite" | head -1)"
  _budget="${_budget:-${REIN_SUITE_TIMEOUT:-180}}"
  _out="$(mktemp)"
  _t0="$(_now_ms)"
  set -m
  bash "$suite" </dev/null >"$_out" 2>&1 &
  _spid=$!
  set +m
  echo "$_spid" > "${PG_DIR}/${idx}"   # E-313: the sampler sums this group while it runs
  _timed_out=0; _s0=$SECONDS   # whole seconds: the deadline needs no sub-second clock (no spawn per poll)
  while kill -0 "$_spid" 2>/dev/null; do
    if (( SECONDS - _s0 >= _budget )); then
      _timed_out=1
      # `|| true`: run.sh is errexit, and a group that already exited makes kill return 1.
      kill -TERM -- "-${_spid}" 2>/dev/null || true
      _g=0; while kill -0 "$_spid" 2>/dev/null && (( _g < 30 )); do sleep 0.1; _g=$((_g + 1)); done
      kill -KILL -- "-${_spid}" 2>/dev/null || true
      break
    fi
    sleep 0.1
  done
  wait "$_spid" 2>/dev/null || suite_exit=$?
  rm -f "${PG_DIR}/${idx}"
  output="$(cat "$_out")"; rm -f "$_out"
  if [[ $_timed_out -eq 1 ]]; then
    output="${output}"$'\n'"  [SUITE_TIMEOUT] ${suite_name} after ${_budget}s"
    suite_exit=124
  fi
  _wall_ms=$(( $(_now_ms) - _t0 ))

  if [[ "${REIN_TEST_NO_SWEEP:-0}" != "1" ]]; then
    _leak_snapshot > "$_leak_after" 2>/dev/null
    _leaked="$(_leak_diff "$_leak_before" "$_leak_after")"
    if [[ -n "$_leaked" ]]; then
      _n="$(printf '%s\n' "$_leaked" | grep -c .)"
      _kinds="$(printf '%s\n' "$_leaked" | cut -d'|' -f1 | sort -u | tr '\n' ',' | sed 's/,$//')"
      _keys="$(printf '%s\n' "$_leaked" | awk -F'|' '$3!=""{print $1 ":" $2 " key=" $3}' | tr '\n' ' ' | sed 's/ $//')"
      output="${output}"$'\n'"  LEAKED ${_n} ${_kinds}   (${REIN_LANE_LABEL:+${REIN_LANE_LABEL} }${suite_name})${_keys:+   [${_keys}]}"
      if [[ "$REIN_SWEEP" -eq 1 ]]; then
        _leak_sweep "$_leaked"
        output="${output}"$'\n'"  swept ${_n} leaked item(s) from ${suite_name}"
      fi
    fi
  fi
  rm -f "$_leak_before" "$_leak_after"

  # Parse counts from machine-readable summary line emitted by assert_summary()
  summary=$(echo "$output" | grep "^SUITE_RESULT" | tail -1 || true)
  passes=$(echo "$summary" | grep -oE 'PASS=[0-9]+' | grep -oE '[0-9]+' || echo 0)
  fails=$(echo "$summary"  | grep -oE 'FAIL=[0-9]+' | grep -oE '[0-9]+' || echo 0)
  # E-236: SKIP is optional in the summary line, so an older suite that does not emit it
  # still parses. A skip is neither a pass nor a failure — it is a layer that did not run.
  skips=$(echo "$summary"  | grep -oE 'SKIP=[0-9]+' | grep -oE '[0-9]+' || echo 0)
  passes="${passes:-0}"; fails="${fails:-0}"; skips="${skips:-0}"

  # If the suite script itself crashed (non-zero exit, no SUITE_RESULT line), count it as 1 failure
  if [[ $suite_exit -ne 0 && -z "$summary" ]]; then
    fails=$(( fails + 1 ))
  elif [[ "${_timed_out:-0}" -eq 1 ]]; then
    fails=$(( fails + 1 ))   # a suite that printed its summary and THEN hung still failed
  fi

  # E-297: this suite's census lines (the footprint log is the lane's own, E-309).
  printf 'CENSUS_SUITE\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$suite_name" "$_wall_ms" "$passes" "$fails" "$skips" "$suite_exit" > "${RUN_DIR}/${idx}.census"
  if [[ -s "$_fp" ]]; then
    cut -f2- "$_fp" | sort | uniq -c \
      | awk -v s="$suite_name" '{ n=$1; sub(/^ *[0-9]+ /, ""); printf "CENSUS_FP\t%s\t%s\t%s\n", s, n, $0 }' \
      >> "${RUN_DIR}/${idx}.census" || true
    : > "$_fp"
  fi
  printf '%s\n' "$output" > "${RUN_DIR}/${idx}.out"
  printf '%s %s %s %s %s %s\n' "$passes" "$fails" "$skips" "$suite_exit" "$_n" "${_kinds:--}" > "${RUN_DIR}/${idx}.res"
  return 0
}

# _collect <idx> <suite> — fold one finished suite into the run's totals, census and output.
_collect() {
  local idx="$1" suite_name passes fails skips suite_exit _n _kinds
  suite_name="$(basename "$2")"
  read -r passes fails skips suite_exit _n _kinds < "${RUN_DIR}/${idx}.res"
  cat "${RUN_DIR}/${idx}.census" >> "$CENSUS_INPUT"
  if [[ "$_n" -gt 0 ]]; then
    LEAK_REPORTS+=("${suite_name}: ${_n} ${_kinds}")
    TOTAL_LEAKED=$(( TOTAL_LEAKED + _n ))
  fi
  TOTAL_PASS=$(( TOTAL_PASS + passes ))
  TOTAL_FAIL=$(( TOTAL_FAIL + fails ))
  TOTAL_SKIP=$(( TOTAL_SKIP + skips ))

  if [[ $fails -eq 0 && $suite_exit -eq 0 ]]; then
    if [[ $skips -gt 0 ]]; then
      SUITE_RESULTS+=("  ${C_OK}✓${C_RESET} $suite_name ($passes passed, $skips skipped)")
    else
      SUITE_RESULTS+=("  ${C_OK}✓${C_RESET} $suite_name ($passes passed)")
    fi
  else
    SUITE_RESULTS+=("  ${C_FAIL}✗${C_RESET} $suite_name ($passes passed, $fails failed)")
  fi

  # Always print suite output (suites label themselves)
  cat "${RUN_DIR}/${idx}.out"
  echo ""
}

# ── E-386 (D-135 r3): one shard — the same lane classes, partitioned by wall hint ──
# tests/tools/shard-plan.mjs is the pure partition (unit-tested): shared and exclusive suites
# separately, hint descending then name, greedy to the lightest bin, unknown hint = median.
# The node unit layer goes to shard 1, and shard 1 starts that much heavier (E-389: `rein ci
# run` runs the unit layer again there, as its coverage step). Every shard of the same commit and baseline computes
# the same partition, so shards 1..N together run every suite exactly once.
if [[ -n "$REIN_SHARD" ]]; then
  _wall_hints_load
  _lane_clone_home_set
  _shard_in="${TEST_TMPDIR}/shard-classes.tsv"; : > "$_shard_in"
  for _f in "${SUITES[@]}"; do
    _c="$(_lane_class "$_f")"
    printf '%s\t%s\n' "$(basename "$_f")" "${_c%% *}" >> "$_shard_in"
  done
  _shard_out="$(node --no-warnings "${SCRIPT_DIR}/tools/shard-plan.mjs" --shard "$REIN_SHARD" \
    --hints "${TEST_TMPDIR}/wall-hints.tsv" --pin node_unit_test.sh --seed node_unit_test.sh < "$_shard_in")" \
    || { echo "run.sh: shard partition failed" >&2; exit 2; }
  # An empty shard selects nothing: grep's status 1 must not end the run under pipefail (E-332).
  _keep=" $({ grep -v '^#' <<< "$_shard_out" || :; } | tr '\n' ' ')"
  _all=("${SUITES[@]}"); SUITES=()
  for _f in "${_all[@]}"; do [[ "$_keep" == *" $(basename "$_f") "* ]] && SUITES+=("$_f"); done
  read -r _ _sh_k _sh_m _sh_s <<< "$(grep '^#SHARD ' <<< "$_shard_out")"
  echo "   Shard ${REIN_SHARD}: ${_sh_k} shared, ${_sh_m} exclusive (est. ${_sh_s} s)"
  if [[ ${#SUITES[@]} -eq 0 ]]; then
    # More shards than suites: an empty leg passes (bash 3.2 cannot expand an empty array
    # under set -u, so it stops here rather than in the loops below).
    echo "   Shard ${REIN_SHARD}: no suites — nothing to run"
    echo "   Total: 0 passed, 0 failed"
    echo "[TEST_PASSED] All tests passed ✓"
    exit 0
  fi
fi

RUN_DIR="${TEST_TMPDIR}/suites"; mkdir -p "$RUN_DIR"
PG_DIR="${TEST_TMPDIR}/pgids"; mkdir -p "$PG_DIR"

# E-309: memory, not cores, binds the lane count — refuse a request above free / 1.5 GB.
if [[ "$REIN_LANES" -gt 1 ]]; then
  _wall_hints_load
  # E-313 (D-094): the per-lane figure is measured — the last run's concurrent sum per lane.
  read -r _per_mb _per_src <<< "$(_lane_mem_mb)"
  read -r _cap _free_mb _mem_src <<< "$(_mem_cap "$_per_mb")"
  # E-312: the kernel figure and the per-lane number, on one line, every multi-lane run.
  [[ -n "${_cap:-}" ]] && echo "   Memory: ${_free_mb} MB available (${_mem_src}) / ${_per_mb} MB per lane (${_per_src}) → cap ${_cap} lane(s)"
  if [[ -n "${_cap:-}" && "$REIN_LANES" -gt "$_cap" ]]; then
    if [[ "${REIN_TEST_LANES_AUTO:-0}" == "1" ]]; then
      # A DEFAULT lane count (rein ci run without --lanes) is clamped, never refused.
      echo "   Lanes: ${REIN_LANES} requested by default, clamped to the memory cap ${_cap} (${_free_mb} MB free / ${_per_mb} MB per lane)"
      REIN_LANES="$_cap"
    else
      echo "run.sh: --lanes ${REIN_LANES} refused — memory cap is ${_cap} lane(s) (${_free_mb} MB free / ${_per_mb} MB per lane)" >&2
      exit 2
    fi
  fi
fi

echo "   Lanes: ${REIN_LANES}"
_rss_out="${TEST_TMPDIR}/rss-sampler.out"; _rss_stop="${TEST_TMPDIR}/rss-sampler.stop"
_rss_sampler "$_rss_out" "$_rss_stop" &
REIN_RSS_SAMPLER_PID=$!
if [[ "$REIN_LANES" -eq 1 ]]; then
  # ── One lane: today's behaviour — every suite in order, output as it finishes ──
  _i=0
  for suite in "${SUITES[@]}"; do
    _run_suite "$_i" "$suite"
    _collect "$_i" "$suite"
    _i=$((_i + 1))
  done
else
  # ── E-309 (D-091): shared suites in N lanes, then the exclusive suites serially ──
  _lanes_run
  _i=0
  for suite in "${SUITES[@]}"; do _collect "$_i" "$suite"; _i=$((_i + 1)); done
fi
touch "$_rss_stop"; wait "$REIN_RSS_SAMPLER_PID" 2>/dev/null || true; REIN_RSS_SAMPLER_PID=""
read -r _rss_kb _rss_n _rss_cpu < "$_rss_out" 2>/dev/null || { _rss_kb=0; _rss_n=0; _rss_cpu=0; }
# E-313: the concurrent peak, beside the totals (rein ci run records it as peak_sum_rss_mb).
echo "[run] peak_sum_rss_mb=$(( ${_rss_kb:-0} / 1024 )) samples=${_rss_n:-0} sampler_cpu_ms=${_rss_cpu:-0}"

# ── E-297: publish the census input (TEST_TMPDIR is deleted on exit) ─────────
# Two copies, because the two kinds of run keep different things:
#  - `rein ci run` (REIN_CI=local / CI=true) runs under a throwaway HOME and TMPDIR that are
#    deleted with its worktree, and this runner may not write ~/.rein (rule 6). What it
#    KEEPS is this run's stdout, tee'd into ~/.rein/ci/logs/<sha>-<started>.log — so the
#    census lines go into the log, beside the run they describe. They are printed BEFORE
#    the Results block and start with CENSUS_, so `rein ci log --failed` (failedSections)
#    never selects them and `rein ci run`'s Total: parse is untouched.
#  - every top-level run also leaves ${TMPDIR}/rein-census-<stamp>-XXXXXX.tsv (newest 5
#    kept) and prints its path; census.mjs reads those for plain `bash tests/run.sh` runs.
printf 'CENSUS_TOTAL\t%s\t%s\t%s\t%s\n' "${#SUITES[@]}" "$TOTAL_PASS" "$TOTAL_FAIL" "$TOTAL_SKIP" >> "$CENSUS_INPUT"
if [[ "$REIN_CENSUS_NESTED" -eq 0 ]]; then
  if [[ "${CI:-}" == "true" || "${REIN_CI:-}" == "local" ]]; then
    echo "── census input (E-297) ──"
    cat "$CENSUS_INPUT"
    echo ""
  fi
  _census_copy="$(mktemp "${TMPDIR:-/tmp}/rein-census-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX" 2>/dev/null)" || _census_copy=""
  if [[ -n "$_census_copy" ]] && cp "$CENSUS_INPUT" "$_census_copy" 2>/dev/null; then
    mv -f "$_census_copy" "${_census_copy}.tsv" 2>/dev/null && _census_copy="${_census_copy}.tsv"
    # Newest five only; the names carry the census prefix, nothing else is touched.
    ls -1t "${TMPDIR:-/tmp}"/rein-census-*.tsv 2>/dev/null | tail -n +6 | while IFS= read -r _old; do
      rm -f "$_old" 2>/dev/null || true
    done
    echo "   Census input: ${_census_copy}   (node tests/tools/census.mjs)"
  fi
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo "━━ Results ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
for result in "${SUITE_RESULTS[@]}"; do
  printf "$result\n"
done
echo ""
# E-236: skips are reported alongside the totals, never folded into "passed". A run that
# quietly stops exercising a layer must be visible here rather than reading as all-green.
# E-240: a run that leaks is not clean, and on CI it is a failure — a green run that leaves
# state behind is how the next run gets a mysterious result nobody can reproduce.
if [[ "${TOTAL_LEAKED:-0}" -gt 0 ]]; then
  echo ""
  echo "   LEAKED external state: ${TOTAL_LEAKED} item(s)"
  for _r in "${LEAK_REPORTS[@]}"; do echo "     - ${_r}"; done
  # E-265 (D-072): `rein ci run` sets REIN_CI=local and has no operator to sweep either, so
  # a leak fails a local CI run exactly as it fails a hosted one.
  if [[ "${CI:-}" == "true" || "${REIN_CI:-}" == "local" ]]; then
    echo "   [LEAK_FAILED] a test run must leave nothing behind (E-240 / D-063 §2)"
    TOTAL_FAIL=$(( TOTAL_FAIL + 1 ))
  else
    echo "   Run 'bash tests/run.sh --sweep' to remove them (REIN_TEST_NO_SWEEP=1 disables this check)."
  fi
fi

# E-257: the live telemetry store. Both numbers are printed so a reader can tell "the
# store grew because other sessions were busy" from "this run wrote into it".
read -r REIN_TELEMETRY_AFTER REIN_TELEMETRY_OURS <<< "$(_live_telemetry_counts)"
echo "   Live telemetry: ${REIN_TELEMETRY_BEFORE:-0} rows at start, ${REIN_TELEMETRY_AFTER:-0} at end; ${REIN_TELEMETRY_OURS:-0} written by this run"
# Under CI (a throwaway HOME nothing else writes to) ANY growth is this run's: the marker
# alone missed 56 rows from drivers that spawned servers with a hand-built env, dropping
# both the redirect and the marker. Locally, other sessions write concurrently, so only
# the marker is attributable.
_tel_grew=$(( ${REIN_TELEMETRY_AFTER:-0} - ${REIN_TELEMETRY_BEFORE:-0} + ${REIN_LANE_TEL_GREW:-0} ))
if [[ "${CI:-}" == "true" || "${REIN_CI:-}" == "local" ]]; then
  if [[ "$_tel_grew" -gt 0 ]]; then
    echo "   [TELEMETRY_LEAKED] the throwaway HOME's store grew by ${_tel_grew} row(s) — only tests write there under CI"
    echo "   A test wrote to the telemetry store outside AI_TELEMETRY_DB_PATH (E-257 / D-070 §1)."
    TOTAL_FAIL=$(( TOTAL_FAIL + 1 ))
  fi
elif [[ "${REIN_TELEMETRY_OURS:-0}" -gt 0 ]]; then
  echo "   [TELEMETRY_LEAKED] ${REIN_TELEMETRY_OURS} row(s) with session_id ${REIN_TELEMETRY_MARKER} reached ${REIN_TELEMETRY_LIVE}"
  echo "   A test wrote to the operator's telemetry store — it must use AI_TELEMETRY_DB_PATH (E-257 / D-070 §1)."
  TOTAL_FAIL=$(( TOTAL_FAIL + 1 ))
fi

# E-298 (D-088): the fast tier's budget, E-239 style — both numbers always; the absolute
# 60 s budget is enforced only on CI (rule 2: a developer machine's speed is not a verdict).
if [[ "$REIN_TIER" == "fast" ]]; then
  _fast_s=$(( $(date +%s) - REIN_RUN_STARTED ))
  echo "   Fast tier: ${#SUITES[@]} suite(s) in ${_fast_s}s (budget 60s, enforced when CI=true)"
  if [[ "${CI:-}" == "true" && "$_fast_s" -gt 60 ]]; then
    echo "   [FAST_TIER_OVER_BUDGET] ${_fast_s}s > 60s (D-088 r5)"
    TOTAL_FAIL=$(( TOTAL_FAIL + 1 ))
  fi
fi

if [[ "${TOTAL_SKIP:-0}" -gt 0 ]]; then
  echo "   Total: $TOTAL_PASS passed, $TOTAL_FAIL failed, $TOTAL_SKIP skipped"
else
  echo "   Total: $TOTAL_PASS passed, $TOTAL_FAIL failed"
fi
echo ""

if [[ $TOTAL_FAIL -eq 0 ]]; then
  echo "[TEST_PASSED] All tests passed ✓"
  exit 0
else
  echo "[TEST_FAILED] $TOTAL_FAIL test(s) failed ✗"
  exit 1
fi
