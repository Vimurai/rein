// input-limits.mjs — the size limits a command is checked against before it is tokenized.
// Moved out of index.js by E-442 (D-164 r8): a pure move, no limit or message changed.

// E-350 (D-111 r6 iv): shell-quote's parse grows quadratically with the token count (~100 s for
// 50k groups), so the gate leaned on the hook's timeout. A group is one command separator or
// grouping operator — ; & | ( ) { } ` $( newline — counted in one linear pass before anything
// is tokenized. Ordinary commands use tens; a long script hundreds. The cost is per TOKEN, so
// redirections (< >, which split a word into tokens), words and bytes are capped the same way.
const MAX_GROUPS = 2000;
const MAX_WORDS = 10000;
const MAX_BYTES = 64 * 1024;
const GROUP_RE = /\$\(|&&|\|\||[;&|(){}`\n<>]/g;
const WORD_RE = /\S+/g;
function _count(re, text) {
  let n = 0;
  re.lastIndex = 0;
  while (re.exec(text) !== null) n++;
  return n;
}
// E-351 (D-112 r2): the first limit that tripped, with the measured figure, or null. The line
// names the escape so a refusal is not read as a gate failure: a document goes through Write/Edit.
export function _tooLarge(full) {
  const bytes = Buffer.byteLength(full);
  const hit = bytes > MAX_BYTES ? [bytes, MAX_BYTES, "bytes"]
    : [[GROUP_RE, MAX_GROUPS, "command groups"], [WORD_RE, MAX_WORDS, "words"]]
      .map(([re, max, unit]) => [_count(re, full), max, unit]).find(([n, max]) => n > max);
  if (!hit) return null;
  const [n, max, unit] = hit;
  return `${n} ${unit} (limit ${max}) — not analysed; split the command, or a document this size goes through the Write/Edit tool`;
}
