'use strict';

const { EVENT_TYPES, resolveLearningEligibility } = require('./contract');

/** Derive the closing manifest from the journal's verified run cache. */
function journalManifest(runId, run) {
  if (!run) {
    return Object.freeze({
      runId, closed: false, eventCount: 0, head: 0,
      outcomeStatus: 'unknown', learningEligibility: 'ineligible',
    });
  }
  let executionStatus;
  let outcomeStatus = 'unknown';
  let proofs;
  let verificationConflicting;
  let failureEvidence;
  for (const stored of run.events) {
    if ([EVENT_TYPES.EXECUTION_FINISHED, EVENT_TYPES.RUN_CLOSED].includes(stored.type) && stored.executionStatus) {
      executionStatus = stored.executionStatus;
    }
    if (stored.type === EVENT_TYPES.FAILURE && stored.payload !== undefined) failureEvidence = true;
    if (stored.type === EVENT_TYPES.VERIFICATION) {
      const verdict = stored.verdict || stored.outcomeStatus;
      if (outcomeStatus !== 'unknown' && verdict && verdict !== outcomeStatus) {
        verificationConflicting = true;
      }
      if (verdict) outcomeStatus = verdict;
      if (stored.proofs !== undefined) proofs = stored.proofs;
    }
  }
  const eligibility = resolveLearningEligibility({
    executionStatus, outcomeStatus, verificationConflicting,
    proofs: proofs || (failureEvidence ? { failureEvidence: true } : undefined),
  });
  return Object.freeze({
    runId, closed: run.closed, eventCount: run.events.length, head: run.head,
    executionStatus: executionStatus || 'unknown',
    outcomeStatus,
    learningEligibility: eligibility.eligibility,
  });
}


module.exports = Object.freeze({ journalManifest });
