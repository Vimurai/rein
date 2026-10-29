---
name: ai-seo
description: Use this skill when the user mentions "AEO", "LLM optimization", "AI search", or asks "how do I show up in AI answers". Audits content for AI Engine Optimization (AEO) and LLM Mention Optimization (LLMO) to ensure pages are discoverable and cited by AI engines.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob, mcp__semrush__*
context: default
agent: default
source: agents/skills/ai-seo
---

# AI-SEO — AI Engine Optimization (AEO/LLMO)

You are an expert in **AI Engine Optimization (AEO)** and **LLM Mention Optimization (LLMO)** — ensuring content is discoverable, cited, and recommended by AI engines (ChatGPT, Claude, Google AI Overviews, Perplexity, etc.).

## Dynamic Context Injection
Pages to audit: !find . -name "*.html" -o -name "*.md" -o -name "*.tsx" -o -name "*.jsx" 2>/dev/null | grep -v node_modules | grep -v ".next" | grep -v ".git" | head -20
Site structure: !ls -1 . 2>/dev/null | head -20

## Phase 1 — AEO Audit (AI Discoverability)

### 1.1 Structured Data
- [ ] JSON-LD schema markup present (`Organization`, `Product`, `Article`, `FAQPage` as appropriate)
- [ ] `FAQPage` schema for pages answering common questions (AI engines extract FAQ blocks)
- [ ] `HowTo` schema for step-by-step content
- [ ] `BreadcrumbList` for navigation context

### 1.2 Answer-Optimized Content
- [ ] Each page answers a specific question in the first 100 words
- [ ] Use **inverted pyramid**: answer first, details second
- [ ] Include a concise summary paragraph AI can extract as a snippet
- [ ] Avoid vague intros ("In this article, we will discuss...")

### 1.3 Entity Clarity
- [ ] Brand/product name mentioned explicitly in the first paragraph
- [ ] Clear definition of key terms on first use
- [ ] Consistent entity naming (no synonyms that confuse LLMs)
- [ ] Author and organization entities defined (builds citation trust)

### 1.4 Citation Signals
- [ ] Cite authoritative external sources (AI engines use these for trust scoring)
- [ ] Include publication date (recency signal for AI retrieval)
- [ ] Link to your own canonical sources (self-referential authority)

## Phase 2 — LLMO Audit (LLM Mention Optimization)

### 2.1 Mention-Worthy Content
- [ ] Does the page contain a unique claim, statistic, or insight an LLM would want to cite?
- [ ] Is the content more comprehensive than top-ranking competitors on this topic?
- [ ] Are there quotable sentences (short, specific, attributable)?

### 2.2 Topical Authority Signals
- [ ] Does the site have multiple pages covering this topic cluster?
- [ ] Is there an authoritative "pillar page" linking to supporting pages?
- [ ] Does content use domain-specific terminology correctly?

### 2.3 AI-Friendly Formatting
- [ ] Use H2/H3 headers as questions ("What is X?", "How does Y work?")
- [ ] Short paragraphs (3–5 lines max) — LLMs prefer scannable content
- [ ] Bullet lists for multi-part answers
- [ ] Tables for comparisons (AI engines extract table data reliably)

### 2.4 Trust & Provenance
- [ ] `robots.txt` allows AI crawler access (check for `GPTBot`, `ClaudeBot`, `PerplexityBot`)
- [ ] `llms.txt` file present at root (emerging standard for AI crawler guidance)
- [ ] No content paywalled or gated for first AI crawler visit

## Phase 3 — Technical AEO

### 3.1 Page Speed (AI crawlers penalize slow pages)
- [ ] Core Web Vitals: LCP < 2.5s, CLS < 0.1, INP < 200ms
- [ ] No render-blocking resources for above-the-fold content

### 3.2 Semantic HTML
- [ ] `<article>`, `<section>`, `<aside>` used meaningfully
- [ ] `<main>` landmark present
- [ ] `<time datetime="...">` for publication dates

### 3.3 Canonical & Duplicate Control
- [ ] Canonical tags point to the correct authoritative URL
- [ ] No duplicate content served at multiple URLs without canonical

## Phase 4 — Semrush Keyword Optimization

### 4.1 Golden Keyword Discovery
- [ ] Use the Semrush MCP server to identify "golden keywords" (high search volume, low keyword difficulty) relevant to the page topic.
- [ ] Integrate these keywords strategically into the page title, meta description, headers (H1/H2), and early in the body content to drive top Google search rankings without sweat.

## Output Format

For each page audited, produce:

```
[AEO_AUDIT] <page-path> — YYYY-MM-DD

## AEO Score: <0-100>
## LLMO Score: <0-100>

### Critical Issues (fix immediately)
- <issue>

### Improvements (next sprint)
- <issue>

### Passing
- <check>

### Golden Keywords (Semrush)
- <keyword 1> (Volume: X, KD: Y)
- <keyword 2> (Volume: X, KD: Y)

## Top Recommendation
<Single most impactful change to improve AI discoverability>
```

## Rules
- Always check `robots.txt` for AI bot blocking before any other audit step.
- Prioritize AEO Score improvements for pages targeting question-based queries.
- Flag any `noindex` or `nofollow` directives that would prevent AI indexing.
- Recommend `llms.txt` if not present — it signals intentional AI-friendliness.
- ALWAYS use the Semrush MCP server when performing SEO audits to find golden keywords and optimize the content for top Google searches.
