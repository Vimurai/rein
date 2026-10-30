// shard-plan.test.mjs — the runner's shard partition (E-386, D-135 r3), tested as the pure
// function it is; it extends select-suites.test.mjs, the runner's other selection layer.
// tests/run.sh only prints what shardPlan returns for its shard.
import { test } from "node:test";
import assert from "node:assert/strict";
import { shardPlan, parseShard, UNKNOWN_HINT_MS } from "../tools/shard-plan.mjs";

// A synthetic census: 13 shared and 4 exclusive suites, two of them with no hint.
const SUITES = [
  ...Array.from({ length: 12 }, (_, k) => ({ name: `s${String(k).padStart(2, "0")}_test.sh`, cls: "shared" })),
  { name: "node_unit_test.sh", cls: "shared" },
  ...["x_tmux_test.sh", "x_port_test.sh", "x_perf_test.sh", "x_inst_test.sh"].map((name) => ({ name, cls: "exclusive" })),
];
const HINTS = new Map([
  ...SUITES.filter((s) => !["s03_test.sh", "x_perf_test.sh"].includes(s.name)).map((s, k) => [s.name, 1000 * ((k * 7) % 13 + 1)]),
  ["node_unit_test.sh", 90000],
]);
const plan = (n, suites = SUITES) => shardPlan({ suites, n, hints: HINTS, pin: ["node_unit_test.sh"] });

test("shards 1..N together hold every suite exactly once, for every N", () => {
  for (const n of [1, 2, 3, 4, 8, 20]) {
    const all = plan(n).flatMap((b) => [...b.shared, ...b.exclusive]).sort();
    assert.deepEqual(all, SUITES.map((s) => s.name).sort(), `n=${n}`);
  }
});

test("the partition is deterministic: input order and repeated calls do not move a suite", () => {
  const shuffled = [...SUITES].reverse();
  assert.deepEqual(plan(4, shuffled), plan(4));
  assert.deepEqual(plan(4), plan(4));
});

test("a class stays in its class, and the exclusive suites spread like the shared ones", () => {
  const bins = plan(4);
  for (const b of bins) {
    assert.ok(b.shared.every((n) => SUITES.find((s) => s.name === n).cls === "shared"));
    assert.ok(b.exclusive.every((n) => SUITES.find((s) => s.name === n).cls === "exclusive"));
  }
  assert.equal(bins.filter((b) => b.exclusive.length).length, 4, "4 exclusive suites over 4 shards: one each");
});

test("the node unit layer is pinned to shard 1, whatever its weight", () => {
  for (const n of [2, 4, 8]) assert.ok(plan(n)[0].shared.includes("node_unit_test.sh"), `n=${n}`);
});

test("greedy to the lightest bin: heaviest first, ties to the lowest shard, then by name", () => {
  const suites = ["b", "a", "c", "d"].map((name) => ({ name, cls: "shared" }));
  const hints = new Map([["a", 5], ["b", 5], ["c", 3], ["d", 1]]);
  const bins = shardPlan({ suites, n: 2, hints });
  assert.deepEqual(bins.map((b) => b.shared), [["a", "c"], ["b", "d"]]);
  assert.deepEqual(bins.map((b) => b.shared_ms), [8, 6]);
});

test("a suite with no hint counts as the median of the known ones; none known → the 30 s default", () => {
  const suites = ["a", "b", "c", "z"].map((name) => ({ name, cls: "shared" }));
  const bins = shardPlan({ suites, n: 1, hints: new Map([["a", 10], ["b", 20], ["c", 60]]) });
  assert.equal(bins[0].shared_ms, 10 + 20 + 60 + 20);
  assert.equal(shardPlan({ suites, n: 1 })[0].shared_ms, 4 * UNKNOWN_HINT_MS);
});

test("parseShard accepts 1 ≤ i ≤ N and nothing else; a duplicate suite is refused", () => {
  assert.deepEqual(parseShard("2/4"), { i: 2, n: 4 });
  for (const bad of ["0/4", "5/4", "1/0", "a/b", "1/", "/4", "1/4/2", "", undefined]) assert.equal(parseShard(bad), null, String(bad));
  assert.throws(() => shardPlan({ suites: [{ name: "a", cls: "shared" }, { name: "a", cls: "shared" }], n: 2 }), /listed twice/);
});

// E-389 (D-135 addendum 2 r4): extends the E-386 partition tests above — `rein ci run` runs the
// unit layer again on shard 1 (its coverage step), so bin 1 starts that much heavier.
test("a seeded bin 1 still holds every suite exactly once, and takes about the seed fewer suite seconds", () => {
  const suites = Array.from({ length: 24 }, (_, k) => ({ name: `t${String(k).padStart(2, "0")}_test.sh`, cls: "shared" }));
  suites.push({ name: "node_unit_test.sh", cls: "shared" });
  const hints = new Map(suites.map((s, k) => [s.name, 10000 + 1000 * (k % 7)]));
  // The unit layer below a fair share (as on Rein: ~25 s of ~400 s over 4 shards).
  hints.set("node_unit_test.sh", 30000);
  const opts = { suites, n: 4, hints, pin: ["node_unit_test.sh"] };
  const seeded = shardPlan({ ...opts, seed: "node_unit_test.sh" });
  assert.deepEqual(seeded.flatMap((b) => [...b.shared, ...b.exclusive]).sort(), suites.map((s) => s.name).sort());
  assert.equal(seeded[0].seed_ms, 30000);
  const suiteSecs = (b) => b.shared_ms - b.seed_ms;   // what the suites themselves weigh
  const others = seeded.slice(1).map(suiteSecs);
  const lighter = Math.min(...others) - suiteSecs(seeded[0]);
  assert.ok(lighter >= 30000 - 16000 && lighter <= 30000 + 16000, `bin 1 is lighter by ${lighter} ms, about the 30000 ms seed (± one suite)`);
  // The total each shard carries comes out level: the seed is balanced, not just added.
  const loads = seeded.map((b) => b.shared_ms);
  assert.ok(Math.max(...loads) - Math.min(...loads) <= 16000, `loads ${loads}`);
});

test("no hint known at all → no seed, and the partition is exactly the unseeded one", () => {
  const suites = ["a", "b", "c", "node_unit_test.sh"].map((name) => ({ name, cls: "shared" }));
  const opts = { suites, n: 2, pin: ["node_unit_test.sh"] };
  assert.deepEqual(shardPlan({ ...opts, seed: "node_unit_test.sh" }), shardPlan(opts));
});
