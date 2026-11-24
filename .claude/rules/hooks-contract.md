---
paths:
  - "hooks/**"
---

# Hooks contract (hooks/)

- **The boundary is the role sandbox, not a hook** (D-169 r3, E-463). `pre-tool-use.sh` is the
  seatbelt: advice on three classes, answered with `permissionDecision: "ask"`. It is not a
  security boundary — no pen-test round, no new spellings; a miss is a miss, not a finding.
- **Claude Code PreToolUse**: the payload is JSON on stdin; exit 2 blocks and feeds stderr back
  to the model; exit 0 allows; a printed `hookSpecificOutput.permissionDecision` answers the call.
- **Claude Code hooks fail OPEN; the git hooks that check a commit fail CLOSED.** A missing helper
  in a Claude Code hook is a skipped check, never a broken session.
- **An aborted hook (E-292, D-082 r2).** Every hook's FIRST executable line is its one
  inline-string EXIT trap (builtins only); a later EXIT trap must chain to it. A deliberate exit
  is `exit` with the hook's own codes. An empty `$( … )` result on a path to `exit 0` must be
  checked — an abort in a subshell does not reach the trap. No `printf | grep -q` under
  `pipefail` (SIGPIPE); use `<<<`.
- **Resolve helpers install-first (E-223).** Set `REIN_LOCATE_UNTRUSTED_ENV=1` in the hook's
  own text, `unset -f rein_locate rein_locate_enable_dev_tree rein_is_framework_clone`
  before sourcing `~/.rein/shared/locate.sh`, and never resolve from the visited repo's
  `src/`: a project's `.claude/settings.json` `env` block is inherited by hooks and is an
  attacker channel (T-LOCATOR-001, T-HOOKENV-001).
- **The role comes from the launch records on the process chain** (`launch-record.py role` or
  `walk`; most restrictive wins) and from nothing else (E-294, D-087, E-463): no role variable,
  no positional role.
- **Parse the payload once** so newlines and quotes survive.
- **Hooks run as exec-form `/bin/bash -p <absolute path>`** (E-290) and stay within their
  latency budget.
