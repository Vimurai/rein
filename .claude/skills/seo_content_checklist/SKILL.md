---
name: seo_content_checklist
description: Use this skill before publishing new pages or updating web content. Runs the full SEO and content compliance checklist covering title tags, meta descriptions, H1/H2 structure, canonical tags, sitemap, and GDPR requirements.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob
context: default
agent: default
---

# SEO + Content Checklist

## Per Page
- [ ] Unique title (50–60 chars, primary keyword first)
- [ ] Unique meta description (120–155 chars, action-oriented)
- [ ] Single H1 matching page intent
- [ ] H2s for main sections (keyword-natural, not stuffed)
- [ ] At least 2 internal links to/from this page
- [ ] Open Graph tags if shared on social

## Site-Level
- [ ] Clean URLs (no `.html`, no excessive params, hyphens not underscores)
- [ ] `sitemap.xml` generated
- [ ] `robots.txt` present
- [ ] Canonical tags on duplicate/paginated content

## Compliance
- [ ] Affiliate disclosure above the fold if affiliate links present
- [ ] Cookie/GDPR notice if analytics or tracking pixels present
- [ ] No misleading claims, fake urgency, or dark patterns

## Dynamic Context Injection
Pages to audit: !find . -name "*.html" -o -name "*.tsx" -o -name "*.jsx" 2>/dev/null | grep -v node_modules | grep -v ".next" | head -15
