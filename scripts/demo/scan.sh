#!/usr/bin/env bash
# scan.sh — the demo cast through the privacy gate before anything is rendered (D-139,
# .ai/blueprints/demo-video.md §Component 4). Exit 0 clean, 1 on any finding, 2 on usage.
#   scripts/demo/scan.sh <cast>
set -euo pipefail
[[ $# -eq 1 && -f "$1" ]] || { echo "usage: scripts/demo/scan.sh <cast>" >&2; exit 2; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${HERE%/scripts/demo}"
exec node --no-warnings "${REPO}/scripts/demo/scan.mjs" "$1" "$REPO"
