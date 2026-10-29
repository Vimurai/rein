#!/usr/bin/env bash
# Seeds the shared fixture project (evals/fixtures/rein-project.sh) into this case's workspace,
# with the Engineer queue genuinely exhausted.
# The eval dir is this case dir's parent; ${d%/*} names it without a ".." segment.
d="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "${d%/*}/fixtures/rein-project.sh" --queue-done
