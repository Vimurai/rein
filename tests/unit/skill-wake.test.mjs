// tests/unit/skill-wake.test.mjs — the Triad wake text in the five handoff skills
// (D-099, native-first.md §Component 9). Extends the static layer of
// tests/suites/skill_evals_test.sh; replaces the skill-text checks of
// tests/suites/handoff_enforcement_test.sh, which E-322 deletes with the signal path.
//
// The wake is a model action: each skill tells the session to load SendMessage through
// ToolSearch and call it as the last action of the turn. Nothing executes that text but the
// model, so a skill that still names the retired signal path, or forgets the deferred-tool
// load, fails silently — the other pane simply never wakes. The text is pinned here, for
// the source copy and the provisioned copy the plugin evals grade.
//
//   node --test tests/unit/skill-wake.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SKILLS = {
  "rein-handoff": "src/shared/skills/rein-handoff/SKILL.md",
  "rein-task": "src/shared/skills/rein-task/SKILL.md",
  "rein-triage": "src/shared/skills/rein-triage/SKILL.md",
  "arch-task": "src/claude/skills/arch-task/SKILL.md",
  "task-planner": "src/claude/skills/task-planner/SKILL.md",
};

const RETIRED = /handoff_control|ai handoff|signal\.json|ai watch/;

const allowedTools = (text) =>
  (/^allowed-tools:\s*(.*)$/m.exec(text)?.[1] ?? "").split(",").map((t) => t.trim()).filter(Boolean);

for (const [name, src] of Object.entries(SKILLS)) {
  for (const path of [src, `.claude/skills/${name}/SKILL.md`]) {
    const text = readFileSync(path, "utf8");

    test(`${path}: wakes with SendMessage, loaded through ToolSearch`, () => {
      assert.match(text, /SendMessage/);
      assert.match(text, /ToolSearch/);
      assert.match(text, /select:SendMessage/);
    });

    test(`${path}: names none of the retired signal path`, () => {
      assert.doesNotMatch(text, RETIRED);
    });

    test(`${path}: a down target is reported once, never retried`, () => {
      assert.match(text, /not reachable/);
      assert.match(text, /no retry,\s+no\s+queue,\s+no\s+fallback/i);
    });

    test(`${path}: an allowed-tools list, when present, admits the wake`, () => {
      const tools = allowedTools(text);
      if (tools.length === 0) return; // no list = no restriction
      for (const t of ["ToolSearch", "SendMessage"]) assert.ok(tools.includes(t), `${t} missing`);
    });
  }
}

test("provisioned copies match their source", () => {
  for (const [name, src] of Object.entries(SKILLS)) {
    assert.equal(readFileSync(`.claude/skills/${name}/SKILL.md`, "utf8"), readFileSync(src, "utf8"), name);
  }
});
