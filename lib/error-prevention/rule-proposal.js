'use strict';

const { makeId } = require('./decision');
const { makeProvenance } = require('../memory-store-utils');

const ENFORCEMENTS = Object.freeze(['warn', 'require_verify', 'block']);

function cleanString(value) { return typeof value === 'string' ? value.trim() : ''; }
function clampRisk(value, fallback = 20) {
  const score = Number(value);
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : fallback;
}

// Provenance `sourceRef` a rule learned from an AURA signal carries (the AURA
// loop writes its failure/rule with it). It is the durable marker of "this rule
// came out of the AURA path", which activation reads back to refuse a core
// promotion that never ran the bounded canary trial (#3778).
const AURA_PROVENANCE_SOURCE = 'aura';

// A provenance record only survives schema validation when the required string
// fields are present, so the stamp starts from a valid record (`makeProvenance`)
// and overrides the source identity. Caller-supplied fields win, which lets a
// caller pin the actor or workspace without losing the AURA marker.
function auraRuleProvenance(provenance = {}) {
  const base = makeProvenance(provenance.actor, provenance.workspaceId, provenance.trustPolicyVersion);
  return {
    ...base,
    ...provenance,
    sourceRef: AURA_PROVENANCE_SOURCE,
    sourceTitle: provenance.sourceTitle || 'AURA risk engine',
    sourceType: provenance.sourceType || 'aura-signal',
  };
}

function isAuraDerivedProvenance(provenance) {
  return cleanString(provenance?.sourceRef).toLowerCase() === AURA_PROVENANCE_SOURCE;
}

function buildRuleProposal(failureMemoryId, input, failure, workspaceId) {
  const enforcement = ENFORCEMENTS.includes(input.enforcement) ? input.enforcement : 'require_verify';
  const action = failure.action || {};
  const trigger = {
    actionFingerprint: action.actionFingerprint, tool: action.tool,
    operation: action.operation, repo: action.repo, path: action.path,
  };
  return {
    kind: 'error_prevention_rule', schemaVersion: '1.0.0',
    ruleId: makeId('rule', { failureId: failure.failureId, trigger, constraint: input.constraint, enforcement }),
    status: 'proposed', enforcement, riskScore: clampRisk(input.riskScore, enforcement === 'block' ? 40 : 20), trigger,
    constraint: cleanString(input.constraint) || 'Do not repeat the verified failure pattern.',
    remediation: cleanString(input.remediation), sourceFailureId: failure.failureId,
    sourceFailureMemoryId: failureMemoryId, activationEligible: failure.verificationStatus === 'verified',
    workspaceId, proposedAt: new Date().toISOString(),
  };
}

module.exports = {
  AURA_PROVENANCE_SOURCE,
  auraRuleProvenance,
  buildRuleProposal,
  clampRisk,
  ENFORCEMENTS,
  isAuraDerivedProvenance,
};
