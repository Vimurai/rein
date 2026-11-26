// tests/unit/checks.test.mjs — the check-record grammar in src/shared/checks.mjs (E-478, D-176,
// .ai/blueprints/acceptance-replay.md §Data Model). A new file: no earlier test covers a CHECK
// summary. The add_stamp refusal and the REVIEWS.md line extend the MCP-write-path rows in
// tests/unit/record-store.test.mjs.
//
// Run standalone: node --test tests/unit/checks.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseCheck, parseRetire, parseExpect, expectText, checkStampSummary, COMMAND_MAX } from "../../src/shared/checks.mjs";

test("each expect form parses, and prints back as written", () => {
  for (const [text, kind, value] of [
    ["exit=0", "exit", 0], ["exit=255", "exit", 255], ["empty", "empty", null],
    ["lines=0", "lines", 0], ["lines=3", "lines", 3], ["lines>=1", "lines>=", 1], ["out=ok 2", "out", "ok 2"],
  ]) {
    const e = parseExpect(text);
    assert.deepEqual(e, { kind, value }, text);
    assert.equal(expectText(e), text);
  }
});

test("a well-formed CHECK parses; the command is everything after the second separator, '|' included", () => {
  const r = parseCheck("E-476#3 | lines>=1 | git grep -n 'a | b' -- docs | wc -l", "E-476");
  assert.equal(r.ok, true, r.reason);
  assert.deepEqual(r.check, { id: "E-476#3", task: "E-476", n: 3, expect: { kind: "lines>=", value: 1 },
    command: "git grep -n 'a | b' -- docs | wc -l" });
  assert.equal(checkStampSummary("CHECK", "E-476#3 | empty | git grep -n X -- src", "E-476"), null);
});

test("a well-formed CHECK_RETIRED parses, by a decision, a task or a plan", () => {
  for (const by of ["D-181", "E-490", "P-56"]) {
    const r = parseRetire(`E-476#3 | ${by} | the promise ended | on purpose`, "E-476");
    assert.equal(r.ok, true, r.reason);
    assert.deepEqual(r.retire, { id: "E-476#3", task: "E-476", n: 3, by, reason: "the promise ended | on purpose" });
  }
});

test("each malformed CHECK is refused with [CHECK_MALFORMED] and its reason", () => {
  const long = "x".repeat(COMMAND_MAX + 1);
  for (const [summary, task, reason] of [
    ["E-1#1 | maybe | true", "E-1", /"maybe" is not an expect form/],
    ["E-1#1 | exit=256 | true", "E-1", /"exit=256" is not an expect form/],
    ["E-1#1 | lines=-1 | true", "E-1", /not an expect form/],
    ["E-1#1 | out= | true", "E-1", /not an expect form/],
    ["E-1#1 | out= x | true", "E-1", /not an expect form/],
    ["E-1#1 | empty", "E-1", /must be "<task>#<n> \| … \| …"/],
    ["E-1 | empty | true", "E-1", /"E-1" is not a check id/],
    ["E-1#0 | empty | true", "E-1", /not a check id/],
    ["E-1#1 | empty |  ", "E-1", /the command is empty/],
    [`E-1#1 | empty | ${long}`, "E-1", /at most 400/],
    ["E-1#1 | empty | true\nrm -rf x", "E-1", /one line/],
    ["E-1#1 | empty | true", "E-2", /belongs to E-1, but task_id is E-2/],
    ["E-1#1 | empty | true", undefined, /task_id is \(none\)/],
  ]) {
    const line = checkStampSummary("CHECK", summary, task);
    assert.match(line ?? "", /^\[CHECK_MALFORMED\] CHECK: /, summary);
    assert.match(line, reason, summary);
  }
});

test("each malformed CHECK_RETIRED is refused; other stamp types are never read", () => {
  assert.match(checkStampSummary("CHECK_RETIRED", "E-1#1 | D-x | why", "E-1"), /^\[CHECK_MALFORMED\] CHECK_RETIRED: "D-x" is not a decision or task id/);
  assert.match(checkStampSummary("CHECK_RETIRED", "E-1#1 | D-7 |  ", "E-1"), /the reason is empty/);
  assert.equal(checkStampSummary("ACCEPT_PASS", "anything at all", null), null);
  assert.equal(checkStampSummary("CHECKS_PASS", "[CHECKS_PASS] at abc1234 — 0 hold, 0 retired", null), null);
});

// E-479 security round, F-E479-1: an ESC sequence (or a bidi/format character) made `--list`
// show one command while another ran. Every such character is refused anywhere in a summary.
test("a summary with a control, format or bidi character is refused (the --list spoof)", () => {
  const spoof = "E-10#1 | exit=0 | touch PWNED; true \u001b[2K\u001b[1GE-10#1 | exit=0 | true";
  assert.match(checkStampSummary("CHECK", spoof, "E-10"), /^\[CHECK_MALFORMED\] CHECK: the summary carries a control or format character \(U\+001B\)$/);
  for (const ch of ["\t", "\u007f", "\u0085", "\u200b", "\u202e", "\u2066", "\ufeff"]) {
    assert.match(checkStampSummary("CHECK", `E-1#1 | empty | echo a${ch}b`, "E-1") ?? "", /control or format character/, JSON.stringify(ch));
    assert.match(checkStampSummary("CHECK_RETIRED", `E-1#1 | D-1 | why${ch}`, "E-1") ?? "", /control or format character/, JSON.stringify(ch));
  }
});
