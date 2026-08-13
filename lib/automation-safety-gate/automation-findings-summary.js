'use strict';

const {
  AUTOMATION_SAFETY_DECISIONS,
  AUTOMATION_SAFETY_REASONS,
  AUTOMATION_RISK_LEVELS,
} = require('./automation-safety-vocabulary');
const {
  isPlainObject,
  firstText,
  normalizeDecisionLabel,
  normalizeRiskLevel,
  clampScore,
  decisionRank,
  mergeDecision,
} = require('./automation-input-normalizer');
const { normalizeText } = require('../text-utils');

function normalizeAutomationFinding(finding) {
  const raw = isPlainObject(finding) ? finding : {};
  const notes = Array.isArray(raw.notes) ? raw.notes.filter(Boolean).map(value => String(value)) : [];
  return {
    ok: Boolean(raw.ok ?? true),
    id: firstText(raw.id, raw.operationType, 'automation'),
    operationType: normalizeText(firstText(raw.operationType, 'unknown')),
    target: firstText(raw.target, ''),
    actor: firstText(raw.actor, ''),
    branch: firstText(raw.branch, ''),
    baseBranch: firstText(raw.baseBranch, ''),
    category: firstText(raw.category, 'unknown'),
    riskLevel: normalizeRiskLevel(raw.riskLevel),
    riskScore: clampScore(raw.riskScore, 0.5),
    decision: normalizeDecisionLabel(raw.decision) || AUTOMATION_SAFETY_DECISIONS.REVIEW,
    reason: firstText(raw.reason, AUTOMATION_SAFETY_REASONS.UNKNOWN_OPERATION_REVIEW_REQUIRED),
    notes,
    sensitive: Boolean(raw.sensitive),
    explicitApproval: Boolean(raw.explicitApproval),
    previewRequested: Boolean(raw.previewRequested),
  };
}

function summarizeAutomationFindings(findings) {
  const normalizedFindings = Array.isArray(findings)
    ? findings.map(finding => normalizeAutomationFinding(finding)).sort((left, right) => `${left.category}:${left.operationType}:${left.id}`.localeCompare(`${right.category}:${right.operationType}:${right.id}`))
    : [];

  if (!normalizedFindings.length) {
    return {
      entryCount: 0,
      categories: [],
      riskLevel: AUTOMATION_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: AUTOMATION_SAFETY_DECISIONS.REVIEW,
      reason: AUTOMATION_SAFETY_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED,
      hasCritical: false,
      hasHighRisk: false,
      reasons: [AUTOMATION_SAFETY_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED],
    };
  }

  let decision = AUTOMATION_SAFETY_DECISIONS.ALLOW;
  let reason = AUTOMATION_SAFETY_REASONS.LOW_RISK_READ_ONLY;
  let riskLevel = AUTOMATION_RISK_LEVELS.LOW;
  let riskScore = 0.1;
  const categories = new Set();
  const reasons = [];
  let hasCritical = false;
  let hasHighRisk = false;

  for (const finding of normalizedFindings) {
    categories.add(finding.category);
    reasons.push(finding.reason);
    decision = mergeDecision(decision, finding.decision);

    const rank = decisionRank(finding.decision);
    if (rank >= 3) {
      hasCritical = true;
      riskLevel = AUTOMATION_RISK_LEVELS.CRITICAL;
      riskScore = 1;
      reason = finding.reason;
      continue;
    }
    if (rank === 2) {
      if (riskLevel === AUTOMATION_RISK_LEVELS.LOW) {
        riskLevel = AUTOMATION_RISK_LEVELS.MEDIUM;
        riskScore = Math.max(riskScore, 0.55);
      }
      reason = finding.reason;
    }
    if (rank === 1) {
      hasHighRisk = true;
      riskLevel = AUTOMATION_RISK_LEVELS.HIGH;
      riskScore = Math.max(riskScore, 0.8);
      reason = finding.reason;
    }
    if (rank === 0) {
      reason = finding.reason;
    }
  }

  const categoryList = [...categories].sort();
  if (hasCritical) {
    decision = AUTOMATION_SAFETY_DECISIONS.BLOCK;
    riskLevel = AUTOMATION_RISK_LEVELS.CRITICAL;
    riskScore = 1;
    reason = reasons.find(item => item === AUTOMATION_SAFETY_REASONS.AUTO_MERGE_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.ENABLE_AUTO_MERGE_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.FORCE_PUSH_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.HISTORY_REWRITE_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.BRANCH_PROTECTION_BYPASS_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.CI_BYPASS_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.WORKFLOW_ABUSE_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.DESTRUCTIVE_CLEANUP_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.TOKEN_PERSISTENCE_BLOCKED)
      || reasons.find(item => item === AUTOMATION_SAFETY_REASONS.PUSH_TO_MAIN_BLOCKED)
      || reason;
  } else if (hasHighRisk && decision === AUTOMATION_SAFETY_DECISIONS.ALLOW) {
    decision = AUTOMATION_SAFETY_DECISIONS.DRY_RUN_ONLY;
    riskLevel = AUTOMATION_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.8);
    reason = AUTOMATION_SAFETY_REASONS.DRY_RUN_ONLY_PREVIEW;
  } else if (hasHighRisk && decision === AUTOMATION_SAFETY_DECISIONS.REVIEW) {
    riskLevel = AUTOMATION_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.8);
  } else if (decision === AUTOMATION_SAFETY_DECISIONS.REVIEW) {
    riskLevel = riskLevel === AUTOMATION_RISK_LEVELS.LOW ? AUTOMATION_RISK_LEVELS.MEDIUM : riskLevel;
    riskScore = Math.max(riskScore, 0.55);
  }

  return {
    entryCount: normalizedFindings.length,
    categories: categoryList,
    riskLevel,
    riskScore,
    decision,
    reason,
    hasCritical,
    hasHighRisk,
    reasons,
  };
}

module.exports = {
  normalizeAutomationFinding,
  summarizeAutomationFindings,
};
