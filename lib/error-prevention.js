'use strict';

const crypto = require('node:crypto');

const VERIFIED_SOURCES = new Set(['test_failure', 'ci_failure', 'tool_failure', 'verifier_failure']);
const REVIEW_SOURCES = new Set(['user_correction', 'model_self_report', 'external_content']);
const RULE_STATES = new Set(['proposed', 'active', 'superseded', 'rejected', 'quarantined']);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
}

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeScope(scope = {}) {
  return Object.freeze({
    workspace: clean(scope.workspace),
    repo: clean(scope.repo),
    path: clean(scope.path),
  });
}

function actionIdentity(input = {}) {
  return Object.freeze({
    tool: clean(input.tool),
    operation: clean(input.operation),
    scope: normalizeScope(input.scope),
  });
}

function fingerprintAction(input = {}) {
  return hash(actionIdentity(input));
}

function classifyFailureSource(source) {
  if (VERIFIED_SOURCES.has(source)) return 'verified';
  if (REVIEW_SOURCES.has(source)) return 'review';
  return 'quarantined';
}

function recordFailure(input = {}, options = {}) {
  const source = clean(input.source);
  const identity = actionIdentity(input);
  const evidence = input.evidence && typeof input.evidence === 'object' ? stable(input.evidence) : null;
  const verification = classifyFailureSource(source);
  const record = Object.freeze({
    id: `failure_${hash({ source, identity, expected: input.expected, observed: input.observed, evidence }).slice(0, 24)}`,
    type: 'error_prevention_failure',
    source,
    tool: identity.tool,
    operation: identity.operation,
    scope: identity.scope,
    expected: input.expected ?? null,
    observed: input.observed ?? null,
    evidence,
    fingerprint: fingerprintAction(identity),
    verification,
  });
  if (options.store?.putFailure) options.store.putFailure(record);
  if (options.audit) options.audit({ event: 'error_prevention.failure_recorded', record });
  return record;
}

function proposeRule(failure, input = {}, options = {}) {
  if (!failure || failure.type !== 'error_prevention_failure') throw new TypeError('verified failure record required');
  const decision = input.decision === 'review' ? 'review' : 'block';
  const provenance = input.provenance && typeof input.provenance === 'object' ? stable(input.provenance) : null;
  const state = failure.verification === 'quarantined' ? 'quarantined' : 'proposed';
  const rule = Object.freeze({
    id: `rule_${hash({ failureId: failure.id, decision, provenance }).slice(0, 24)}`,
    type: 'error_prevention_rule',
    failureId: failure.id,
    failureFingerprint: failure.fingerprint,
    tool: failure.tool,
    operation: failure.operation,
    scope: failure.scope,
    decision,
    provenance,
    state,
  });
  if (options.store?.putRule) options.store.putRule(rule);
  return rule;
}

function activateRule(rule, failure, approval = {}, options = {}) {
  if (!rule || rule.type !== 'error_prevention_rule') throw new TypeError('rule required');
  if (!failure || failure.id !== rule.failureId) throw new TypeError('matching failure required');
  const approved = approval.approved === true && clean(approval.approver) !== '';
  const hasProvenance = rule.provenance && Object.keys(rule.provenance).length > 0;
  const eligible = failure.verification === 'verified' || failure.source === 'user_correction';
  const state = approved && hasProvenance && eligible ? 'active' : 'quarantined';
  const next = Object.freeze({ ...rule, state, approval: approved ? stable(approval) : null });
  if (options.store?.putRule) options.store.putRule(next);
  if (options.audit) options.audit({ event: 'error_prevention.rule_state', rule: next });
  return next;
}

function supersedeRule(rule, replacementRuleId = '', options = {}) {
  if (!rule || !RULE_STATES.has(rule.state)) throw new TypeError('valid rule required');
  const next = Object.freeze({ ...rule, state: 'superseded', replacementRuleId: clean(replacementRuleId) || null });
  if (options.store?.putRule) options.store.putRule(next);
  return next;
}

function sameScope(ruleScope, actionScope) {
  return ['workspace', 'repo', 'path'].every((key) => !ruleScope[key] || ruleScope[key] === actionScope[key]);
}

function severity(decision) {
  if (decision === 'block') return 2;
  if (decision === 'review') return 1;
  return 0;
}

function preflight(action = {}, rules = [], options = {}) {
  const identity = actionIdentity(action);
  const fingerprint = fingerprintAction(identity);
  const matches = rules.filter((rule) => (
    rule?.type === 'error_prevention_rule'
    && rule.state === 'active'
    && rule.failureFingerprint === fingerprint
    && rule.tool === identity.tool
    && rule.operation === identity.operation
    && sameScope(rule.scope, identity.scope)
  ));
  const preventionDecision = matches.some((r) => r.decision === 'block') ? 'block'
    : matches.some((r) => r.decision === 'review') ? 'review' : 'allow';
  const existingDecision = ['allow', 'review', 'block'].includes(options.existingDecision)
    ? options.existingDecision : 'allow';
  const decision = severity(existingDecision) > severity(preventionDecision) ? existingDecision : preventionDecision;
  const result = Object.freeze({
    decision,
    preventionDecision,
    reasonCode: matches.length ? 'ERROR_PREVENTION_RULE_MATCH' : 'ERROR_PREVENTION_NO_MATCH',
    fingerprint,
    matchedRuleIds: Object.freeze(matches.map((rule) => rule.id)),
    matchedFailureIds: Object.freeze(matches.map((rule) => rule.failureId)),
  });
  if (options.audit) options.audit({ event: 'error_prevention.preflight', action: identity, result });
  return result;
}

function listActiveRules(store) {
  const rules = store?.listRules ? store.listRules() : [];
  return rules.filter((rule) => rule?.state === 'active');
}

module.exports = {
  VERIFIED_SOURCES,
  actionIdentity,
  activateRule,
  fingerprintAction,
  listActiveRules,
  preflight,
  proposeRule,
  recordFailure,
  supersedeRule,
};
