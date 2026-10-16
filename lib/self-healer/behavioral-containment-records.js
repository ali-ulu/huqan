'use strict';

// #2217: the decision per deviation code, the containment it implies, and the
// receipt summary and finding an assessment emits.

const { createFinding } = require('./finding-schema');
const { BEHAVIORAL_CONTAINMENT_VERSION, BEHAVIORAL_DECISIONS, BEHAVIORAL_DEVIATION_CODES, stableHash } = require('./behavioral-containment-baseline');

function decisionFor(code) {
  return code === BEHAVIORAL_DEVIATION_CODES.REPEATED_ANOMALY
    ? BEHAVIORAL_DECISIONS.REQUIRE_REVIEW
    : code
      ? BEHAVIORAL_DECISIONS.QUARANTINE
      : BEHAVIORAL_DECISIONS.OBSERVE;
}

function containmentFor(decision, observation, baseline) {
  const action = decision === BEHAVIORAL_DECISIONS.REQUIRE_REVIEW
    ? 'pause'
    : decision === BEHAVIORAL_DECISIONS.OBSERVE
      ? 'none'
      : decision;
  const suppressed = action !== 'none';
  return Object.freeze({
    action,
    applied: false,
    executorSuppressed: suppressed,
    scope: Object.freeze({
      workspaceId: observation.workspaceId,
      agentId: observation.agentId || baseline.agentId || null,
    }),
    baselineScope: Object.freeze({
      workspaceId: baseline.workspaceId,
      agentId: baseline.agentId || null,
    }),
    reintegration: suppressed
      ? Object.freeze({
          required: true,
          operatorApprovalRequired: true,
          outcome: null,
          prerequisites: Object.freeze([
            'fresh_identity_verification',
            'fresh_dependency_verification',
            'fresh_policy_verification',
            'operator_approval',
          ]),
        })
      : Object.freeze({ required: false, operatorApprovalRequired: false, outcome: null, prerequisites: Object.freeze([]) }),
  });
}

function buildReceiptSummary({ baseline, observation, decision, deviationCode, sequence }) {
  const payload = {
    version: BEHAVIORAL_CONTAINMENT_VERSION,
    baselineHash: baseline.baselineHash || null,
    baselineVersion: baseline.version || null,
    decision,
    deviationCode: deviationCode || null,
    scope: {
      workspaceId: observation.workspaceId,
      agentId: observation.agentId || baseline.agentId || null,
    },
    sequence,
    operatorOutcome: null,
  };
  return Object.freeze({
    receiptId: `asi10_${stableHash(payload).slice(0, 16)}`,
    receiptKind: 'asi10_behavioral_containment_summary',
    version: BEHAVIORAL_CONTAINMENT_VERSION,
    baselineHash: payload.baselineHash,
    baselineVersion: payload.baselineVersion,
    decision,
    deviationCode: payload.deviationCode,
    scope: Object.freeze({ ...payload.scope }),
    sequenceSummary: sequence,
    operatorOutcome: null,
  });
}

function buildBehavioralFinding({ baseline, observation, decision, deviationCode, receipt, sequence }) {
  if (!deviationCode) return null;
  const severity = decision === BEHAVIORAL_DECISIONS.QUARANTINE || decision === BEHAVIORAL_DECISIONS.BLOCK
    ? 'high'
    : 'medium';
  return createFinding({
    kind: 'security',
    severity,
    confidence: 0.86,
    title: 'Behavioral integrity deviation detected',
    summary: `${deviationCode} detected against the declared agent/workspace baseline.`,
    evidence: [{
      type: 'manual',
      ref: `asi10:${deviationCode}`,
      detail: `baseline=${String(baseline.baselineHash || 'missing').slice(0, 16)}; sequenceLength=${sequence.length}`,
    }],
    affectedFiles: [],
    suggestedTests: ['Fresh identity, dependency, and policy verification before reintegration'],
    suggestedFix: {
      summary: 'Keep the scoped executor suppressed pending operator review and fresh verification.',
      allowedFiles: [],
      forbiddenFiles: [],
      risk: severity,
    },
    riskFlags: [
      'behavioral_deviation',
      ...(decision === BEHAVIORAL_DECISIONS.QUARANTINE ? ['behavioral_quarantine'] : []),
      deviationCode,
    ],
    status: 'candidate',
    receiptId: receipt.receiptId,
    workspaceId: observation.workspaceId,
  }, { workspaceId: observation.workspaceId });
}

module.exports = {
  buildBehavioralFinding,
  buildReceiptSummary,
  containmentFor,
  decisionFor,
};
