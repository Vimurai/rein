#!/usr/bin/env bash
# toolchain-fixture.sh — E-286 test seams for the hook toolchain pin.
#
# Since E-286 a hook ASSIGNS its PATH and never reads the inherited one, so the old test
# idiom — `env PATH="$stub:$PATH" bash hook` to slip in a fake `git`, or a node-free PATH
# to simulate a missing interpreter — no longer reaches the hook. That is the point: it
# was the T-HOOKENV-001 attack channel. These helpers drive the hooks through the channel
# production uses instead, the INSTALL-TIME RECORD (~/.rein/shared/toolchain.sh).
#
#   tc_overlay_home <fake_home> <bin_dir> [--no-pin]
#       A fake HOME whose ~/.rein links every entry of the real one, except that
#       shared/toolchain.sh records node and python3 as symlinks INSIDE <bin_dir> — so
#       <bin_dir> is FIRST on the hook's pinned PATH and a stub placed there (e.g. `git`)
#       is what the hook runs. --no-pin also omits shared/toolchain-pin.sh, so a hook run
#       from a tree copy loads that tree's own pin (see tc_stale_tree).
#   tc_fixture_home <home>
#       E-345 (D-109 r1): THE way to make a fixture HOME that a hook, `ai`, or a pin-loading
#       script runs under. Writes <home>/.rein/shared/toolchain.sh through the installer's
#       own rein_tc_write with the host's resolved node, python3 and nice — the values
#       install-rein.sh records — and puts this tree's toolchain-pin.sh beside it, as the
#       install does. The hooks' fallback dir list is never the answer (D-109 r1).
#       REIN_TEST_EMPTY_FALLBACK=1 (a harness switch, never read by production code) writes
#       the pin with its fallback list emptied, as tc_stale_tree does: a suite that passes
#       under it finds node through the record alone, on any host.
#       tests/tools/fixture-home-census.mjs fails a run whose suite sets a HOME and runs a
#       hook or `ai` without calling this (or tc_overlay_home).
#   tc_link_shared <home> [<src-shared>]
#       tc_fixture_home plus every other entry of <src-shared> (default src/shared) linked
#       into the fixture's REAL shared/ — for a mirror that points at the code under test.
#   tc_stale_tree <dest> <hook.sh>
#       Copies <hook.sh> to <dest>/hooks/ beside a pin whose fallback dir list is empty, so
#       a recorded interpreter that is gone is ALSO absent from the fallback — the only way
#       to simulate "no node anywhere" on a host that has one in /opt/homebrew/bin.
#       Prints the copied hook's path.

_TC_FIX_REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

tc_overlay_home() {
  local fh="$1" bin="$2" mode="${3:-}" real="${HOME}/.rein" e n
  mkdir -p "$fh/.rein/shared" "$bin"
  if [[ -d "$real" ]]; then
    # Link only the read-only CODE trees (critic_tests P2): linking run/, trash/, the
    # sqlite stores or incidents.ndjson would let a hook under test write through into the
    # operator's own mirror. run/ is a fresh private dir; everything else is simply absent.
    for n in bin claude config contracts copilot hooks mcp scripts templates VERSION; do
      [[ -e "$real/$n" ]] && ln -s "$real/$n" "$fh/.rein/$n"
    done
    mkdir -p "$fh/.rein/run" && chmod 700 "$fh/.rein/run"
    for e in "$real/shared"/* "$real/shared"/.[!.]*; do
      [[ -e "$e" || -L "$e" ]] || continue
      n="${e##*/}"
      [[ "$n" == "toolchain.sh" ]] && continue
      [[ "$mode" == "--no-pin" && "$n" == "toolchain-pin.sh" ]] && continue
      ln -s "$e" "$fh/.rein/shared/$n"
    done
  fi
  # The pin must exist in the fake mirror even when the real mirror predates E-286.
  if [[ "$mode" != "--no-pin" && ! -e "$fh/.rein/shared/toolchain-pin.sh" ]]; then
    cp "${_TC_FIX_REPO}/src/shared/toolchain-pin.sh" "$fh/.rein/shared/"
  fi
  local rn rp
  rn="$(. "${_TC_FIX_REPO}/src/shared/toolchain-record.sh"; rein_tc_realpath "$(command -v node)")"
  rp="$(. "${_TC_FIX_REPO}/src/shared/toolchain-record.sh"; rein_tc_realpath "$(command -v python3)")"
  [[ -n "$rn" ]] && ln -sf "$rn" "$bin/node"
  [[ -n "$rp" ]] && ln -sf "$rp" "$bin/python3"
  ( . "${_TC_FIX_REPO}/src/shared/toolchain-record.sh"
    rein_tc_write "$fh/.rein/shared/toolchain.sh" "$bin/node" "$bin/python3" /usr/bin/nice )
}

# _tc_pin_emptied <src-pin> <dest-pin> <empty-dir> — the pin with both fallback halves emptied.
_tc_pin_emptied() {
  sed -e "s#for d in /usr/bin /bin /usr/local/bin /opt/homebrew/bin; do#for d in ${3}; do#" \
      -e "s#^REIN_TC_FALLBACK_PATH=.*#REIN_TC_FALLBACK_PATH=\"${3}:/usr/bin:/bin:/usr/sbin:/sbin\"#" \
    "$1" > "$2"
}

# A suite that cannot build its fixture HOME must not run on without the record — it would
# test the fallback list again. The helper ends the suite (it is called at the suite's top
# level, or in a function of it) with a ✗ line the runner counts.
_tc_fixture_fail() { echo "  ✗ tc_fixture_home: $*"; exit 1; }

tc_fixture_home() {
  local fh="$1" rn rp rc
  [[ -n "$fh" ]] || _tc_fixture_fail "no home given"
  # A shared/ that IS a symlink (into src/shared, say) would take the record and the pin into
  # the tree it points at. Link its ENTRIES instead: tc_link_shared.
  [[ -L "$fh/.rein/shared" ]] && _tc_fixture_fail "$fh/.rein/shared is a symlink — use tc_link_shared"
  mkdir -p "$fh/.rein/shared" || _tc_fixture_fail "cannot create $fh/.rein/shared"
  local pin="${_TC_FIX_REPO}/src/shared/toolchain-pin.sh"
  # The destination may be a symlink into a source tree (linkShared, a copied mirror): replace
  # the link, never write through it.
  rm -f "$fh/.rein/shared/toolchain-pin.sh"
  if [[ "${REIN_TEST_EMPTY_FALLBACK:-0}" == "1" ]]; then
    mkdir -p "$fh/.rein/shared/.empty-fallback"
    _tc_pin_emptied "$pin" "$fh/.rein/shared/toolchain-pin.sh" "$fh/.rein/shared/.empty-fallback"
  else
    cp "$pin" "$fh/.rein/shared/toolchain-pin.sh"
  fi
  ( . "${_TC_FIX_REPO}/src/shared/toolchain-record.sh"
    rn="$(rein_tc_realpath "$(command -v node)")" || exit 1
    rp="$(rein_tc_realpath "$(command -v python3)")" || rp=""
    rc="$(rein_tc_realpath "$(command -v nice)")" || rc=/usr/bin/nice
    rein_tc_write "$fh/.rein/shared/toolchain.sh" "$rn" "$rp" "$rc" ) \
    || _tc_fixture_fail "could not record this host's node/python3 for $fh"
}

# tc_link_shared <home> [<src-shared>] — a fixture mirror whose shared/ is a REAL dir of links
# into <src-shared> (default: this tree's src/shared), with the record and the pin written by
# tc_fixture_home rather than linked: a hook under it runs the code under test and the
# toolchain the install would record.
tc_link_shared() {
  local fh="$1" src="${2:-${_TC_FIX_REPO}/src/shared}" e n
  tc_fixture_home "$fh"
  for e in "$src"/* "$src"/.[!.]*; do
    [[ -e "$e" || -L "$e" ]] || continue
    n="${e##*/}"
    [[ -e "$fh/.rein/shared/$n" || -L "$fh/.rein/shared/$n" ]] && continue
    ln -s "$e" "$fh/.rein/shared/$n"
  done
}

tc_stale_tree() {
  local dest="$1" hook="$2"
  mkdir -p "$dest/hooks" "$dest/src/shared" "$dest/empty-fallback"
  cp "$hook" "$dest/hooks/"
  # Both halves of the fallback: the resolution loop AND the fallback PATH (a hook's own
  # `command -v node` searches the latter). /usr/bin and /bin stay so coreutils work; no
  # supported host ships node there. (macOS DOES ship a /usr/bin/python3 shim, so a hook's
  # own `command -v python3` still finds one — the gate keys on REIN_TC_PYTHON3 instead,
  # which the emptied loop leaves unset.)
  _tc_pin_emptied "${_TC_FIX_REPO}/src/shared/toolchain-pin.sh" "$dest/src/shared/toolchain-pin.sh" "$dest/empty-fallback"
  printf '%s\n' "$dest/hooks/${hook##*/}"
}
