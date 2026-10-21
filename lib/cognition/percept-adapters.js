'use strict';

/**
 * COG-M1 (#4064) PR-2: the pure mapping from each observation source onto the
 * shared percept. Every adapter is a plain function -- it opens no file, reads
 * no clock and touches no network; the caller hands it an already-taken
 * reading. Each one builds a K1 CognitiveMessage and delegates to buildPercept,
 * so the envelope rules, the size cap and the habituation key stay in one place.
 *
 * The invariant they all keep: a percept never claims more than its source
 * established. A step report is `reported`. A file effect is `observed` only
 * when the sensor took both readings -- an indeterminate effect abstains rather
 * than becoming a percept nobody measured. A browser receipt contributes only
 * its already-hashed fields, so no raw URL or page title is carried.
 */

const { COGNITION_STATUS, AUTHORITY, freezeResult } = require('./contract');
const { SCHEMA_VERSION, buildPercept } = require('./percept');
const { isObserved } = require('../file-effect-sensor');
const { RECEIPT_KIND } = require('../browser-session-observer');

const TARGET = 'cognition';

const SOURCE_BY_MODALITY = Object.freeze({
  'file-effect': 'file-effect-sensor',
  'browser-event': 'browser-session-observer',
  ingest: 'company-ingest',
  'step-report': 'agent-step-executor',
  'prediction-error': 'prediction-error',
  outcome: 'prediction-outcome-pairs',
});

/**
 * The receipt and metadata fields a percept may carry. Every one is a short
 * classification or an already-hashed identifier; the raw page URL, title and
 * request target are deliberately absent so nothing sensitive can be copied in.
 */
const RECEIPT_FIELDS = Object.freeze([
  'receiptId', 'receiptHash', 'sessionId', 'event', 'phase', 'targetIdHash',
  'targetType', 'requestIdHash', 'method', 'resourceType', 'statusCode',
  'consoleType', 'argumentCount', 'failed',
]);

const isText = (value) => typeof value === 'string' && value.trim() !== '';

const abstain = (modality, reason) =>
  freezeResult({
    schemaVersion: SCHEMA_VERSION,
    status: COGNITION_STATUS.ABSTAIN,
    reason,
    modality,
    provenance: null,
    authority: AUTHORITY.OBSERVATION_ONLY,
  });

/**
 * The K1 envelope every adapter fills. Absent payload fields stay explicit
 * nulls so `validateCognitiveMessage` records FIELD_UNKNOWN rather than an
 * empty placeholder.
 */
function baseMessage({ modality, workspace, goal = null, traceId, evidenceRefs = [], temporalContext = null, payload = {} }) {
  return {
    source: SOURCE_BY_MODALITY[modality],
    target: TARGET,
    workspace,
    goal,
    observation: null,
    prediction: null,
    hypothesis: null,
    action: null,
    confidence: null,
    evidenceRefs,
    temporalContext,
    budget: null,
    traceId,
    ...payload,
  };
}

/**
 * A file-effect reading (#1866). `observed` is earned only when the sensor
 * actually took both readings; an `indeterminate` effect abstains, and a caller
 * that reports success on a no-op file does not move the label.
 *
 * @param {{fileEffect: object, path: string, frame?: object, workspace?: string,
 *   goal?: string|null, traceId: string, evidenceRefs?: string[],
 *   observedAt?: string|null}} input
 */
function fromFileEffect(input = {}) {
  const { fileEffect = null, path = null, frame = null, workspace = 'default', goal = null, traceId = null, evidenceRefs = [], observedAt = null } = input;
  const observation = fileEffect && fileEffect.observation;
  if (!isObserved(observation)) return abstain('file-effect', 'unobserved_effect');
  return buildPercept({
    modality: 'file-effect',
    provenance: 'observed',
    frame,
    message: baseMessage({
      modality: 'file-effect',
      workspace,
      goal,
      traceId,
      evidenceRefs,
      temporalContext: observedAt ? { observedAt } : null,
      payload: { observation: { path: isText(path) ? path : null, effect: observation, reportedStatus: null } },
    }),
  });
}

/**
 * A browser session receipt. Only the hashed/classified fields are copied; the
 * raw destination and page title never enter the percept.
 *
 * @param {{receipt: object, frame?: object, workspace?: string, goal?: string|null,
 *   traceId: string, evidenceRefs?: string[], observedAt?: string|null}} input
 */
function fromBrowserReceipt(input = {}) {
  const { receipt = null, frame = null, workspace = 'default', goal = null, traceId = null, evidenceRefs = [], observedAt = null } = input;
  if (!receipt || receipt.receiptKind !== RECEIPT_KIND) return abstain('browser-event', 'invalid_receipt');
  const metadata = receipt.metadata && typeof receipt.metadata === 'object' ? receipt.metadata : {};
  const observation = {};
  for (const field of RECEIPT_FIELDS) {
    const value = field in receipt ? receipt[field] : metadata[field];
    if (value !== undefined) observation[field] = value;
  }
  return buildPercept({
    modality: 'browser-event',
    provenance: 'observed',
    frame,
    message: baseMessage({
      modality: 'browser-event',
      workspace,
      goal,
      traceId,
      evidenceRefs: evidenceRefs.length ? evidenceRefs : (isText(receipt.receiptId) ? [`receipt:${receipt.receiptId}`] : []),
      temporalContext: observedAt ? { observedAt } : null,
      payload: { observation },
    }),
  });
}

/**
 * A step report is what the agent says it did, so it is always `reported` and
 * can never be upgraded to `observed`.
 *
 * @param {{report: object, frame?: object, workspace?: string, goal?: string|null,
 *   traceId: string, evidenceRefs?: string[], observedAt?: string|null}} input
 */
function fromStepReport(input = {}) {
  const { report = null, frame = null, workspace = 'default', goal = null, traceId = null, evidenceRefs = [], observedAt = null } = input;
  if (!report || typeof report !== 'object') return abstain('step-report', 'missing_report');
  const observation = {
    step: isText(report.step) ? report.step : null,
    status: isText(report.status) ? report.status : null,
    reportedStatus: isText(report.status) ? report.status : null,
  };
  return buildPercept({
    modality: 'step-report',
    provenance: 'reported',
    frame,
    message: baseMessage({
      modality: 'step-report',
      workspace,
      goal,
      traceId,
      evidenceRefs,
      temporalContext: observedAt ? { observedAt } : null,
      payload: { observation },
    }),
  });
}

/**
 * A prediction-error signal (#4061) is derived from a prediction/outcome pair,
 * never observed directly.
 *
 * @param {{error: object, frame?: object, workspace?: string, goal?: string|null,
 *   traceId: string, evidenceRefs?: string[], observedAt?: string|null}} input
 */
function fromPredictionError(input = {}) {
  const { error = null, frame = null, workspace = 'default', goal = null, traceId = null, evidenceRefs = [], observedAt = null } = input;
  if (!error || typeof error !== 'object') return abstain('prediction-error', 'missing_error');
  const observation = {
    kind: isText(error.kind) ? error.kind : null,
    signedError: typeof error.signedError === 'number' ? error.signedError : null,
    magnitude: typeof error.magnitude === 'number' ? error.magnitude : null,
    decisionId: isText(error.decisionId) ? error.decisionId : null,
  };
  return buildPercept({
    modality: 'prediction-error',
    provenance: 'derived',
    frame,
    message: baseMessage({
      modality: 'prediction-error',
      workspace,
      goal,
      traceId,
      evidenceRefs,
      temporalContext: observedAt ? { observedAt } : null,
      payload: { observation, prediction: null },
    }),
  });
}

/**
 * An observed outcome paired with its prediction. The outcome state is what
 * makes it `observed`; a censored pair (no outcome yet) abstains.
 *
 * @param {{pair: object, frame?: object, workspace?: string, goal?: string|null,
 *   traceId: string, evidenceRefs?: string[], observedAt?: string|null}} input
 */
function fromOutcomePair(input = {}) {
  const { pair = null, frame = null, workspace = 'default', goal = null, traceId = null, evidenceRefs = [], observedAt = null } = input;
  const outcome = pair && pair.outcome;
  if (!outcome || !isText(outcome.state)) return abstain('outcome', 'censored_outcome');
  const observation = {
    decisionId: isText(pair.decisionId) ? pair.decisionId : null,
    state: outcome.state,
    at: isText(outcome.at) ? outcome.at : null,
  };
  return buildPercept({
    modality: 'outcome',
    provenance: 'observed',
    frame,
    message: baseMessage({
      modality: 'outcome',
      workspace,
      goal,
      traceId,
      evidenceRefs,
      temporalContext: observedAt ? { observedAt } : null,
      payload: { observation },
    }),
  });
}

module.exports = {
  RECEIPT_FIELDS,
  SOURCE_BY_MODALITY,
  fromFileEffect,
  fromBrowserReceipt,
  fromStepReport,
  fromPredictionError,
  fromOutcomePair,
};
