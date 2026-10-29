---
type: blueprint
tier: 2
tags: [seo, agents, topic-cluster]
status: active
---

# Domain Blueprint: SEO Topic Cluster Engine

> [!IMPORTANT]
> Modern SEO strategy replacing the deprecated keyword-multiplier. Focuses on distinct search intents to prevent keyword cannibalization.

## Goal & Architecture
The goal is to implement a Topic Cluster system for the SEO Agent that establishes topical authority. Instead of spinning one keyword into many formats, it generates one comprehensive Pillar page and multiple distinct-intent Cluster pages (e.g., cost, comparison, process) to capture unique, non-overlapping long-tail search traffic without cannibalizing rankings.

## Core Concept
- **Pillar Page**: A comprehensive, broad-intent overview page targeting the primary topic.
- **Cluster Pages**: Specific, deep-dive pages branching off the Pillar, each targeting a distinct semantic intent or question (e.g., "What does X cost?", "X vs Y").
- **Cannibalization Guard**: Explicit mandate that every generated page MUST target a unique, non-overlapping search query.

## Components
1. **SEO-Topic-Cluster-Manager** (formerly Keyword-Multiplier-Manager): Orchestrates the expansion of a seed topic into a defined cluster (1 Pillar + N Cluster intents) by emitting distinct task requests.
2. **SEO-Content-Generator**: A specialized LLM agent service that takes a specific cluster intent (e.g., "pillar-overview", "cluster-cost") and generates a complete, intent-optimized article.
3. **Multi-Variation-State-Tracker**: Tracks the status and performance of all pages within a topic cluster to prevent collisions and identify top-performing content.
4. **SEO-Engineer** (Claude Persona): A specialized execution persona (`src/claude/agents/seo_engineer.md`) that handles the technical frontend implementation of SEO tasks (meta tags, JSON-LD structured data, internal linking, and canonicals) ensuring the generated cluster content is perfectly wired into the application.

## Data Model
- `TopicSeed` (formerly KeywordSeed): `id`, `term`, `status`, `target_volume`.
- `ClusterPage` (formerly ContentVariation): `id`, `seed_id`, `intent_type`, `content_blob`, `performance_metrics`, `published_at`.

## API / Interface Contracts
- `generateTopicCluster(term: string) -> task_ids[]`: Initiates the creation of the Pillar and Cluster tasks.
- `generateClusterContent(seed_id: string, intent_type: string) -> content_blob`: Executes the generation for a specific intent.
- `reportPerformance(variation_id: string, metrics: Object)`: Updates the content's SEO metrics.

## Security
- **Content Integrity**: All generated content must be validated against a "duplicate-content" checker (Jaccard similarity threshold) to ensure semantic distinctness.
- **Rate Limiting**: Automated generation is bound by LLM provider rate limits; requires exponential backoff.
- **PII/Safety**: Content generation is gated through the existing Identity Guardian and Security Engineer (critic_security) checks.

## Execution Constraints
- **Concurrency**: Generate up to 3 pages concurrently.
- **Generation Limits**: Dynamic based on identified intents, but capped at a reasonable limit (e.g., 10 cluster pages per pillar) to maintain quality.
- **Performance**: Each page must be generated in < 120 seconds.

## Rollback Plan
- Delete the `TopicSeed` and all associated `ClusterPage` records via `task-synchronizer-mcp` commands.
- Purge generated content files from the repository if they have been staged.

## E-## Task Breakdown
- E-87: Refactor `seo_manager.md` to orchestrate Topic Clusters (Pillar + Cluster intents) instead of 20 format-spins.
- E-88: Refactor `src/shared/seo-approach-types.mjs` to define canonical cluster intents (pillar, cost, comparison, etc.) and lift strict 20-cap.
- E-90: Create `src/claude/agents/seo_engineer.md` persona to enforce technical SEO standards and metadata implementation during task execution.
