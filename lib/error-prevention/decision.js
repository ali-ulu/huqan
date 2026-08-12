'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../receipt/canonical-receipt');

const DECISION_PRIORITY = Object.freeze({ allow: 0, review: 1, block: 2 });

function makeId(prefix, value) {
  const digest = crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
  return `${prefix}_${digest.slice(0, 24)}`;
}

function ruleDecision(enforcement) {
  if (enforcement === 'block') return 'block';
  if (enforcement === 'require_verify') return 'review';
  return 'allow';
}

function matchesRule(rule, action) {
  const trigger = rule.trigger || {};
  if (trigger.actionFingerprint && trigger.actionFingerprint !== action.actionFingerprint) return false;
  for (const field of ['tool', 'operation', 'repo', 'path']) {
    if (trigger[field] && trigger[field] !== action[field]) return false;
  }
  return true;
}

function buildPreflightDecision(action, rules, policyVersion) {
  const matches = rules.filter((rule) => matchesRule(rule, action));
  let decision = 'allow';
  for (const rule of matches) {
    const next = ruleDecision(rule.enforcement);
    if (DECISION_PRIORITY[next] > DECISION_PRIORITY[decision]) decision = next;
  }
  const reasonCodes = matches.length === 0
    ? ['NO_PREVIOUS_VERIFIED_FAILURE']
    : ['PREVIOUS_VERIFIED_FAILURE', `PREVENTION_${decision.toUpperCase()}`];
  const payload = {
    kind: 'error_prevention_preflight_receipt',
    policyVersion,
    decision,
    action,
    matchedRuleIds: matches.map((rule) => rule.ruleId),
    matchedFailureIds: matches.map((rule) => rule.sourceFailureId),
    reasonCodes,
  };
  return {
    ok: true,
    decision,
    allowed: decision === 'allow',
    requiresReview: decision === 'review',
    blocked: decision === 'block',
    reasonCodes,
    matchedRules: matches,
    remediation: matches.map((rule) => rule.remediation).filter(Boolean),
    receipt: { ...payload, receiptId: makeId('ep_receipt', payload), createdAt: new Date().toISOString() },
  };
}

module.exports = { DECISION_PRIORITY, buildPreflightDecision, makeId, matchesRule };
