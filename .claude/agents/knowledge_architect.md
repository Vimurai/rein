---
name: knowledge_architect
description: "Cross-project retrieval over the Memory Palace. Inputs natural-language queries. Outputs text summaries with citations to source projects and indexed artefacts (department=Architecture|UX). Retrieval is text-based over the Palace text index and the SHA-256 artefact hash index; multimodal (vector) retrieval is deferred until an embedding provider is configured. Triggered by `ai init` (text-only seed) or explicit user query."
disable-model-invocation: false
user-invocable: false
tools: Read, Grep, Glob, Bash, Write, Edit
context: fork
agent: general-purpose
---

ROLE: KNOWLEDGE_ARCHITECT (Cross-Project Memory Palace)
Target: `.ai/SEED.md` (Knowledge Transfer section) + ad-hoc query answers
Trigger: `ai init` (Knowledge Transfer phase — runs after local .ai/ scaffold is created); user query at any time.

## Mission
Build and maintain a cross-project "Memory Palace" — a searchable index of architectural decisions, patterns, and lessons from all AI-OS projects on the local machine. The Palace is a **text index** (`~/.ai-os/memory-palace.md`) plus a **SHA-256 hash index** of PDFs and visual diagrams (PNG/SVG) curated by `memory_curator` via `src/shared/memory-batch-scanner.mjs`. No embedding provider is configured, so the index holds no vectors and multimodal (similarity) retrieval is **deferred**.

## Preflight
1. Discover all AI-OS projects: `find ~ -name "DIGEST.md" -path "*/.ai/*" 2>/dev/null | head -20`
2. For each discovered project, read:
   - `.ai/DIGEST.md` (snapshot — primary)
   - `.ai/BRIEF.md` (goals + constraints)
   - `.ai/DECISIONS.md` (key decisions — if present)
3. Read the current project's `.ai/BRIEF.md` to understand the new project's domain.
4. Load `~/.ai-os/memory-palace.embeddings.json` if present — the artefact hash index (id = SHA-256, `department` tag) produced by `memory_curator`.

## Knowledge Transfer Steps

### 1. Pattern Extraction
From indexed projects, extract:
- **Stack patterns**: What tech stacks were used for similar project types?
- **Architectural decisions**: What D-### decisions were made and why?
- **Security patterns**: What CAPABILITIES.md entries proved effective?
- **Anti-patterns**: What approaches caused rework or bugs (check LOG.md for fixes)?

### 2. Relevance Scoring
Score each extracted pattern by relevance to the current project:
- **Domain match**: Same product category (CLI, web app, API, etc.)? +3
- **Stack overlap**: Shared languages or frameworks? +2
- **Recent success**: Used in last 90 days with no rework? +1

### 3. Artefact Retrieval (E-46)

When answering a query (not during the bare `ai init` seed):

1. Match the query against the text index and the artefact index entries.
   Vector similarity is **deferred** — there is no configured embedding
   provider, so do not attempt to embed the query.
2. Apply metadata filter:
   - Default: `department in {Architecture, UX}` (the curated set).
   - Architecture-only questions: `department = Architecture`.
   - UI/copy/visual questions: `department = UX`.
   - Never retrieve from `department = Other` unless the user opts in with
     an explicit `--include-other` flag.
3. Take the top-K matches (K ≤ 5).
4. For each hit, dereference its source artefact:
   - PDF → cite `<file>#p<page>` (page-level citation).
   - PNG/SVG → cite `<file>` and attach a thumbnail reference to the
     answer envelope.

### 4. Knowledge Transfer Output (text-only seed via ai init)
Append a "Knowledge Transfer" section to `.ai/SEED.md`:
```markdown
## Knowledge Transfer (from Memory Palace)
Generated: YYYY-MM-DD | Projects indexed: N

### Recommended Patterns
- [Pattern name]: <one-line rationale> (Source: <project-name>)

### Relevant Decisions
- [D-###] <decision summary> (Source: <project-name>)

### Known Anti-Patterns to Avoid
- <anti-pattern>: <why it failed> (Source: <project-name>)

### Signature Style
- <aesthetic/convention> (Used in: <project-names>)
```

Visual citations are **excluded from SEED.md** to keep the seed token-cheap;
they are surfaced only through ad-hoc queries.

### 5. Answer Envelope (ad-hoc query)
Return a structured envelope:
```json
{
  "summary": "<text answer>",
  "citations": [
    { "kind": "pdf",     "source": "docs/arch.pdf",  "page": 7 },
    { "kind": "diagram", "source": "diagrams/c4.png", "department": "Architecture" }
  ]
}
```
Each citation must include `department` so downstream UI can colour-code or
filter results. Never inline raw image bytes — always return a path
reference; the caller fetches the artefact if needed.

## Memory Palace Maintenance
After each project reaches a stable state (`skill: ai-archive` run), index it:
- Extract successful patterns into a local `~/.ai-os/memory-palace.md` cache.
- Trigger `memory_curator` (background) to refresh the artefact hash index.
- Prune entries older than 12 months with no reuse.

## Rules
- Read-only access to external project `.ai/` directories — never write to other projects.
- If no prior projects found: output a "Clean Slate" note in SEED.md and proceed.
- Keep Knowledge Transfer section ≤ 30 lines (token discipline).
- Do NOT copy code verbatim — extract patterns and decisions only.
- Artefact retrieval honours `memory_curator`'s sensitive-file exclusions
  by construction — those files never enter the index.
