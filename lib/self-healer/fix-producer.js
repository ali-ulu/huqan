'use strict';

/**
 * Self-Healer — concrete fix production (#3670).
 *
 * The self-healer already classifies findings and decides a safety level
 * (`safety-decision.js`), and the coder already projects a verified failure
 * record onto a bounded transform task (`lib/task-producer.js`). What was
 * missing is the join: a finding whose decision permits a human-reviewed
 * proposal should yield an actual, reviewable fix, and one whose decision does
 * not must yield nothing.
 *
 * This module is that join and nothing else. It reuses the two authorities it
 * joins and decides nothing new:
 *
 *   - It never applies. `applied` is `false` on every path, and the proposal it
 *     returns is a coder transform task that still has to pass
 *     code-change-gate, exactly like one a human wrote by hand.
 *   - It never invents the two strings a transform needs. A finding does not
 *     carry them; the caller supplies the verified failure record that does,
 *     and with no record there is no fix, only a named reason.
 *   - It does not widen a decision. A fix is offered only for the two decision
 *     levels that mean "a human reviews a fix" -- `propose` and
 *     `require_review`. `observe`, `block` and `quarantine` never yield a
 *     proposal here, so this module adds no way past the safety matrix.
 */

const { decideSelfHealerAction } = require('./safety-decision');
const { produceTask } = require('../task-producer');
const { isPlainObject } = require('../is-plain-object');

const FIX_PRODUCER_VERSION = 'self-healer-fix-producer-v0.1.0';

/**
 * The decision levels under which a human reviews a proposed fix. Only these
 * two carry `human_review` as a next step: `propose` is the docs-only path and
 * `require_review` is the fail-closed default for a real code surface. They are
 * named explicitly so the permission is readable here, rather than inferred
 * from a next-step list that `quarantine` also happens to share.
 */
const REVIEW_PERMITTING_DECISIONS = Object.freeze([
  'propose',
  'require_review',
]);

/**
 * Reasons a permitted decision still yields no proposal. Each names a real
 * outcome, so a caller can tell "the decision forbade it" apart from "the
 * record could not be projected".
 */
const FIX_PRODUCER_REFUSALS = Object.freeze({
  DECISION_DOES_NOT_PERMIT_PROPOSAL: 'DECISION_DOES_NOT_PERMIT_PROPOSAL',
  NO_FAILURE_RECORD: 'NO_FAILURE_RECORD',
  PROPOSAL_OUTSIDE_ALLOWED_FILES: 'PROPOSAL_OUTSIDE_ALLOWED_FILES',
});


function refusal(reason, decisionResult, extra = {}) {
  return Object.freeze({
    ok: true,
    version: FIX_PRODUCER_VERSION,
    findingId: extra.findingId || '',
    decision: decisionResult.decision,
    reason: decisionResult.reason,
    requiresApproval: decisionResult.requiresApproval,
    applied: false,
    proposal: null,
    proposalSource: 'failure_record',
    refusal: Object.freeze({ reason, ...(extra.producerReason ? { producerReason: extra.producerReason } : {}) }),
  });
}

function fileList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry == null ? '' : entry).trim()).filter(Boolean);
}

/**
 * Join one finding's safety decision with a caller-supplied verified failure
 * record, producing a coder transform task when — and only when — the decision
 * permits a human-reviewed proposal and the record projects cleanly.
 *
 * @param {object} finding a normalized finding (see finding-schema.js)
 * @param {object} [options]
 * @param {object} [options.failure] a verified failure record (see
 *   lib/error-prevention/failure-record.js); the string pair a transform needs
 * @returns {object} frozen result; `applied` is always false
 */
function proposeConcreteFix(finding, options = {}) {
  const decisionResult = decideSelfHealerAction(finding);
  const findingId = isPlainObject(finding) && typeof finding.findingId === 'string' ? finding.findingId : '';

  // The decision level itself states whether a fix may be proposed; this
  // module does not add a second opinion. An observe/block/quarantine finding
  // is refused here even though quarantine also lists `human_review`.
  if (!REVIEW_PERMITTING_DECISIONS.includes(decisionResult.decision)) {
    return refusal(FIX_PRODUCER_REFUSALS.DECISION_DOES_NOT_PERMIT_PROPOSAL, decisionResult, { findingId });
  }

  const failure = options && options.failure;
  if (!isPlainObject(failure)) {
    return refusal(FIX_PRODUCER_REFUSALS.NO_FAILURE_RECORD, decisionResult, { findingId });
  }

  // Reuse the one projection authority rather than re-deriving here.
  const produced = produceTask(failure);

  if (produced.status !== 'TASK_PRODUCED' || !produced.task) {
    return refusal(FIX_PRODUCER_REFUSALS.NO_FAILURE_RECORD, decisionResult, {
      findingId,
      producerReason: produced.reason || 'NOT_PRODUCED',
    });
  }

  // Coherence check between the two surfaces being joined: a proposal must land
  // inside the finding's own declared surface. When the finding names no files,
  // there is nothing to check against and the record's own path stands.
  const allowedFiles = fileList(finding && finding.suggestedFix && finding.suggestedFix.allowedFiles);
  const proposedPaths = new Set([...(produced.task.allowedPaths || []), produced.task.operation.path]);
  if (allowedFiles.length > 0 && ![...proposedPaths].every((filePath) => allowedFiles.includes(filePath))) {
    return refusal(FIX_PRODUCER_REFUSALS.PROPOSAL_OUTSIDE_ALLOWED_FILES, decisionResult, {
      findingId,
      producerReason: produced.reason || null,
    });
  }

  return Object.freeze({
    ok: true,
    version: FIX_PRODUCER_VERSION,
    findingId,
    sourceFailureId: produced.sourceFailureId || '',
    decision: decisionResult.decision,
    reason: decisionResult.reason,
    requiresApproval: decisionResult.requiresApproval,
    applied: false,
    proposal: produced.task,
    proposalSource: 'failure_record',
    refusal: null,
  });
}

module.exports = {
  FIX_PRODUCER_REFUSALS,
  FIX_PRODUCER_VERSION,
  proposeConcreteFix,
};
