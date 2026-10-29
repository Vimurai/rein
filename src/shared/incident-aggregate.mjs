#!/usr/bin/env node
// E-66/E-67: incident-aggregate.mjs — JIT aggregator for ai-preflight.
//
// Reads ~/.ai-os/incidents.ndjson (E-65), groups by stack_signature, and
// emits a single JSON block to stdout. The ai-preflight skill formats
// the result for the active agent; if any signature has reached the
// threshold (>= INCIDENT_THRESHOLD, default 3) the output carries
// status:"THRESHOLD_REACHED", which the skill turns into an
// [INCIDENT_THRESHOLD_REACHED] preflight context block (E-67).
//
// Budget: <50ms (incident-tracker.md §Execution Constraints). Reads the
// file once, performs a single linear pass, no extra disk I/O.
//
// Honours AI_INCIDENT_TRACKER_DISABLE=1: emits status:"DISABLED" and exits 0.
// Missing log → status:"NO_INCIDENTS". Parse errors per-line are skipped
// (the file is append-only and resilient to partial writes).

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const INCIDENTS_PATH = resolve(homedir(), ".ai-os", "incidents.ndjson");
const THRESHOLD      = Number(process.env.INCIDENT_THRESHOLD || 3);
const TOP_N          = Number(process.env.INCIDENT_TOP_N || 5);

function emit(payload) {
  process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
}

function main() {
  if (process.env.AI_INCIDENT_TRACKER_DISABLE === "1") {
    emit({ status: "DISABLED", threshold: THRESHOLD, groups: [] });
    return 0;
  }
  if (!existsSync(INCIDENTS_PATH)) {
    emit({ status: "NO_INCIDENTS", threshold: THRESHOLD, groups: [] });
    return 0;
  }

  let raw;
  try { raw = readFileSync(INCIDENTS_PATH, "utf8"); } catch (e) {
    emit({ status: "READ_ERROR", threshold: THRESHOLD, groups: [], error: e.message });
    return 0; // fail-open: never block preflight
  }

  // Group by stack_signature.
  const groups = new Map();
  let total = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    const sig = typeof rec.stack_signature === "string" ? rec.stack_signature : "(unknown)";
    if (!groups.has(sig)) {
      groups.set(sig, {
        stack_signature: sig,
        count:           0,
        first_seen:      rec.timestamp || null,
        last_seen:       rec.timestamp || null,
        sample_message:  typeof rec.message === "string" ? rec.message : "",
        incident_types:  new Set(),
        agents:          new Set(),
      });
    }
    const g = groups.get(sig);
    g.count += 1;
    if (rec.timestamp) {
      if (!g.first_seen || rec.timestamp < g.first_seen) g.first_seen = rec.timestamp;
      if (!g.last_seen  || rec.timestamp > g.last_seen)  g.last_seen  = rec.timestamp;
    }
    if (typeof rec.incident_type === "string") g.incident_types.add(rec.incident_type);
    if (typeof rec.source_agent  === "string") g.agents.add(rec.source_agent);
    total += 1;
  }

  // Rank by count desc, take TOP_N. Determinism on ties: keep insertion order.
  const ranked = [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, TOP_N)
    .map(g => ({
      stack_signature: g.stack_signature,
      count:           g.count,
      first_seen:      g.first_seen,
      last_seen:       g.last_seen,
      sample_message:  g.sample_message,
      incident_types:  [...g.incident_types],
      agents:          [...g.agents],
      threshold_reached: g.count >= THRESHOLD,
    }));

  const anyThreshold = ranked.some(g => g.threshold_reached);
  emit({
    status:    anyThreshold ? "THRESHOLD_REACHED" : "OK",
    threshold: THRESHOLD,
    total_incidents: total,
    distinct_signatures: groups.size,
    groups:    ranked,
  });
  return 0;
}

process.exit(main());
