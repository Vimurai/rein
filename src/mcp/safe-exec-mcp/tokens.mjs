// tokens.mjs — the string tokens of a command as shell-quote parses them; whitespace split when
// the parse throws. Moved out of index.js by E-442 (D-164 r8) so the rule modules share one copy.

import { parse } from "shell-quote";

export function shellTokens(text) {
  try {
    return parse(text).filter((t) => typeof t === "string").map((t) => String(t));
  } catch {
    return String(text).split(/\s+/);
  }
}
