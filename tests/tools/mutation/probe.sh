#!/usr/bin/env bash
# probe.sh — E-300 (D-088 §Component 5): the one-off mutation probe, end to end.
#
#   bash tests/tools/mutation/probe.sh [--out <report.json>] [--skip-a]
#
# Pass A: Stryker over src/shared, src/mcp/shared, src/mcp/safe-exec-mcp with the node unit
#         layer (tests/unit, tap runner, per-test coverage).
# Pass B: every gate mutant pass A left alive, against the gate's contract tables.
# Report: ~/.ai-os/ci/mutation-<date>.json by default (the ONLY write outside the temp dir);
#         the markdown summary is printed and saved next to it as .md.
#
# Every test process runs with a throwaway HOME (rule 6). Needs @stryker-mutator/core and
# @stryker-mutator/tap-runner installed (dev dependencies — see tests/tools/README.md).
# Never wired into `ai ci run`: a run takes hours.
set -euo pipefail
_mut_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; _repo="${_mut_dir%/tests/tools/mutation}"
_here="${_repo}/tests/tools/mutation"
out="${HOME}/.ai-os/ci/mutation-$(date +%Y-%m-%d).json"
skip_a=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="${2:?--out needs a path}"; shift 2 ;;
    --skip-a) skip_a=1; shift ;;   # reuse $AIOS_MUTATION_OUT/pass-a.json from an earlier run
    *) echo "probe.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[[ -x "${_repo}/node_modules/.bin/stryker" ]] || { echo "probe.sh: Stryker not installed (see tests/tools/README.md)" >&2; exit 2; }

work="${AIOS_MUTATION_OUT:-$(mktemp -d "${TMPDIR:-/tmp}/aios-mutation.XXXXXX")}"
mkdir -p "${work}/home/.ai-os"
echo "probe: work dir ${work}"
cd "$_repo"
export AIOS_MUTATION_OUT="$work"
commit="$(git rev-parse --short HEAD)"

if [[ -z "$skip_a" ]]; then
  HOME="${work}/home" npm_config_cache="${work}/npm-cache" \
    node "${_repo}/node_modules/.bin/stryker" run "${_here}/stryker.unit.mjs"
fi
HOME="${work}/home" AIOS_MUTATION_HOME_OK=1 node --no-warnings "${_here}/gate-pass.mjs" "${work}/pass-a.json" "${work}/pass-b.json" "${work}/gate"
node --no-warnings "${_here}/report.mjs" "${work}/pass-a.json" "${work}/pass-b.json" "$out" "$commit" | tee "${out%.json}.md"
echo "probe: report ${out}"
