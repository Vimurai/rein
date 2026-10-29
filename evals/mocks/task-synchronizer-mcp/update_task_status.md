---
type: fixed
expect:
  id: /^E-[0-9]+$/
  status: string
---
{"ok": true, "id": "{{input.id}}", "status": "{{input.status}}"}
