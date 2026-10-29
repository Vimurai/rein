/**
 * seo-cluster-intents.mjs — canonical SEO Topic Cluster intents (E-88).
 *
 * Single source of truth for the Topic Cluster Engine defined in
 * .ai/blueprints/seo-keyword-multiplier.md (SEO Topic Cluster Engine).
 * Replaces the deprecated 20 "approach-type" format-spins (E-79) with a
 * Pillar + distinct-intent Cluster model that captures unique,
 * non-overlapping long-tail search traffic without keyword cannibalization.
 *
 * Model:
 *   - One Pillar page per TopicSeed — the broad-intent overview
 *     (`SEO_PILLAR_INTENT`).
 *   - Up to `MAX_CLUSTER_PAGES_PER_SEED` Cluster pages, each targeting a
 *     distinct semantic intent (`SEO_CLUSTER_INTENTS`). Every page MUST
 *     target a unique, non-overlapping search query (cannibalization guard).
 *
 * Consumers:
 *   - task-synchronizer-mcp (E-88): validate ClusterPage.intent_type and
 *     enforce the cluster-page cap on add_cluster_page.
 *   - src/claude/agents/seo_manager.md (E-87): SEO-Topic-Cluster-Manager —
 *     documents the same intents as a markdown table; kept in sync via
 *     tests/suites/seo_cluster_test.sh.
 *   - src/claude/agents/seo_content_generator.md: same — one template per
 *     intent.
 *   - src/claude/agents/seo_engineer.md (E-90): technical-SEO persona that
 *     wires each generated page (meta tags, JSON-LD, canonicals, internal
 *     links) into the application.
 *
 * Order is stable — never reorder these. Downstream consumers may iterate
 * the cluster intents index-by-index and rely on a deterministic sequence
 * for CI replay.
 */

/** The single broad-intent overview page that anchors a topic cluster. */
export const SEO_PILLAR_INTENT = "pillar-overview";

/**
 * Distinct deep-dive Cluster intents. Each one targets a non-overlapping
 * search query branching off the Pillar (cannibalization guard). The list
 * is curated for semantic distinctness — not an exhaustive enumeration of
 * every possible long-tail.
 */
export const SEO_CLUSTER_INTENTS = Object.freeze([
  "cost",               // "What does X cost?" — commercial intent
  "comparison",         // "X vs Y" — head-to-head decision intent
  "how-to",             // "How to do X" — procedural intent
  "process",            // "How X works" — mechanism / explainer intent
  "alternatives",       // "X alternatives" — consideration-stage intent
  "best-for-use-case",  // "Best X for <use case>" — segmented recommendation
  "benefits",           // "Benefits of X" / "Why X" — value intent
  "requirements",       // "What you need for X" — prerequisite intent
  "mistakes",           // "Common X mistakes" — pain-point intent
  "faq",                // "X FAQ" — People-Also-Ask cluster intent
]);

/** Pillar + every Cluster intent — the full set of valid intent_type values. */
export const SEO_ALL_INTENTS = Object.freeze([
  SEO_PILLAR_INTENT,
  ...SEO_CLUSTER_INTENTS,
]);

export const SEO_CLUSTER_INTENTS_SET = new Set(SEO_CLUSTER_INTENTS);
export const SEO_ALL_INTENTS_SET = new Set(SEO_ALL_INTENTS);

/**
 * Blueprint §Execution Constraints/Generation Limits: a topic cluster is
 * capped at a reasonable number of Cluster pages per Pillar to maintain
 * quality (the old rigid 20-cap is lifted). The Pillar page itself is not
 * counted against this cap. Defence-in-depth at the storage layer so a
 * buggy upstream caller can never over-expand a cluster.
 */
export const MAX_CLUSTER_PAGES_PER_SEED = 10;

/** True when `slug` is the Pillar intent or any Cluster intent. */
export function isValidIntentType(slug) {
  return typeof slug === "string" && SEO_ALL_INTENTS_SET.has(slug);
}

/** True when `slug` is one of the distinct deep-dive Cluster intents. */
export function isClusterIntent(slug) {
  return SEO_CLUSTER_INTENTS_SET.has(slug);
}
