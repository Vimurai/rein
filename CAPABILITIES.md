# CAPABILITIES (Declarative Capability Schema)
# What AI agents may read, write and run in THIS repository; the security_engineer reads it.
# A project's copy lives at .ai/CAPABILITIES.md (rein-exec reads that one; the template is
# src/templates/CAPABILITIES.md). The role boundary itself is the Claude Code sandbox in the
# role settings files (docs/role-sandbox.md), not this file.

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
- ~/.rein/*.sqlite

## filesystem.write
# Allowed path patterns for WRITE operations (requires --allow-write in rein-exec).
- src/**
- .ai/**
- tests/**
- ~/.rein/*.sqlite

## shell.exec
# Allowed commands/patterns for EXECUTE operations (requires [SEC_CLEARED] + --allow-execute).
- npm test
- npm run build
- npm run lint
- git commit
- git add
- git status
- git diff
- npx tsc --noEmit
- delta
- diff -u
- patch
- gh issue list
- gh issue view
- gh pr view
- gh auth status

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
- READ of ~/.rein/config/registry.json is pre-approved for `rein doctor --compliance` (§32)
- READ/WRITE of ~/.rein/*.sqlite is pre-approved (the task-synchronizer-mcp and telemetry stores)
