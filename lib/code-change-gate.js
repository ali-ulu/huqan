'use strict';

// The code-change gate: decides whether a proposed code change may be applied,
// needs review, may only dry-run, or is blocked. This file is the decision
// sequence; the vocabulary, input normalisation, per-file classification and
// the finding summary live in their own modules (#2134).

const { isSecretLikeValue, normalizeText } = require('./text-utils');
const { isPlainObject } = require('./is-plain-object');
const {
  CODE_CHANGE_GATE_DECISIONS,
  CODE_CHANGE_GATE_REASONS,
  CODE_CHANGE_POLICY_VERSION,
  CODE_CHANGE_RISK_LEVELS,
  DEFAULT_WORKSPACE_ID,
  clampScore,
  mergeDecision,
  normalizeDecisionLabel,
} = require('./code-change-gate-vocabulary');
const { normalizeCodeChangeInput } = require('./code-change-input');
const { SECRET_HINTS, classifyChangedFile } = require('./code-change-file-classifier');
const { summarizeFileFindings, normalizeCodeChangeDecision } = require('./code-change-decision-summary');
const { summarizeCodeChangeBlastRadius } = require('./code-change-blast-radius');

const BREADTH_REVIEW_THRESHOLD = 6;
const BREADTH_DRY_RUN_THRESHOLD = 10;

function hasWriteLikeOperation(operationType) {
  const text = normalizeText(operationType);
  return ['patch', 'write', 'apply', 'commit', 'update'].includes(text);
}

function applyPolicyFloor(decision, reason, policy) {
  const minimumDecision = normalizeDecisionLabel(policy && policy.minimumDecision);
  if (!minimumDecision) {
    return { decision, reason };
  }

  const raised = mergeDecision(decision, minimumDecision);
  if (raised !== decision) {
    return {
      decision: raised,
      reason: raised === CODE_CHANGE_GATE_DECISIONS.BLOCK
        ? CODE_CHANGE_GATE_REASONS.POLICY_OVERRIDE_BLOCK
        : CODE_CHANGE_GATE_REASONS.POLICY_OVERRIDE_REVIEW,
    };
  }

  return { decision, reason };
}

function evaluateCodeChange(input, options = {}) {
  const normalized = normalizeCodeChangeInput({
    ...(isPlainObject(input) ? input : {}),
    policyOverride: options.policy || (isPlainObject(input) ? input.policyOverride : null),
  });

  const fileFindings = normalized.files.map(file => classifyChangedFile(file, normalized));
  const summary = summarizeFileFindings(fileFindings);
  const warnings = [];
  let decision = summary.decision;
  let reason = summary.reason;
  let riskLevel = summary.riskLevel;
  let riskScore = summary.riskScore;
  const secretDetected = isSecretLikeValue({
    intent: normalized.intent,
    diffSummary: normalized.diffSummary,
    patchMetadata: isPlainObject(normalized.raw.patchMetadata) ? normalized.raw.patchMetadata : normalized.patchMetadata,
    metadata: isPlainObject(normalized.raw.metadata) ? normalized.raw.metadata : normalized.metadata,
    files: normalized.files,
  }, SECRET_HINTS);

  if (normalized.malformed) {
    decision = mergeDecision(decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    reason = CODE_CHANGE_GATE_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED;
    warnings.push('Malformed code change input detected.');
  }

  if (!normalized.files.length) {
    decision = mergeDecision(decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    reason = CODE_CHANGE_GATE_REASONS.EMPTY_FILE_LIST_REVIEW_REQUIRED;
    warnings.push('No files were provided.');
  }

  if (normalized.operationType === 'unknown') {
    decision = mergeDecision(decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    reason = CODE_CHANGE_GATE_REASONS.UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED;
    warnings.push('Unknown operation type detected.');
  }

  if (normalized.repoState.dirty || normalized.repoState.hasUntracked) {
    decision = mergeDecision(decision, CODE_CHANGE_GATE_DECISIONS.REVIEW);
    reason = CODE_CHANGE_GATE_REASONS.DIRTY_REPO_REVIEW_REQUIRED;
    warnings.push('Dirty root or untracked files detected.');
  }

  if (normalized.repoState.isMain && hasWriteLikeOperation(normalized.operationType) && normalized.files.length > 0) {
    decision = CODE_CHANGE_GATE_DECISIONS.BLOCK;
    reason = CODE_CHANGE_GATE_REASONS.MAIN_BRANCH_WRITE_BLOCKED;
    warnings.push('Write attempt on main branch blocked.');
  }

  if (secretDetected) {
    decision = CODE_CHANGE_GATE_DECISIONS.BLOCK;
    reason = CODE_CHANGE_GATE_REASONS.SECRET_CHANGE_BLOCKED;
    warnings.push('Sensitive content detected in change metadata.');
  }

  const fileCount = normalized.patchMetadata.fileCount || normalized.files.length;
  if (fileCount >= BREADTH_REVIEW_THRESHOLD && summary.categories.some(category => !['docs', 'tests', 'helper'].includes(category))) {
    const broadDecision = fileCount >= BREADTH_DRY_RUN_THRESHOLD
      ? CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY
      : CODE_CHANGE_GATE_DECISIONS.REVIEW;
    if (decision === CODE_CHANGE_GATE_DECISIONS.ALLOW) {
      decision = broadDecision;
      reason = CODE_CHANGE_GATE_REASONS.BREADTH_REVIEW_REQUIRED;
    } else {
      decision = mergeDecision(decision, broadDecision);
    }
    riskLevel = CODE_CHANGE_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.85);
    warnings.push('Broad change spans many files.');
  }

  if (summary.categories.filter(category => !['docs', 'tests', 'helper'].includes(category)).length > 1) {
    if (decision === CODE_CHANGE_GATE_DECISIONS.ALLOW) {
      decision = CODE_CHANGE_GATE_DECISIONS.REVIEW;
      reason = CODE_CHANGE_GATE_REASONS.CROSS_CUTTING_CHANGE_REVIEW_REQUIRED;
    }
    riskLevel = riskLevel === CODE_CHANGE_RISK_LEVELS.LOW ? CODE_CHANGE_RISK_LEVELS.MEDIUM : riskLevel;
    riskScore = Math.max(riskScore, 0.55);
    warnings.push('Cross-cutting change across multiple surfaces detected.');
  }

  const policyApplied = applyPolicyFloor(decision, reason, normalized.policy);
  decision = policyApplied.decision;
  reason = policyApplied.reason;

  // #2505 A, recorded only: the dependency fan-in of the changed files rides
  // next to the decision so a later threshold can weigh it against breadth.
  // It never changes the decision above, and a recording failure degrades to
  // `unknown` rather than breaking the gate.
  let blastRadius;
  try {
    blastRadius = summarizeCodeChangeBlastRadius(normalized.files, { repoRoot: options.repoRoot });
  } catch (error) {
    blastRadius = Object.freeze({
      ...summarizeCodeChangeBlastRadius([], { repoRoot: options.repoRoot }),
      status: 'unknown',
      reasons: [`blast radius recording failed: ${error?.message || error}`],
    });
  }

  if (decision === CODE_CHANGE_GATE_DECISIONS.ALLOW) {
    riskLevel = CODE_CHANGE_RISK_LEVELS.LOW;
    riskScore = Math.min(riskScore, 0.2);
  } else if (decision === CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY) {
    riskLevel = riskLevel === CODE_CHANGE_RISK_LEVELS.CRITICAL ? CODE_CHANGE_RISK_LEVELS.CRITICAL : CODE_CHANGE_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.85);
  } else if (decision === CODE_CHANGE_GATE_DECISIONS.REVIEW) {
    riskLevel = riskLevel === CODE_CHANGE_RISK_LEVELS.CRITICAL ? CODE_CHANGE_RISK_LEVELS.CRITICAL : (riskLevel === CODE_CHANGE_RISK_LEVELS.HIGH ? CODE_CHANGE_RISK_LEVELS.HIGH : CODE_CHANGE_RISK_LEVELS.MEDIUM);
    riskScore = Math.max(riskScore, 0.55);
  } else {
    riskLevel = CODE_CHANGE_RISK_LEVELS.CRITICAL;
    riskScore = 1;
  }

  const result = {
    ok: true,
    allowed: decision === CODE_CHANGE_GATE_DECISIONS.ALLOW,
    canApply: decision === CODE_CHANGE_GATE_DECISIONS.ALLOW,
    canDryRun: decision !== CODE_CHANGE_GATE_DECISIONS.BLOCK,
    decision,
    reason,
    risk: {
      level: riskLevel,
      score: clampScore(riskScore, 0.5),
      categories: summary.categories,
    },
    requiredReview: decision !== CODE_CHANGE_GATE_DECISIONS.ALLOW,
    dryRunOnly: decision === CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY,
    fileFindings,
    warnings,
    metadata: {
      policyVersion: normalized.policy.policyVersion || CODE_CHANGE_POLICY_VERSION,
      workspaceId: normalized.metadata.workspaceId || DEFAULT_WORKSPACE_ID,
      blastRadius,
    },
  };

  return normalizeCodeChangeDecision(result);
}

module.exports = {
  CODE_CHANGE_GATE_DECISIONS,
  CODE_CHANGE_GATE_REASONS,
  CODE_CHANGE_POLICY_VERSION,
  CODE_CHANGE_RISK_LEVELS,
  evaluateCodeChange,
  normalizeCodeChangeDecision,
  normalizeCodeChangeInput,
  classifyChangedFile,
  summarizeFileFindings,
};
