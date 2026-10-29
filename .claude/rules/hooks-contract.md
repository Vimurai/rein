---
paths:
  - "hooks/**"
---

# Hooks contract (hooks/)

- **Claude Code PreToolUse**: the payload is JSON on stdin; exit 2 BLOCKS and feeds stderr back
  to the model; exit 0 allows. A gate treats ANY non-zero exit of its analyzer as a block — a
  module that fails to load exits 1, and only-2-blocks is a fail-open hole.
- **Gates fail CLOSED, everything else fails OPEN.** A missing helper degrades a gate to its
  backstop. Telemetry and logging hooks never block.
- **An aborted gate is a blocked call (E-292, D-082 r2).** Every hook's FIRST executable line
  is its one inline-string EXIT trap (builtins only); a later EXIT trap must chain to it. A
  deliberate exit is `exit` with the hook's own codes — anything else is an abort: gates exit 2
  with `[GATE_INTERNAL_ERROR]`, fail-open hooks exit 0 and write one `HOOK_ABORT` incident.
  An empty `$( … )` result on a path to `exit 0` must be checked — an abort in a subshell
  does not reach the trap. No `printf | grep -q` under `pipefail` (SIGPIPE); use `<<<`.
- **Resolve helpers install-first (E-223).** Set `AI_OS_LOCATE_UNTRUSTED_ENV=1` in the hook's
  own text, `unset -f ai_os_locate ai_os_locate_enable_dev_tree ai_os_is_framework_clone`
  before sourcing `~/.ai-os/shared/locate.sh`, and never resolve from the visited repo's
  `src/`: a project's `.claude/settings.json` `env` block is inherited by hooks and is an
  attacker channel (T-LOCATOR-001, T-HOOKENV-001).
- **The role comes from the HMAC-verified session token** (`--session` + `--session-pid
  "$PPID"` on the hook path, `--verify-role` elsewhere) and from nothing else (E-294, D-087):
  no role variable, no positional role. The token is minted from the launch records on the
  process chain (most restrictive wins) and bound to the claude process — the hook's PPID.
- **Parse the payload once** (python3, base64 for free text) so newlines and quotes survive.
- **No environment rollback for a gate** (E-291, D-081 r2): a project's settings `env` can
  set any variable, so an env switch is an attacker's switch. The operator's escape is
  `ai gate off` (a time-boxed, owner-checked file). Block messages say "Operator escape —
  in YOUR terminal, not through the agent" and never tell the model to run it.
- **Hooks run as exec-form `/bin/bash -p <absolute path>`** (E-290) and stay within their
  latency budget (PermissionDenied/telemetry < 20 ms).
- **The Architect write gate is frozen (D-056)**: `tests/fixtures/arch-write-cases.json` passes
  byte-identical after any hook change.
