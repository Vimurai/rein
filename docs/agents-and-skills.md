# Agents and skills

Both are plain Claude Code files, copied into the project's `.claude/` by `ai sync` — there is no
plugin to install.

- A **skill** is a procedure the current session carries out itself (`skill: ai-task`). Only its
  one-line description is in context until it is invoked.
- A **subagent** is a specialist that runs in its own context and reports back, so its file reads
  never land in your session.

## Subagents

| Group | Agent | Does |
| :--- | :--- | :--- |
| Critics | `critic_arch` | Compares the diff with the blueprint; stamps `ARCH_PASS`/`ARCH_FAIL`. |
| | `critic_security` | Audits the diff for OWASP-class issues and secrets; stamps `SEC_PASS`/`SEC_FAIL`. |
| | `critic_tests` | Checks each changed behaviour has one test at the cheapest layer; stamps `TESTS_PASS`/`TESTS_FAIL`. |
| | `critic_clean_code` | Applies the engineering standards to the staged diff; stamps `CLEAN_PASS`/`CLEAN_FAIL`. |
| Testing | `test_engineer` | The headless Tester: writes and runs tests under `tests/` in the project's own harness. |
| | `chaos_monkey` | Invalid inputs, latency and stress against the UI before a release. |
| | `ux_reviewer` | Playwright and Lighthouse visual audit: animation, contrast, layout shift, accessibility. |
| | `vibe_sentinel` | Visual audit of UI changes; escalates to `chaos_monkey` for risky releases. |
| Engineering | `security_engineer` | Threat model and active probing for auth, secrets and capability changes. |
| | `db_architect` | SQLite schema migrations, WAL, locking and rollback paths. |
| | `dependency_manager` | Package upgrades and breaking-change fixes, with a security review. |
| | `devops_engineer` | CI/CD pipelines, deployment config, test infrastructure. |
| | `performance_engineer` | Node.js CPU and heap profiling; an optimisation report. |
| Knowledge | `docs-architect` | Audits public docs against the blueprint and the server list for drift. |
| | `knowledge_architect` | Retrieval across projects over the local memory index. |
| | `memory_curator` | Builds and maintains the cross-project memory index. |
| | `meta_analyst` | Reads local telemetry and proposes improvements and new skills (staged, never auto-activated). |
| Operations | `sre_responder` | Read-only triage of recorded incidents; drafts post-mortems. |
| SEO | `seo_manager` | Expands a topic into one pillar page and distinct-intent cluster pages. |
| | `seo_content_generator` | Writes one article for one cluster intent. |
| | `seo_engineer` | Meta tags, structured data, canonical URLs and internal linking. |

## Skills

### Every session

| Skill | Does |
| :--- | :--- |
| `ai-preflight` | Session start: digest, open tasks, state sync, incidents, stale-server check. |
| `ai-task` | Close a task: mark done (CI must be green), hand over, surface the next. |
| `ai-handoff` | Write the COMM.md entry, commit it, wake the other pane. |
| `arch-task` | The Architect's close-out for planning tasks. |
| `ai-sync-state` | Re-read `.ai/` from disk when another session changed it. |
| `ai-log` | Append a structured entry to `.ai/LOG.md`. |

### Building and testing

| Skill | Does |
| :--- | :--- |
| `ai-test` | Run the project's tests; `--generate` dispatches the Tester, `--vibe` the UI audit. |
| `ai-review` | Tier-aware review with the matching critics. |
| `ai-debug` | Hypothesis → test → observe; commits locked until green; escalates after three cycles. |
| `bug-reproducer` | A failing reproduction before any fix. |
| `aqg-resolver` | Low-context fixer for a failed quality gate. |
| `repo-oracle`, `arch-oracle` | History and rationale from git and `.ai/` before an edit. |
| `trigger-audit` | Which mandatory gates a planned change will trip. |
| `commit-crafter` | Conventional commit message with task id and tier. |
| `ai-profile` | CPU and heap profiling in a throwaway directory. |
| `ai-migration` | Schema changes to the state or telemetry databases. |

### Gates

| Skill | Does |
| :--- | :--- |
| `dependency_gate` | Before a new dependency: justification, alternatives, security record, licence. |
| `ci_gate` | Before a CI/CD change: the change, its security impact, the rollback. |
| `scope_safety` | Filesystem and shell scope on every operation. |
| `identity_guardian` | Personal data and secrets hygiene audit. |
| `architectural-aligner` | Code against the blueprint before a Tier 2/3 commit. |

### Planning (Architect)

| Skill | Does |
| :--- | :--- |
| `blueprint-writer` | A blueprint must have its required sections before it is written. |
| `task-planner` | A task must have a tier, a verb, acceptance criteria and no circular dependency. |
| `decision-recorder` | A decision as a D-### entry: context, choice, alternatives. |
| `arch-review` | Codebase audit against the blueprint. |
| `review_synthesizer` | All critic stamps → a release-readiness verdict. |

### Housekeeping

| Skill | Does |
| :--- | :--- |
| `ai-digest`, `digest_updater` | Regenerate `.ai/DIGEST.md`. |
| `ai-archive` | Rotate long logs (only when you ask). |
| `token-miser` | Trim context before a long session. |
| `release-manager` | Version bump, changelog, signed tag. |
| `ai-upgrade` | Dependency upgrades with test runs. |
| `ai-incident`, `ai-triage` | Record unexpected events; triage recurring ones. |
| `ai-insights`, `ai-review-proposed-skills` | Telemetry insights; review proposed skills before activation. |

### Product and content

| Skill | Does |
| :--- | :--- |
| `obs_baseline` | Logging, metrics, tracing and health-check standards. |
| `ux_template` | A UI screen's purpose, states, accessibility and mobile behaviour. |
| `ai-seo`, `seo_content_checklist` | Answer-engine optimisation; the pre-publish SEO checklist. |
| `copilot` | Shell and `gh` command lookups through GitHub Copilot CLI. |

## Writing your own

Agents go in `src/claude/agents/<name>.md`, skills in `src/claude/skills/<name>/SKILL.md` (or
`src/shared/skills/` for both roles). The frontmatter's `allowed-tools`/`tools` may name only
tools that exist — the pre-commit gate refuses ghost tools. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
