# rein-plugins — plan handed to its Architect (from `rein`, 2026-11-08)

Read `plans/rein-ecosystem-contract.md` in the `rein` repo first; this plan assumes it.

## Purpose
A Claude Code plugin marketplace for everything Rein ships that is NOT part of the gate or the role machinery: specialist agents, skills, rules, optional hooks (formatters, notifiers), and project templates. Today these live in `rein/src/claude/{agents,skills,rules}` and `rein/src/shared/skills` and are provisioned by `rein sync`. Moving them to a marketplace lets them version and update independently of the gate, and lets the app enable them per profile with one setting.

## What stays in `rein` (never move these)
- The safe-exec gate and every hook `rein doctor` audits (pre-tool-use, post-tool-use, stop, session-start).
- The role machinery: `rein-preflight`, `rein-handoff`, `rein-task`, `arch-task`, `task-planner`, `decision-recorder`, `blueprint-writer`, the four critics, `rein-review`, `rein-test`, `commit-crafter`. These are what the Triad is; the gate's contract tables reference them.
- `roles.json`, `registry.json`, the MCP servers.

## What moves (in order; each move is one E-## in `rein` removing it and one in `rein-plugins` adding it)
1. Domain specialists with no gate coupling: `seo_manager`, `seo_engineer`, `seo_content_generator`, `rein-seo`, `seo_content_checklist`, `ux_template`, `ux_reviewer`, `vibe_sentinel`, `chaos_monkey`, `performance_engineer` + `rein-profile`, `obs_baseline`, `devops_engineer`, `knowledge_architect`.
2. Optional workflow skills: `token-miser`, `rein-insights` + `meta_analyst`, `rein-triage` + `sre_responder`, `release-manager`, `rein-upgrade` + `dependency_manager`, `rein-migration` + `db_architect`.
3. Project templates (`rein init` scaffolds) once the app can select a template at init.

Do NOT move `security_engineer`, `identity_guardian`, `scope_safety`, `trigger-audit`: they are gate-adjacent; a D-### in `rein` first.

## Marketplace structure
```
.claude-plugin/marketplace.json        # name "rein-plugins", owner, plugin list
plugins/<plugin>/.claude-plugin/plugin.json
plugins/<plugin>/{agents,skills,rules,hooks}/
```
One plugin per coherent bundle (e.g. `rein-seo`, `rein-ux`, `rein-ops`, `rein-data`), not one per file. Each plugin passes `claude plugin eval`; the repo's CI runs it for every plugin on every PR.

## Rules the plugins must keep
- Skill names keep the `arch-` / `rein-` prefix discipline (D-055 in `rein`): same-provider Triads share one `.claude/skills/`, so names must not collide with `rein`'s own.
- A plugin never writes the Rein home directory, never touches a profile's `hooks`, `autoMode`, `permissions`, `defaultMode`, never adds a PreToolUse hook on `Bash` (that is the gate's slot).
- Rein state is read through the MCP servers `rein` installs; never through `.ai/state.sqlite` directly.
- Privacy: the same publish scan `rein` runs on commit (`src/shared/publish-scan.mjs scan-tree`) runs here in CI; no operator name, login or path in a tracked file (D-117).

## Repo bootstrap for your Engineer (first E-## tasks)
- E-1: marketplace skeleton, one empty plugin, `claude plugin eval` in CI, publish-scan in CI.
- E-2: move group 1 (domain specialists) from `rein` — copy, eval, then `rein` removes them in its own E-## with the legacy-mention allowlist updated (D-076).
- E-3: `rein-app` registration test: the marketplace installs with one `extraKnownMarketplaces` entry and `enabledPlugins` map (ask the `rein-app` Architect for the exact shape).
- E-4: group 2.

## Open questions for the `rein` Architect (send back, do not decide locally)
1. Whether `rein sync` keeps provisioning moved skills during a transition window, or the move is a clean cut at a `rein` minor version.
2. Which of the four gate-adjacent agents, if any, may move.
