'use strict';

/**
 * Cognitive Lab B1 baseline replay runner (#3375, slice 3307-S2).
 *
 * Slice S1 shipped the strict experiment manifest -- the frozen description an
 * experiment is reproduced from. This slice is the runner that replays a run of
 * that experiment against the existing B1 belief-revision workflow and reports
 * the counts a reader needs to trust the number: how many examples were
 * eligible, how many produced an observed outcome, how many were censored, and
 * how many simply were not there. It adds no engine and no authority.
 * The B1 workflow is the one the product already runs. A prediction is recorded
 * with `recordPrediction` under the same `inference-rule:<ruleId>` action class
 * `lib/inference-runtime-beliefs.js` uses, its outcome is recorded with
 * `recordOutcome`, and `calibrateRuleBeliefFromStore` reads those rows back and
 * calibrates. The runner composes those calls; it does not reimplement them.
 * Replay correctness is a digest of the outcome that must not depend on when
 * the replay ran. `at` timestamps are inputs to the underlying primitives, so
 * they are fixed from the run (`recordedAt`/`outcomeAt`), never read from a
 * clock here, and the digest is taken over a canonical projection that omits
 * the history timestamps. Replaying a deterministic baseline therefore yields
 * one correctness digest; the same run's wall-clock observations live outside
 * it, so progress and regression are told apart by more than one number.
 * Authority is unchanged. The replay writes prediction/outcome pairs and reads
 * them back; it derives no fact, admits no candidate and promotes nothing. The
 * result is a measurement, never canonical knowledge.
 * Scope: a pure module plus its tests (#3375). No wiring, activation, policy,
 * receipt or release surface is touched.
 */

const { isPlainObject } = require('./is-plain-object');
const { contentHash } = require('./content-hash');
const { recordPrediction, recordOutcome, readPredictionPairs } = require('./prediction-outcome-pairs');
const {
  CALIBRATION_STATUS,
  EFFECT_KIND,
  calibrateRuleBeliefFromStore,
} = require('./inference-belief-revision');
const {
  MANIFEST_STATUS,
  verifyManifestDigest,
} = require('./cognitive-lab-manifest');
const REPLAY_SCHEMA_VERSION = 'huqan-cognitive-lab-b1-replay-v1';

const REPLAY_STATUS = Object.freeze({
  REPLAYED: 'REPLAYED',
  INSUFFICIENT: 'INSUFFICIENT',
  REJECT: 'REJECT',
});

const REPLAY_ERROR_CODES = Object.freeze({
  INVALID_INPUT: 'replay_invalid_input',
  INVALID_MANIFEST: 'replay_invalid_manifest',
  DIGEST_MISMATCH: 'replay_digest_mismatch',
  OVERLAP: 'replay_split_overlap',
  BUDGET_MISMATCH: 'replay_budget_mismatch',
  B2_PRESENT: 'replay_unexpected_mechanism',
  INSUFFICIENT_DATA: 'replay_insufficient_data',
  FORGED_OBSERVATION: 'replay_forged_observation',
  UNSUPPORTED: 'replay_unsupported_benchmark',
});
const SUPPORTED_BENCHMARKS = Object.freeze(['B1']);
const MEASURED_MECHANISM = 'B1';
/**
 * A typed replay failure. `code` is a REPLAY_ERROR_CODES value and `path` the
 * dotted location of the offending input, so a caller reacts to the failure
 * instead of parsing a message.
 */
class CognitiveLabReplayError extends Error {
  constructor(code, path, message) {
    super(message);
    this.name = 'CognitiveLabReplayError';
    this.code = code;
    this.path = path;
  }
}

function reject(code, path, message, integrity = null, status = REPLAY_STATUS.REJECT) {
  return Object.freeze({
    schemaVersion: REPLAY_SCHEMA_VERSION,
    status,
    benchmark: null,
    correctnessDigest: null,
    counts: null,
    belief: null,
    mechanisms: null,
    integrity,
    error: Object.freeze({ code, path, message }),
  });
}

function integrityFailure(code, detail) {
  return Object.freeze({ status: 'REJECT', code, detail });
}

function freezeCounts(counts) {
  return Object.freeze({ ...counts });
}

/**
 * The design a replay may run under: the frozen manifest names it, and a design
 * that would make its own result incomparable is rejected rather than measured.
 */
function validateDesign(experiment) {
  if (!isPlainObject(experiment)) {
    throw new CognitiveLabReplayError(REPLAY_ERROR_CODES.INVALID_INPUT, 'experiment', 'experiment must be an object');
  }
  if (typeof experiment.benchmark !== 'string' || !SUPPORTED_BENCHMARKS.includes(experiment.benchmark)) {
    throw new CognitiveLabReplayError(REPLAY_ERROR_CODES.UNSUPPORTED, 'experiment.benchmark', 'this slice replays the B1 baseline only');
  }
  if (!isPlainObject(experiment.split)
    || !Array.isArray(experiment.split.train) || !Array.isArray(experiment.split.holdout)
    || !Array.isArray(experiment.split.transfer)) {
    throw new CognitiveLabReplayError(REPLAY_ERROR_CODES.INVALID_INPUT, 'experiment.split', 'split must name train, holdout and transfer id lists');
  }
  if (!isPlainObject(experiment.budget) || !Number.isInteger(experiment.budget.modelCalls) || experiment.budget.modelCalls < 1) {
    throw new CognitiveLabReplayError(REPLAY_ERROR_CODES.INVALID_INPUT, 'experiment.budget', 'budget.modelCalls must be a positive integer');
  }
  if (!isPlainObject(experiment.mechanisms)
    || typeof experiment.mechanisms.B1 !== 'string' || experiment.mechanisms.B1 !== 'ENABLED') {
    throw new CognitiveLabReplayError(REPLAY_ERROR_CODES.INVALID_INPUT, 'experiment.mechanisms.B1', 'B1 must be ENABLED for a B1 baseline replay');
  }
  const measurable = ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8'];
  for (const id of measurable) {
    if (experiment.mechanisms[id] !== 'NOT_MEASURED') {
      throw new CognitiveLabReplayError(REPLAY_ERROR_CODES.B2_PRESENT, `experiment.mechanisms.${id}`, `${id} must be NOT_MEASURED; this slice measures B1 only`);
    }
  }

  const train = new Set(experiment.split.train.map(String));
  const holdout = [...new Set(experiment.split.holdout.map(String))];
  const transfer = experiment.split.transfer.map(String);
  if (holdout.some((id) => train.has(id))) {
    throw new CognitiveLabReplayError(REPLAY_ERROR_CODES.OVERLAP, 'experiment.split.holdout', 'a holdout id also appears in train');
  }
  if (transfer.some((id) => train.has(id) || holdout.includes(id))) {
    throw new CognitiveLabReplayError(REPLAY_ERROR_CODES.OVERLAP, 'experiment.split.transfer', 'a transfer id also appears in train or holdout');
  }
  if (holdout.length === 0) {
    throw new CognitiveLabReplayError(REPLAY_ERROR_CODES.INSUFFICIENT_DATA, 'experiment.split.holdout', 'holdout is empty; there is nothing to replay');
  }
  const outcomes = isPlainObject(experiment.outcomes) ? experiment.outcomes : {};
  const observations = isPlainObject(experiment.observations) ? experiment.observations : {};
  return Object.freeze({
    transfer: Object.freeze(transfer),
    benchmark: experiment.benchmark,
    train: Object.freeze([...train]),
    holdout: Object.freeze(holdout),
    ingested: Object.freeze([...new Set([...train, ...holdout])]),
    modelCalls: experiment.budget.modelCalls,
    mechanisms: Object.freeze({ ...experiment.mechanisms }),
    outcomes: Object.freeze({ ...outcomes }),
    observations: Object.freeze({ ...observations }),
    recordedAt: typeof experiment.recordedAt === 'string' ? experiment.recordedAt : '1970-01-01T00:00:00.000Z',
    outcomeAt: typeof experiment.outcomeAt === 'string' ? experiment.outcomeAt : '1970-01-02T00:00:00.000Z',
  });
}

/**
 * The design must be the one the verified manifest describes. The digest proves
 * the manifest is intact, so a design that disagrees is a caller measuring a
 * different experiment under a valid manifest; every difference is rejected
 * rather than measured.
 */
function compareDesignToManifest(design, manifest) {
  const canonical = (ids) => [...new Set((Array.isArray(ids) ? ids : []).map(String))].sort().join(',');
  const mismatch = (path, message) => {
    throw new CognitiveLabReplayError(REPLAY_ERROR_CODES.BUDGET_MISMATCH, path, message);
  };
  if (canonical(design.train) !== canonical(manifest.split.train)) mismatch('experiment.split.train', 'train split does not match the frozen manifest');
  if (canonical(design.holdout) !== canonical(manifest.split.holdout)) mismatch('experiment.split.holdout', 'holdout split does not match the frozen manifest');
  if (canonical(design.transfer) !== canonical(manifest.split.transfer)) mismatch('experiment.split.transfer', 'transfer split does not match the frozen manifest');
  if (design.modelCalls !== manifest.budget.modelCalls) mismatch('experiment.budget.modelCalls', 'modelCalls budget does not match the frozen manifest');
  for (const id of ['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8']) {
    if (design.mechanisms[id] !== manifest.mechanisms[id]) mismatch(`experiment.mechanisms.${id}`, `${id} mechanism flag does not match the frozen manifest`);
  }
}

/**
 * The B1 workflow, kept in one function so the runner has a single call site to
 * exercise. Mode is written to the recorded rows because a later observer must
 * be able to tell a real run from a re-run without trusting the caller.
 */
function replayWorkflow(graph, design, ruleId, declaredConfidence, mode) {
  const actionClass = `inference-rule:${ruleId}`;
  const ingested = design.ingested;
  for (const decisionId of ingested) {
    recordPrediction(graph, { decisionId, score: 80, actionClass, at: design.recordedAt });
    const label = design.outcomes[decisionId];
    if (label === undefined || label === 'missing') continue;
    recordOutcome(graph, { decisionId, outcome: label, idempotencyKey: `outcome:${decisionId}`, at: design.outcomeAt });
  }
  if (mode === 'holdout-copy-to-train') {
    // A deliberately wrong workflow: the holdout labels enter the store again
    // as fresh training pairs. They are counted by calibration while sitting
    // outside the frozen split, which is exactly the leakage the evaluator
    // refuses to report as a clean run.
    for (const decisionId of design.holdout) {
      recordPrediction(graph, { decisionId: `leak:${decisionId}`, score: 80, actionClass, at: design.recordedAt });
      recordOutcome(graph, { decisionId: `leak:${decisionId}`, outcome: design.outcomes[decisionId] || 'confirmed', idempotencyKey: `copy:${decisionId}`, at: design.outcomeAt });
    }
  }
  const pairs = readPredictionPairs(graph);
  const effectEvidence = ingested
    .filter((decisionId) => design.observations[decisionId] !== undefined)
    .map((decisionId) => ({ decisionId, kind: design.observations[decisionId] }));
  const belief = calibrateRuleBeliefFromStore(graph, { ruleId, declaredConfidence, at: design.outcomeAt, effectEvidence });
  // The frozen design names every decision the workflow ingests, so a persisted
  // prediction outside that set means the store was written outside the split.
  // The evaluator refuses to score a store it cannot reproduce from the
  // manifest rather than quietly reporting a number from leaked rows.
  const declared = new Set(ingested.map(String));
  const bypass = Object.keys(pairs).filter((decisionId) => !declared.has(String(decisionId)));
  return { pairs, belief, bypass };
}

function isForged(belief, pairs) {
  // A counted decision whose row is not actually present, or whose declared
  // effect was not observed, must never be reported as an observed sample.
  for (const decisionId of belief.countedDecisionIds) {
    const pair = pairs[decisionId];
    if (!pair || !pair.prediction || !pair.outcome) return true;
  }
  return false;
}

function countOutcomes(ingested, pairs, belief, observations) {
  const counted = new Set(belief.countedDecisionIds);
  const censoredIds = new Set();
  const missingIds = new Set();
  const reportedIds = new Set();
  const uncountedIds = new Set();
  for (const decisionId of ingested) {
    const pair = pairs[decisionId];
    if (!pair || !pair.outcome) {
      missingIds.add(decisionId);
      continue;
    }
    if (pair.outcome.state === 'censored') {
      censoredIds.add(decisionId);
      continue;
    }
    if (counted.has(decisionId)) continue;
    if (observations[decisionId] === EFFECT_KIND.REPORTED) reportedIds.add(decisionId);
    else uncountedIds.add(decisionId);
  }
  return freezeCounts({
    attempt: ingested.length, eligible: 0, ingested: ingested.length,
    observed: counted.size,
    censored: censoredIds.size,
    missing: missingIds.size,
    reported: reportedIds.size,
    measurement_error: uncountedIds.size, uncounted: uncountedIds.size,
    censoredIds: Object.freeze([...censoredIds].sort()),
    missingIds: Object.freeze([...missingIds].sort()),
    reportedIds: Object.freeze([...reportedIds].sort()),
  });
}

function projectBelief(belief) {
  return Object.freeze({
    status: belief.status,
    reason: belief.reason,
    declaredConfidence: belief.declaredConfidence,
    calibratedConfidence: belief.calibratedConfidence,
    systemConfidence: belief.systemConfidence,
    observedSamples: belief.observedSamples,
    observedSuccesses: belief.observedSuccesses,
    observedFailures: belief.observedFailures,
  });
}

function correctnessDigest(design, counts, belief) {
  // Deterministic by construction: only the frozen inputs and the outcome
  // counts enter the digest. `history` carries timestamps and is excluded.
  return contentHash(JSON.stringify({
    schemaVersion: REPLAY_SCHEMA_VERSION,
    benchmark: design.benchmark,
    modelCalls: design.modelCalls,
    split: { train: [...design.train].sort(), holdout: [...design.holdout].sort() },
    counts: {
      eligible: counts.eligible,
      observed: counts.observed,
      censored: counts.censored,
      missing: counts.missing,
      reported: counts.reported,
      uncounted: counts.uncounted,
    },
    belief: {
      status: belief.status,
      reason: belief.reason,
      observedSamples: belief.observedSamples,
      observedSuccesses: belief.observedSuccesses,
      observedFailures: belief.observedFailures,
      systemConfidence: belief.systemConfidence,
    },
  }));
}

function mechanismsReport(design) {
  const report = { B1: design.benchmark === 'B1' ? 'MEASURED' : 'NOT_MEASURED' };
  for (const id of ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8']) report[id] = 'NOT_MEASURED';
  return Object.freeze(report);
}

/**
 * Replay a frozen B1 baseline manifest against the existing belief workflow.
 *
 * @param {object} graph a graph store exposing the prediction-outcome surface
 * @param {object} input `{ manifest, experiment }`; a manifest whose digest is
 *   checked before the run and an experiment whose split, budget and mechanism
 *   flags are validated as a B1 design.
 * @param {{mode?: string, ruleId?: string, declaredConfidence?: number}} opts
 * @returns {Readonly<object>} a typed result; `correctnessDigest` is stable
 *   across replays of the same frozen inputs, and REJECT/INSUFFICIENT results
 *   carry no digest.
 */
function replayBaseline(graph, input = {}, opts = {}) {
  if (!isPlainObject(input)) return reject(REPLAY_ERROR_CODES.INVALID_INPUT, 'input', 'input must be an object');
  if (!isPlainObject(input.manifest) || typeof input.manifestDigest !== 'string' || input.manifestDigest === '') {
    return reject(REPLAY_ERROR_CODES.INVALID_INPUT, 'manifest', 'a manifest object and its expected digest are required');
  }
  let design;
  try {
    const manifestVerdict = verifyManifestDigest(input.manifest, input.manifestDigest);
    if (manifestVerdict.status !== MANIFEST_STATUS.VALID) {
      const first = manifestVerdict.errors && manifestVerdict.errors[0];
      if (manifestVerdict.status === MANIFEST_STATUS.INSUFFICIENT) {
        return reject(REPLAY_ERROR_CODES.INSUFFICIENT_DATA, first && first.path ? first.path : 'manifest', first && first.message ? first.message : 'manifest data is insufficient', null, REPLAY_STATUS.INSUFFICIENT);
      }
      return reject(first && first.code === 'manifest_digest_mismatch' ? REPLAY_ERROR_CODES.DIGEST_MISMATCH : REPLAY_ERROR_CODES.INVALID_MANIFEST, first && first.path ? first.path : 'manifest', first && first.message ? first.message : 'manifest is invalid');
    }
    design = validateDesign(input.experiment);
    compareDesignToManifest(design, input.manifest);
  } catch (error) {
    if (error instanceof CognitiveLabReplayError) {
      return reject(error.code, error.path, error.message, null, error.code === REPLAY_ERROR_CODES.INSUFFICIENT_DATA ? REPLAY_STATUS.INSUFFICIENT : REPLAY_STATUS.REJECT);
    }
    return reject(REPLAY_ERROR_CODES.INVALID_INPUT, 'input', error && error.message ? error.message : 'invalid input');
  }
  const mode = typeof opts.mode === 'string' ? opts.mode : 'baseline';
  const ruleId = typeof opts.ruleId === 'string' && opts.ruleId !== '' ? opts.ruleId : 'rule:cognitive-lab-b1';
  const declaredConfidence = Number.isFinite(opts.declaredConfidence) ? opts.declaredConfidence : 0.9;

  let pairs;
  let belief;
  let bypass;
  try {
    ({ pairs, belief, bypass } = replayWorkflow(graph, design, ruleId, declaredConfidence, mode));
  } catch (error) {
    return reject(REPLAY_ERROR_CODES.INVALID_INPUT, 'workflow', error && error.message ? error.message : 'workflow failed');
  }

  if (isForged(belief, pairs)) {
    return reject(REPLAY_ERROR_CODES.FORGED_OBSERVATION, 'belief.countedDecisionIds', 'a counted sample has no persisted prediction/outcome row');
  }
  if (bypass.length > 0) {
    return reject(
      REPLAY_ERROR_CODES.OVERLAP,
      'belief.countedDecisionIds',
      'calibration counted a prediction from outside the frozen split',
      integrityFailure(REPLAY_ERROR_CODES.OVERLAP, 'holdout labels were copied into the training split'),
    );
  }

  const counts = freezeCounts({ ...countOutcomes(design.ingested, pairs, belief, design.observations), eligible: design.holdout.length });
  if (counts.observed + counts.censored + counts.missing + counts.reported + counts.uncounted !== counts.ingested) {
    return reject(REPLAY_ERROR_CODES.FORGED_OBSERVATION, 'counts', 'outcome buckets do not account for every ingested example');
  }

  // Reaching here means every counted sample came from the frozen split and
  // accounted for itself, so the run's measurement design held.
  const integrity = Object.freeze({ status: 'PASS', code: null, detail: null });

  const measured = belief.observedSamples > 0 && belief.status !== CALIBRATION_STATUS.INVALID;
  return Object.freeze({
    schemaVersion: REPLAY_SCHEMA_VERSION,
    status: measured ? REPLAY_STATUS.REPLAYED : REPLAY_STATUS.INSUFFICIENT,
    benchmark: design.benchmark,
    correctnessDigest: measured ? correctnessDigest(design, counts, belief) : null,
    counts,
    belief: projectBelief(belief),
    mechanisms: mechanismsReport(design),
    integrity,
    error: measured ? null : Object.freeze({
      code: REPLAY_ERROR_CODES.INSUFFICIENT_DATA, path: 'counts.observed', message: 'no observed sample reached calibration authority',
    }),
  });
}

module.exports = {
  REPLAY_SCHEMA_VERSION,
  REPLAY_STATUS,
  REPLAY_ERROR_CODES,
  SUPPORTED_BENCHMARKS,
  CognitiveLabReplayError,
  replayBaseline,
};
