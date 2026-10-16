'use strict';

// Phase 1 of classifyAutomationOperation (#2176): an uncategorisable
// operation, preview/dry-run requests and read-only inspection. Returns the
// finding, or null to hand over to the next phase in the original order.

const { AUTOMATION_SAFETY_DECISIONS, AUTOMATION_RISK_LEVELS, AUTOMATION_SAFETY_REASONS, READ_ONLY_HINTS, MUTATION_HINTS, DEPLOY_HINTS, RELEASE_HINTS, MERGE_HINTS, BRANCH_DELETE_HINTS, SETTINGS_CHANGE_HINTS, PREVIEW_HINTS } = require('./automation-safety-vocabulary');
const { containsAny, makeFinding } = require('./automation-input-normalizer');

function classifyEntryPhase(ctx) {
  const { normalized, opType, opText, explicitApproval } = ctx;

  if (!opType || opType === 'unknown' || opType === 'undefined' || opType === 'null') {
    return makeFinding({
      operationType: opType || 'unknown',
      category: 'unknown',
      riskLevel: AUTOMATION_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
      reason: AUTOMATION_SAFETY_REASONS.UNKNOWN_OPERATION_REVIEW_REQUIRED,
      notes: ['Operation type could not be safely categorized.'],
      sensitive: false,
      explicitApproval,
      previewRequested: normalized.previewRequested,
    });
  }

  if (normalized.previewRequested || normalized.dryRunRequested || containsAny(opText, PREVIEW_HINTS)) {
    if (containsAny(opType, ['deploy']) || containsAny(opText, DEPLOY_HINTS)) {
      return makeFinding({
        operationType: opType,
        category: 'deploy_preview',
        riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
        riskScore: 0.8,
        decision: AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY,
        reason: AUTOMATION_SAFETY_REASONS.DEPLOY_PREVIEW_ONLY,
        notes: ['Deploy preview can be generated safely, but execution must wait.'],
        sensitive: false,
        explicitApproval,
        previewRequested: true,
      });
    }
    if (containsAny(opType, ['release_notes_preview']) || containsAny(opText, ['release notes preview', 'release-notes-preview'])) {
      return makeFinding({
        operationType: opType,
        category: 'preview',
        riskLevel: AUTOMATION_RISK_LEVELS.LOW,
        riskScore: 0.15,
        decision: AUTOMATION_SAFETY_DECISIONS.ALLOW,
        reason: AUTOMATION_SAFETY_REASONS.RELEASE_PREVIEW_ONLY,
        notes: ['Release notes preview is read-only.'],
        sensitive: false,
        explicitApproval,
        previewRequested: true,
      });
    }
    if (containsAny(opType, ['merge']) || containsAny(opText, MERGE_HINTS) || containsAny(opText, RELEASE_HINTS)) {
      return makeFinding({
        operationType: opType,
        category: 'preview',
        riskLevel: AUTOMATION_RISK_LEVELS.HIGH,
        riskScore: 0.75,
        decision: AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY,
        reason: AUTOMATION_SAFETY_REASONS.DRY_RUN_ONLY_PREVIEW,
        notes: ['Mutation preview is safe, execution must wait.'],
        sensitive: false,
        explicitApproval,
        previewRequested: true,
      });
    }
  }

  // Excluded against every mutation family, not an enumerated subset (#739).
  // The old list omitted BRANCH_DELETE_HINTS and SETTINGS_CHANGE_HINTS, whose
  // own branches sit further down this chain and were therefore unreachable.
  if (containsAny(opText, READ_ONLY_HINTS) && !containsAny(opText, MUTATION_HINTS)) {
    return makeFinding({
      operationType: opType,
      category: 'read_only',
      riskLevel: AUTOMATION_RISK_LEVELS.LOW,
      riskScore: 0.1,
      decision: AUTOMATION_SAFETY_DECISIONS.ALLOW,
      reason: containsAny(opText, ['ci']) ? AUTOMATION_SAFETY_REASONS.LOW_RISK_CI_INSPECTION : AUTOMATION_SAFETY_REASONS.LOW_RISK_READ_ONLY,
      notes: ['Read-only automation inspection.'],
      sensitive: false,
      explicitApproval,
      previewRequested: normalized.previewRequested,
    });
  }

  return null;
}

module.exports = { classifyEntryPhase };
