#!/usr/bin/env bash
# skill-exec-driver.sh — run the EXECUTABLE lines of a skill file the way the harness
# does, from inside a decoy project, and report whether the decoy's own helper ran.
#
# WHY A DRIVER: the vulnerability is not in a shell script we can grep — it is in what a
# `!`-prefixed markdown line DOES when the harness expands it at session start. A static
# check on the SKILL.md text would pass against any rewrite that still resolved
# cwd-relative by another route, so the assertion has to be on EXECUTION.
#
# Usage: skill-exec-driver.sh <skill-file> [<skill-file>...]
# Prints one line per canary that executed, or nothing at all (the pass case).
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DECOY="$(mktemp -d)"
MARK="$DECOY/CANARY_EXECUTED"

# The decoy plants every helper the skills resolve, at the cwd-relative path the OLD
# chains looked at first. Each announces itself and exits cleanly, so a skill that runs
# one sees a plausible result and carries on — a canary that crashed would be caught by
# accident rather than by the guard.
mkdir -p "$DECOY/src/shared" "$DECOY/.ai"
for helper in incident-aggregate insights-staleness telemetry skill-promoter; do
  cat > "$DECOY/src/shared/${helper}.mjs" <<EOF
import { appendFileSync } from "node:fs";
appendFileSync("$MARK", "${helper}\n");
console.log('{"status":"OK"}');
EOF
done

cd "$DECOY" || exit 1

for skill in "$@"; do
  [[ -f "$skill" ]] || continue
  # Extract the executable lines exactly as the E-224 classifier sees them, so the driver
  # and the review gate agree on what "executable" means.
  node --input-type=module --no-warnings -e '
    import { classifyMarkdown } from "'"$REPO"'/src/shared/markdown-exec.mjs";
    import { readFileSync } from "node:fs";
    const p = process.argv[1];
    const body = readFileSync(p, "utf8");
    const { executable } = classifyMarkdown(body, p);
    const lines = body.split("\n");
    // CONTIGUOUS executable lines are emitted as ONE block, separated by a NUL. A fenced
    // `for c in ...; do ... done` spans several lines, so running each line on its own
    // never executes it — the first version of this driver did that and silently missed
    // two of the four helpers, which would have made the canary look stronger than it was.
    const nums = [...executable].sort((a, b) => a - b);
    let block = [];
    const flush = () => { if (block.length) { process.stdout.write(block.join("\n") + "\0"); block = []; } };
    let prev = null;
    for (const n of nums) {
      if (prev !== null && n !== prev + 1) flush();
      let l = lines[n-1] ?? "";
      l = l.replace(/^[^!]*!/, "");                     // strip the "Label: !" prefix
      if (/\S/.test(l)) block.push(l);
      prev = n;
    }
    flush();
  ' -- "$skill" 2>/dev/null | while IFS= read -r -d '' cmd; do
    # Run it the way the harness does: a plain shell, in the visited project.
    #
    # `</dev/null` is load-bearing. Without it a block that reads stdin — `node "$X"` with
    # X unset reads a program from stdin — swallows the REST of the block stream and the
    # loop ends early. That is exactly what happened: the driver stopped after two blocks
    # and reported two canaries, making the fix look better verified than it was.
    bash -c "$cmd" >/dev/null 2>&1 </dev/null || true
  done
done

if [[ -s "$MARK" ]]; then
  sort -u "$MARK" | sed 's/^/EXECUTED /'
fi

cd "$REPO" || exit 1
rm -rf "$DECOY"
