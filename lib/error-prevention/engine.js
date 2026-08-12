'use strict';

const { buildActionFingerprint, buildFailureFingerprint, normalizeAction } = require('./fingerprint');
const { classifyFailureTrust } = require('./trust');
const { evaluateRuleAdmission } = require('./admission');
const { buildPreflightDecision, makeId } = require('./decision');
const ErrorPreventionStore = require('./store');

const ENFORCEMENTS = Object.freeze(['warn', 'require_verify', 'block']);
const RULE_STATUSES = Object.freeze(['proposed', 'active', 'superseded', 'rejected', 'quarantined']);

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function normalizeEvidence(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item !== undefined && item !== null).map(clone);
}

class ErrorPrevention {
  constructor(memoryStore, options = {}) {
    this.store = new ErrorPreventionStore(memoryStore);
    this.policyVersion = cleanString(options.policyVersion) || 'error-prevention-v0.1.0';
  }

  recordFailure(input = {}) {
    const action = normalizeAction(input);
    if (!action.operation) return { ok: false, error: { code: 'OPERATION_REQUIRED', message: 'operation is required' } };
    const observed = cleanString(input.observed);
    if (!observed) return { ok: false, error: { code: 'OBSERVED_REQUIRED', message: 'observed is required' } };

    const evidence = normalizeEvidence(input.evidence);
    const trust = classifyFailureTrust(input.source, evidence);
    const failureFingerprint = buildFailureFingerprint(input);
    const actionFingerprint = buildActionFingerprint(input);
    const content = {
      kind: 'failure_record',
      schemaVersion: '1.0.0',
      failureId: makeId('failure', { failureFingerprint }),
      source: trust.source,
      verificationStatus: trust.verificationStatus,
      trust: trust.trust,
      action: { ...action, actionFingerprint },
      expected: cleanString(input.expected),
      observed,
      evidence,
      failureFingerprint,
      workspaceId: action.workspaceId,
      recordedAt: new Date().toISOString(),
    };
    const stored = this.store.storeContent(content, {
      workspaceId: action.workspaceId,
      actor: input.actor,
      provenance: input.provenance,
      trustPolicyVersion: input.trustPolicyVersion,
    });
    return stored.ok ? { ok: true, failure: stored.memory.content, memory: stored.memory } : stored;
  }

  proposeRule(failureMemoryId, input = {}) {
    const workspaceId = cleanString(input.workspaceId) || 'default';
    const failureResult = this.store.get(failureMemoryId, workspaceId);
    if (!failureResult.ok) return failureResult;
    const failure = failureResult.memory.content;
    if (failure?.kind !== 'failure_record') {
      return { ok: false, error: { code: 'FAILURE_MEMORY_REQUIRED', message: 'memory is not a failure record' } };
    }
    const enforcement = ENFORCEMENTS.includes(input.enforcement) ? input.enforcement : 'require_verify';
    const action = failure.action || {};
    const trigger = {
      actionFingerprint: action.actionFingerprint,
      tool: action.tool,
      operation: action.operation,
      repo: action.repo,
      path: action.path,
    };
    const content = {
      kind: 'error_prevention_rule',
      schemaVersion: '1.0.0',
      ruleId: makeId('rule', { failureId: failure.failureId, trigger, constraint: input.constraint, enforcement }),
      status: 'proposed',
      enforcement,
      trigger,
      constraint: cleanString(input.constraint) || 'Do not repeat the verified failure pattern.',
      remediation: cleanString(input.remediation),
      sourceFailureId: failure.failureId,
      sourceFailureMemoryId: failureMemoryId,
      activationEligible: failure.verificationStatus === 'verified',
      workspaceId,
      proposedAt: new Date().toISOString(),
    };
    const stored = this.store.storeContent(content, {
      workspaceId,
      actor: input.actor,
      provenance: input.provenance || failureResult.memory.provenance,
      trustPolicyVersion: input.trustPolicyVersion || failureResult.memory.trustPolicyVersion,
    });
    return stored.ok ? { ok: true, rule: stored.memory.content, memory: stored.memory } : stored;
  }

  activateRule(ruleMemoryId, opts = {}) {
    const workspaceId = cleanString(opts.workspaceId) || 'default';
    const ruleResult = this.store.get(ruleMemoryId, workspaceId);
    if (!ruleResult.ok) return ruleResult;
    const rule = ruleResult.memory.content;
    if (rule?.kind !== 'error_prevention_rule' || rule.status !== 'proposed') {
      return { ok: false, error: { code: 'PROPOSED_RULE_REQUIRED', message: 'rule must be proposed' } };
    }
    const failureResult = this.store.get(rule.sourceFailureMemoryId, workspaceId);
    if (!failureResult.ok) return failureResult;
    if (failureResult.memory.content?.verificationStatus !== 'verified') {
      return { ok: false, error: { code: 'UNVERIFIED_FAILURE_CANNOT_ACTIVATE', message: 'active rules require verified failure evidence' } };
    }

    const active = { ...clone(rule), status: 'active', activatedAt: new Date().toISOString() };
    const provenance = opts.provenance || ruleResult.memory.provenance || failureResult.memory.provenance;
    const admission = evaluateRuleAdmission({
      ruleMemoryId, rule: active, memory: ruleResult.memory, provenance, opts,
      policyVersion: this.policyVersion, reason: 'activate_error_prevention_rule',
    });
    if (!admission.ok || admission.decision?.decision !== 'allow') {
      return { ok: false, decision: admission.decision || null, receipt: admission.receipt || null, rule: null };
    }
    const updated = this.store.supersede(ruleMemoryId, active, {
      workspaceId, actor: opts.actor, provenance, trustPolicyVersion: ruleResult.memory.trustPolicyVersion,
    });
    return updated.ok
      ? { ok: true, rule: updated.newMemory.content, memory: updated.newMemory, admission: admission.decision, receipt: admission.receipt }
      : updated;
  }

  listRules(opts = {}) {
    const status = RULE_STATUSES.includes(opts.status) ? opts.status : 'active';
    const listed = this.store.listKind('error_prevention_rule', { workspaceId: opts.workspaceId || 'default' });
    if (!listed.ok) return listed;
    const rules = listed.memories.filter((memory) => memory.content.status === status);
    return { ok: true, rules: rules.map((memory) => ({ memoryId: memory.memoryId, ...clone(memory.content) })), total: rules.length };
  }

  preflight(input = {}) {
    const action = { ...normalizeAction(input), actionFingerprint: buildActionFingerprint(input) };
    if (!action.operation) return { ok: false, error: { code: 'OPERATION_REQUIRED', message: 'operation is required' } };
    const listed = this.listRules({ workspaceId: action.workspaceId, status: 'active' });
    return listed.ok ? buildPreflightDecision(action, listed.rules, this.policyVersion) : listed;
  }

  supersedeRule(ruleMemoryId, replacement = {}, opts = {}) {
    const workspaceId = cleanString(opts.workspaceId || replacement.workspaceId) || 'default';
    const currentResult = this.store.get(ruleMemoryId, workspaceId);
    if (!currentResult.ok) return currentResult;
    const current = currentResult.memory.content;
    if (current?.kind !== 'error_prevention_rule' || current.status !== 'active') {
      return { ok: false, error: { code: 'ACTIVE_RULE_REQUIRED', message: 'rule must be active' } };
    }
    const next = {
      ...clone(current),
      ruleId: makeId('rule', { supersedes: current.ruleId, replacement }),
      enforcement: ENFORCEMENTS.includes(replacement.enforcement) ? replacement.enforcement : current.enforcement,
      constraint: cleanString(replacement.constraint) || current.constraint,
      remediation: replacement.remediation === undefined ? current.remediation : cleanString(replacement.remediation),
      status: 'active',
      supersedesRuleId: current.ruleId,
      activatedAt: new Date().toISOString(),
    };
    const provenance = opts.provenance || currentResult.memory.provenance;
    const admission = evaluateRuleAdmission({
      ruleMemoryId, rule: next, memory: currentResult.memory, provenance, opts,
      policyVersion: this.policyVersion, reason: 'supersede_error_prevention_rule',
    });
    if (!admission.ok || admission.decision?.decision !== 'allow') {
      return { ok: false, decision: admission.decision || null, receipt: admission.receipt || null, rule: null };
    }
    const updated = this.store.supersede(ruleMemoryId, next, {
      workspaceId, actor: opts.actor, provenance, trustPolicyVersion: currentResult.memory.trustPolicyVersion,
    });
    return updated.ok ? { ok: true, rule: updated.newMemory.content, memory: updated.newMemory, receipt: admission.receipt } : updated;
  }
}

module.exports = { ENFORCEMENTS, ErrorPrevention, RULE_STATUSES };
