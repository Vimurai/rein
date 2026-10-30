#!/usr/bin/env bash
# gate-tables.sh — E-300 (D-088 §Component 5) pass B: the gate's contract tables against ONE
# safe-exec tree (normally a mutated sandbox copy). Same session shape as the retired
# architect_write_gate suite (E-301): one live session per role, tokens minted by the repo's own
# (unmutated) gate through tests/lib/as-session.sh; the verdicts come from <index.js>.
#
# Usage: HOME=<throwaway> gate-tables.sh <safe-exec index.js> [--inproc] [--all]
#   default   the spawn drivers (tests/lib/secret-cases.mjs, arch-write-cases.mjs): one
#             `--check` process per case, the gate exactly as the hook runs it (~2 min);
#   --inproc  inproc-tables.mjs: one process asks runAnalysis for every case (seconds) — for
#             mutants outside the CLI glue only (gate-pass.mjs decides).
# Prints "<table> PASS|FAIL" per table run; stops at the first FAIL unless --all.
# Exits 1 when any table failed (the mutant is killed), 0 when all passed (it survived).
set -uo pipefail
_mut_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; _repo="${_mut_dir%/tests/tools/mutation}"
se="${1:?usage: gate-tables.sh <safe-exec index.js> [--inproc] [--all]}"; shift
inproc=""; all=""
for a in "$@"; do case "$a" in --inproc) inproc=1 ;; --all) all="--all" ;; esac; done
# The flag says probe.sh set HOME; the account's real home (from the user record, not $HOME)
# says it really is a throwaway one (critic_security P2-1).
[[ -n "${REIN_MUTATION_HOME_OK:-}" ]] || { echo "gate-tables.sh: run through probe.sh (throwaway HOME)" >&2; exit 2; }
[[ "$HOME" != "$(node -p 'require("os").userInfo().homedir')" ]] || { echo "gate-tables.sh: HOME is the real home — refusing" >&2; exit 2; }
mkdir -p "${HOME}/.rein"
as="${_repo}/tests/lib/as-session.sh"
stop="${HOME}/stop-$$-${RANDOM}"
failed=0
source "${_repo}/tests/lib/assert.sh"
# Safety net, registered before the sessions start: an abnormal exit still stops them. The
# normal path is _done below — it must WAIT in this shell (a cleanup handler runs in a
# subshell and cannot), or a session still winding down removes the next run's lock file.
on_exit "touch '${stop}'"
_done() { touch "$stop"; wait 2>/dev/null; exit "$1"; }

# One live session per role for the arch-write table (the suite's _awg_session).
for role in architect engineer; do
  ( cd "$_repo" && exec bash "$as" "$role" "mut-$role" -- \
      bash -c 'i=0; while [ ! -e "$1" ] && [ $i -lt 6000 ]; do sleep 0.1; i=$((i+1)); done' _ "$stop" ) >/dev/null 2>&1 &
  eval "p_${role}=$!"
done
i=0; while { [ ! -e "${HOME}/.rein/run/role-mut-architect.lock" ] || [ ! -e "${HOME}/.rein/run/role-mut-engineer.lock" ]; } && [ $i -lt 100 ]; do sleep 0.1; i=$((i+1)); done
sess=("architect=mut-architect:${p_architect}" "engineer=mut-engineer:${p_engineer}")

if [[ -n "$inproc" ]]; then
  ( cd "$_repo" && bash "$as" none mut-eng -- node --no-warnings "${_repo}/tests/tools/mutation/inproc-tables.mjs" \
      "$se" "$_repo" mut-eng "${sess[@]}" $all 2>/dev/null )
  _done $?
fi

rule="$(dirname "$se")/secret-rule.mjs"
for t in secret pipe-shell gate-relative-home arch-write; do
  rc=0
  if [[ "$t" == "arch-write" ]]; then
    ( cd "$_repo" && node --no-warnings "${_repo}/tests/lib/arch-write-cases.mjs" "$se" \
        "${_repo}/tests/fixtures/arch-write-cases.json" "${sess[@]}" >/dev/null 2>&1 ) || rc=$?
  else
    ( cd "$_repo" && bash "$as" none "mut-$t" -- node --no-warnings "${_repo}/tests/lib/secret-cases.mjs" \
        "$se" "$rule" "${_repo}/tests/fixtures/${t}-cases.json" "mut-$t" >/dev/null 2>&1 ) || rc=$?
  fi
  if [[ $rc -eq 0 ]]; then echo "${t} PASS"; else echo "${t} FAIL"; failed=1; fi
  [[ $failed -eq 1 && "$all" != "--all" ]] && break
done
_done "$failed"
