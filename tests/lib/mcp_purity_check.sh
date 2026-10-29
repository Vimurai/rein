#!/usr/bin/env bash
# mcp_purity_check.sh — E-48 MCP Stdout Purity Gate
#
# Scans the staged diff for newly added console.log / console.info calls
# under src/mcp/ — those calls would corrupt the JSON-RPC stdout stream that
# MCP clients parse. console.error / process.stderr.write are permitted
# (the shared logger writes NDJSON to stderr by design).
#
# Usage:    bash tests/lib/mcp_purity_check.sh
# Exit 0:   no violations OR no staged src/mcp/ changes.
# Exit 1:   one or more added lines under src/mcp/ contain a forbidden call.
#
# The check is line-oriented and only considers `+` added lines (skipping
# `+++` file headers). Lines inside comments (//) or block comments are
# ignored. Strings/templates are NOT introspected — that's a deliberate
# trade-off: accept false-positives on `console.log` mentioned inside string
# literals, since logging *about* the forbidden pattern is rare and easy to
# rewrite (use "console-dot-log" or similar) when it occurs.

set -uo pipefail

# Only run inside a git repo with a working tree.
if ! git rev-parse --show-toplevel >/dev/null 2>&1; then
  exit 0
fi

# Pre-filter: any staged file under src/mcp/?
staged_mcp_files="$(git diff --cached --name-only --diff-filter=AM 2>/dev/null | grep -E '^src/mcp/.*\.(js|mjs|cjs|ts)$' || true)"
if [[ -z "$staged_mcp_files" ]]; then
  exit 0
fi

# Hand the diff to Python — bash regex is too limited for the comment guard
# and the multi-file hunk walk.
python3 - <<'PY'
import re, subprocess, sys

proc = subprocess.run(
    ["git", "diff", "--cached", "--diff-filter=AM", "--unified=0", "--", "src/mcp/"],
    capture_output=True, text=True,
)
diff = proc.stdout

# A forbidden call starts a function invocation; `console.log` as a property
# reference (e.g. `if (console.log)`) without the `(` is allowed — it can't
# write anything by itself.
FORBIDDEN_RE = re.compile(r"\bconsole\.(?:log|info)\s*\(")
ADDED_RE     = re.compile(r"^\+(?!\+\+)(?P<body>.*)$")
LINE_COMMENT_RE = re.compile(r"^\s*//")

current_file = None
in_block_comment = False
violations = []

for raw in diff.split("\n"):
    if raw.startswith("+++ b/"):
        current_file = raw[6:].strip()
        in_block_comment = False
        continue
    if raw.startswith("---") or raw.startswith("@@"):
        in_block_comment = False
        continue

    m = ADDED_RE.match(raw)
    if not m:
        continue
    body = m.group("body")
    stripped = body.lstrip()

    if in_block_comment:
        if "*/" in stripped:
            in_block_comment = False
        continue
    if stripped.startswith("/*"):
        if "*/" not in stripped[2:]:
            in_block_comment = True
        continue
    if LINE_COMMENT_RE.match(stripped):
        continue
    if not FORBIDDEN_RE.search(stripped):
        continue

    cleaned = stripped.split("//", 1)[0].rstrip()
    violations.append((current_file or "<unknown>", cleaned[:120]))

if violations:
    sys.stderr.write("[MCP_PURITY_FAIL] forbidden console.log/info in staged src/mcp/:\n")
    for f, body in violations:
        sys.stderr.write(f"  {f}\n    {body}\n")
    sys.stderr.write(
        "\nMCP servers must keep stdout reserved for JSON-RPC. "
        "Use the shared NDJSON logger:\n"
        "    import { createLogger } from \"../shared/logger.js\";\n"
        "    const log = createLogger(\"my-mcp\");\n"
        "    log.info(\"tool\", \"message\", { extras });\n"
    )
    sys.exit(1)
PY
