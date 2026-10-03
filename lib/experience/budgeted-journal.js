'use strict';

const { performance } = require('node:perf_hooks');
const { evaluateWriteCostBudget, summarizeWriteCost } = require('./write-cost-budget');

// A synchronous SQLite write blocks until committed. Report its actual cost
// after acknowledgement; never discard later audit events because a commit was
// slow. The run evaluator can refuse the measured run without erasing history.
function budgetExperienceJournal(journal, { ceiling, now = () => performance.now() } = {}) {
  const samples = new Map();
  const durations = new Map();

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
    const writeCost = evaluateWriteCostBudget({
      msPerEvent: summarizeWriteCost(timings).median,
      bytesPerEvent: Math.max(prior?.bytesPerEvent || 0, bytes),
      eventsPerRun: journal.manifest(event.runId).eventCount,
    }, { ceiling });
    samples.set(event.runId, writeCost);
    return { ...result, writeCost };
  }

  return Object.freeze({ ...journal, append, writeCost: runId => samples.get(runId) || null });
}

module.exports = { budgetExperienceJournal };
