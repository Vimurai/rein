---
name: ai-migration
description: Workflow triggered when an Engineer needs to alter the shape of any core database (state.sqlite, telemetry.sqlite). Guides migration design, validates against ORM contracts, and manages rollback paths with ACID guarantees.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Write, Edit, Glob, Grep, Bash
context: default
agent: default
---

# AI-Migration — Database Schema Migration Workflow

## Dynamic Context Injection
Current schema version: !grep "^- Schema" .ai/DIGEST.md 2>/dev/null | head -1 || echo "(unknown)"
Open migrations: !ls -1 src/db/migrations/*.up.sql 2>/dev/null | wc -l | tr -d ' '
Last migration: !ls -1t src/db/migrations/*.up.sql 2>/dev/null | head -1 | xargs basename

## PREREQUISITE: Deferred Substrate
**NOTE**: The directory `src/db/migrations/` and the schema versioning table (`schema_migrations`) are a DEFERRED substrate — they do not yet exist in the baseline. The canonical state repository is `.ai/state.sqlite` via `src/mcp/shared/state-db.js`. This skill guides authoring migration files using the `.up.sql`/`.down.sql` convention (superseding any `.sql`/`.js` pairs from the blueprint). Deployment will apply migrations to both the filesystem versioning store and the production state database.

## When to Invoke

- Adding a new column, table, or index to `state.sqlite` or `telemetry.sqlite`
- Changing column types, constraints, or foreign keys
- Normalizing or denormalizing schema to fix performance or correctness issues
- Adding PII auditing or encryption markers to existing columns
- Preparing for a schema version bump (documented in DIGEST)

## Role

You are the **Schema Migration Facilitator**. You do not execute migrations yourself — you guide the `db_architect` agent through the design, validation, and rollback planning phases.

## Step 1 — Clarify Migration Scope

From conversation or E-## task description, confirm:
1. **Which database**: `state.sqlite` or `telemetry.sqlite`?
2. **Which tables**: list all tables being modified (CREATE, ALTER, DROP)?
3. **Data sensitivity**: will the migration introduce PII, auth tokens, or encrypted fields?
4. **Rollback risk**: are any operations destructive (DROP COLUMN/TABLE)?
5. **Concurrency**: will other MCPs need to read the schema during migration?

If any of the above is unclear, ask for clarification before proceeding.

## Step 2 — Read Existing Schema & Validators

```bash
# Examine current schema
cat src/db/schema.sql

# Check existing migrations
ls -1 src/db/migrations/ | sort

# Verify validator rules
grep -A 5 '"state_table"' src/shared/schemas/state.json
```

Note any columns that already exist and their types (to avoid duplicate-column errors).

## Step 3 — Invoke DB_ARCHITECT Agent

Once scope is clear, activate the db_architect agent to design and validate the migration:

```
Agent({
  subagent_type: "db_architect",
  prompt: {   // state these fields in the prompt text
    task_id: "E-##",
    migration_scope: "<table list>",
    up_script_outline: "<brief SQL outline>",
    pii_columns: "<list of PII columns, or 'none'>",
    rollback_risk: "<destructive operations, or 'none'>"
  }
})
```

The agent will:
- Design `.up.sql` and `.down.sql` migration files
- Validate against `schema-validator.js` rules
- Check for exclusive write-lock conflicts
- Generate timestamped filenames
- Plan rollback scenarios

## Step 4 — Verify Migration Pair (You)

After db_architect returns the migration pair, manually review:

1. **UP script**:
   - Does it begin with `BEGIN TRANSACTION;` and end with `COMMIT;`?
   - Are all schema changes atomic within the transaction?
   - Does it include seed data or post-migration UPDATE statements if needed?

2. **DOWN script**:
   - Does it exactly mirror the UP changes in reverse?
   - Will it restore any dropped data (via INSERT from shadow table or backup)?
   - Is it idempotent (IF EXISTS / IF NOT EXISTS guards)?

3. **PII sensitivity**:
   - If new columns introduced, are they flagged with `-- PII:` comments?
   - Does DOWN properly drop sensitive columns (to avoid data leakage)?

## Step 5 — Test Rollback (throwaway copy)

Before committing, simulate a rollback against a throwaway database with node:sqlite
DatabaseSync under the Bash tool (D-075 / E-278 retired the Docker sandbox):

```bash
# Extract the UP and DOWN scripts
cat src/db/migrations/<YYYYMMDD_HHmmss>.up.sql
cat src/db/migrations/<YYYYMMDD_HHmmss>.down.sql

# Test UP then DOWN against a throwaway database (fresh dir, removed on exit)
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
( ulimit -t 30; TEST_DB="$T/test.db" node --input-type=module <<'JS'
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';

// Create a temporary test database
const testDb = new DatabaseSync(process.env.TEST_DB);

// Load the baseline schema
const baselineSchema = fs.readFileSync('src/db/schema.sql', 'utf8');
testDb.exec(baselineSchema);

// Load and apply the UP migration
const upMigration = fs.readFileSync('src/db/migrations/<YYYYMMDD_HHmmss>.up.sql', 'utf8');
testDb.exec(upMigration);
console.log('UP migration applied');

// Verify the schema changed (check for new table/column)
const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables after UP:', tables);

// Apply the DOWN migration
const downMigration = fs.readFileSync('src/db/migrations/<YYYYMMDD_HHmmss>.down.sql', 'utf8');
testDb.exec(downMigration);
console.log('DOWN migration applied');

// Verify schema reverted
const tablesAfterDown = testDb.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
console.log('Tables after DOWN:', tablesAfterDown);

testDb.close();
JS
)
```

If the test passes, the migration pair is safe to commit.

## Step 6 — Commit Migration Files

Once verified:

```bash
git add src/db/migrations/<YYYYMMDD_HHmmss>.up.sql src/db/migrations/<YYYYMMDD_HHmmss>.down.sql
git commit -m "E-##: Add migration <version> — <description>"
```

Append to `.ai/LOG.md`:
```
YYYY-MM-DD HH:mm:ss | Engineer (ai-migration) | Commit | Added migration pair <version> for <table>
```

## Step 7 — Apply Migration (Only in Target Env)

**DO NOT apply the migration in this session** — migrations are applied only:
- In development when explicitly tested
- In staging before production promotion
- In production with Architect + Ops approval + recorded rollback plan

Record in `.ai/TASKS.md` comment that the migration is **authored, tested, committed** and awaits deployment scheduling.

## What NOT to Do

- Do NOT modify `state.sqlite` directly; author migration files only
- Do NOT skip the DOWN script (without rollback, failed migrations break deployments)
- Do NOT test migrations against the live database (use a throwaway copy only)
- Do NOT commit migrations with TODO comments or incomplete transactions
- Do NOT execute a migration within this skill — that happens in the `db_architect` agent during task execution

## Escalation to DB_ARCHITECT

If at any point:
- The migration scope becomes unclear or contradictory
- Schema changes conflict with existing ORM queries
- PII auditing requirements are unclear

Invoke the db_architect agent immediately:
```
Agent({ subagent_type: "db_architect", description: "<3-5 words>", prompt: "<what to analyse>" })
```

The agent can rehearse migrations on a throwaway copy and validate them directly.