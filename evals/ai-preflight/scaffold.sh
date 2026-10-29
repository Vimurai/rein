#!/usr/bin/env bash
# Seeds the shared fixture project (evals/fixtures/ai-project.sh) into this case's workspace.
# The eval dir is this case dir's parent; ${d%/*} names it without a ".." segment.
d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${d%/*}/fixtures/ai-project.sh"
