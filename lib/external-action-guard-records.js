'use strict';

// #2173: recording an admitted action's outcome, and a person's review of it.

const { normalizeExternalActionEnvelope } = require('./external-action-envelope');
const { evaluateAgentIdentity } = require('./external-action-identity');
const { evaluatePostActionBehavior, postActionMonitoringOptions } = require('./post-action-monitor');
const { buildExternalActionOutcomeReceipt, buildExternalActionOutcomeReviewReceipt, persistExternalActionReceipt } = require('./external-action-receipt');

function recordExternalActionOutcome(input, admissionReceipt, outcome, options = {}) {
  const envelope = normalizeExternalActionEnvelope(input, options);
  if (envelope.malformed) throw new TypeError(`invalid external action envelope: ${envelope.errors.join(',')}`);
  envelope.identity = evaluateAgentIdentity(envelope, options).identity;
  const monitoringOptions = postActionMonitoringOptions(options);
  const monitoring = monitoringOptions
    ? evaluatePostActionBehavior({ envelope, identity: envelope.identity, admissionReceipt, outcome }, monitoringOptions)
    : null;
  envelope.postActionMonitoring = monitoring?.receiptSummary || null;
  const receipt = buildExternalActionOutcomeReceipt(envelope, admissionReceipt, outcome, options);
  let persisted = false;
  let receiptError = null;
  try {
    persisted = persistExternalActionReceipt(options.receiptWriter, receipt);
    if (monitoring?.receiptSummary?.quarantine?.applied && !persisted) {
      throw new Error('post-action quarantine requires durable receipt persistence');
    }
  } catch (error) {
    receiptError = String(error?.message || error);
  }
  const quarantineApplied = monitoring?.receiptSummary?.quarantine?.applied === true;
  const quarantined = quarantineApplied && persisted;
  let findingError = null;
  if (quarantined && monitoringOptions.findingSink && monitoring.finding) {
    try {
      monitoringOptions.findingSink(monitoring.finding);
    } catch (error) {
      findingError = String(error?.message || error);
    }
  }
  const monitoringError = monitoring && !monitoring.active
    ? monitoring.receiptSummary.reason
    : findingError;
  return Object.freeze({
    ok: receiptError === null && monitoringError === null,
    receipt,
    receiptPersisted: persisted,
    receiptError,
    monitoringError,
    monitoring,
    quarantined,
    demotedTo: quarantined ? 'T1' : null,
    finding: monitoring?.finding || null,
  });
}

/**
 * Attach a human review decision to a recorded outcome (#2137). The outcome
 * receipt is immutable, so the review is persisted as its own
 * `external_action_outcome_review_receipt` through the same writer and the
 * same fail-closed contract as an outcome: the receipt is built and returned
 * even when persistence fails, but `ok` stays false until the trail actually
 * holds it.
 */
function recordExternalActionReview(outcomeReceipt, review, options = {}) {
  let receipt = null;
  let receiptError = null;
  let persisted = false;
  try {
    receipt = buildExternalActionOutcomeReviewReceipt(outcomeReceipt, review, options);
  } catch (error) {
    receiptError = String(error?.message || error);
  }
  if (receipt) {
    try {
      persisted = persistExternalActionReceipt(options.receiptWriter, receipt);
    } catch (error) {
      receiptError = String(error?.message || error);
    }
  }
  return Object.freeze({
    ok: receiptError === null && persisted,
    receipt,
    receiptPersisted: persisted,
    receiptError,
  });
}

module.exports = {
  recordExternalActionOutcome,
  recordExternalActionReview,
};
