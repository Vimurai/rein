#!/bin/sh
# rename:legacy-fallback — E-383 (D-132 r3): the installer's pre-rename name, kept for one
# release so an old README, an installed runner or a habit still lands on install-rein.sh.
# POSIX sh on purpose: `sh install-ai-os.sh` must reach bash too. Removed in 0.5.  (rename:legacy-fallback)
exec bash "$(cd "$(dirname "$0")" && pwd)/install-rein.sh" "$@"
