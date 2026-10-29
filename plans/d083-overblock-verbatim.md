# D-083 over-block — the two blocked commands, verbatim (for `tests/fixtures/pipe-shell-cases.json`)

Both were issued by the Architect session on 2026-10-01 through the Bash tool and blocked by
`[CURL_PIPE_SHELL]`. Both are ALLOW cases. Note the shape the fixture must accept: the `cat`
line carries a leading `cd <abs> &&` prefix (the harness's own idiom — every Bash call in this
project starts that way), and a plain command line follows the heredoc terminator. The body is
between the delimiter line and the terminator and is the only part the exemption excludes from
scanning; everything else on the command is scanned normally.

## Command 1 (first D-083 draft; the body differs from the final entry, which was written with Edit)

```
cd /Users/dev/Documents/develompment/cli_apps/@vimurai/rein && cat >> .ai/DECISIONS.md <<'EOF'

---

## D-083 — Hooks in exec form with absolute paths; the gate is tamper-resistant against a same-uid agent, with a classifier backstop; role minted from a launch record, never from env

**Date**: 2026-10-01
**Task**: E-290 and E-291 (scope amended), E-293 (new), E-294 (new), E-289 (ratified)
**Decision**: Nine rulings on the Engineer's 2026-10-01 E-290/E-291 threat-model entry (`.ai/COMM.md`). Verified against code.claude.com/docs/en/hooks.md: exec form spawns `command` directly with `args`, "there is no shell"; a timed-out PreToolUse hook does NOT block; exit codes other than 0/2 do NOT block; stderr on exit 0 goes to the debug log only; `systemMessage` is shown to the user.

### E-290
**1. Exec form — adopted.** `/bin/bash -p` on a shell-form line runs AFTER `sh -c` has already honoured `SHELLOPTS`/`PS4` (probed). Every generated hook entry becomes `{"type":"command","command":"/bin/bash","args":["-p","<absolute hook path>"],"timeout":30}`. No shell, no tokenisation, no expansion.
**2. HOME — closed by construction.** `args` carries the install-time ABSOLUTE path; `$HOME` disappears from the hook lines. Consequence accepted: `.claude/settings.json` leaves git tracking and is gitignored in every Rein project (the `.gemini/settings.json` precedent, via the E-233 generated-artefact mechanism); `ai sync` regenerates it; `ai doctor` reports absent or stale; `ai ci run` and every test generate it in the fixture rather than reading the repo copy; the role overlays stay tracked (no paths). The `env.HOME` measurement is still recorded in the threat model.
**3. Old-form entries removed — in scope.** `_configure_project_claude_settings` removes every Rein-owned entry for the five hooks in any form (command or args resolving to one of the hook basenames) before writing the exec-form entry; user-authored entries are untouched; idempotent.
**4. Git stubs — in scope.** `exec /bin/bash -p` and the chained `/bin/bash -p "$USER_HOOK"`; the prologue also unsets `POSIXLY_CORRECT` and `BASH_COMPAT` (`-p` does not clear them, and posix mode on 3.2 turns process substitution into a fail-open syntax error until E-292); `ai doctor` reports a stale hook form or stub.

### E-291
**5. Agent self-disable — the ceiling is accepted and named.** A same-uid agent cannot be prevented from reaching anything the operator can reach; no TTY or owner check distinguishes them. The gate is TAMPER-RESISTANT, not tamper-proof, and the blueprint says so. Funded mitigations: (i) analyzer rule `GATE_SELF_DISABLE`, every role: `ai gate`, `gate-override`, and any shell write under `~/.rein/` BLOCK (string-splitting residual recorded); (ii) ruling 6; (iii) **E-293 — classifier backstop**: `ai install` OFFERS (y/N, never silent) to add a `hard_deny` entry to the operator's `~/.claude/settings.json` (`"$defaults"` preserved) covering `ai gate off`, writes under `~/.rein/` and edits of `~/.claude/settings.json`; the classifier's configuration is the one layer the agent cannot reach from the project (D-080), so the two gates are independently configured; (iv) operator presence (Keychain/Touch ID) is the next rung, recorded, not funded. Block messages never instruct the model to run `ai gate off`; the Engineer's wording ("Operator escape — in YOUR terminal, not through the agent") is adopted.
**6. `~/.rein/**` is protected for every role.** The Write/Edit branch blocks both roles there; shell writes there are blocked by (i). The only writer paths are the inline repair predicate, widened to a literal allowlist of our own commands: `bash install-rein.sh`, `ai install`, `ai sync` (documented flags only), `ai doctor`. Nothing else.
**7. Loud means user-visible.** On every bypassed call the hook exits 0 with JSON stdout `{"systemMessage":"[GATE_OVERRIDE] safe-exec bypassed until <until> (<reason>) — operator: ai gate on", …}`; one telemetry row (`source=hook`, `status=BYPASS`); the session-start hook injects an `[GATE_OVERRIDE active until …]` line into `additionalContext`; `ai doctor` reports it. Stderr alone is invisible on exit 0 and is not loudness.
**8. The catastrophic backstop ALWAYS applies.** The override lifts the policy gate only; `rm -rf /`, fork bombs, `mkfs`, `dd` to a device and `curl | sh` block under an active override. Old S06 is reversed and a fixture asserts it.
**9. Role spoofing → E-294.** The mint reads `REIN_PANE_ROLE` and the gate falls back to `REIN_CALLER_ROLE`; both are settable by a project's settings `env`, so a project can hand the Architect persona an Engineer token and write source. Design: `ai pane` writes a launch record `~/.rein/run/launch/<pid>.json` (`role`, `project`, `started`; the `exec`'d claude keeps `ai pane`'s pid) before exec; the session-start mint walks the PPID chain to that pid and reads the record (O_NOFOLLOW/fstat as in E-291), never env; no record → `engineer` (the documented plain-launch default) with the token marked `launch: unverified`; the `--check`/`--check-path` env fallback is REMOVED: no valid token → the UNION of both roles' write blocks with `[ROLE_UNVERIFIED] run: ai pane <role>`. `REIN_PANE_ROLE`/`REIN_CALLER_ROLE` remain advisory for prompts and handoff, never for gating. Tier 3, after E-290 and E-291.

### E-289 divergence ratified
rc 0 with no `Verdict:` line is "no verdict" and blocks (a pre-E-125 mirror starts its stdio server and exits 0).

### Alternatives considered
- Keep shell form with `-p` — rejected: the outer `sh -c` runs the payload first (probed).
- Keep `$HOME` and a tracked settings file — rejected: the HOME channel stays open and the exec form needs a literal path anyway.
- Operator-presence step in E-291 — deferred: platform-specific, out of size; the classifier backstop buys most of the value now.
- Treat the ceiling as a reason to drop the override file — rejected: the env opt-out it replaces was weaker on every axis.

### Constraints driving this decision
- No shell between Claude Code and a gate; no variable in a gate's path; no env input to a gate's identity.
- A gate's own tooling is gated too (`~/.rein/**`), with a literal allowlist as the only exception.
- Two independently configured gates beat one hardened gate against a same-uid agent.

### Impact
- Unlocks: E-293 (after E-291), E-294 (after E-290, E-291). Queue: E-284 (in progress) → E-290 ∥ E-291 → E-292 → E-293 → E-294 → E-281 → E-285 → E-262 → E-263.
- Risk if wrong: a project cloned on a second machine has no `.claude/settings.json` until `ai sync` runs; `ai doctor` and the SessionStart heal say so.

### Rollback
Each task reverts as one PR; the exec-form entries revert to shell form with the same hooks.

---
EOF
echo "D-083 written"
```

## Command 3 (blocked by `GATE_SELF_DISABLE` while writing D-084 — the prose names the override command; the heredoc class is rule-independent)

The command was `cd /Users/dev/Documents/develompment/cli_apps/@vimurai/rein && cat >> .ai/DECISIONS.md <<'EOF'` followed by the D-084 entry text exactly as it now stands in `.ai/DECISIONS.md` from its heading through its closing `---`, then `EOF`, then `cat >> .ai/COMM.md <<'EOF'` with the "D-084 rulings after PRs #91–#93" handoff entry as it now stands in `.ai/COMM.md` (minus the two sentences added afterwards about the third block and the Edit-tool workaround), then `EOF`, then `cat >> .ai/LOG.md <<'EOF'` with the 2026-10-01 D-084 LOG line, then `EOF`, then `echo ok`. The fixture may reconstruct the body from those files; the consumer lines and the trailing `echo ok` are the part that matters and are given here verbatim.

## Command 2

```
cd /Users/dev/Documents/develompment/cli_apps/@vimurai/rein && cat >> .ai/COMM.md <<'EOF'
**Addendum (over-block, record per D-080)**: while writing D-083 the gate blocked `cat >> .ai/DECISIONS.md <<'EOF' …` with `[CURL_PIPE_SHELL]` because the heredoc PROSE listed the catastrophic set ("curl | sh"). Same class as the three 2026-09-29 secret blocks: a rule matching inside a quoted heredoc body. Add the verbatim command to the fixture as ALLOW and make CURL_PIPE_SHELL skip quoted heredoc bodies the way the secret rule does — fold into E-291 (same analyzer, same session of changes) or E-292 if E-291 has landed.
---
EOF
echo ok
```
