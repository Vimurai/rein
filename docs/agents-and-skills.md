# Agents and skills

Rein ships 4 agents and 5 skills as one Claude Code plugin, `rein`. `rein install` builds it in
`~/.rein/plugin/` and adds it as a local marketplace; `rein init` and `rein sync` enable it for
the project (`rein@rein`, project scope), so it loads only in Rein projects. Nothing is copied
into `.claude/agents/` or `.claude/skills/`.

- A **subagent** runs in its own context and reports back. Plugin agents are named with the
  plugin prefix: `rein:reviewer`, which is what `rein review` prints.
- A **skill** is a procedure the current session carries out itself. Only its one-line
  description is in context until it is invoked.

## Agents

| Agent | Does | Stamps |
| :--- | :--- | :--- |
| `rein:reviewer` | Reads the diff against the task and the blueprint it names; one test per behaviour at the cheapest layer. | `REVIEW_PASS` / `REVIEW_FAIL` |
| `rein:critic_acceptance` | Observes each clause of a Tier 2/3 task's acceptance line. | `ACCEPT_PASS` / `ACCEPT_FAIL` |
| `rein:security_engineer` | One Tier 3 round: threat review and active probing in a throwaway, resource-capped directory. | `SEC_CLEARED` / `SEC_BLOCKED` |
| `rein:test_engineer` | The headless Tester: writes tests under `tests/` in the project's own harness and runs them. | `TESTS_PASS` / `TESTS_FAIL` |

## Skills

Both roles load every skill; the second column is the role that uses it.

| Skill | Used by | Does |
| :--- | :--- | :--- |
| `blueprint-writer` | Architect | Refuses a blueprint that lacks its required sections (core concept, data model, API, security, rollback, at least three components). |
| `rein-review` | Engineer | Runs `rein review <tier>` and dispatches the agents it prints. |
| `rein-test` | Engineer | Runs the project's own test command; `--generate` dispatches the Tester, `--fast` runs it on `haiku`. |
| `rein-debug` | Engineer | Hypothesis, test, observe; three cycles, then a handoff to the Architect. |
| `release-manager` | Engineer | Version bump, `CHANGELOG.md`, signed tag. |

Closing a task, handing off and recording a decision are commands, not skills:
`rein done`, `rein handoff`, `rein decide` ([Commands](commands.md)).

## Removed units

The other agents and skills of v0.5.0 were removed by D-170. Tag `v0.5.0` holds every one; their
future home is a plugin marketplace.

## Writing your own

Agents go in `src/claude/agents/<name>.md`, skills in `src/claude/skills/<name>/SKILL.md` or
`src/shared/skills/<name>/SKILL.md`. The plugin build refuses two units with the same name.
`rein doctor --compliance` audits frontmatter for tools that do not exist. See
[CONTRIBUTING.md](../CONTRIBUTING.md).
