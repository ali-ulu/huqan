'use strict';

// #2173: the guard's decision mechanics -- running one gate fail-closed,
// merging decisions, scoring findings, the AB1 / tool-gate inputs, and
// finalizing the merged result into the guard's decision.

const { ACTION_DECISIONS, RISK_LEVELS } = require('./action-risk-classifier');
const { observeFile } = require('./file-effect-sensor');
const { findingPercentRiskScore } = require('./risk-scale');
const { EXTERNAL_ACTION_GUARD_VERSION, buildExternalActionAdmissionReceipt, persistExternalActionReceipt } = require('./external-action-receipt');
const { DECISION_RANK, EXTERNAL_ACTION_DECISIONS, EXTERNAL_ACTION_REASONS } = require('./external-action-guard-rules');

function mergeDecision(current, requested) {
  return (DECISION_RANK[requested] ?? 2) > (DECISION_RANK[current] ?? 2) ? requested : current;
}

function scoreForLevel(level) {
  const value = String(level || '').toLowerCase();
  if (value === 'critical') return 100;
  if (value === 'high') return 80;
  if (value === 'medium') return 50;
  return 10;
}

// The gate's declared scale converts a finding score, never its value (#2505).
const normalizeScore = (finding) => findingPercentRiskScore(finding, scoreForLevel);

function actionDecision(value) {
  if (value === ACTION_DECISIONS.BLOCK) return EXTERNAL_ACTION_DECISIONS.BLOCK;
  if (value === ACTION_DECISIONS.ALLOW) return EXTERNAL_ACTION_DECISIONS.ALLOW;
  return EXTERNAL_ACTION_DECISIONS.REVIEW;
}

function genericDecision(value) {
  return value === 'allow' ? EXTERNAL_ACTION_DECISIONS.ALLOW
    : value === 'block' ? EXTERNAL_ACTION_DECISIONS.BLOCK
      : EXTERNAL_ACTION_DECISIONS.REVIEW;
}

function recordGateError(gate, error, findings) {
  findings.push({ gate, decision: 'block', reason: EXTERNAL_ACTION_REASONS.GATE_ERROR, error: String(error?.message || error) });
  return EXTERNAL_ACTION_DECISIONS.BLOCK;
}

function runGate(gate, findings, evaluate, project) {
  try {
    const result = evaluate();
    const finding = project(result);
    findings.push({ gate, ...finding });
    return genericDecision(finding.decision);
  } catch (error) {
    return recordGateError(gate, error, findings);
  }
}

function buildAb1Input(envelope) {
  const target = {};
  if (envelope.target.path) target.path = envelope.target.path;
  if (envelope.target.url) target.url = envelope.target.url;
  return {
    action: envelope.action,
    category: envelope.riskCategory,
    target,
    context: {
      source: 'external-action-guard',
      flags: Array.isArray(envelope.metadata.flags) ? envelope.metadata.flags : [],
      allowlistedPaths: [envelope.workspaceRoot],
      allowlistedUrls: Array.isArray(envelope.metadata.allowlistedUrls) ? envelope.metadata.allowlistedUrls : [],
      financial: envelope.args,
    },
  };
}

function classifierForToolGate(ab1) {
  return {
    classifierVersion: EXTERNAL_ACTION_GUARD_VERSION,
    risk: {
      level: String(ab1.riskLevel || RISK_LEVELS.HIGH).toLowerCase(),
      score: scoreForLevel(ab1.riskLevel) / 100,
      category: ab1.category || 'external-action',
    },
  };
}

function finalize(envelope, partial, options) {
  let result = {
    ok: true,
    allowed: partial.decision === EXTERNAL_ACTION_DECISIONS.ALLOW,
    canExecute: partial.decision === EXTERNAL_ACTION_DECISIONS.ALLOW,
    requiredReview: partial.decision === EXTERNAL_ACTION_DECISIONS.REVIEW,
    decision: partial.decision,
    reason: partial.reason,
    risk: partial.risk,
    findings: partial.findings,
    envelope,
    metadata: {
      guardVersion: EXTERNAL_ACTION_GUARD_VERSION,
      autonomy: envelope.autonomy || null,
    },
  };
  // The first of the two readings that make `effectVerification: observed`
  // possible. Taken here, from the filesystem, so the later conclusion does not
  // rest on what the executor reports. Only for an action that names a file;
  // everything else carries null and stays `reported`.
  // Measured against the action cwd, never the guard process's: a relative
  // target resolved anywhere else would observe the wrong file (#1865).
  envelope.fileBefore = envelope.target.path ? observeFile(envelope.target.resolvedPath || envelope.target.path) : null;
  let receipt = buildExternalActionAdmissionReceipt(envelope, result, options);
  let receiptPersisted = false;
  let receiptError = null;
  try {
    receiptPersisted = persistExternalActionReceipt(options.receiptWriter, receipt);
    if (['promoted', 'demoted'].includes(envelope.autonomy?.transition?.status) && !receiptPersisted) {
      throw new Error('graduated autonomy transition requires durable receipt persistence');
    }
  } catch (error) {
    receiptError = String(error?.message || error);
    result = {
      ...result,
      allowed: false,
      canExecute: false,
      requiredReview: false,
      decision: EXTERNAL_ACTION_DECISIONS.BLOCK,
      reason: EXTERNAL_ACTION_REASONS.RECEIPT_PERSISTENCE_FAILED,
      risk: { level: RISK_LEVELS.CRITICAL, score: 100 },
      findings: [...result.findings, { gate: 'receipt', decision: 'block', reason: EXTERNAL_ACTION_REASONS.RECEIPT_PERSISTENCE_FAILED, error: receiptError }],
    };
    receipt = buildExternalActionAdmissionReceipt(envelope, result, options);
  }
  return Object.freeze({ ...result, receipt, receiptPersisted, receiptError });
}

module.exports = {
  actionDecision,
  buildAb1Input,
  classifierForToolGate,
  finalize,
  genericDecision,
  mergeDecision,
  normalizeScore,
  recordGateError,
  runGate,
  scoreForLevel,
};
