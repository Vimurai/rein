# Proposed Skills — Instinct Staging Area (E-93)

This directory holds **auto-generated, PROPOSED** Claude skills produced by the
`meta_analyst` Instinct-Extraction mode (`.ai/blueprints/ecc-integrations.md`
§Components 1 & 2) via `src/shared/instinct-stager.mjs`.

## Contract

- Files here are written by `stageInstincts()` as `<slug>/SKILL.md` with
  `disable-model-invocation: true`, `user-invocable: false`, and
  `status: proposed` — they are **inert** and cannot fire.
- A staged skill is **untrusted, machine-generated content**. The stager
  statically rejects low-confidence (< 0.7), malformed, path-unsafe, and
  dangerous-content (secrets / `rm -rf` / pipe-to-shell) proposals.
- **Promotion to an active skill (`.claude/skills/<name>/`) is gated by a
  Human-in-the-Loop `approval-mcp` review (E-94).** Nothing here should be
  moved out manually without that approval.

Anything in this folder is safe to delete — the next extraction run
regenerates current proposals from telemetry.
