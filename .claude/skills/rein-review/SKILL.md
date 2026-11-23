---
name: rein-review
description: Review a task by its tier (E-464, D-169 r8). Runs `rein review <tier>` (the deterministic checks) and dispatches the agents it prints — Tier 1 none; Tier 2 reviewer then critic_acceptance; Tier 3 those plus one security_engineer round. A Tier 2/3 task is refused DONE without its stamps; commits are not gated on review.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash
context: fork
agent: default
---

# Rein Review (by tier)

Source: `.ai/blueprints/lean-core.md` §Component 5, D-169 r8, D-170 r9.

| Tier | What it is | Review | Needed at DONE |
|---|---|---|---|
| 1 | no behaviour change (docs, text, renames) | none | nothing |
| 2 | everything else | `reviewer`, then `critic_acceptance` | `[REVIEW_PASS]`, `[ACCEPT_PASS]` |
| 3 | the role boundary, the install, hooks, secrets, release signing | Tier 2 plus one `security_engineer` round | those and `[SEC_CLEARED]` |

## Steps
1. Run the deterministic checks and read the dispatch list:
   ```bash
   rein review <tier>
   ```
   A P0 line means fix first; nothing is dispatched on a P0.
2. Dispatch the agents it prints, in order, each with the task id:
   ```
   Agent("Run the reviewer agent on E-###: review the diff against the task and its blueprint; stamp REVIEW_PASS or REVIEW_FAIL")
   Agent("Run the critic_acceptance agent on E-###: observe each Acceptance clause and stamp ACCEPT_PASS or ACCEPT_FAIL")
   Agent("Run the security_engineer agent on E-### (Tier 3): one round; stamp SEC_CLEARED or SEC_BLOCKED")
   ```
3. Every stamp binds to HEAD (E-329). A source commit after a stamp needs that stamp again; a
   commit that touches only `.ai/` does not.
4. Close the task with `rein-task`. The DONE gate (`src/shared/completion-gates.mjs`) refuses a
   Tier 2/3 task whose stamps are missing for HEAD: `[REVIEW_GATE]`, `[ACCEPT_GATE]`, `[SEC_GATE]`.

A second security round needs the Architect (D-164 r6). A `[REVIEW_FAIL]` is fixed on the branch
and the reviewer runs again.
