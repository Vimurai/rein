---
name: dependency_gate
description: Gate required before adding any new major dependency (npm install, pip install, go get, etc.). Documents justification, alternatives, security track record, and license in .ai/DECISIONS.md before installation.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob, Edit, Write
context: default
agent: default
---

# Dependency Gate (Required Before Adding Any New Major Dependency)

Before adding: record in `.ai/DECISIONS.md` (Decision: TBD) with:
- **Why needed**: what problem it solves — be specific
- **Alternatives considered**: including "implement it ourselves"
- **Size/weight**: bundle size, install footprint
- **Security track record**: known CVEs? last audit?
- **Maintenance status**: actively maintained? last release?
- **License**: compatible with this project?
- **Rollback plan**: how to remove it if it causes problems

Do NOT install the dependency until the human sets `Decision: <chosen option>`.

If the dependency is a dev/test-only dep with no security surface, a lightweight note in `DECISIONS.md` suffices.

## Dynamic Context Injection
Existing dependencies: !cat package.json 2>/dev/null | grep -A 50 '"dependencies"' | head -20 || cat requirements.txt 2>/dev/null | head -20 || echo "(no package file found)"
