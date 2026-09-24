'use strict';

// Folds per-file findings into one decision, and normalises a finished
// decision into the shape callers read (#2134).

const { normalizeText } = require('./text-utils');
const { isPlainObject } = require('./is-plain-object');
const { CODE_BLAST_RADIUS_VERSION } = require('./code-change-blast-radius');
const {
  CODE_CHANGE_GATE_DECISIONS,
  CODE_CHANGE_RISK_LEVELS,
  CODE_CHANGE_GATE_REASONS,
  CODE_CHANGE_POLICY_VERSION,
  DEFAULT_WORKSPACE_ID,
  firstText,
  normalizePath,
  compareCodePoints,
  normalizeDecisionLabel,
  normalizeRiskLevel,
  clampScore,
  decisionRank,
  mergeDecision,
  reasonToDecision,
} = require('./code-change-gate-vocabulary');

function summarizeFileFindings(fileFindings) {
  const findings = Array.isArray(fileFindings)
    ? fileFindings.map(normalizeCodeChangeDecisionFileFinding).sort((left, right) => compareCodePoints(left.path, right.path))
    : [];

  if (!findings.length) {
    return {
      fileCount: 0,
      categories: [],
      riskLevel: CODE_CHANGE_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: CODE_CHANGE_GATE_DECISIONS.REVIEW,
      reason: CODE_CHANGE_GATE_REASONS.EMPTY_FILE_LIST_REVIEW_REQUIRED,
      hasCritical: false,
      hasHighRisk: false,
      reasons: [CODE_CHANGE_GATE_REASONS.EMPTY_FILE_LIST_REVIEW_REQUIRED],
    };
  }

  let decision = CODE_CHANGE_GATE_DECISIONS.ALLOW;
  let reason = CODE_CHANGE_GATE_REASONS.LOW_RISK_DOCS_ONLY;
  let riskLevel = CODE_CHANGE_RISK_LEVELS.LOW;
  let riskScore = 0.15;
  const categories = new Set();
  const reasons = [];
  let hasCritical = false;
  let hasHighRisk = false;

  for (const finding of findings) {
    categories.add(finding.category);
    reasons.push(finding.reason);
    decision = mergeDecision(decision, finding.decision);

    const rank = decisionRank(finding.decision);
    if (rank >= 3) {
      hasCritical = true;
      riskLevel = CODE_CHANGE_RISK_LEVELS.CRITICAL;
      riskScore = 1;
      reason = finding.reason;
      continue;
    }
    if (rank === 2 && decisionRank(reasonToDecision(reason)) < 2) {
      riskLevel = CODE_CHANGE_RISK_LEVELS.MEDIUM;
      riskScore = Math.max(riskScore, 0.55);
      reason = finding.reason;
    }
    if (rank === 1) {
      hasHighRisk = true;
      riskLevel = CODE_CHANGE_RISK_LEVELS.HIGH;
      riskScore = Math.max(riskScore, 0.85);
      reason = finding.reason;
    }
    if (rank === 0) {
      reason = finding.reason;
    }
  }

  const categoryList = [...categories].sort();
  const broadCategories = categoryList.filter(category => category !== 'docs' && category !== 'tests' && category !== 'helper');
  if (broadCategories.length > 1) {
    hasHighRisk = true;
    if (riskLevel === CODE_CHANGE_RISK_LEVELS.LOW) {
      riskLevel = CODE_CHANGE_RISK_LEVELS.MEDIUM;
      riskScore = Math.max(riskScore, 0.55);
    }
  }

  if (hasCritical) {
    decision = CODE_CHANGE_GATE_DECISIONS.BLOCK;
    reason = reasons.find(item => item === CODE_CHANGE_GATE_REASONS.RELEASE_OR_DEPLOY_CHANGE_BLOCKED)
      || reasons.find(item => item === CODE_CHANGE_GATE_REASONS.AUTO_MERGE_OR_AUTOPUSH_BLOCKED)
      || reasons.find(item => item === CODE_CHANGE_GATE_REASONS.SECRET_CHANGE_BLOCKED)
      || reason;
    riskLevel = CODE_CHANGE_RISK_LEVELS.CRITICAL;
    riskScore = 1;
  } else if (hasHighRisk && decision === CODE_CHANGE_GATE_DECISIONS.ALLOW) {
    decision = CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY;
    riskLevel = CODE_CHANGE_RISK_LEVELS.HIGH;
    riskScore = Math.max(riskScore, 0.85);
    reason = CODE_CHANGE_GATE_REASONS.BREADTH_REVIEW_REQUIRED;
  }

  if (decision === CODE_CHANGE_GATE_DECISIONS.REVIEW && !hasHighRisk) {
    riskLevel = riskLevel === CODE_CHANGE_RISK_LEVELS.LOW ? CODE_CHANGE_RISK_LEVELS.MEDIUM : riskLevel;
    riskScore = Math.max(riskScore, 0.55);
  }

  return {
    fileCount: findings.length,
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

function normalizeCodeChangeDecisionFileFinding(finding) {
  const raw = isPlainObject(finding) ? finding : {};
  const path = normalizePath(raw.path);
  const status = firstText(raw.status, 'modified');
  const changeType = normalizeText(firstText(raw.changeType, 'source')) || 'source';
  const category = firstText(raw.category, 'source');
  const reason = firstText(raw.reason, CODE_CHANGE_GATE_REASONS.SOURCE_CHANGE_REQUIRES_REVIEW);
  const notes = Array.isArray(raw.notes) ? raw.notes.filter(Boolean).map(note => String(note)) : [];
  return {
    ok: Boolean(raw.ok ?? true),
    path,
    status,
    changeType,
    category,
    riskLevel: normalizeRiskLevel(raw.riskLevel),
    riskScore: clampScore(raw.riskScore, 0.5),
    decision: normalizeDecisionLabel(raw.decision) || CODE_CHANGE_GATE_DECISIONS.REVIEW,
    reason,
    notes,
    sensitive: Boolean(raw.sensitive),
  };
}

function normalizeCodeChangeDecision(decision) {
  const raw = isPlainObject(decision) ? decision : {};
  const normalizedDecision = normalizeDecisionLabel(raw.decision);
  const normalizedRisk = isPlainObject(raw.risk) ? raw.risk : {};
  const normalizedFileFindings = Array.isArray(raw.fileFindings)
    ? raw.fileFindings.map(normalizeCodeChangeDecisionFileFinding).sort((left, right) => compareCodePoints(left.path, right.path))
    : [];
  const warnings = Array.isArray(raw.warnings) ? raw.warnings.filter(Boolean).map(value => String(value)) : [];
  const metadata = isPlainObject(raw.metadata) ? raw.metadata : {};

  return {
    ok: Boolean(raw.ok ?? true),
    allowed: normalizedDecision === CODE_CHANGE_GATE_DECISIONS.ALLOW,
    canApply: normalizedDecision === CODE_CHANGE_GATE_DECISIONS.ALLOW,
    canDryRun: normalizedDecision !== CODE_CHANGE_GATE_DECISIONS.BLOCK,
    decision: normalizedDecision || CODE_CHANGE_GATE_DECISIONS.REVIEW,
    reason: firstText(raw.reason, CODE_CHANGE_GATE_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED),
    risk: {
      level: normalizeRiskLevel(normalizedRisk.level),
      score: clampScore(normalizedRisk.score, 0.5),
      categories: Array.isArray(normalizedRisk.categories)
        ? [...new Set(normalizedRisk.categories.filter(Boolean).map(value => String(value)))].sort()
        : [],
    },
    requiredReview: normalizedDecision !== CODE_CHANGE_GATE_DECISIONS.ALLOW,
    dryRunOnly: normalizedDecision === CODE_CHANGE_GATE_DECISIONS.DRY_RUN_ONLY,
    fileFindings: normalizedFileFindings,
    warnings,
    metadata: {
      policyVersion: firstText(metadata.policyVersion, CODE_CHANGE_POLICY_VERSION),
      workspaceId: firstText(metadata.workspaceId, DEFAULT_WORKSPACE_ID) || DEFAULT_WORKSPACE_ID,
      // #2505 A: the recorded-only dependency dimension rides through only
      // when it is a well-formed envelope; anything else is dropped rather
      // than persisted into the receipt.
      ...(isPlainObject(metadata.blastRadius)
      && metadata.blastRadius.version === CODE_BLAST_RADIUS_VERSION
        ? { blastRadius: metadata.blastRadius }
        : {}),
    },
  };
}

module.exports = {
  summarizeFileFindings,
  normalizeCodeChangeDecision,
};
