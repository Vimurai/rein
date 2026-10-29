# Domain Blueprint: Agents & Skills

> [!IMPORTANT]
> This document maps all AI-OS Agents and Skills according to §34 Architectural Fragmentation.

The AI-OS ecosystem divides cognitive labor across specialized agents and dynamic skills to maintain strict context limits and Token Economics.

## 1. Shared (Cross-Agent) Skills
- **`ai-preflight`**: Executes the DIGEST-first read order and stamps `SESSION.md` at session start.
- **`ai-digest`**: Generates a concise project snapshot when the cache is stale.
- **`ai-archive`**: Destructively rotates bloated logs (only when explicitly requested).
- **`ai-sync-state`**: Forces a strict re-read of state files when handing off between Gemini and Claude.
- **`ai-test`**: Triggers TestSprite or Vibe & Chaos audit.
- **`release-manager`**: Handles the sprint release lifecycle (version bump, changelog, tags).
- **`token-miser`**: Optimizes token usage when context grows large using progressive disclosure.
- **`trigger-audit`**: Scans diffs and descriptions for mandatory trigger keywords (auth, secrets).

## 2. Principal Architect (Agy)

> **YAML Schema Note:** Gemini agents and skills do not support or require Claude-specific frontmatter fields such as `disable-model-invocation`, `user-invocable`, and `allowed-tools`. The system's compliance audit tool conditionally ignores these fields for the Gemini domain.

### Agents
- **`docs-architect`**: Audits public docs against `architect.md` to detect drift.
- **`knowledge_architect`**: Cross-project RAG and Memory Palace management.
- **`memory_curator`**: Builds the Memory Palace index from local digests.
- **`ux_reviewer`**: Automated visual audit of the UI (Playwright/Lighthouse).
- **`digest_updater`**: Updates `DIGEST.md` cache after Gemini-domain changes.

> Retired (E-146): `gemini_tasks` → use `skill: ai-task` (unified, provider-agnostic task lifecycle).

### Skills
- **`arch-review`**: Audits the codebase against `architect.md` for orphaned work and deviations (renamed from `ai-review` in E-147 to stop shadowing the Engineer's `ai-review`).
- **`architectural-aligner`**: Validates blueprint compliance before Tier 2/3 commits.
- **`repo-oracle`**: Git archaeology for historical awareness and past decisions.
- **`ux_template`**: Generates structured UX documentation for views.
- **`seo_content_checklist`**: Audits SEO and content compliance.
- **`ai-seo`**: Audits content for AI Engine Optimization (AEO).

## 3. Lead Engineer (Claude)
### Agents
- **`aqg-resolver`**: Low-context autonomous fixer for failed tests.
- **`digest_updater`**: Regenerates `DIGEST.md` using JIT reads.
- **`devops_engineer`**: Establishes CI/CD pipelines and observability.
- **`critic_tests`**: Deterministic test coverage verifier.
- **`vibe_sentinel`**: Triggers automated visual UI audits for Tier 2/3 changes.
- **`chaos_monkey`**: Stress-tests UI interactions to find edge cases.
- **`critic_security`**: Deterministic security auditor (OWASP/secrets).
- **`task_validator`**: Validates P-## dependency chains to prevent circular loops.
- **`security_engineer`**: Produces `SECURITY.md`, enforces capability boundaries, and (E-44) runs active OWASP Top 10 pen-test payloads inside `code-execution-mcp` for any new input boundary.
- **`critic_arch`**: Architecture reviewer comparing git diff against `architect.md`.

> Retired (E-146): `claude_tasks` → use `skill: ai-task` (unified task lifecycle).
> Relocated to Skills (E-141/E-148): `identity_guardian`, `review_synthesizer`,
> `decision_recorder` (→ `decision-recorder` skill). See the Skills list below.

### Skills
- **`ai-compact`**: Distills conversation history into "Active Context" to save tokens.
- **`identity_guardian`**: Audits handling of PII, secrets, and user data (E-148 — was listed as an agent).
- **`review_synthesizer`**: Aggregates Tier-3 audit stamps into a Release Readiness Report (E-148 — was listed as an agent).
- **`decision-recorder`**: Captures architectural decisions into `DECISIONS.md` as D-### entries (E-141 — was the `decision_recorder` agent).
- **`ai-review`**: Runs a tier-aware critic review before committing.
- **`bug-reproducer`**: Enforces empirical validation with isolated repro scripts.
- **`ci_gate`**: Gate required before changing CI/CD pipelines.
- **`obs_baseline`**: Applies observability standards.
- **`commit-crafter`**: Automates AI-OS Conventional Commits.
- **`scope_safety`**: Enforces filesystem and shell scope boundaries.
- **`dependency_gate`**: Gate required before adding major dependencies.
- **`copilot`**: Delegates CLI tasks to GitHub Copilot CLI.