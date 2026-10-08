'use strict';

const { performance } = require('node:perf_hooks');
const { evaluateWriteCostBudget, writeCostGuard, summarizeWriteCost } = require('./write-cost-budget');

// A synchronous SQLite write blocks until committed. Report its actual cost
// after acknowledgement; never discard later audit events because a commit was
// slow. The run evaluator can refuse the measured run without erasing history.
//
// #3495 follow-up: the same wrapper also surfaces the *deterministic* guard
// (bytes per event, events per run). The measured `writeCost` is timing-based
// and host-dependent, so it stays an observability signal; the guard is what a
// live run may refuse on, because it depends only on what the run wrote. The
// read side that turns the guard into a stop lives in `runtime-seam.js`.
function budgetExperienceJournal(journal, { ceiling, now = () => performance.now() } = {}) {
  const samples = new Map();
  const durations = new Map();
  const guards = new Map();

  function append(event, opts) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) return journal.append(event, opts);
    let bytes;
    try { bytes = Buffer.byteLength(JSON.stringify(event), 'utf8'); }
    catch { return { ok: false, code: 'invalid_event' }; }
    const started = now();
    const result = journal.append(event, opts);
    if (!result.ok || result.duplicate) return result;
    const elapsed = now() - started;
    const timings = durations.get(event.runId) || [];
    timings.push(elapsed);
    durations.set(event.runId, timings);
    const prior = samples.get(event.runId)?.measured;
    const measured = {
      msPerEvent: summarizeWriteCost(timings).median,
      bytesPerEvent: Math.max(prior?.bytesPerEvent || 0, bytes),
      eventsPerRun: journal.manifest(event.runId).eventCount,
    };
    const writeCost = evaluateWriteCostBudget(measured, { ceiling });
    samples.set(event.runId, writeCost);
    const guard = writeCostGuard(measured, { ceiling });
    guards.set(event.runId, guard);
    return { ...result, writeCost, writeCostGuard: guard };
  }

  return Object.freeze({
    ...journal,
    append,
    writeCost: runId => samples.get(runId) || null,
    writeCostGuard: runId => guards.get(runId) || null,
  });
}

module.exports = { budgetExperienceJournal };
