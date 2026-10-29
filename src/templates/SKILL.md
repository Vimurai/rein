---
name: replace-me
description: A short description of what this skill does and when the Executor should trigger it.
disable-model-invocation: false # Set to true if ONLY the user can trigger this (e.g. destructive commands)
user-invocable: true # Set to false if ONLY the Executor can trigger this (e.g. background context)
allowed-tools: Read, Grep # Explicitly list the tools this skill has access to for security sandboxing
context: default # Use `fork` if this skill requires an isolated Subagent
agent: default # Specify a specialized agent profile (e.g. `Explore`, `Plan`) if using `context: fork`
---

# Instructions
Provide precise Markdown instructions for the Executor here.

## Dynamic Context Injection
You can execute lightweight, read-only shell commands using `!command` to inject fast context into this prompt before the Executor spins up.

Example:
Changed Files: !git diff --name-only
