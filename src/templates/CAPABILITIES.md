# CAPABILITIES (Declarative Capability Schema)
# Source of truth for ai-exec and .mcp.json enforcement.
# Edit this file to define what AI agents are allowed to do in THIS project.

## filesystem.read
# Allowed path patterns for READ operations (no approval required).
- src/**
- .ai/**
- docs/**
- tests/**
- *.md
- *.json
- *.ts
- *.js
- *.sh
- ~/.rein/config/**
- ~/.rein/memory/**

## filesystem.write
# Allowed path patterns for WRITE operations (requires --allow-write in ai-exec).
- src/**
- .ai/**
- tests/**
- ~/.rein/memory/**

## shell.exec
# Allowed commands/patterns for EXECUTE operations (requires [SEC_CLEARED] + --allow-execute).
# gh — READ verbs only (E-279, T-GH-001); write verbs stay on the permission prompt
- gh pr view / list / status / checks / diff
- gh issue view / list
- gh auth status (exactly — no flags; never --show-token)
# gh --jq/-q and --template/-t read the environment: always on the permission prompt
- npm test
- npm run build
- npm run lint
- git commit
- git add
- git status
- git diff
# E-331 (D-102 §4), team projects only (.ai/team.json): task claims, run by task-claims.mjs —
# never typed by the agent. `git fetch origin <trunk>`, plumbing on a private index
# (hash-object, read-tree, update-index, write-tree, commit-tree) and a fast-forward-only
# `git push origin <sha>:refs/heads/<trunk>` of ONE commit touching .ai/tasks/<id>.json.
# <trunk> is `ai trunk` (E-341, D-105): team.json "trunk", else origin/HEAD, else main|master.
# claim, release and DONE each push one such commit; the pre-push CI gate still runs.
- git fetch origin <trunk> (claims)
- git push origin <sha>:refs/heads/<trunk> (claim/release/done bookkeeping commit)

## network.outbound
# Allowed external domains for network operations.
- npmjs.org
- github.com
- registry.npmjs.org

## notes
# Project-specific capability notes.
# Add context here for the security_engineer to evaluate SEC_CLEARED requests.
- WRITE to .ai/ is low-risk (documentation only)
- EXECUTE of npm test/build is pre-approved (no side effects on external systems)
- Any operation touching auth, secrets, or external APIs requires explicit [SEC_CLEARED]
- WRITE to ~/.rein/memory/ is low-risk (architectural signatures only, no secrets per §31 sanitize())
- READ of ~/.rein/config/registry.json is pre-approved for compliance tools (verification-mcp, §32)
