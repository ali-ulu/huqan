'use strict';

/**
 * Experience Core E0-c — write-cost budget for the fail-closed journal (#2375).
 *
 * Experience is durable, ordered, integrity-protected and **fail-closed**: a
 * failed append fails the execution. That is the right guarantee, and it is
 * also a synchronous SQLite write on the hot path for every lifecycle event.
 * A spend with no ceiling is where a production stall comes from, so this file
 * carries the number and the check; the measurement harness that fills the
 * number in lives in `test/experience-write-cost-budget.test.js`.
 *
 * ## Durable store vs. fail-closed write
 *
 * `lib/experience/journal.js` uses the world's SQLite (`better-sqlite3`)
 * synchronously. Two consequences are recorded here because the plan
 * (`#2375` item 4) asks for them explicitly rather than leaving them implicit:
 *
 * - **Ordering** is guaranteed by the writer, not the store. The journal
 *   assigns `sequence` inside `store.withTransaction`, so concurrent writers
 *   serialise. There is no store-side ordering contract to lean on.
 * - **Behaviour at the ceiling is *block*.** A synchronous driver does not
 *   queue; a slow journal makes the calling step wait. That is a defensible
 *   answer for a fail-closed design — a step must not proceed past a write it
 *   cannot confirm — but it is a different answer from "queue", and until it
 *   is written down the two are indistinguishable in source.
 *
 * This module does not wire that write anywhere. It is the budget the runtime
 * seam wiring (#2378) is then measured against.
 *
 * ## Where the numbers come from
 *
 * Measured on 2026-09-25, this repository, Node 24.21.0, better-sqlite3
 * 12.10.0, 2000 sequential `append()` calls × 3 runs per durability class
 * (median reported), via `lib/sqlite-durability.js`:
 *
 *   RESUMABLE (no fsync)   82 us/append   0.082 ms
 *   EVIDENCE  (fsync)    1303 us/append   1.303 ms
 *
 * A typical ~165-byte event JSON was measured against the same journal for
 * `MAX_JSON_BYTES_PER_EVENT`, and the event-count profile (1-step 7,
 * ten-step 52, ten-step + 3 repairs 61) for `MAX_EVENTS_PER_RUN`.
 *
 * These are design-phase numbers, not live-run evidence. `#2375` keeps its
 * production acceptance (median/p99 from real integrated runs, the disabled
 * path, `#2366` backpressure and `#2399` recovery) open; the harness in the
 * test proves the budget is *enforceable*, not that it has been met in
 * production.
 *
 * Re-measure before moving a store between durability classes: the ratio is
 * per-commit, not per-byte, so a larger payload does not change it.
 */

const MEASURED_DURABILITY_COST = Object.freeze({
  RESUMABLE: Object.freeze({ msPerAppend: 0.082, detail: 'no fsync on commit' }),
  EVIDENCE: Object.freeze({ msPerAppend: 1.303, detail: 'fsync on commit' }),
});

/**
 * Ceilings. A measured run that exceeds any of these is refused rather than
 * reported as fast enough.
 *
 * `MAX_MS_PER_EVENT` sits between the two measured classes and an order of
 * magnitude above the slower one, so it catches a store regression (a missing
 * transaction, a re-opened connection, a synchronous network store) without
 * failing on the fsync class that `#2375` decision 2 permits.
 */
const WRITE_COST_CEILING = Object.freeze({
  MAX_MS_PER_EVENT: 5,
  MAX_JSON_BYTES_PER_EVENT: 4096,
  MAX_EVENTS_PER_RUN: 2000,
});

const WRITE_COST_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REFUSE: 'refuse',
});

const WRITE_COST_REASONS = Object.freeze({
  WITHIN_BUDGET: 'within_budget',
  EVENT_TOO_SLOW: 'write_cost_event_too_slow',
  EVENT_TOO_LARGE: 'write_cost_event_too_large',
  TOO_MANY_EVENTS: 'write_cost_too_many_events',
  UNMEASURED: 'write_cost_unmeasured',
});

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Evaluate one measured run against the budget. Pure: the caller supplies the
 * numbers, this decides.
 *
 * An input that is missing (rather than merely over budget) is refused as
 * `UNMEASURED` rather than allowed: "we did not measure it" is not "it is
 * fine", the same fail-closed stance the journal takes on an unreadable
 * counter.
 *
 * @param {object} sample
 * @param {number} sample.msPerEvent - measured median append cost
 * @param {number} sample.bytesPerEvent - measured median stored event size
 * @param {number} sample.eventsPerRun - events a run produced
 * @param {object} [opts]
 * @param {object} [opts.ceiling] - overrides for the measured ceilings
 */
function evaluateWriteCostBudget(sample = {}, opts = {}) {
  const ceiling = { ...WRITE_COST_CEILING, ...(opts.ceiling || {}) };
  const fields = [
    ['msPerEvent', WRITE_COST_REASONS.EVENT_TOO_SLOW, ceiling.MAX_MS_PER_EVENT],
    ['bytesPerEvent', WRITE_COST_REASONS.EVENT_TOO_LARGE, ceiling.MAX_JSON_BYTES_PER_EVENT],
    ['eventsPerRun', WRITE_COST_REASONS.TOO_MANY_EVENTS, ceiling.MAX_EVENTS_PER_RUN],
  ];

  const measured = {};
  for (const [field] of fields) {
    if (!isFiniteNonNegative(sample[field])) {
      return {
        decision: WRITE_COST_DECISIONS.REFUSE,
        reason: WRITE_COST_REASONS.UNMEASURED,
        detail: `${field} was not measured`,
        measured: sample,
        ceiling,
      };
    }
    measured[field] = sample[field];
  }

  for (const [field, reason, limit] of fields) {
    if (measured[field] > limit) {
      return {
        decision: WRITE_COST_DECISIONS.REFUSE,
        reason,
        detail: `${field}=${measured[field]} exceeds ${limit}`,
        measured,
        ceiling,
      };
    }
  }

  return {
    decision: WRITE_COST_DECISIONS.ALLOW,
    reason: WRITE_COST_REASONS.WITHIN_BUDGET,
    detail: 'measured run is within the write-cost budget',
    measured,
    ceiling,
  };
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (rank - lower);
}

/**
 * Median and p99 of a set of samples — the figure `#2375` asks for in place of
 * a reasoned-about estimate. Non-numeric entries are dropped rather than
 * coerced, so an unmeasured run cannot pass as a fast one.
 */
function summarizeWriteCost(samples = []) {
  const values = samples.filter(isFiniteNonNegative).slice().sort((a, b) => a - b);
  return Object.freeze({
    count: values.length,
    median: percentile(values, 50),
    p99: percentile(values, 99),
    min: values.length ? values[0] : null,
    max: values.length ? values[values.length - 1] : null,
  });
}

module.exports = Object.freeze({
  MEASURED_DURABILITY_COST,
  WRITE_COST_CEILING,
  WRITE_COST_DECISIONS,
  WRITE_COST_REASONS,
  evaluateWriteCostBudget,
  summarizeWriteCost,
});
