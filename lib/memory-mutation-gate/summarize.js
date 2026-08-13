'use strict';

const {
  MEMORY_MUTATION_GATE_DECISIONS,
  MEMORY_MUTATION_GATE_REASONS,
  MEMORY_MUTATION_RISK_LEVELS,
  DEFAULT_WORKSPACE_ID,
} = require('./constants');
const {
  isPlainObject,
  firstText,
  normalizeDecisionLabel,
  normalizeRiskLevel,
  clampScore,
  decisionRank,
  mergeDecision,
} = require('./normalize');
const { normalizeText } = require('../text-utils');

function normalizeMemoryMutationFinding(finding) {
  const raw = isPlainObject(finding) ? finding : {};
  const notes = Array.isArray(raw.notes) ? raw.notes.filter(Boolean).map(value => String(value)) : [];
  return {
    ok: Boolean(raw.ok ?? true),
    id: firstText(raw.id, ''),
    action: normalizeText(firstText(raw.action, '')),
    changeType: normalizeText(firstText(raw.changeType, '')),
    scope: normalizeText(firstText(raw.scope, '')),
    workspaceId: firstText(raw.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
    targetSpace: firstText(raw.targetSpace, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
    category: firstText(raw.category, 'unknown'),
    riskLevel: normalizeRiskLevel(raw.riskLevel),
    riskScore: clampScore(raw.riskScore, 0.5),
    decision: normalizeDecisionLabel(raw.decision) || MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
    reason: firstText(raw.reason, MEMORY_MUTATION_GATE_REASONS.UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED),
    notes,
    sensitive: Boolean(raw.sensitive),
    contentChanged: Boolean(raw.contentChanged),
    linksChanged: Boolean(raw.linksChanged),
    auditChanged: Boolean(raw.auditChanged),
  };
}

function summarizeMemoryMutationFindings(findings) {
  const normalizedFindings = Array.isArray(findings)
    ? findings.map(normalizeMemoryMutationFinding).sort((left, right) => `${left.workspaceId}:${left.id}`.localeCompare(`${right.workspaceId}:${right.id}`))
    : [];

  if (!normalizedFindings.length) {
    return {
      entryCount: 0,
      categories: [],
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
      reason: MEMORY_MUTATION_GATE_REASONS.EMPTY_ENTRY_LIST_REVIEW_REQUIRED,
      hasCritical: false,
      hasHighRisk: false,
      reasons: [MEMORY_MUTATION_GATE_REASONS.EMPTY_ENTRY_LIST_REVIEW_REQUIRED],
    };
  }

  let decision = MEMORY_MUTATION_GATE_DECISIONS.ALLOW;
  let reason = MEMORY_MUTATION_GATE_REASONS.LOW_RISK_MEMORY_INSPECTION;
  let riskLevel = MEMORY_MUTATION_RISK_LEVELS.LOW;
  let riskScore = 0.15;
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
      riskLevel = MEMORY_MUTATION_RISK_LEVELS.CRITICAL;
      riskScore = 1;
      reason = finding.reason;
      continue;
    }
    if (rank === 2) {
      if (riskLevel === MEMORY_MUTATION_RISK_LEVELS.LOW) {
        riskLevel = MEMORY_MUTATION_RISK_LEVELS.MEDIUM;
        riskScore = Math.max(riskScore, 0.55);
      }
      reason = finding.reason;
    }
    if (rank === 1) {
      hasHighRisk = true;
      riskLevel = MEMORY_MUTATION_RISK_LEVELS.HIGH;
      riskScore = Math.max(riskScore, 0.85);
      reason = finding.reason;
    }
    if (rank === 0) {
      reason = finding.reason;
    }
  }

  const categoryList = [...categories].sort();
  const nonReadCategories = categoryList.filter(category => !['read_only', 'metadata'].includes(category));
  if (nonReadCategories.length > 1) {
    hasHighRisk = true;
  }

  if (hasCritical) {
    decision = MEMORY_MUTATION_GATE_DECISIONS.BLOCK;
    riskLevel = MEMORY_MUTATION_RISK_LEVELS.CRITICAL;
    riskScore = 1;
    reason = reasons.find(item => item === MEMORY_MUTATION_GATE_REASONS.AUDIT_REWRITE_OR_DELETE_BLOCKED)
      || reasons.find(item => item === MEMORY_MUTATION_GATE_REASONS.CROSS_WORKSPACE_MUTATION_BLOCKED)
      || reasons.find(item => item === MEMORY_MUTATION_GATE_REASONS.SECRET_MUTATION_BLOCKED)
      || reasons.find(item => item === MEMORY_MUTATION_GATE_REASONS.RELEASE_OR_DEPLOY_MUTATION_BLOCKED)
      || reasons.find(item => item === MEMORY_MUTATION_GATE_REASONS.AUTO_MERGE_OR_AUTOPUSH_BLOCKED)
      || reasons.find(item => item === MEMORY_MUTATION_GATE_REASONS.CANONICAL_GRAPH_MUTATION_BLOCKED)
      || reason;
  } else if (hasHighRisk && decision === MEMORY_MUTATION_GATE_DECISIONS.ALLOW) {
    decision = MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY;
    riskLevel = MEMORY_MUTATION_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.85);
    reason = MEMORY_MUTATION_GATE_REASONS.BREADTH_REVIEW_REQUIRED;
  } else if (hasHighRisk && decision === MEMORY_MUTATION_GATE_DECISIONS.REVIEW) {
    riskLevel = MEMORY_MUTATION_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.85);
  } else if (decision === MEMORY_MUTATION_GATE_DECISIONS.REVIEW) {
    riskLevel = riskLevel === MEMORY_MUTATION_RISK_LEVELS.LOW ? MEMORY_MUTATION_RISK_LEVELS.MEDIUM : riskLevel;
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
  normalizeMemoryMutationFinding,
  summarizeMemoryMutationFindings,
};
