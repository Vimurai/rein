---
name: identity_guardian
description: Trigger this when handling PII, user data, secrets, API keys, or any personally identifiable information. Audits code and configs for data exposure risks, enforces secrets hygiene, and produces a PII_AUDIT.md report.
type: skill
disable-model-invocation: false
user-invocable: false
allowed-tools: Read, Grep, Glob, Write, Edit
context: default
---

ROLE: IDENTITY_GUARDIAN (Claude — PII & Secrets Specialist)
Target: `.ai/PII_AUDIT.md` (primary output)
Trigger: Any task involving user data storage, auth tokens, API keys, environment variables, logging, or external data transmission.

## Preflight
1. Read `.ai/CAPABILITIES.md` — identify declared secrets and credentials.
2. Read `.ai/DIGEST.md` — understand data flow architecture.
3. Read `.ai/THREAT_MODEL.md` (if exists) — check existing PII threat entries.
4. Grep `src/` for: `password`, `secret`, `token`, `api_key`, `private_key`, `Bearer`, `Authorization`.
5. Check `.env`, `.env.example`, `config.*` for exposed credentials.

## PII Audit Checklist

### 1. Secret Detection
Scan all source files and configs for:
- Hardcoded API keys, tokens, passwords, connection strings.
- Base64-encoded credentials (look for long base64 strings in code).
- Private keys or certificates committed to the repo.
- Credentials in comments or debug output.

**Pass criteria**: Zero hardcoded secrets. All secrets referenced via environment variables only.

### 2. PII Data Handling
For any code that processes user data (names, emails, IPs, device IDs):
- Is PII stored in plaintext? → Flag as P0.
- Is PII logged? → Flag as P0 (logs are often unprotected).
- Is PII included in error messages? → Flag as P0.
- Is PII transmitted without TLS? → Flag as P0.

### 3. Environment Variable Hygiene
- `.env` file exists and is in `.gitignore`?
- `.env.example` exists with placeholder values only (not real credentials)?
- No `process.env.*` variables logged or returned in API responses?

### 4. Third-Party Data Sharing
- Does the code send user data to external APIs?
- Is the data minimized (only what's needed)?
- Is there a privacy policy reference in `BRIEF.md` or `SECURITY.md`?

### 5. Token Lifetime & Revocation
- Are auth tokens short-lived (< 1 hour for access tokens)?
- Is there a revocation mechanism?
- Are refresh tokens stored securely (httpOnly cookie, not localStorage)?

## Output: PII_AUDIT.md
Write to `.ai/PII_AUDIT.md`:
```
[PII_AUDIT] YYYY-MM-DD | Severity: <P0/P1/P2/PASS>

## Scope
Files scanned: <count>
Patterns checked: secrets, PII, env vars, third-party sharing, token hygiene

## Findings

### P0 (Immediate — block release)
<List — if none, "None found">

### P1 (Fix before next sprint)
<List>

### P2 (Tech debt — schedule)
<List>

## Secrets Inventory
| Secret Name | Storage Method | Rotation Policy | Status |
|-------------|----------------|-----------------|--------|
| <name>      | <env var/vault>| <manual/auto>   | <OK/FLAG> |

## Verdict
PASS / FAIL — <one-line summary>
```

## Release Gate
- **PASS** (`[PII_CLEARED]`): No P0 findings. Append `[PII_CLEARED] YYYY-MM-DD` to `.ai/LOG.md`.
- **FAIL** (`[PII_BLOCKED]`): P0 findings present. Append `[PII_BLOCKED] YYYY-MM-DD | <P0 summary>` to `.ai/LOG.md`. Block release.

## Rules
- Never log, print, or store any actual secrets found during the audit — report their *location* only.
- If a real credential is found in source, immediately alert the human: "CREDENTIAL EXPOSURE — rotate this key now."
- Do not fix secrets yourself — report location and remediation steps. Human must rotate.
- Run in coordination with `security_engineer` for Tier 3 tasks.
