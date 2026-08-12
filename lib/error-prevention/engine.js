'use strict';

const { buildActionFingerprint, buildFailureFingerprint, normalizeAction } = require('./fingerprint');
const { classifyFailureTrust, normalizeSource } = require('./trust');
const { evaluateRuleAdmission } = require('./admission');
const { buildPreflightDecision, makeId, mergeWithUpstreamVerdict } = require('./decision');
const { collectRuleEvidenceRefs } = require('./evidence');
const { recordPreflightAudit } = require('./audit');
const {
  effectiveRuleStatus,
  persistActivationTerminal,
  persistReplacementTerminal,
} = require('./lifecycle');
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

function clampRisk(value, fallback = 20) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : fallback;
}

class ErrorPrevention {
  constructor(memoryStore, options = {}) {
    this.store = new ErrorPreventionStore(memoryStore);
    this.policyVersion = cleanString(options.policyVersion) || 'error-prevention-v0.1.0';
    this.verifyEvidence = typeof options.verifyEvidence === 'function' ? options.verifyEvidence : null;
    this.resolveApproval = typeof options.resolveApproval === 'function' ? options.resolveApproval : null;
    this.auditTarget = options.auditTarget || null;
  }

  _verifyFailureEvidence(source, evidence, input) {
    if (!this.verifyEvidence) return { verified: false, reason: 'verifier_unavailable' };
    try {
      const result = this.verifyEvidence({ source, evidence: clone(evidence), input: clone(input) });
      if (result === true) return { verified: true, reason: 'verified_by_authority' };
      if (result && typeof result === 'object') {
        return { verified: result.verified === true, reason: cleanString(result.reason) || 'verifier_decision' };
      }
      return { verified: false, reason: 'verifier_rejected' };
    } catch (_) {
      return { verified: false, reason: 'verifier_error' };
    }
  }

  _resolveRuleApproval(ruleMemoryId, rule, opts) {
    if (!this.resolveApproval) return { approvalId: '', status: 'pending' };
    try {
      const result = this.resolveApproval({
        ruleMemoryId,
        rule: clone(rule),
        workspaceId: cleanString(opts.workspaceId || rule.workspaceId) || 'default',
        approvalIdHint: cleanString(opts.approvalId),
      });
      const approvalId = cleanString(result?.approvalId);
      const status = cleanString(result?.status).toLowerCase();
      const authoritative = ['approved', 'rejected', 'cancelled', 'expired'];
      if (!approvalId || !authoritative.includes(status)) return { approvalId, status: 'pending' };
      return { approvalId, status };
    } catch (_) {
      return { approvalId: '', status: 'pending' };
    }
  }

  recordFailure(input = {}) {
    const action = normalizeAction(input);
    if (!action.operation) return { ok: false, error: { code: 'OPERATION_REQUIRED', message: 'operation is required' } };
    const observed = cleanString(input.observed);
    if (!observed) return { ok: false, error: { code: 'OBSERVED_REQUIRED', message: 'observed is required' } };

    const evidence = normalizeEvidence(input.evidence);
    const source = normalizeSource(input.source);
    const verification = this._verifyFailureEvidence(source, evidence, input);
    const trust = classifyFailureTrust(source, evidence, verification);
    const failureFingerprint = buildFailureFingerprint(input);
    const actionFingerprint = buildActionFingerprint(input);
    const content = {
      kind: 'failure_record', schemaVersion: '1.0.0',
      failureId: makeId('failure', { failureFingerprint }),
      source: trust.source, verificationStatus: trust.verificationStatus, trust: trust.trust,
      verificationReason: verification.reason,
      action: { ...action, actionFingerprint }, expected: cleanString(input.expected), observed,
      evidence, failureFingerprint, workspaceId: action.workspaceId, recordedAt: new Date().toISOString(),
    };
    const stored = this.store.storeContent(content, {
      workspaceId: action.workspaceId, actor: input.actor,
      provenance: input.provenance, trustPolicyVersion: input.trustPolicyVersion,
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
      actionFingerprint: action.actionFingerprint, tool: action.tool,
      operation: action.operation, repo: action.repo, path: action.path,
    };
    const content = {
      kind: 'error_prevention_rule', schemaVersion: '1.0.0',
      ruleId: makeId('rule', { failureId: failure.failureId, trigger, constraint: input.constraint, enforcement }),
      status: 'proposed', enforcement, riskScore: clampRisk(input.riskScore, enforcement === 'block' ? 40 : 20), trigger,
      constraint: cleanString(input.constraint) || 'Do not repeat the verified failure pattern.',
      remediation: cleanString(input.remediation), sourceFailureId: failure.failureId,
      sourceFailureMemoryId: failureMemoryId, activationEligible: failure.verificationStatus === 'verified',
      workspaceId, proposedAt: new Date().toISOString(),
    };
    const stored = this.store.storeContent(content, {
      workspaceId, actor: input.actor,
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
    const approval = this._resolveRuleApproval(ruleMemoryId, active, opts);
    const admission = evaluateRuleAdmission({
      ruleMemoryId, rule: active, memory: ruleResult.memory, provenance, approval, opts,
      policyVersion: this.policyVersion, reason: 'activate_error_prevention_rule',
    });
    if (!admission.ok || admission.decision?.decision !== 'allow') {
      const terminal = admission.ok
        ? persistActivationTerminal(this.store, ruleMemoryId, ruleResult, rule, admission, { ...opts, provenance })
        : null;
      return { ok: false, decision: admission.decision || null, receipt: admission.receipt || null,
        rule: terminal?.ok ? terminal.newMemory.content : null, memory: terminal?.ok ? terminal.newMemory : null };
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
    const listed = this.store.listKind('error_prevention_rule', {
      workspaceId: opts.workspaceId || 'default', includeTombstoned: status === 'superseded',
    });
    if (!listed.ok) return listed;
    const rules = listed.memories
      .map((memory) => ({ memory, status: effectiveRuleStatus(memory) }))
      .filter((entry) => entry.status === status)
      .map(({ memory, status: effectiveStatus }) => ({ memoryId: memory.memoryId, ...clone(memory.content), status: effectiveStatus }));
    return { ok: true, rules, total: rules.length };
  }

  preflight(input = {}, options = {}) {
    const action = { ...normalizeAction(input), actionFingerprint: buildActionFingerprint(input) };
    if (!action.operation) return { ok: false, error: { code: 'OPERATION_REQUIRED', message: 'operation is required' } };
    const listed = this.listRules({ workspaceId: action.workspaceId, status: 'active' });
    if (!listed.ok) return listed;
    const evidenceRefs = collectRuleEvidenceRefs(this.store, listed.rules, action.workspaceId);
    const result = buildPreflightDecision(action, listed.rules, this.policyVersion, { ...options, evidenceRefs });
    const audit = recordPreflightAudit(options.auditTarget || this.auditTarget, result, action, options);
    if (audit.ok) return { ...result, audit };
    const decision = mergeWithUpstreamVerdict(result.decision, 'review');
    return { ...result, ok: false, decision, allowed: false, requiresReview: decision === 'review',
      blocked: decision === 'block', reasonCodes: [...result.reasonCodes, 'AUDIT_WRITE_FAILED'], receipt: null, audit };
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
      ...clone(current), ruleId: makeId('rule', { supersedes: current.ruleId, replacement }),
      enforcement: ENFORCEMENTS.includes(replacement.enforcement) ? replacement.enforcement : current.enforcement,
      riskScore: clampRisk(replacement.riskScore, current.riskScore),
      constraint: cleanString(replacement.constraint) || current.constraint,
      remediation: replacement.remediation === undefined ? current.remediation : cleanString(replacement.remediation),
      status: 'active', supersedesRuleId: current.ruleId, activatedAt: new Date().toISOString(),
    };
    const provenance = opts.provenance || currentResult.memory.provenance;
    const approval = this._resolveRuleApproval(ruleMemoryId, next, opts);
    const admission = evaluateRuleAdmission({
      ruleMemoryId, rule: next, memory: currentResult.memory, provenance, approval, opts,
      policyVersion: this.policyVersion, reason: 'supersede_error_prevention_rule',
    });
    if (!admission.ok || admission.decision?.decision !== 'allow') {
      const terminal = admission.ok
        ? persistReplacementTerminal(this.store, next, currentResult.memory, admission, { ...opts, provenance })
        : null;
      return { ok: false, decision: admission.decision || null, receipt: admission.receipt || null,
        rule: terminal?.ok ? terminal.memory.content : null, memory: terminal?.ok ? terminal.memory : null };
    }
    const updated = this.store.supersede(ruleMemoryId, next, {
      workspaceId, actor: opts.actor, provenance, trustPolicyVersion: currentResult.memory.trustPolicyVersion,
    });
    return updated.ok ? { ok: true, rule: updated.newMemory.content, memory: updated.newMemory, receipt: admission.receipt } : updated;
  }
}

module.exports = { ENFORCEMENTS, ErrorPrevention, RULE_STATUSES };
