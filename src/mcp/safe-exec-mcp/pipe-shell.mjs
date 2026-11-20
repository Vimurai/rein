// pipe-shell.mjs — the pipe-into-shell match the CURL_PIPE_SHELL / WGET_PIPE_SHELL rules use.
// Moved out of index.js by E-442 (D-164 r8): a pure move, no rule or verdict changed.

import { stripInertHeredocs } from "./heredoc.mjs";

// E-353 (D-112 r3 f): a `|` inside the BODY of a quoted-delimiter cat/tee heredoc is text, not a
// pipe. A pipe rule blocks only when it matches the strictly stripped text AND the text stripped
// with the read-only relaxation (heredoc.mjs readOnlyLines): a body kept scanned only because a
// later, provably read-only line names its file (`echo "$(grep -c … .ai/DECISIONS.md)"`) is prose.
// Either view proving the body inert is enough; implicit-run sinks stay scanned in both.
export function pipeHit(re, raw) {
  return re.test(stripInertHeredocs(raw)) && re.test(stripInertHeredocs(raw, { readOnlyLines: true }));
}
