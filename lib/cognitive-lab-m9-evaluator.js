'use strict';

/**
 * M9 value-ledger H1 Lab evaluator (#4063, epic #4060).
 *
 * The preregistration
 * (`docs/task-packs/cog-m9-value-ledger-preregistration-20261029.md`) asks one
 * question: does the ledger's separate `success.p` forecast beat a
 * key-independent base rate that carries the same prior, on the next observed
 * outcome being `confirmed`? The expected reward `V` is NOT that p, so the two
 * are never interchanged. This module owns only the frozen contract and the
 * pure, fail-closed evaluation; the frozen corpus stays in the caller.
 *
 * Time-ordered predict-then-update: every holdout decision's forecast is built
 * from the history available strictly before it, through the pure M9 fold
 * (`buildValueLedger`). The candidate arm is `success.p`; the baseline arm is
 * the same `(nConfirmed+1)/(nObserved+2)` prior applied to the key-independent
 * history. Coverage is reported, never hidden: a decision whose key has no
 * MEASURED support is not silently scored as a win.
 *
 * The paired Brier delta, ECE non-inferiority, equal-budget check and label
 * come from the existing paired-delta contract, so no threshold can be chosen
 * after seeing the data. `assertsGain` is false by construction: better
 * calibration is not task success (§9), and the ledger's own §10 makes a
 * default change a separate PR after a preregistered gain and G3 acceptance.
 */

const { buildValueLedger, MAX_EVENTS } = require('./cognition/value-ledger');
const { rewardForOutcome } = require('./cognition/reward-signal');
const { pairedCalibrationDelta, PAIRED_STATUS } = require('./cognitive-lab-paired-delta');
const { isPlainObject } = require('./is-plain-object');

const SCHEMA_VERSION = 'huqan-cognitive-lab-value-ledger-report-v1';
const M9_MANIFEST_SEED = 40630;
// Locked before the corpus is scored (preregistration §2). The floor of 10
// mirrors the paired-delta contract's own minimum; the ledger's own MIN_SAMPLES
// (3) gates per-key support inside the fold, not the paired sample here.
const CONTRACT = Object.freeze({
  method: 'seeded-paired-bootstrap',
  seed: M9_MANIFEST_SEED,
  resamples: 2000,
  confidenceLevel: 0.95,
  meaningfulEffect: 0,
  nonInferiorityMargin: 0.05,
  minimumSamples: 10,
  direction: 'lower-brier-is-better',
});
const LEDGER_FIELDS = ['workspaceId', 'key', 'decisionId', 'at', 'availableAt', 'outcome', 'sourceGroup', 'sourceRefs'];

// A decision is scorable only for an observed outcome: `confirmed` is 1, every
// other known reward outcome is 0, and an unknown/censored outcome is excluded
// rather than folded as a silent zero.
function observedY(outcome) {
  const reward = rewardForOutcome(outcome);
  if (reward === null) return null;
  return outcome === 'confirmed' ? 1 : 0;
}

function toLedgerRecord(record) {
  const normalized = {};
  for (const field of LEDGER_FIELDS) {
    if (record[field] !== undefined) normalized[field] = record[field];
  }
  return normalized;
}

/** The key-independent base rate with the ledger's own `(n+1)/(n+2)` prior. */
function baseRate(history) {
  let nObserved = 0;
  let nConfirmed = 0;
  for (const record of history) {
    const y = observedY(record.outcome);
    if (y === null) continue;
    nObserved += 1;
    if (y === 1) nConfirmed += 1;
  }
  return (nConfirmed + 1) / (nObserved + 2);
}

function reject(reason, scope = {}) {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    status: 'REJECT',
    reason,
    authority: 'SIGNAL_ONLY',
    workspaceId: scope.workspaceId || null,
    asOf: scope.asOf || null,
    contract: scope.contract || null,
    coverage: null,
    h1: null,
    pairedDelta: null,
    assertsGain: false,
    intelligenceGain: 'NOT_MEASURED',
  });
}

/**
 * Walk the frozen holdout decisions in time order, producing one calibration
 * record per arm. The candidate probability is the key's `success.p` from the
 * pre-decision history; the baseline is the key-independent base rate over the
 * same window. A decision with no MEASURED candidate support is left out of
 * both arms so the pairing stays exact, and the omission is counted.
 */
function walkForward(records, { workspaceId, asOf }) {
  const ledgerRecords = records.map(toLedgerRecord);
  const ordered = records
    .map((record, index) => ({ record, index }))
    .sort((a, b) => Date.parse(a.record.at) - Date.parse(b.record.at)
      || (a.record.decisionId < b.record.decisionId ? -1 : a.record.decisionId > b.record.decisionId ? 1 : 0));
  const baseline = [];
  const candidate = [];
  let holdoutTotal = 0;
  let uncovered = 0;
  for (const { record } of ordered) {
    if (record.split !== 'holdout') continue;
    const y = observedY(record.outcome);
    if (y === null) continue;
    holdoutTotal += 1;
    const boundary = { at: record.at, decisionId: record.decisionId };
    const ledger = buildValueLedger(ledgerRecords, { workspaceId, asOf, historyBoundary: boundary });
    if (ledger.status === 'REJECT') throw new TypeError(`ledger rejected holdout history: ${ledger.reason}`);
    const entry = ledger.entries.find((row) => row.key === record.key);
    if (!entry || entry.status !== 'MEASURED') { uncovered += 1; continue; }
    // The baseline reads the same window as the fold: records whose availability
    // time is at or before the decision, ordered strictly before the boundary,
    // retained to the ledger's own MAX_EVENTS ceiling so the two arms cannot
    // disagree about what "prior" means.
    const priorHistory = ledgerRecords.filter((row) => row.workspaceId === workspaceId
      && row.decisionId !== record.decisionId
      && Date.parse(row.availableAt) <= Date.parse(record.at)
      && (Date.parse(row.at) < Date.parse(record.at)
        || (Date.parse(row.at) === Date.parse(record.at) && row.decisionId < record.decisionId)))
      .slice(-MAX_EVENTS);
    candidate.push({ decisionId: record.decisionId, status: 'observed', probability: entry.success.p, y });
    baseline.push({ decisionId: record.decisionId, status: 'observed', probability: baseRate(priorHistory), y });
  }
  return { baseline, candidate, holdoutTotal, uncovered };
}

/**
 * Score a frozen value-ledger request. The request holds the frozen corpus
 * (`records`), the scope, the preregistered `contract` and optional equal-budget
 * evidence. An empty or unpaired corpus reports INSUFFICIENT; a malformed
 * request throws before any measurement is fabricated.
 */
function evaluateValueLedgerRequest(request) {
  if (!isPlainObject(request)) throw new TypeError('request object required');
  if (!Array.isArray(request.records)) throw new TypeError('records array required');
  const { workspaceId, asOf } = request;
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) throw new TypeError('workspaceId is required');
  if (typeof asOf !== 'string' || !Number.isFinite(Date.parse(asOf))) throw new TypeError('asOf must be an instant');
  const contract = request.contract === undefined ? CONTRACT : request.contract;
  if (request.records.length === 0) {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      status: 'INSUFFICIENT',
      reason: 'no_holdout_records',
      authority: 'SIGNAL_ONLY',
      workspaceId,
      asOf: new Date(asOf).toISOString(),
      contract: null,
      coverage: { holdoutTotal: 0, covered: 0, uncovered: 0 },
      h1: null,
      pairedDelta: null,
      assertsGain: false,
      intelligenceGain: 'NOT_MEASURED',
    });
  }
  const { baseline, candidate, holdoutTotal, uncovered } = walkForward(request.records, { workspaceId, asOf });
  const pairedDelta = pairedCalibrationDelta({
    baseline, candidate, contract, budget: request.budget,
  });
  const coverage = Object.freeze({ holdoutTotal, covered: candidate.length, uncovered });
  const interval = pairedDelta.status === PAIRED_STATUS.MEASURED ? pairedDelta.delta.brier : null;
  // H1 asks one thing: is the ledger's success.p forecast better than the
  // key-independent base rate on paired Brier? The label reads the interval
  // alone; ECE non-inferiority is reported beside it, because the ledger's p is
  // explicitly not calibrated until a calibration measurement says so (§9).
  const h1 = interval === null ? null : Object.freeze({
    label: interval.lower > contract.meaningfulEffect ? 'GAIN'
      : interval.upper < 0 ? 'HARM' : 'NOT_CLEARED',
    mean: interval.mean,
    lower: interval.lower,
    upper: interval.upper,
    confidenceLevel: interval.confidenceLevel,
    eceNonInferior: pairedDelta.delta.ece.nonInferior,
  });
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    status: pairedDelta.status,
    reason: h1 === null ? pairedDelta.reason
      : h1.label === 'GAIN' ? 'paired_gain_measured'
        : h1.label === 'HARM' ? 'interval_upper_below_zero' : 'interval_below_meaningful_effect',
    authority: 'SIGNAL_ONLY',
    workspaceId,
    asOf: new Date(asOf).toISOString(),
    contract: pairedDelta.contract,
    coverage,
    h1,
    pairedDelta,
    // Better calibration is not task success (§9): the ledger never claims a
    // gain here, whatever the paired interval says.
    assertsGain: false,
    intelligenceGain: 'NOT_MEASURED',
  });
}

module.exports = { SCHEMA_VERSION, M9_MANIFEST_SEED, CONTRACT, observedY, baseRate, walkForward, evaluateValueLedgerRequest };
