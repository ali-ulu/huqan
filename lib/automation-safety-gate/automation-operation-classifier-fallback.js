'use strict';

// Phase 4 of classifyAutomationOperation (#2176): direct push to main, secret
// material, push-to-main hints, and the default finding every operation that
// reached this far receives. Always returns a finding.

const { AUTOMATION_SAFETY_DECISIONS, AUTOMATION_RISK_LEVELS, AUTOMATION_SAFETY_REASONS, PUSH_TO_MAIN_HINTS } = require('./automation-safety-vocabulary');
const { containsAny, signalsEqual, makeFinding } = require('./automation-input-normalizer');

function classifyFallbackPhase(ctx) {
  const { normalized, opType, opText, explicitApproval, approvedMergePath, secretDetected } = ctx;

  if (signalsEqual(opType, 'push_to_main')) {
    if (explicitApproval && approvedMergePath) {
      return makeFinding({
        operationType: opType,
        category: 'push_to_main',
        riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
        riskScore: 0.85,
        decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
        reason: AUTOMATION_SAFETY_REASONS.MERGE_REQUIRES_APPROVAL,
        notes: ['Push to main only follows an approved merge path.'],
        sensitive: false,
        explicitApproval,
        previewRequested: false,
      });
    }
    return makeFinding({
      operationType: opType,
      category: 'push_to_main',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.PUSH_TO_MAIN_BLOCKED,
      notes: ['Push to main without approved merge context is blocked.'],
      sensitive: false,
      explicitApproval,
      previewRequested: false,
    });
  }

  if (secretDetected) {
    return makeFinding({
      operationType: opType,
      category: 'secret',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.TOKEN_PERSISTENCE_BLOCKED,
      notes: ['Sensitive automation data detected.'],
      sensitive: true,
      explicitApproval,
      previewRequested: normalized.previewRequested,
    });
  }

  if (containsAny(opText, PUSH_TO_MAIN_HINTS)) {
    return makeFinding({
      operationType: opType,
      category: 'push_to_main',
      riskLevel: AUTOMATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: AUTOMATION_SAFETY_DECISIONS.BLOCK,
      reason: AUTOMATION_SAFETY_REASONS.PUSH_TO_MAIN_BLOCKED,
      notes: ['Push to main without approved merge context is blocked.'],
      sensitive: false,
      explicitApproval,
      previewRequested: normalized.previewRequested,
    });
  }

  const isUnknown = opType === 'unknown' || !opType;
  return makeFinding({
    operationType: opType || 'unknown',
    category: isUnknown ? 'unknown' : 'automation',
    riskLevel: AUTOMATION_RISK_LEVELS.MEDIUM,
    riskScore: 0.55,
    decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
    reason: AUTOMATION_SAFETY_REASONS.UNKNOWN_OPERATION_REVIEW_REQUIRED,
    notes: ['Automation operation could not be safely classified.'],
    sensitive: false,
    explicitApproval,
    previewRequested: normalized.previewRequested,
  });
}

module.exports = { classifyFallbackPhase };
