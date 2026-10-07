'use strict';

/**
 * B4 learned-procedure-transfer evaluator (#3310 / #3562, program #3306).
 *
 * This is the measurement the B4 preregistration
 * (`docs/task-packs/b4-transfer-preregistration-20261004.md`) asks for, lifted
 * out of `test/cognitive-lab-b4-transfer.test.js` so a lab runner can emit a
 * Cognitive Lab manifest for the B4 mechanism (§15). The corpus and the arms
 * stay in the test harness because building them drives the real coder runtime;
 * this module owns only the frozen contract and the pure, fail-closed evaluator.
 *
 * Conservative about any gain claim, by construction:
 *
 * - The contract (metric, direction, seed, resamples, confidence, meaningful
 *   effect, wrong-write tolerance, fixed minimum sample and fixed minimum
 *   transfer) is locked before a single outcome is scored; an unknown, missing
 *   or invalid field is rejected, so no threshold can be chosen after seeing the
 *   data. The minimums are fixed in the contract, not derived from the corpus.
 * - Every observation is validated: each arm's binary outcome must agree with
 *   its changed set, budgets must be equal, and the splits must not leak. Any
 *   A2 wrong write is a trust regression and the verdict is REJECT, whatever the
 *   interval says; the diagnostic delta is still reported.
 * - The §10 kill criteria return INSUFFICIENT: too few pairs, no counter-case
 *   (class iii), or a corpus where the gates never changed an outcome.
 *
 * `intelligenceGain` stays NOT_MEASURED and the result is candidate-only: a
 * verdict here is an experimental ranking, never a promoted rule.
 */

const { createPairedSampler } = require('./cognitive-lab-paired-delta');

const B4_MANIFEST_SEED = 33100;
const ARMS = Object.freeze(['A0', 'A1', 'A2']);
const MECHANISM_IDS = Object.freeze(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8']);
const MECHANISM_FLAGS = Object.freeze({ B4: 'ENABLED' });

// Approved 4 Oct 2026 (§7). Every field is required; nothing is chosen at
// scoring time, and the minimums are constants, not corpus length.
const CONTRACT = Object.freeze({
  metric: 'correct-outcome-rate',
  direction: 'higher-is-better',
  seed: 3310,
  resamples: 2000,
  confidenceLevel: 0.95,
  meaningfulEffect: 0,
  wrongWriteTolerance: 0,
  minimumSamples: 24,
  minimumTransfer: 8,
});

// One predicate per field, looked up rather than chained: adding a field is a
// table entry, not another branch in a dispatch that grows with it.
const CONTRACT_SPEC = Object.freeze({
  metric: (value) => value === 'correct-outcome-rate',
  direction: (value) => value === 'higher-is-better',
  seed: (value) => Number.isInteger(value) && value >= 0,
  resamples: (value) => Number.isInteger(value) && value >= 100,
  confidenceLevel: (value) => typeof value === 'number' && value > 0 && value < 1,
  meaningfulEffect: (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0,
  wrongWriteTolerance: (value) => Number.isInteger(value) && value >= 0,
  minimumSamples: (value) => Number.isInteger(value) && value >= 1,
  minimumTransfer: (value) => Number.isInteger(value) && value >= 1,
});

function lockContract(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('contract is required');
  for (const field of Object.keys(raw)) {
    if (!Object.hasOwn(CONTRACT_SPEC, field)) throw new Error(`unknown contract field ${field}`);
  }
  for (const [field, valid] of Object.entries(CONTRACT_SPEC)) {
    if (!Object.hasOwn(raw, field)) throw new Error(`missing contract field ${field}`);
    if (!valid(raw[field])) throw new Error(`invalid contract field ${field}`);
  }
  return Object.freeze({ ...raw });
}

function mechanismsReport() {
  return Object.freeze(Object.fromEntries(MECHANISM_IDS.map((id) => [id, MECHANISM_FLAGS[id] || 'NOT_MEASURED'])));
}

function bootstrapInterval(deltas, contract) {
  const random = createPairedSampler(contract.seed);
  const means = [];
  for (let i = 0; i < contract.resamples; i += 1) {
    let sum = 0;
    for (let j = 0; j < deltas.length; j += 1) sum += deltas[Math.floor(random() * deltas.length)];
    means.push(sum / deltas.length);
  }
  means.sort((a, b) => a - b);
  const alpha = 1 - contract.confidenceLevel;
  const at = (fraction) => means[Math.min(means.length - 1, Math.max(0, Math.floor(fraction * means.length)))];
  return { lower: at(alpha / 2), upper: at(1 - alpha / 2) };
}

/**
 * A record is only scorable when each arm's binary outcome agrees with its
 * changed set. A missing arm, a non-binary outcome or a changed set that
 * contradicts the outcome is not a measurement; it is rejected rather than
 * silently scored.
 */
function observationError(record) {
  for (const arm of [...ARMS, 'O']) {
    const run = record[arm];
    if (!run || !Array.isArray(run.changed)) return `missing_${arm}`;
    if (![0, 1].includes(run.correct) || ![0, 1].includes(run.wrongWrite)) return `invalid_${arm}_outcome`;
    if (run.correct && run.wrongWrite) return `inconsistent_${arm}_outcome`;
    if (run.wrongWrite && run.changed.length === 0) return `inconsistent_${arm}_outcome`;
    if (record.expected === 'refuse' && run.correct !== (run.changed.length === 0 ? 1 : 0)) return `inconsistent_${arm}_outcome`;
    if (record.expected === 'change' && !run.correct && run.changed.length > 0 && !run.wrongWrite) return `inconsistent_${arm}_outcome`;
  }
  return null;
}

const sum = (records, arm, field = 'correct') => records.reduce((total, record) => total + record[arm][field], 0);
const mean = (values) => values.reduce((total, value) => total + value, 0) / values.length;

/**
 * Evaluate paired transfer records against the frozen contract.
 *
 * @param {ReadonlyArray<object>} records one observation per task
 * @param {object} rawContract the preregistered contract; re-locked here so a
 *   caller cannot score against a threshold it chose after seeing the data.
 * @param {{tasks?: ReadonlyArray<object>, trainContents?: Iterable<string>}} options
 *   the frozen task list and the set of train target contents; a holdout or
 *   transfer task whose target content is a train content is split leakage.
 * @returns {Readonly<object>} a typed report; `assertsGain` is true only when no
 *   arm wrote a wrong change and the lower bootstrap bound clears the effect.
 */
function evaluate(records, rawContract, { tasks = [], trainContents = [] } = {}) {
  const contract = lockContract(rawContract);
  const ids = records.map((record) => record.taskId);
  if (new Set(ids).size !== ids.length) return { status: 'REJECT', reason: 'duplicated_observation', assertsGain: false };
  for (const record of records) {
    const error = observationError(record);
    if (error) return { status: 'REJECT', reason: error, assertsGain: false };
    if (ARMS.some((arm) => record[arm].dispatches !== 1)) return { status: 'REJECT', reason: 'budget_mismatch', assertsGain: false };
  }
  const train = trainContents instanceof Set ? trainContents : new Set(trainContents);
  if (tasks.some((task) => task.split !== 'train' && train.has(task.tree[task.targetPath]))) {
    return { status: 'REJECT', reason: 'split_leakage', assertsGain: false };
  }
  const holdout = records.filter((record) => record.split === 'holdout');
  const transfer = records.filter((record) => record.split === 'transfer');
  if (holdout.length < contract.minimumSamples || transfer.length < contract.minimumTransfer) {
    return { status: 'INSUFFICIENT', reason: 'sample_below_minimum', assertsGain: false };
  }
  if (!holdout.some((record) => record.class === 'iii')) return { status: 'INSUFFICIENT', reason: 'missing_counter_cases', assertsGain: false };
  if (holdout.every((record) => record.A1.correct === record.A2.correct)) {
    return { status: 'INSUFFICIENT', reason: 'gates_inert', assertsGain: false };
  }
  const primary = holdout.map((record) => record.A2.correct - record.A1.correct);
  const secondary = holdout.map((record) => record.A2.correct - record.A0.correct);
  const report = {
    holdoutSize: holdout.length,
    correct: Object.fromEntries([...ARMS, 'O'].map((arm) => [arm, sum(holdout, arm)])),
    transferCorrect: Object.fromEntries([...ARMS, 'O'].map((arm) => [arm, sum(transfer, arm)])),
    wrongWrites: Object.fromEntries(ARMS.map((arm) => [arm, sum(records, arm, 'wrongWrite')])),
    primary: { mean: mean(primary), interval: bootstrapInterval(primary, contract) },
    secondary: { mean: mean(secondary), interval: bootstrapInterval(secondary, contract) },
    oracleRecovery: sum(holdout, 'A2') / sum(holdout, 'O'),
    mechanisms: mechanismsReport(),
    intelligenceGain: 'NOT_MEASURED',
  };
  report.clearsEffect = report.primary.interval.lower > contract.meaningfulEffect;
  if (report.wrongWrites.A2 > contract.wrongWriteTolerance) {
    return { status: 'REJECT', reason: 'candidate_wrong_write', assertsGain: false, ...report };
  }
  return {
    status: 'MEASURED',
    reason: report.clearsEffect ? 'paired_gain_measured' : 'interval_below_meaningful_effect',
    assertsGain: report.clearsEffect,
    ...report,
  };
}

module.exports = {
  B4_MANIFEST_SEED,
  ARMS,
  MECHANISM_IDS,
  MECHANISM_FLAGS,
  CONTRACT,
  CONTRACT_SPEC,
  lockContract,
  mechanismsReport,
  bootstrapInterval,
  observationError,
  evaluate,
};
