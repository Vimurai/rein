# Role Abstraction (CLI-Agnostic Triad)

## Goal & Architecture
**Goal**: Decouple the functional roles (Architect, Engineer, Tester) from specific CLI tools (Gemini CLI, Claude Code, TestSprite), allowing any compatible agent to act in any role. Future-proof the OS for *any* upcoming CLI.
**Architecture**: Introduce a global/local Role Mapping Configuration (`.ai/roles.json`), a **Provider Adapter Registry** (`.ai/providers.json`), and dynamic TMUX pane routing. Update `handoff_control` and `ai-watch` to route semantic roles (`architect`, `engineer`) dynamically.

## Core Concept
Historically, the OS hardcoded Gemini = Architect, Claude = Engineer. To support dynamic assignment (e.g., Claude playing both roles via TMUX pane isolation: `claude:1` and `claude:0`), or to drop in a brand new, unknown CLI released next year, we need a **Provider Adapter System**. The Architect defaulted to `agy` under D-050; since **D-066 (2026-09-10)** the default topology is all-Claude — see §Default Topology below. 
1. **Roles** (What is done) map to **Pane Identifiers** (Where it is done).
2. **Providers** (Who does it) declare their unique config requirements (e.g., where they read MCP settings).

## Components
1. **Role Configuration Store**: A JSON configuration (`.ai/roles.json`) tracking the active provider and pane index for `architect` and `engineer`.
2. **Provider Adapter Registry**: A JSON configuration (`.ai/providers.json` or within `registry.json`) that dictates how a CLI is configured by the OS (e.g., config path, MCP schema format).
3. **Dynamic Bootloader (`src/bin/ai`)**: Parses the Provider Adapter to generate the correct configuration files during `ai init`/`ai sync`, and injects the `AI_OS_CALLER_ROLE` HMAC token.
4. **Semantic Handoff Control**: `ai-watch` reads the `.ai/roles.json` mapping to route `tmux send-keys` signals strictly to the assigned pane, preventing infinite loops when one CLI (e.g., Claude) operates in both panes.

## Data Model

**1. `.ai/roles.json` (Role Mapping):**
```json
{
  "roles": {
    "architect": {
      "provider": "claude",
      "pane_identifier": "1"
    },
    "engineer": {
      "provider": "claude",
      "pane_identifier": "0"
    }
  }
}
```

**2. `.ai/providers.json` (Provider Adapter Schema):**
```json
{
  "providers": {
    "claude": {
      "mcp_config_path": ".claude.json",
      "mcp_key": "mcpServers"
    },
    "agy": {
      "mcp_config_path": ".agents/mcp_config.json",
      "mcp_key": "mcpServers"
    },
    "gemini": {
      "mcp_config_path": ".gemini/settings.json",
      "mcp_key": "mcp_servers"
    }
  }
}
```

## API / Interface Contracts
- **CLI Bootloader**: `ai install --architect claude:1 --engineer claude:0` parses the pane indices, saves them to `.ai/roles.json`, and looks up `claude` in the Provider Registry to know how to install the MCPs.
- **Provider Registration**: `ai provider add <name> --config-path <path> --mcp-key <key>`
- **`handoff_control`**: Accepts `target: "architect" | "engineer"`.

## Security
- Role spoofing remains protected by the HMAC session token (`AI_OS_CALLER_ROLE`). The bootloader still mints the token based on the semantic role map.
- Provider configurations cannot point outside the local repository bounds (no arbitrary path traversal for `mcp_config_path`).

## Execution Constraints
- If a provider acts as both Architect and Engineer, explicit pane indices (e.g. `1` and `0`) MUST be provided so `ai-watch` routes signals safely.

## Rollback Plan
- Delete `.ai/roles.json` and `.ai/providers.json`. Hardcode the fallback mapping: `architect` = `agy`, `engineer` = `claude`.

## E-## Task Breakdown
- **E-135**: Implement the Role Configuration Store (`.ai/roles.json`) supporting explicit pane indices (`claude:1`, `claude:0`).
- **E-136**: Refactor `task-synchronizer-mcp` to use semantic targets in `handoff_control` and `TASKS.md` generation.
- **E-137**: Update `src/bin/ai-watch` to dynamically map semantic roles to specific `tmux` pane identifiers via `.ai/roles.json`.
- **E-138**: Implement the **Provider Adapter System** (`.ai/providers.json`) in the bootloader (`src/bin/ai`), allowing seamless registration and configuration of new CLI agents.

## Provider Directories (D-052 Taxonomy)
While the roles (Architect, Engineer) are abstract, the physical configuration files for the execution environments remain scoped to the *provider*. 
Directories such as `src/gemini/` and `src/claude/` are strictly **Provider Adapters**. They contain vendor-specific configuration (e.g., `settings.json`, `.claude.json`) and legacy fallback shims. They do *not* define the logic of the "Architect" or "Engineer" roles. Renaming these directories to semantic roles (`src/architect/`) is forbidden as it breaks this decoupling (per D-052).
## Same-Provider Triad — Per-Pane Role Binding (D-054 Amendment, 2026-09-04)
**Status**: Ratified by D-054. Supersedes the implicit assumption that a provider's project
config (`.claude/settings.json`, `CLAUDE.md`) can carry the role. **Role identity is bound
per pane at launch, never per project.** The Engineer's 2026-09-04 findings handoff (COMM.md)
reproduced four gaps (G1–G4) that this section closes.

### Goal
Two panes of the SAME provider (the dual-Claude case above) must each boot the correct
persona (G1), mint the correct E-129 role token (G2), receive their own handoffs (G3), and be
reachable by the A2A bridge (G4) — with sovereignty enforced by the gate, not by prompt.

### Components
1. **`ai pane <role>` launcher (`src/bin/ai`)** — the single provider-agnostic binding surface,
   symmetric to `ai handoff <role>` and `ai add-task` (D-053). It reads `.ai/roles.json`, looks
   up the role's `provider` in `providers.json`, and execs the provider CLI with:
   - launch env `AI_OS_PANE_ROLE=<role>` and `AI_OS_CALLER_ROLE=<role>`;
   - the provider's `launch` adapter argv (see Data Model) — for `claude`:
     `--settings .claude/settings.<role>.json --append-system-prompt-file <ROLE>.md`
     plus `--model <roles.json model>` when present;
   - `tmux select-pane -T <role>` on the current pane BEFORE exec (pins Pass 1 routing;
     no-op outside tmux).
2. **Launch-time role for the SessionStart hook** — `session-start.sh` mints the token for
   `${AI_OS_PANE_ROLE:-$1}`. The positional default stays `engineer` so the plain `claude`
   launch path is unchanged. The hook ALSO emits `[AI_OS_ROLE] <role>` as the first line of its
   `additionalContext` so the persona layer can read the minted role. (D-055 R3) The stamp is role
   binding, not caching: `AI_OS_DISABLE_CACHE=1` suppresses the compiled blob only and MUST NOT
   suppress the stamp — a caching rollback must never reopen G1.
3. **Per-role settings overlay `.claude/settings.<role>.json`** (derived programmatically by
   `ai init`/`ai sync` from `.ai/roles.json` — there is no template under `src/claude/`, so nothing
   can drift out of sync; one per role that maps to `claude`) — carries `env.AI_OS_CALLER_ROLE`,
   the role's permission deltas, and (D-055 R1) `permissions.deny` for every filesystem-mutating
   MCP tool when the role is `architect`. It MUST NOT register a second `SessionStart` hook
   (hook arrays merge; two mints for one session id would race).
4. **Role Resolution clause (both rulefiles)** — first section of `ENGINEER.md` and `ARCHITECT.md`:
   > If the session context carries an `[AI_OS_ROLE] <role>` stamp naming a different role,
   > that role's rulefile governs and this file is inert for the session.
   `CLAUDE.md` keeps `@ENGINEER.md` (D-051 unchanged); the Architect pane gets `ARCHITECT.md`
   appended by the launcher, and the clause resolves the conflict deterministically.
5. **Sovereignty gate coverage** — `hooks/pre-tool-use.sh` additionally matches `Write|Edit`
   (and `MultiEdit`/`NotebookEdit` if registered) and, when the *token-minted* role is
   `architect`, BLOCKS any target path outside `.ai/` and `plans/` (mirrors
   `context-guardian-mcp::check_role_access`, which stays advisory). Engineer role: unchanged.
6. **Provider-aware A2A bridge** — `advisor-mcp::ask_architect` resolves `architect.provider`
   from `.ai/roles.json` and builds argv from the adapter's `print_mode` template. Never a
   vendor literal. See `interop.md` for the read-only invariant (print mode, no permission bypass).

### Data Model (extended)
**`.ai/roles.json`** — role entries MAY carry an optional `model`:
```json
{ "roles": {
    "architect": { "provider": "claude", "pane_identifier": "1", "model": "claude-opus-5" },
    "engineer":  { "provider": "claude", "pane_identifier": "0" } } }
```
**`.ai/providers.json`** — adapters gain `launch` and `print_mode` argv templates
(`{role}`, `{rulefile}`, `{model}`, `{prompt}` substituted; a template entry that resolves to an
empty substitution is dropped):
```json
{ "providers": {
    "claude": { "mcp_config_path": ".claude.json", "mcp_key": "mcpServers",
      "launch":     ["--settings", ".claude/settings.{role}.json", "--append-system-prompt-file", "{rulefile}", "--model", "{model}"],
      "print_mode": ["-p", "--append-system-prompt-file", "{rulefile}", "{prompt}"],
      "child_env_unset": ["CLAUDECODE"] },
    "agy":    { "mcp_config_path": ".agents/mcp_config.json", "mcp_key": "mcpServers",
      "launch": [], "print_mode": ["--print-timeout", "90s", "-p", "{prompt}"] },
    "gemini": { "mcp_config_path": ".gemini/settings.json", "mcp_key": "mcp_servers",
      "launch": [], "print_mode": ["-p", "{prompt}"] } } }
```
`child_env_unset` lists env vars the bridge strips from the child (Claude Code refuses to nest
while `CLAUDECODE=1` is inherited).

### API / Interface Contracts
- `ai pane <architect|engineer> [-- <extra provider args>]` — binds and execs. Exit 2 if the
  role is unmapped or the provider adapter has no `launch` entry.
- `resolve_pane` precedence for semantic targets — see `interactive-bridge.md §Pane Resolution
  Precedence (D-054)`.
- Legacy provider targets `claude`/`gemini` — **deprecated**: `ai-watch` warns on stderr; if
  `.ai/roles.json` maps both roles to that provider the target is ambiguous and MUST fail
  closed (`return 1`, hint: use `architect`/`engineer`). Removal: v4.0.

### Security
- The E-129 HMAC token remains the sole enforcement surface; `AI_OS_CALLER_ROLE` stays advisory.
  Launch-time env (`AI_OS_PANE_ROLE`) is consumed once by the SessionStart hook before any agent
  tool call and is as trusted as the settings file itself — the E-129 in-session-mutation threat
  is unaffected.
- The Architect pane's `Write`/`Edit` block is Tier 3: E-208 is DONE only after a live negative
  test (`Write` to `src/**` from an `ai pane architect` session → BLOCKED by the hook).
- **Write-gate coverage (D-055 R1, E-216)**: three channels — native `Write`/`Edit` (E-208); MCP write
  tools (overlay `permissions.deny`); recognised shell write forms (redirections, `tee`, `cp`/`mv`/
  `install`/`ln`, `sed -i`/`perl -i`, `rsync`, `dd`, `truncate`, `git apply`/`patch`) with a target
  outside `.ai/`+`plans/`. Inline interpreters (`python3 -c`, `node -e`, `bash -c`, `eval`, …) are
  blocked outright for the architect role; unparsable targets fail closed. Stated residual (tests
  fail if a stronger claim is reinserted): exotic encodings, git plumbing, interactive editors,
  MCP proxying beyond the denied names, `find -delete` / `-exec rm`, awk `-f` program files.
- **Widening freeze (D-056 R3)**: the shell layer is NOT widened further. The E-216 review showed
  five of eleven findings were over-blocks of ordinary Architect work (prose with `->` into `.ai/`,
  `> /dev/null`, `awk '$1 > 5'`, `sed -i .ai/n && git diff`); an over-block on this gate is a
  defect of the same severity as a bypass. `tests/fixtures/arch-write-cases.json` (argv-passed,
  READ positives beside the write forms they resemble) is the analyser's contract: any change to
  `architect-writes.mjs` MUST add cases in both directions, and turning a READ positive into a
  block is a regression. Over-blocks outrank under-blocks in review ordering. The Git Lane is the
  last checkpoint for the accepted residual.
- **MCP write tools without the overlay (D-056 R1, E-219)**: `patch-mcp` / `propose-patch-mcp`
  derive the role server-side (verified session record → spawn-frozen `AI_OS_CALLER_ROLE` → no
  evidence = `architect`); a volunteered `caller_role` can only add restriction.
- **A2A child environment (E-210, amended per measurement)**: the bridge never spreads
  `process.env`. The allowlist is `PATH`, `HOME`, `USER` plus any `child_env_keep` names the
  provider adapter declares. `USER` is REQUIRED for a `claude` child — without it the CLI exits
  "Not logged in" (bisected live); it is an account name, not a credential. `child_env_unset`
  still strips the nested-session guard.

### Execution Constraints
- **Interim (until E-208 ships)**: a same-provider Triad is prompt-level only. Operators MUST pin
  pane titles (`tmux select-pane -T architect` / `-T engineer`) and MUST NOT rely on the gate
  to stop the Architect pane writing `src/`.
- Both panes of a same-provider Triad MUST use semantic handoff targets; never `claude`.

### Rollback Plan
Per D-054 §Rollback. The Role Resolution clause is inert without a stamp and may remain.

### E-## Task Breakdown (D-054)
- **E-208** (Tier 3): `ai pane <role>` launcher + `.claude/settings.<role>.json` overlay + launch-time
  role in `session-start.sh` (`[AI_OS_ROLE]` stamp) + Role Resolution clause in both rulefiles +
  `Write|Edit` sovereignty gate for the architect token. Acceptance includes the live negative test.
- **E-209** (Tier 2): `resolve_pane` precedence — roles.json ordinal before fuzzy passes for
  semantic targets (interactive-bridge.md §Pane Resolution Precedence).
- **E-210** (Tier 2): provider-aware `advisor-mcp::ask_architect` via `providers.json print_mode`
  + `child_env_unset`.
- **E-211** (Tier 1, after E-209): deprecate legacy `claude`/`gemini` targets — stderr warning +
  same-provider ambiguity fail-closed.

## Default Topology (D-066, 2026-09-10)
The framework default is the **all-Claude Triad**: `architect = claude:1` on model `fable`, `engineer = claude:0` on model `opus` (`src/templates/roles.json`, `_write_roles_json`). `agy` and `gemini` remain supported providers — their `src/` adapters stay (D-052) and either is selected per project with `ai install --architect agy:1` or by editing `roles.json`. Consequences: (1) every banner and owner/footer label derives from `roles.json` provider AND model (`Architect (claude · fable)`), never from a vendor literal; (2) the overlay path in the `claude` launch adapter is ABSOLUTE (rooted at the `.ai/` parent) and `ai pane` self-heals a missing overlay — the cwd-relative form produced "Settings file not found" from `ai start`; (3) workspace directories (`.claude/`, `.agents/`, `.gemini/`) are provisioned only for mapped providers, unmapped ones are reported by `ai doctor` and removed only by the explicit `ai sync --prune-providers`. → E-242, E-243, E-244.
