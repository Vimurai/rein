---
name: trigger-audit
description: Use this skill immediately after the PLAN phase and before the first WRITE operation on any E-## task. Scans staged git diff and task description for keywords that mandate agent/skill dispatches (auth, secrets, new deps, CI, endpoints). Returns a Mandatory Trigger Report checklist. Also invoke mid-task if the implementation deviates from the original plan.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Bash
context: default
agent: default
---

# Trigger Audit — Mid-Execution Enforcement (§21)

## Why This Skill Exists

The Engineer's mid-execution trigger table (ENGINEER.md) is declarative — it lists conditions but
does not force compliance. This skill is the **enforcement layer**: it actively scans the
current diff and task context, identifies which mandatory agents/skills have been triggered,
and blocks progression until outstanding dispatches are resolved.

Invoke at three checkpoints (§21 Checkpoint Protocol):
- **Pre-Flight**: after PLAN, before first WRITE
- **Mid-Flight**: if implementation deviates from plan or introduces new deps/endpoints
- **Post-Flight**: before marking E-## task as DONE in TASKS.md

---

## Step 1 — Gather Context

Run these reads. Do NOT skip any.

1. Read `.ai/TASKS.md` — identify the current E-## task being implemented and its Tier
2. Read `.ai/architect.md` — first 60 lines for system philosophy and security rules
3. Run `git diff HEAD` (or `git diff --staged`) — get the current diff
4. Read `.ai/LOG.md` — last 40 lines to see which agents have already been dispatched this session

---

## Step 2 — Keyword Scan

Scan the **task description** and **git diff** for the following trigger keywords.
For each keyword found, record the corresponding mandatory dispatch:

| Keyword detected in diff/task | Mandatory dispatch |
| :--- | :--- |
| `auth`, `token`, `jwt`, `session`, `credential`, `password`, `oauth`, `login` | `security_engineer` (MANDATORY — Tier 3) |
| `.env`, `secret`, `api.key`, `private.key`, `API_KEY`, `SECRET` | `security_engineer` + `identity_guardian` (MANDATORY) |
| `npm install`, `pip install`, `go get`, new entry in `package.json` dependencies | `dependency_gate` (MANDATORY) |
| `.github/`, `Dockerfile`, `docker-compose`, `workflow`, `CI`, `.yml` in CI path | `ci_gate` (MANDATORY) |
| new `app.get`, `app.post`, `router.`, `@app.route`, `func.*Handler`, new API endpoint | `obs_baseline` (MANDATORY) |
| task marked Tier: 3 in TASKS.md | `security_engineer` + `ai-review` (MANDATORY) |
| architectural decision keyword: `chose`, `decided`, `using X instead of Y`, `rationale` | `decision-recorder` (ADVISORY) |
| E-## task completed | `ai-task` + `digest_updater` (MANDATORY on completion) |

---

## Step 3 — Cross-Reference LOG.md

For each **MANDATORY** dispatch identified in Step 2, check `.ai/LOG.md` (last 40 lines)
for evidence of dispatch:

- `security_engineer` → look for `[SECURITY]`, `security_engineer`, `THREAT_MODEL`
- `identity_guardian` → look for `identity_guardian`, `PII_AUDIT`
- `dependency_gate` → look for `dependency_gate`, `DECISIONS.md`
- `ci_gate` → look for `ci_gate`, `DEVOPS.md`
- `obs_baseline` → look for `obs_baseline`, `[OBS]`
- `decision-recorder` → look for `decision-recorder`, `DECISIONS.md`, `D-###`
- `ai-review` → look for `[CRITIC_STAMP]`, `[ARCH_PASS]`, `[SEC_PASS]`

Mark each dispatch as **DISPATCHED** or **OUTSTANDING**.

---

## Step 4 — Output Mandatory Trigger Report

```
[TRIGGER_AUDIT] YYYY-MM-DD HH:MM
Task: E-## — <task title>
Tier: <1 / 2 / 3>
Phase: <Pre-Flight / Mid-Flight / Post-Flight>

MANDATORY DISPATCHES:
  ✓ DISPATCHED  — <agent/skill name> (evidence: <LOG.md reference>)
  ✗ OUTSTANDING — <agent/skill name> (reason: <keyword that triggered this>)

ADVISORY DISPATCHES:
  ✓ DISPATCHED  — <agent/skill name>
  — NOT NEEDED  — <agent/skill name>

VERDICT: CLEAR | BLOCKED
```

- **CLEAR**: all mandatory dispatches are DISPATCHED → proceed to next phase
- **BLOCKED**: one or more mandatory dispatches are OUTSTANDING → DO NOT proceed

---

## Step 5 — If BLOCKED

Do NOT continue implementation. For each OUTSTANDING dispatch:

1. Invoke the required agent/skill immediately:
   - Use the Agent tool for agents
   - Use the Skill tool for skills
2. After dispatch completes, re-run this skill (Step 1–4) to confirm CLEAR
3. Only proceed with implementation once verdict is CLEAR

---

## Post-Flight Special Rules (before marking DONE)

Before writing `Status: DONE` to TASKS.md, verify:

1. If Tier 3 task → `[SEC_PASS]` or `[SECURITY]` entry must exist in LOG.md or REVIEWS.md
2. If any new files were created in `src/` → LOG.md must have been updated this session
3. If architectural decision was made → `decision-recorder` must have been dispatched

If any check fails → output `[TRIGGER_AUDIT] POST_FLIGHT_BLOCKED` and dispatch missing agents before marking DONE.

---

## Rules

- This skill is **read-only** — it does not modify files.
- Do NOT skip Step 3 (LOG.md cross-reference) — a dispatch is only DISPATCHED if evidence exists in LOG.md, not just in your context window.
- After outputting CLEAR verdict, resume the original task immediately.
- Append the `[TRIGGER_AUDIT]` report line to `.ai/LOG.md` after each invocation.
