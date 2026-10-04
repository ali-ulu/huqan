'use strict';

const { computeManifestDigest } = require('./cognitive-lab-manifest');
const { calibrate, ADVERSE_STATES } = require('./cognitive-lab-probability-calibration');
const { pairedCalibrationDelta, createPairedSampler, pairedPercentile } = require('./cognitive-lab-paired-delta');
const { budgetUsageCheck } = require('./cognitive-lab-budget-envelope');
const { verifyComparisonManifest, VARIANTS, pairedComparisonContract, comparisonBudgetEnvelope } = require('./cognitive-lab-comparison-contract');

const COUNTERS = Object.freeze(['modelCalls', 'toolCalls', 'humanCalls', 'tokens', 'wallTimeMs', 'compute']);

function refusal(reason, detail) {
  return { status: 'REJECT', calibrationComparison: 'NOT_MEASURED', intelligenceGain: 'NOT_MEASURED', assertsGain: false, reason, detail };
}

function inspectBudget(manifest, budgets) {
  const cap = manifest.experiment.budget;
  const unknown = [];
  for (const variant of VARIANTS) {
    const entry = budgets && budgets[variant];
    if (!entry || !entry.envelope || !entry.usage) return { status: 'INSUFFICIENT', reason: 'budget_missing' };
    if (computeManifestDigest(entry.envelope) !== computeManifestDigest(cap)) return { status: 'REJECT', reason: 'budget_mismatch' };
    if (Object.keys(entry.usage).some(k => !COUNTERS.includes(k))) return { status: 'REJECT', reason: 'budget_unknown_field' };
    for (const counter of COUNTERS) {
      const used = entry.usage[counter];
      if (used === null || used === undefined || cap[counter] === null) {
        unknown.push(`${variant}.${counter}`);
      } else if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) {
        return { status: 'REJECT', reason: 'budget_invalid' };
      } else if (counter.endsWith('Calls') && !Number.isSafeInteger(used)) {
        return { status: 'REJECT', reason: 'budget_invalid_calls' };
      } else if (used > cap[counter]) return { status: 'REJECT', reason: 'budget_exceeded' };
    }
  }
  const usage = variant => ({ tokens: budgets[variant].usage.tokens,
    calls: ['modelCalls', 'toolCalls', 'humanCalls'].reduce((sum, key) => sum + budgets[variant].usage[key], 0) });
  const pairedInput = unknown.length ? null : { envelope: comparisonBudgetEnvelope(cap),
    baselineUsage: usage('baseline'), candidateUsage: usage('candidate') };
  const canonicalCheck = pairedInput && budgetUsageCheck({ envelope: pairedInput.envelope,
    baseline: pairedInput.baselineUsage, candidate: pairedInput.candidateUsage });
  if (canonicalCheck?.status === 'REJECT') return { status: 'REJECT', reason: canonicalCheck.reason, canonicalCheck };
  return {
    status: unknown.length ? 'INSUFFICIENT' : 'MEASURED', reason: unknown.length ? 'budget_unknown' : 'equal_reported_tokens_calls',
    envelopeHash: computeManifestDigest(cap), usageEvidence: 'CALLER_REPORTED', unknown,
    baseline: budgets.baseline.usage, candidate: budgets.candidate.usage, canonicalCheck, pairedInput,
  };
}

function indexRecords(records, tasks) {
  if (!Array.isArray(records)) throw new TypeError('records must be arrays');
  const allowed = new Set(tasks.filter(t => t.split !== 'train').map(t => t.taskId));
  const indexed = new Map();
  for (const record of records) {
    if (!record || !allowed.has(record.decisionId) || indexed.has(record.decisionId)) {
      throw new TypeError('unknown, train, or duplicate decision in comparison');
    }
    indexed.set(record.decisionId, record);
  }
  return indexed;
}

function scoreable(record) {
  return record.status === 'observed' && (record.y === 0 || record.y === 1)
    && typeof record.probability === 'number' && Number.isFinite(record.probability)
    && record.probability >= 0 && record.probability <= 1;
}

function matchesOutcome(record) {
  return record.y === (record.outcome === 'confirmed' ? 1 : ADVERSE_STATES.includes(record.outcome) ? 0 : null);
}

// ECE is nonlinear: extend the canonical paired sampler with an ECE interval.
// Brier's point/interval/gain remain owned by pairedCalibrationDelta.
function pairedEceInterval(left, right, protocol, contract) {
  const random = createPairedSampler(contract.seed);
  const samples = [];
  for (let iteration = 0; iteration < contract.resamples; iteration += 1) {
    const baseline = [];
    const candidate = [];
    for (let i = 0; i < left.length; i += 1) {
      const index = Math.floor(random() * left.length);
      // Bootstrap replicas are temporary draws, not extra independent ledger samples.
      baseline.push({ ...left[index], decisionId: `draw:${i}` });
      candidate.push({ ...right[index], decisionId: `draw:${i}` });
    }
    const a = calibrate(baseline, protocol);
    const b = calibrate(candidate, protocol);
    samples.push(b.ece - a.ece);
  }
  const tail = (1 - contract.confidenceLevel) / 2;
  samples.sort((a, b) => a - b);
  return { lower: pairedPercentile(samples, tail), upper: pairedPercentile(samples, 1 - tail) };
}

function negate(value) { return value === 0 ? 0 : -value; }

function compareSplit(name, manifest, baseline, candidate, budget) {
  const tasks = manifest.tasks.filter(t => t.split === name);
  const counts = { attempt: tasks.length, eligible: 0, observed: 0, censored: 0, missing: 0, measurement_error: 0 };
  const left = [];
  const right = [];
  for (const task of tasks) {
    const a = baseline.get(task.taskId);
    const b = candidate.get(task.taskId);
    if (!a || !b || a.status === 'missing' || b.status === 'missing') counts.missing += 1;
    else {
      counts.eligible += 1;
      if (a.status === 'censored' || b.status === 'censored') counts.censored += 1;
      else if (!scoreable(a) || !scoreable(b)) counts.measurement_error += 1;
      else {
        if (!matchesOutcome(a) || !matchesOutcome(b) || a.y !== b.y || a.outcome !== b.outcome) {
          throw new TypeError('paired outcomes must identify the same observed event');
        }
        counts.observed += 1;
        left.push(a);
        right.push(b);
      }
    }
  }
  const measured = counts.observed >= manifest.protocol.minObserved && counts.observed === counts.attempt;
  if (!measured) return { status: 'INSUFFICIENT', counts, baseline: null, candidate: null, delta: null, intervals: null, calibrationComparison: 'NOT_MEASURED' };
  const a = calibrate(left, manifest.protocol);
  const b = calibrate(right, manifest.protocol);
  const contract = pairedComparisonContract(manifest, name);
  const paired = pairedCalibrationDelta({ baseline: left, candidate: right, contract, budget: budget.pairedInput });
  const delta = { brier: negate(paired.delta.brier.mean), ece: paired.delta.ece.value };
  const intervals = { brier: { lower: negate(paired.delta.brier.upper), upper: negate(paired.delta.brier.lower) },
    ece: pairedEceInterval(left, right, manifest.protocol, contract) };
  const tolerance = manifest.protocol.nonInferiority;
  const regression = intervals.brier.lower > tolerance.brier || intervals.ece.lower > tolerance.ece;
  const improved = paired.gain && intervals.ece.upper <= tolerance.ece;
  return {
    status: 'MEASURED', counts, baseline: a, candidate: b, delta, intervals, pairedContract: contract,
    calibrationComparison: regression ? 'REGRESSION' : improved ? 'MEANINGFUL_IMPROVEMENT' : 'NO_MEANINGFUL_IMPROVEMENT',
  };
}

function compareCalibration({ design, baseline, candidate, budgets } = {}) {
  let checked;
  try { checked = verifyComparisonManifest(design); }
  catch (error) { return refusal('invalid_manifest', error.message); }
  const { manifest, digest } = checked;
  const budget = inspectBudget(manifest, budgets);
  if (budget.status === 'REJECT') return refusal(budget.reason, 'budget cannot support a same-envelope comparison');
  let splits;
  try {
    const left = indexRecords(baseline, manifest.tasks);
    const right = indexRecords(candidate, manifest.tasks);
    splits = Object.fromEntries(['holdout', 'transfer'].map(name => [name, compareSplit(name, manifest, left, right, budget)]));
  } catch (error) { return refusal('pair_integrity', error.message); }
  const measured = budget.status === 'MEASURED' && Object.values(splits).every(s => s.status === 'MEASURED');
  const statuses = Object.values(splits).map(s => s.calibrationComparison);
  return {
    schemaVersion: 'huqan-cognitive-lab-comparison-result-v1', status: measured ? 'MEASURED' : 'INSUFFICIENT',
    designDigest: digest, splits, budget, uncertainty: manifest.protocol.uncertainty,
    calibrationComparison: !measured ? 'NOT_MEASURED' : statuses.includes('REGRESSION') ? 'REGRESSION'
      : statuses.every(s => s === 'MEANINGFUL_IMPROVEMENT') ? 'MEANINGFUL_IMPROVEMENT' : 'NO_MEANINGFUL_IMPROVEMENT',
    intelligenceGain: 'NOT_MEASURED', assertsGain: false,
  };
}

module.exports = { COUNTERS, compareCalibration };
