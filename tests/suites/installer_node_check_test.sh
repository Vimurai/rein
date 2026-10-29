#!/usr/bin/env bash
# AIOS_INSTALLER_SUBJECT: the installer's Node.js preflight (E-311, D-092)
# installer_node_check_test.sh — Tests for E-69 fail-closed Node.js check.
#
# Verifies install-ai-os.sh refuses to proceed when Node.js is absent or
# older than v22 — preventing silent WAL bloat on degraded systems
# (system-hardening-phase3.md §Security / §Execution Constraints).
#
# Strategy: run install-ai-os.sh under a synthetic PATH so the embedded
# `command -v node` resolves to a stub we control. The script must exit 1
# before any file copy occurs (asserted by checking the sandbox AIOS dir
# stays empty).

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../lib/assert.sh"

REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
INSTALL="${REPO_ROOT}/install-ai-os.sh"

echo "===== installer_node_check_test.sh ====="

# ── T-NODE-S01: Static check — guard runs before copy logic ───────────────────
echo ""
echo "  [T-NODE-S01] Guard is positioned before mkdir/rsync block"

assert_status 0 "installer references fail-closed node check (E-69)" \
  grep -qE "E-69.*Fail-closed Node" "$INSTALL"

assert_status 0 "installer probes command -v node" \
  grep -qE 'command -v node' "$INSTALL"

assert_status 0 "installer enforces Node 22 major version" \
  grep -qE '_node_major < 22|Node 22\+' "$INSTALL"

assert_status 0 "guard respects AI_OS_SKIP_NODE_CHECK escape hatch" \
  grep -q 'AI_OS_SKIP_NODE_CHECK' "$INSTALL"

# Guard line number must come before the first 'mkdir -p "${AIOS}"' line —
# this protects ordering even if the file is later refactored.
guard_line="$(grep -nE '\[ERROR\] Node\.js is required' "$INSTALL" | head -1 | cut -d: -f1)"
mkdir_line="$(grep -nE '^mkdir -p "\$\{AIOS\}"' "$INSTALL" | head -1 | cut -d: -f1)"
assert_status 0 "guard precedes first mkdir -p AIOS (line $guard_line < $mkdir_line)" \
  bash -c "[[ -n '$guard_line' && -n '$mkdir_line' && '$guard_line' -lt '$mkdir_line' ]]"

# ── T-NODE-S02: Behavioural — missing node aborts before file copy ────────────
echo ""
echo "  [T-NODE-S02] Missing node → fail-closed exit 1, no files copied"

SBOX="$(mktemp -d)"
on_exit 'rm -rf "$SBOX"'
# Minimal PATH that retains coreutils (bash, grep, rsync) but excludes
# /opt/homebrew/bin and ~/.nvm/* where node typically lives. Verified
# empirically: `PATH=/usr/bin:/bin command -v node` returns non-zero on
# both stock macOS and stock Debian/Ubuntu.
PATH_NO_NODE="/usr/bin:/bin"
# Synthetic HOME so the installer would write into the sandbox if it got past the guard.
FAKE_HOME="${SBOX}/home"
mkdir -p "$FAKE_HOME"

set +e
# E-99: run from within the sandbox so a cwd-relative write can never reach the repo.
( cd "$SBOX" && PATH="$PATH_NO_NODE" HOME="$FAKE_HOME" bash "$INSTALL" ) >"${SBOX}/stdout" 2>"${SBOX}/stderr"
exit_code=$?
set -e

assert_status 0 "installer exits non-zero when node absent" \
  bash -c "[[ $exit_code -ne 0 ]]"

assert_status 0 "stderr names Node.js as the missing requirement" \
  grep -qE 'Node\.js is required' "${SBOX}/stderr"

assert_status 0 "no files copied to fake AIOS (sandbox HOME stays empty of .ai-os)" \
  bash -c "[[ ! -d '${FAKE_HOME}/.ai-os/contracts' && ! -d '${FAKE_HOME}/.ai-os/shared' ]]"

# ── T-NODE-S03: Behavioural — old node aborts before file copy ────────────────
echo ""
echo "  [T-NODE-S03] Node < 22 → fail-closed exit 1, version reported"

STUB_DIR="${SBOX}/stub-old"
mkdir -p "$STUB_DIR"
cat >"${STUB_DIR}/node" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "v18.19.0"
  exit 0
fi
exit 0
STUB
chmod +x "${STUB_DIR}/node"

FAKE_HOME2="${SBOX}/home2"
mkdir -p "$FAKE_HOME2"

set +e
# E-99: run from within the sandbox so a cwd-relative write can never reach the repo.
( cd "$SBOX" && PATH="${STUB_DIR}:${PATH_NO_NODE}" HOME="$FAKE_HOME2" bash "$INSTALL" ) >"${SBOX}/stdout2" 2>"${SBOX}/stderr2"
exit_code2=$?
set -e

assert_status 0 "installer exits non-zero on Node 18" \
  bash -c "[[ $exit_code2 -ne 0 ]]"

assert_status 0 "stderr names Node.js 22+ requirement" \
  grep -qE 'Node\.js 22\+ required' "${SBOX}/stderr2"

assert_status 0 "stderr surfaces the detected old version" \
  grep -q 'v18.19.0' "${SBOX}/stderr2"

assert_status 0 "no files copied on stale node (sandbox HOME stays empty of .ai-os)" \
  bash -c "[[ ! -d '${FAKE_HOME2}/.ai-os/contracts' && ! -d '${FAKE_HOME2}/.ai-os/shared' ]]"

# ── T-NODE-S04: AI_OS_SKIP_NODE_CHECK escape hatch ────────────────────────────
echo ""
echo "  [T-NODE-S04] AI_OS_SKIP_NODE_CHECK=1 bypasses the guard"

# We do NOT actually run a full install here (slow, and would mutate test HOME).
# Instead assert the script-level branch exists and reads the env var.
assert_status 0 "skip-flag respected via [[ != 1 ]] gate" \
  grep -qE '"\$\{AI_OS_SKIP_NODE_CHECK:-0\}".*!=.*"1"' "$INSTALL"

# ── T-NODE-S05: Hotfix — `sh install-ai-os.sh` re-execs under bash ───────────
echo ""
echo "  [T-NODE-S05] Invoking via sh re-execs into bash (POSIX-mode hotfix)"

# Static contract: the re-exec block must exist and reference both the bash
# POSIX-mode case and the unset-BASH_VERSION case.
assert_status 0 "re-exec block references POSIX mode detection" \
  grep -q 'SHELLOPTS' "$INSTALL"

assert_status 0 "re-exec uses exec bash to swap interpreters" \
  grep -qE 'exec bash "\$0" "\$@"' "$INSTALL"

assert_status 0 "fallback error names bash explicitly" \
  grep -q 'installer requires bash' "$INSTALL"

# Behavioural: on macOS /bin/sh is bash + POSIX mode. We can simulate that on
# any platform by invoking with `bash --posix`. If `--posix` is supported by
# the local bash, run the full installer end-to-end against a sandbox HOME
# and assert it exits 0 with no syntax error (line 113 process substitution
# would have died pre-fix).
if bash --posix -c ':' 2>/dev/null; then
  SBOX_POSIX="$(mktemp -d)"
  set +e
  # E-99: run the installer from WITHIN the sandbox so any cwd-relative write
  # (the installer regenerates .mcp.json with absolute paths) lands in the
  # sandbox, never the repo working tree. ($INSTALL + redirect paths are
  # absolute, so the cd is safe.)
  ( cd "${SBOX_POSIX}" && HOME="${SBOX_POSIX}/home" AI_OS_SKIP_NODE_CHECK=1 bash --posix "$INSTALL" ) \
    >"${SBOX_POSIX}/stdout" 2>"${SBOX_POSIX}/stderr"
  posix_rc=$?
  set -e

  assert_status 0 "bash --posix install-ai-os.sh exits 0 via re-exec" \
    bash -c "[[ $posix_rc -eq 0 ]]"

  assert_status 1 "no 'syntax error near' surfaces on stderr" \
    grep -q 'syntax error near' "${SBOX_POSIX}/stderr"

  rm -rf "$SBOX_POSIX"
else
  echo "  ⚠  bash --posix not supported on this bash — skipping behavioural sub-tests"
fi

echo ""
assert_summary
echo "===== installer_node_check_test.sh PASS ====="
