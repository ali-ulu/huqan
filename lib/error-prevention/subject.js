'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('../receipt/canonical-receipt');

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildRuleSubject(rule = {}) {
  return {
    schemaVersion: text(rule.schemaVersion),
    ruleId: text(rule.ruleId),
    workspaceId: text(rule.workspaceId) || 'default',
    enforcement: text(rule.enforcement),
    riskScore: Number.isFinite(Number(rule.riskScore)) ? Number(rule.riskScore) : 0,
    trigger: rule.trigger && typeof rule.trigger === 'object' ? rule.trigger : {},
    constraint: text(rule.constraint),
    remediation: text(rule.remediation),
    sourceFailureId: text(rule.sourceFailureId),
    sourceFailureMemoryId: text(rule.sourceFailureMemoryId),
    supersedesRuleId: text(rule.supersedesRuleId),
  };
}

function buildRuleSubjectHash(rule = {}) {
  const json = stableStringify(buildRuleSubject(rule));
  return crypto.createHash('sha256').update(json, 'utf8').digest('hex');
}

module.exports = { buildRuleSubject, buildRuleSubjectHash };
