---
name: ai-upgrade
description: Triggered periodically or on `npm audit` failures to bump packages and run test suites. Calls dependency_manager for complex migrations. Produces upgrade branches and test reports. Routes all dependency changes through critic_security before merge.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash, Grep, Glob, mcp__task-synchronizer-mcp__add_task
context: default
agent: default
---

# AI-Upgrade — Dependency Upgrade Automation

## Dynamic Context Injection

Package status: !npm outdated 2>/dev/null || echo "(npm outdated unavailable)"
Recent vulnerabilities: !npm audit --json 2>/dev/null | jq '.metadata.vulnerabilities.total' || echo "0"

> **Consent rule (D-060 §3, E-232).** This block must never auto-run a program the
> visited project supplies. A `!`-line executes the moment the skill LOADS — before the
> agent has decided anything and before the operator has been asked — so a project's own
> `tests/run.sh` or `package.json` script would execute merely because someone opened a
> skill. Read-only inspection stays here; anything that runs project code is a numbered
> step the agent performs deliberately, below.

## Step 0 — Establish the test baseline (do this FIRST, after loading)

`npm run test` executes whatever `package.json` defines, which is project-supplied code,
so it is not auto-run on load. Run it yourself before touching any dependency:

1. `npm run test 2>&1 | tail -1` — record the result as the pre-upgrade baseline.
2. If the suite is already red, STOP: an upgrade cannot be evaluated against a red
   baseline, because you could not tell a new break from an existing one.

(`npm outdated` and `npm audit` above stay auto-executed on purpose: they QUERY the
manifest and the registry and run none of the project's own code.)

## When to Invoke

- On a recurring schedule (e.g., weekly via `skill: schedule`)
- When `npm audit` reports new vulnerabilities
- When an engineer explicitly requests a package upgrade with `E-## → ai-upgrade { package: "react", target_version: "19.0.0" }`
- After merging a major feature branch to detect newly-required transitive dependency updates

---

## Step 1 — Assess Current Dependency Health

Read and execute:

1. Read `package.json` — note all direct dependencies
2. Run `npm outdated --json` — identify outdated packages
3. Run `npm audit --json` — identify vulnerabilities
4. Run `npm ci` to ensure lock file is in sync

Parse the outputs:
- **Outdated packages**: list all with current→available versions
- **Vulnerabilities**: categorize by severity (critical, high, medium, low)
- **Breaking changes**: check CHANGELOG for each major-version upgrade

---

## Step 2 — Filter Upgrade Candidates

Create a prioritized list:

**Priority 1** (BLOCKING — do first):
- Any package with a **critical** or **high** CVE
- Production-facing packages (not just dev/test)

**Priority 2** (RECOMMENDED):
- Major-version upgrades of actively-maintained packages
- Minor/patch updates that are backwards-compatible

**Priority 3** (OPTIONAL):
- Old/unmaintained packages with no CVE
- Dev-only dependencies if no breaking changes

DO NOT upgrade unmaintained packages unless they block a security fix.

---

## Step 3 — Dispatch to dependency_manager (Complex Upgrades Only)

For each **Priority 1** or **Breaking Change** upgrade:

Check the upgrade complexity:

| Condition | Action |
| :--- | :--- |
| **Major version bump** (e.g., v17→v19) | Dispatch `dependency_manager` |
| **10+ files import the package** | Dispatch `dependency_manager` |
| **Known breaking API changes** (check CHANGELOG) | Dispatch `dependency_manager` |
| **New peer dependencies introduced** | Dispatch `dependency_manager` |
| **Backwards-compatible patch/minor** | Handle inline (Step 4) |

**To dispatch:**

```
Agent({
  subagent_type: "dependency_manager",
  prompt: {   // state these fields in the prompt text
    package: "<package-name>",
    target_version: "<version>",
    current_version: "<current>",
    priority: "P1" (or "CRITICAL")
  }
})
```

Wait for agent to complete and report. If agent returns status: "FAILED", create a P-## task and halt.

---

## Step 4 — Handle Simple Upgrades Inline

For **backwards-compatible** patches/minor updates (no breaking changes):

1. Create branch: `git checkout -b upgrade/<package>-<version>`
2. Bump: `npm install <package>@<version>`
3. Run security gate before committing:
```
Agent({
  subagent_type: "critic_security",
  prompt: {   // state these fields in the prompt text
    scope: "simple_upgrade",
    package: "<package>",
    version: "<version>",
    description: "Quick audit of backwards-compatible patch/minor upgrade"
  }
})
```
4. Wait for critic_security clearance. If PASS, continue:
   ```bash
   git add package-lock.json
   git commit -m "chore: bump <package> to <version>"
   ```
5. Run tests:
   ```bash
   npm run test
   npm run lint
   ```
6. If tests pass → push branch: `git push origin upgrade/<package>-<version>`
7. Report completion in task summary

---

## Step 5 — Post-Upgrade Validation

After each upgrade (whether handled inline or by agent):

1. Verify lock file is committed: `git status | grep package-lock.json`
2. Verify no merge conflicts: `git status`
3. Verify tests pass: `npm run test -- --watch=false`
4. Verify no new audit findings: `npm audit --json | jq '.metadata.vulnerabilities'`

If any check fails → abort and escalate to dependency_manager or create P-##.

---

## Step 6 — Generate Upgrade Report

Produce a summary entry in `.ai/LOG.md`:

```
YYYY-MM-DD | ai-upgrade | Execute | Processed <N> outdated packages
  - CRITICAL: <package> (v1→v2) — dispatched to dependency_manager
  - HIGH: <package> (v1.0→v1.1) — inline upgrade, tests PASS, critic_security PASS
  - Status: <N> upgrades completed, <M> pending review
```

---

## Step 7 — Create Task for Lead Engineer Review

If **any** branch was created:

```
mcp__task-synchronizer-mcp__add_task({
  owner: "Engineer (Claude)",
  prefix: "P",
  tier: 2,
  description: "Review dependency upgrades: verify all upgrade branches (<list branches>). Check for regressions, peer-dependency conflicts, lock file integrity, and critic_security clearance.",
  depends_on: []
})
```

---

## Special Cases

### Out-of-Sync Lock File

If `npm ci` fails with lock file errors:

```bash
rm package-lock.json
npm install
git add package-lock.json
git commit -m "chore: regenerate lock file"
```

Then resume Step 2.

### Transitive Dependency Blocker

If a transitive dependency cannot be upgraded (e.g., conflicts with another package's peer):

1. Document the conflict: "Package X requires Y@^1.0, but Z requires Y@^2.0"
2. Create a P-## task: "Resolve transitive dep conflict: <details>"
3. Halt the upgrade for that package

### All Dependencies Current

If `npm outdated` returns empty:

Report:
```
[UPGRADE_AUDIT] YYYY-MM-DD
Status: All dependencies current
Vulnerabilities: <0 or list any remaining unpatched>
Next check: Scheduled for <+7 days>
```

---

## Rules

- **Never** force-upgrade unmaintained packages without human review (create P-##)
- **Never** skip tests — a passing test suite is the gate before pushing
- **Never** commit `.env` or secrets files (use `.gitignore`)
- **Never** commit dependency changes without critic_security clearance (mandatory gate)
- **Always** dispatch `dependency_manager` for major-version upgrades
- **Always** validate lock file integrity after upgrades
- **Always** route dependency commits through commit-crafter (project git identity)
- **Append** upgrade summary to `.ai/LOG.md` after completion