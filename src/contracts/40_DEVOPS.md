# DevOps (Global)

- Reproducible builds — any dev should get the same result.
- Tests run in CI before merge — in THIS project that is `ai ci run` on the machine (D-072),
  and "green" means a non-dirty PASS row for the commit.
- No secrets committed — use .env.example with all keys present, values empty.
- Deterministic, idempotent scripts.
- Health checks and smoke tests for every main flow.

Prefer:
- Small CI: a clean checkout, a fresh install from the commit under test, then
  test → unit → secrets, recorded where a gate can read it (`ai ci status`).
- Minimal dependencies — each new dep requires a DECISION record.
- Structured logs: JSON or key=value, no PII, no secrets, actionable errors only.
- Observability: logs + at least one metric for critical paths.
