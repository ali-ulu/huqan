'use strict';

const crypto = require('crypto');

function clean(value) { return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : ''; }
function digest(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
function has(object, key) { return Boolean(object) && Object.prototype.hasOwnProperty.call(object, key); }

function createExecutionScope(goal, opts = {}) {
  const trustedGoal = clean(goal);
  const workspaceId = clean(opts.workspaceId) || 'default';
  const policyVersion = clean(opts.policyVersion) || 'goal-binding-v1';
  if (!trustedGoal) return { ok: false, reason: 'GOAL_REQUIRED', receipt: { decision: 'block', reason: 'GOAL_REQUIRED' } };
  if (opts.contentClass === 'untrusted_content' || opts.sourceTrust === 'untrusted') {
    return { ok: false, reason: 'UNTRUSTED_CONTENT_CANNOT_SET_GOAL', receipt: { decision: 'block', reason: 'UNTRUSTED_CONTENT_CANNOT_SET_GOAL', workspaceId, policyVersion } };
  }
  const scope = { goal: trustedGoal, objective: clean(opts.objective), workspaceId, policyVersion };
  return { ok: true, scope: Object.freeze({ ...scope, fingerprint: digest(scope) }), receipt: { decision: 'allow', goalFingerprint: digest(scope), workspaceId, policyVersion } };
}

function evaluateGoalBinding(scope, step = {}) {
  if (!scope || !scope.fingerprint) return { ok: false, reason: 'GOAL_SCOPE_REQUIRED', receipt: { decision: 'block', reason: 'GOAL_SCOPE_REQUIRED' } };
  const untrusted = step.contentClass === 'untrusted_content' || step.sourceTrust === 'untrusted' || step.source?.trust === 'untrusted';
  const changesGoal = (has(step, 'goal') && clean(step.goal) !== scope.goal) || (has(step, 'objective') && clean(step.objective) !== scope.objective);
  const changesPolicy = has(step, 'policyVersion') && clean(step.policyVersion) !== scope.policyVersion;
  const reason = changesGoal ? 'GOAL_SCOPE_DRIFT' : (changesPolicy ? 'GOAL_POLICY_DRIFT' : null);
  if (reason) return { ok: false, reason, receipt: { decision: 'block', reason, contentClass: untrusted ? 'untrusted_content' : 'trusted', goalFingerprint: scope.fingerprint, workspaceId: scope.workspaceId, policyVersion: scope.policyVersion } };
  return { ok: true, receipt: { decision: 'allow', contentClass: untrusted ? 'untrusted_content' : 'trusted', goalFingerprint: scope.fingerprint, workspaceId: scope.workspaceId, policyVersion: scope.policyVersion } };
}

module.exports = { createExecutionScope, evaluateGoalBinding };
