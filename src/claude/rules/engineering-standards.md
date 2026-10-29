---
paths:
  - "src/**"
---

# Engineering standards (src/)

Enforced by `src/shared/standards.json` through `validateFile` (pre-commit and `critic_clean_code`).

- **File size**: source files stay ≤ 1000 lines (warn at 500). Split into focused modules — a
  cohesive piece moves to its own file beside the original (e.g. `safe-exec-mcp/architect-writes.mjs`).
- **Reuse `src/shared/`** for common logic; do not copy a helper. A second copy is how two
  implementations of one policy drift apart.
- **Filenames**: kebab-case (`memory-batch-scanner.mjs`).
- **No committed cruft**: nothing staged ending in `.tmp`, `.bak`, `.swp`, `.orig`.
- **No secrets in a diff** (AKIA…, sk_live_…, Slack tokens, private keys).
- **Subshell state (D-064 §2)**: a shell helper returns DATA on stdout OR sets STATE in the
  caller — never both. A helper that sets state is called as a plain command, never inside
  `$(…)`, a pipeline or a `while read` loop.
- **`validateFile` is the only public entry (D-071 §5)**: production callers and any test that
  asserts "clean" or a finding count go through it. Call a rule handler directly only in that
  rule's own unit test, on a marker-free fixture.
- **Suppressions (D-065)**: silence a false positive with `# standards:allow-<rule_id>` on the
  line or the line above; exempt a file BY NAME in `standards.json` with a one-line reason.
  Never loosen a pattern or narrow a rule's scope to make a finding go away.
- **Fixture-first for gate code**: standards rules, hooks and harness primitives get the failing
  fixture before the implementation — "which fixture would have caught this?"
