// tests/unit/task-quality.test.mjs — the task-planner checks moved into add_task (E-461, D-169 r7).
//
// New: the rules were text in the task-planner skill (removed) and had no test. One runner over
// tests/fixtures/task-quality-cases.json; the MCP path is pinned by task_synchronizer_test.sh
// (the [SCHEMA_FAIL] for a task without Acceptance) and the CLI path by state_views_test.sh T-07.03.
//
// Run standalone: node --test tests/unit/task-quality.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkTaskQuality } from "../../src/shared/task-quality.mjs";

const { cases } = JSON.parse(readFileSync(new URL("../fixtures/task-quality-cases.json", import.meta.url), "utf8"));

test("the task-quality table has rows for every refusal code and for acceptance", () => {
  const codes = new Set(cases.map((c) => c.expect));
  for (const c of [null, "TASK_NO_TIER", "TASK_NO_VERB", "TASK_NO_ACCEPTANCE", "TASK_ACCEPTANCE_UNOBSERVABLE"]) assert.ok(codes.has(c), String(c));
});

for (const c of cases) {
  test(`task quality: ${c.label}`, () => {
    const r = checkTaskQuality({ description: c.description, tier: c.tier });
    assert.equal(r ? r.code : null, c.expect, r ? r.error : "accepted");
  });
}
