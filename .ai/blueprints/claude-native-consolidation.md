# Claude-Native Consolidation (v4.0.0)

> D-069 (2026-09-11). Supersedes the provider-plurality parts of D-050, D-051, D-052 and the
> Gemini Model Mandate (E-45); retains the role/provider DECOUPLING (roles.json, providers.json,
> provider-adapter.mjs) as a single-entry mechanism. Archived on completion: antigravity-migration,
> native-subagents, agy-subagent-robustness, agent-invocation-robustness, may-2026-upgrades.
> Task ids corrected 2026-09-13: the release task is **E-263** (D-070 took E-257..E-262).
> The five blueprints above were archived to `.ai/archive/2026-09/blueprints/` on 2026-09-16
> (after E-254 merged); `_INDEX.md` regenerated.

## Goal & Architecture
Rein carries two provider adapters nobody runs any more. The Architect and the Engineer both
run on Claude (D-066); TestSprite — the "third brain" — is a third-party cloud MCP that needs an
API key, is not exercised by the harness, and whose label is hard-coded in five places. The
`agy`/`gemini` code paths are the largest source of dead branches in `src/bin/ai` (163 hits),
the installer (22), the tests (59 files) and the docs (README 28). Ruling: **Rein v4 is
Claude-native.** One provider, three Claude roles (Architect on `fable`, Engineer on `opus`,
Tester on `sonnet`), no vendor shims but `CLAUDE.md`, no third-party test cloud. Removal is
done by deletion, not by flags; what remains is what runs.

## Core Concept
**Roles stay abstract; vendors go.** `.ai/roles.json` remains the single place that binds a
role to a provider and a model, and `providers.json` remains the adapter registry — but both
ship with exactly one provider, `claude`. Everything that existed only to serve `agy` or
`gemini` (workspaces, plugin builder, TOML commands, field stripping, model pinning, plugin
install, the `.agents/`/`.gemini/` provisioning and the `GEMINI.md`/`AGENTS.md` shims) is
deleted. The Tester becomes a **headless Claude role**: no pane, dispatched as a subagent by
`ai-test`, with its model taken from `roles.json` like the other two.

## Components
> **D-110 (2026-10-23).** Agent model pins are by job: rule-matchers that stamp PASS/FAIL
> (`critic_arch`, `critic_security`, `critic_tests`, `critic_clean_code`, `docs-architect`,
> `sre_responder`, `memory_curator`) pin `model: sonnet`; reasoning agents inherit the pane's
> model; `haiku` stays the `--fast` Tester only. Verdict parity on recorded stamps is the
> acceptance (E-347).
1. **Provider removal (E-254)** — delete `src/gemini/` (its 7 Architect-side agents move to
   `src/claude/agents/` in Claude frontmatter with `allowed-tools`/`user-invocable`/
   `disable-model-invocation` intact — the D-067 §2 strip problem disappears with the strip),
   `src/agents/` (the agy plugin and its skill mirror; the 15 Architect skills move to
   `src/claude/skills/`; **corrected by D-076**: there is NO role→skill partition —
   `role-manifest.mjs` unions directories, both roles name `claude/skills`, and both panes
   read the same `.claude/skills/`; separation is the role token, the write gate and
   distinct skill names), `src/shared/plugin-builder.mjs`, `src/templates/GEMINI.md`,
   `src/templates/AGENTS.md`, root `GEMINI.md`; in `src/bin/ai` remove
   `strip_gemini_agent_fields`, `_configure_project_gemini_settings`, `agy_plugin_install`,
   the `ai provider` subcommand, the `gemini`/`agy` `_provision_workspace` calls, the doctor
   branches and every help/banner string naming a vendor; in `install-rein.sh` the
   `gemini/` and `agents/` mirrors, their purge and the agy plugin step; in `registry.json`
   the `gemini` block; in `ai-watch` and `advisor-mcp` the `agy` fallbacks (→ `claude`);
   `providers.json` template → `claude` only; `provider-adapter.mjs` `DEFAULT_ADAPTERS` →
   `claude` only. Memory Palace agents drop the "Gemini Embedding 2" wording: the index is
   the text/hash index that is actually implemented (`memory-batch-scanner.mjs`); the
   embedding provider is **unconfigured** and multimodal retrieval is deferred, said plainly.
2. **Legacy workspace pruning on `ai sync` (E-254)** — a project upgraded to v4 still has
   `.gemini/`, `.agents/`, `GEMINI.md`, `AGENTS.md`. `ai sync` removes them ONLY when they are
   sync-manifest-owned and unmodified (E-220 manifest-scoped pruning already knows this);
   otherwise it prints one line per leftover with the `rm` the operator can run. Never
   deletes a file it did not generate.
3. **Claude-native Tester (E-255)** — a new `tester` entry in `roles.json`
   (`{"provider":"claude","model":"sonnet","headless":true}`); `ai start`/`ai pane` ignore
   headless roles; the label `Tester (claude · sonnet)` is DERIVED wherever `Tester
   (TestSprite)` was hard-coded (init banner, `OWNER_PATTERNS`, `managed-agents-client.mjs`,
   `state.json` schema text, `tool-schemas.mjs`). New agent `src/claude/agents/
   test_engineer.md` with frontmatter `model: sonnet`: reads the task + diff, writes a test
   plan, adds tests in the project's OWN harness (here `tests/suites/*.sh` + `tests/unit`),
   runs them, and stamps `[TESTS_PASS]`/`[TESTS_FAIL]` via `add_stamp`. `ai-test` is rewritten:
   default = run the project's real test command (`package.json` `test`, else detect
   `tests/run.sh`, `pytest`, `go test`); `--generate` dispatches `test_engineer`; `--vibe`
   unchanged (ux_reviewer + chaos_monkey, now Claude agents); `--fast` runs the Tester on
   `haiku`. TestSprite leaves `registry.json`, `.mcp.json` templates, the API-key preservation
   code, `mcp-domains.mjs` Quality domain, the doctor check and the settings allow-lists.
   **Model ruling**: Sonnet 5 (`sonnet`) is the Tester default — enough reasoning to write
   tests against a real harness at a fraction of Opus cost; Haiku 4.5 is the `--fast` smoke
   tier. Model aliases, never dated ids, so upgrades are config.
4. **Docs and surfaces (E-256)** — README (Triad table, prerequisites, tmux recipes → `ai
   start` with D-068 per-project sessions, MCP count "16 custom + 2 third-party" (was 22
   before the D-075 retirements; `ast-parser-mcp` runs as a CLI and is not counted), Native
   Subagents = `.claude/agents/` with no plugin, command reference without `ai provider`,
   Upgrading section), CONTRIBUTING (directory map, skill frontmatter section), `ai --help`,
   `ai init` banner, `src/templates/*` (architect.md.template, BRIEF, RULES, CAPABILITIES),
   `src/contracts/*.md`, rulefiles (`ARCHITECT.md`/`ENGINEER.md` lose the Provider notes, the
   Gemini Model Mandate and the agy branches of §36; §36 becomes "Skill tool for skills,
   Agent tool for agents"), `hooks/pre-commit.sh`. Acceptance is a repo-wide grep:
   `grep -riE 'gemini|\bagy\b|antigravity|testsprite' src tests hooks README.md CONTRIBUTING.md
   ARCHITECT.md ENGINEER.md CLAUDE.md install-rein.sh` returns ONLY the files named in
   `tests/fixtures/legacy-mention-allowlist.json` (**D-076**, amending the original "nothing"
   which predates D-074). Each entry is `{path, kind: removal|absence-test, hits, reason}`;
   a test runs the grep over the same roots (`corpus_or_fail`) and asserts the hit set and
   the per-file counts EQUAL the list, both directions. User-facing text (help, banners,
   README, CONTRIBUTING, rulefiles, templates, contracts) may never be listed. No split
   literals to dodge the grep — name the file instead.
5. **Release v4.0.0 (E-263, last)** — `release-manager`: CHANGELOG "Claude-Native" section
   with a BREAKING list (removed providers, removed TestSprite, removed `ai provider`,
   removed shims, roles.json `tester`), version bump, tag. Its repo-wide grep permits
   CHANGELOG history, project memory (`.ai/**`, `plans/**`) and the D-076 allowlist, nothing
   else. The Architect archives the five
   blueprints named in the header to `.ai/archive/2026-09/blueprints/` after E-254 deletes
   the tests that reference them, and amends `architect.md` §2/§4/§7 (done 2026-09-11).

## Data Model
```
.ai/roles.json (template, v4)
{ "roles": {
    "architect": { "provider": "claude", "pane_identifier": "1", "model": "fable" },
    "engineer":  { "provider": "claude", "pane_identifier": "0", "model": "opus"  },
    "tester":    { "provider": "claude", "model": "sonnet", "headless": true }   # no pane
} }
.ai/providers.json (template, v4): { "providers": { "claude": { ...unchanged... } } }
registry.json: `gemini` block removed; `mcp_servers.TestSprite` removed.
```
Owner labels: `Architect (claude · fable)`, `Engineer (claude · opus)`, `Tester (claude · sonnet)`
— all three derived from `roles.json` (D-066 lineage); `state.json` schema keeps `owner` free
text so archived rows with `Tester (TestSprite)` remain valid.

## API / Interface Contracts
- `ai start` / `ai pane`: roles with `"headless": true` are neither laid out nor bindable
  (`ai pane tester` → exit 2 "tester is headless; run skill: ai-test").
- `skill: ai-test [--generate] [--vibe] [--fast]`: exit non-zero and `[LOCKED]` on failure as
  today; `--generate` writes tests only under `tests/`; stamps via `add_stamp` never by
  editing `REVIEWS.md`.
- `ai sync`: prints `pruned legacy workspace: <path>` per manifest-owned leftover, or
  `legacy leftover (not generated by sync): <path> — remove with: rm -r <path>`.
- `ai provider *`: removed; exit 2 with "providers are configured in .ai/providers.json".
- `advisor-mcp`: unchanged contract; default provider `claude`.

## Security
- Deleting the Gemini strip and the agy plugin removes two transformations of persona files;
  `.claude/agents/*.md` are now byte-identical to `src/claude/agents/*.md` (mirror test).
- Headless Tester runs as a subagent of the Engineer session and inherits the Engineer's
  permission overlay; it cannot widen its own tools (`allowed-tools` in frontmatter is the
  ceiling). It writes under `tests/` only. No role token is minted for `tester` in v4 — it
  has no pane and acts as the Engineer's delegate.
- `ai sync` legacy pruning deletes ONLY manifest-owned, unmodified files (E-220). Everything
  else is a printed suggestion.
- No API key handling remains for TestSprite; the `${TESTSPRITE_API_KEY}` pass-through in
  `mcp-tester.mjs` becomes a generic `${*_API_KEY}` example.

## Execution Constraints
- One wave at a time, in order E-254 → E-255 → E-256 → (D-070 insights fixes) → E-263. Each
  wave is a PR; full suite + CI green before the next starts. Every wave touches `src/bin`
  and `src/mcp`: finish with `bash install-rein.sh` + server restart (D-067 §3 gate, as
  ratified in D-071 §1 — the gate reads mirror drift and live boot records, not LOG lines).
- E-254 is the largest deletion in the project's history: ~60 test files change. The Engineer
  works file-by-file with `corpus_or_fail` (E-251) protecting every rule-scanning suite whose
  roots move; a suite whose only purpose was agy/gemini is deleted, not emptied.
- The mirror-identity tests (~25) are re-pointed, not removed.

## Rollback Plan
Tag `v3.1.0` is the rollback: check out that tag and run `bash install-rein.sh`. Within v4
there are NO feature flags for the removed providers — a flag would keep the dead code alive,
which is the thing being removed. `ai sync` legacy pruning is the one guarded step:
`REIN_KEEP_LEGACY_WORKSPACES=1` prints instead of deleting.

## E-## Task Breakdown
- **E-254** (Tier 2): provider removal + legacy pruning (Components 1–2).
- **E-255** (Tier 2): Claude-native Tester (Component 3).
- **E-256** (Tier 2): docs and surfaces, repo-wide grep acceptance (Component 4).
- **E-263** (Tier 2): release v4.0.0 (Component 5) — LAST, after the D-070 insights fixes
  (E-257..E-262) and D-071's E-264.
