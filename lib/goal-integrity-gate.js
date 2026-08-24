'use strict';

const crypto = require('node:crypto');

const GOAL_INTEGRITY_VERSION = 'GIG-v0.1.0';

const GOAL_INTEGRITY_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
});

const UNTRUSTED_SOURCE_CLASSES = new Set([
  'untrusted_content',
  'web',
  'rag',
  'email',
  'file',
  'tool_output',
  'peer_agent',
]);

function text(value, fallback = '', max = 256) {
  const normalized = String(value ?? '').trim().replace(/[\u0000-\u001f\u007f]/g, '');
  return (normalized || fallback).slice(0, max);
}

function normalizeGoal(value) {
  return text(value, '', 4096).replace(/\s+/g, ' ').trim();
}

function normalizeSourceClass(value) {
  const normalized = text(value, 'caller_goal', 64).toLowerCase().replace(/[ -]+/g, '_');
  return normalized || 'caller_goal';
}

function fingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function fingerprintGoal(goal) {
  return fingerprint(normalizeGoal(goal));
}

function createGoalIntegrityScope(goal, opts = {}) {
  const normalizedGoal = normalizeGoal(goal);
  const workspaceId = text(opts.workspaceId, 'default', 128) || 'default';
  const sourceClass = normalizeSourceClass(opts.sourceClass || opts.goalSource);
  const policyVersion = text(opts.policyVersion, GOAL_INTEGRITY_VERSION, 64) || GOAL_INTEGRITY_VERSION;
  const goalFingerprint = fingerprintGoal(normalizedGoal);
  const goalScopeId = fingerprint({ goalFingerprint, workspaceId, sourceClass, policyVersion });

  return Object.freeze({
    version: GOAL_INTEGRITY_VERSION,
    goalFingerprint,
    goalScopeId,
    workspaceId,
    sourceClass,
    policyVersion,
    immutable: true,
  });
}

function buildFinding(code, message, details = {}) {
  return {
    code,
    message,
    ...details,
  };
}

function prepareGoalIntegrityForPlan(agent, goal, opts = {}) {
  const verdict = evaluateGoalIntegrity({
    originalGoal: goal,
    proposedGoal: opts.proposedGoal,
    workspaceId: opts.workspaceId,
    sourceClass: opts.goalSource || opts.sourceClass,
    policyVersion: opts.policyVersion,
  });
  if (verdict.canPlan) return { ok: true, scope: verdict.scope, verdict };
  const code = verdict.decision === GOAL_INTEGRITY_DECISIONS.REVIEW
    ? 'GOAL_SCOPE_REVIEW_REQUIRED'
    : 'GOAL_INTEGRITY_BLOCKED';
  return {
    ok: false,
    scope: verdict.scope,
    verdict,
    result: agent._fail('plan', code,
      `Agent goal integrity refused planning: ${verdict.reason}.`,
      [], { goalIntegrity: verdict }, { goal: normalizeGoal(goal), goalIntegrity: verdict }),
  };
}

function evaluateGoalIntegrity(input = {}) {
  const originalGoal = normalizeGoal(input.originalGoal ?? input.goal);
  const hasProposedGoal = input.proposedGoal !== undefined && input.proposedGoal !== null;
  const proposedGoal = hasProposedGoal ? normalizeGoal(input.proposedGoal) : originalGoal;
  const sourceClass = normalizeSourceClass(input.sourceClass || input.goalSource);
  const scope = createGoalIntegrityScope(originalGoal, {
    workspaceId: input.workspaceId,
    sourceClass,
    policyVersion: input.policyVersion,
  });
  const findings = [];

  if (!originalGoal) {
    findings.push(buildFinding('GOAL_REQUIRED', 'A trusted goal is required before planning or execution.'));
    return {
      ok: true,
      decision: GOAL_INTEGRITY_DECISIONS.BLOCK,
      allowed: false,
      canPlan: false,
      reason: 'TRUSTED_GOAL_REQUIRED',
      mismatch: false,
      findings,
      scope,
    };
  }

  if (hasProposedGoal && proposedGoal !== originalGoal) {
    findings.push(buildFinding('GOAL_SCOPE_MISMATCH', 'The proposed goal differs from the trusted run goal.', {
      originalGoalFingerprint: scope.goalFingerprint,
      proposedGoalFingerprint: fingerprintGoal(proposedGoal),
    }));
    return {
      ok: true,
      decision: GOAL_INTEGRITY_DECISIONS.REVIEW,
      allowed: false,
      canPlan: false,
      reason: 'GOAL_SCOPE_MISMATCH_REVIEW_REQUIRED',
      mismatch: true,
      findings,
      scope,
    };
  }

  if (UNTRUSTED_SOURCE_CLASSES.has(sourceClass)) {
    findings.push(buildFinding('UNTRUSTED_GOAL_SOURCE', 'Untrusted content cannot define or replace a trusted system goal.', {
      sourceClass,
    }));
    return {
      ok: true,
      decision: GOAL_INTEGRITY_DECISIONS.BLOCK,
      allowed: false,
      canPlan: false,
      reason: 'UNTRUSTED_GOAL_SOURCE_BLOCKED',
      mismatch: false,
      findings,
      scope,
    };
  }

  return {
    ok: true,
    decision: GOAL_INTEGRITY_DECISIONS.ALLOW,
    allowed: true,
    canPlan: true,
    reason: 'GOAL_SCOPE_BOUND',
    mismatch: false,
    findings: [],
    scope,
  };
}

module.exports = {
  GOAL_INTEGRITY_VERSION,
  GOAL_INTEGRITY_DECISIONS,
  UNTRUSTED_SOURCE_CLASSES,
  normalizeGoal,
  normalizeSourceClass,
  fingerprintGoal,
  createGoalIntegrityScope,
  evaluateGoalIntegrity,
  prepareGoalIntegrityForPlan,
};
