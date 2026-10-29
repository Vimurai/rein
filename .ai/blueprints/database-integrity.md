# Database & State Integrity Architecture

## Core Concept
As AI-OS heavily relies on SQLite (`state.sqlite`, `telemetry.sqlite`) for ACID coordination, the `db_architect` agent and `ai-migration` skill will manage schema migrations, WAL modes, and prevent deadlocks.

## Components
1. **`db_architect` (Agent)**: An expert in database normalization, SQLite tuning, migration scripting, and data integrity.
2. **`ai-migration` (Skill)**: A workflow triggered when the Engineer needs to alter the shape of any core database.
3. **`schema-validator` (Utility)**: A script that runs pre-commit to ensure SQL schema matches the application's ORM/query structure.

## Data Model
- **Migrations**: Stored sequentially in `src/db/migrations/` as timestamped `.sql` and `.js` pairs.
- **State**: The `db_architect` tracks migration state in a `schema_migrations` table inside `state.sqlite`.

## API Contracts
- `activate_skill({ skill_name: "ai-migration", arguments: { description: "Add delivered flag to task table" } })`
- Database alterations must be performed using the `node:sqlite` driver with transactional `BEGIN/COMMIT` blocks.

## Security
- `db_architect` must have exclusive write-lock access during migrations to prevent race conditions from other MCPs.
- `identity_guardian` must audit new columns to ensure PII is not inadvertently stored in plaintext.

## Rollback Plan
- Every migration must include a `DOWN` script. If the `UP` migration fails validation, the `DOWN` script is automatically executed, and the system halts to preserve ACID guarantees.
