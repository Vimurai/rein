---
name: ux_template
description: Use this skill when designing or reviewing a UI screen or view. Generates structured UX documentation capturing purpose, entry points, layout regions, interaction states, accessibility, and mobile behavior.
disable-model-invocation: false
user-invocable: true
allowed-tools: Read, Grep, Glob
context: default
agent: default
---

# UX Screen Template

For each screen/view, document the following:

- **Purpose**: `<one sentence>`
- **Entry points**: `<how user gets here>`
- **Layout**: header / sidebar / main / footer regions
- **Primary action**: `<most important thing user does>`
- **Secondary actions**: `<list>`
- **Keyboard shortcuts**: `<key> → <action>` (table format)

## States
- **loading**: `<what shows>`
- **empty**: `<what shows + CTA>`
- **error**: `<message + recovery action>`
- **success**: `<confirmation>`

## Accessibility
- ARIA landmark roles
- Focus order
- Screen reader announcement

## Mobile
`<layout changes or "same as desktop">`

---

## Dynamic Context Injection
Existing screens/views: !find . -name "*.tsx" -o -name "*.jsx" -o -name "*.vue" 2>/dev/null | grep -iE "page|screen|view|layout" | grep -v node_modules | head -10
