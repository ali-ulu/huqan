'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../receipt/canonical-receipt');
const { CANONICAL_VERDICTS } = require('../verdict/action-verdict');

const PREVENTION_PRIORITY = Object.freeze({ allow: 0, review: 1, block: 2 });
const CANONICAL_PRIORITY = Object.freeze({ allow: 0, disabled: 1, review: 2, dry_run_only: 3, quarantine: 4, block: 5 });
const CANONICAL_SET = new Set(CANONICAL_VERDICTS);

function makeId(prefix, value) {
  const digest = crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
  return `${prefix}_${digest.slice(0, 24)}`;
}

function ruleDecision(enforcement) {
  if (enforcement === 'block') return 'block';
  if (enforcement === 'require_verify') return 'review';
  return 'allow';
}

function mergeWithUpstreamVerdict(upstreamVerdict = 'allow', preventionVerdict = 'allow') {
  const upstream = CANONICAL_SET.has(upstreamVerdict) ? upstreamVerdict : 'block';
  const prevention = PREVENTION_PRIORITY[preventionVerdict] === undefined ? 'block' : preventionVerdict;
  return CANONICAL_PRIORITY[upstream] >= CANONICAL_PRIORITY[prevention] ? upstream : prevention;
}

function matchesRule(rule, action) {
  const trigger = rule.trigger || {};
  if (trigger.actionFingerprint && trigger.actionFingerprint !== action.actionFingerprint) return false;
  for (const field of ['tool', 'operation', 'repo', 'path']) {
    if (trigger[field] && trigger[field] !== action[field]) return false;
  }
  return true;
}

function buildPreflightDecision(action, rules, policyVersion, options = {}) {
  const matches = rules.filter((rule) => matchesRule(rule, action));
  let preventionDecision = 'allow';
  for (const rule of matches) {
    const next = ruleDecision(rule.enforcement);
    if (PREVENTION_PRIORITY[next] > PREVENTION_PRIORITY[preventionDecision]) preventionDecision = next;
  }

  const upstreamVerdict = options.upstreamVerdict || 'allow';
  const invalidUpstream = !CANONICAL_SET.has(upstreamVerdict);
  let decision = mergeWithUpstreamVerdict(upstreamVerdict, preventionDecision);
  const integrityFindings = Array.isArray(options.integrityFindings) ? options.integrityFindings : [];
  if (integrityFindings.length > 0) decision = mergeWithUpstreamVerdict(decision, 'review');

  const reasonCodes = matches.length === 0
    ? ['NO_PREVIOUS_VERIFIED_FAILURE']
    : ['PREVIOUS_VERIFIED_FAILURE', `PREVENTION_${preventionDecision.toUpperCase()}`];
  if (invalidUpstream) reasonCodes.push('UNKNOWN_UPSTREAM_VERDICT_BLOCKED');
  else if (decision !== preventionDecision && integrityFindings.length === 0) reasonCodes.push('STRICTER_UPSTREAM_VERDICT_PRESERVED');
  if (integrityFindings.length > 0) reasonCodes.push('ACTIVE_RULE_INTEGRITY_REVIEW');

  const matchedRuleIds = new Set(matches.map((rule) => rule.ruleId));
  const matchedEvidenceRefs = (Array.isArray(options.evidenceRefs) ? options.evidenceRefs : [])
    .filter((ref) => matchedRuleIds.has(ref.ruleId));
  const payload = {
    kind: 'error_prevention_preflight_receipt', policyVersion, decision,
    upstreamVerdict: invalidUpstream ? 'invalid' : upstreamVerdict,
    preventionDecision, action,
    matchedRuleIds: matches.map((rule) => rule.ruleId),
    matchedFailureIds: matches.map((rule) => rule.sourceFailureId),
    matchedEvidenceRefs, integrityFindings, reasonCodes,
  };
  return {
    ok: true, decision, upstreamVerdict, preventionDecision,
    allowed: decision === 'allow', requiresReview: decision === 'review', blocked: decision === 'block',
    reasonCodes, matchedRules: matches, matchedEvidenceRefs, integrityFindings,
    remediation: matches.map((rule) => rule.remediation).filter(Boolean),
    receipt: { ...payload, receiptId: makeId('ep_receipt', payload), createdAt: new Date().toISOString() },
  };
}

module.exports = { CANONICAL_PRIORITY, PREVENTION_PRIORITY, buildPreflightDecision, makeId, matchesRule, mergeWithUpstreamVerdict };
