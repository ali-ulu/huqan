'use strict';

const { isPlainObject, firstText, isSecretLikeValue } = require('./automation-input-normalizer');
const { normalizeText } = require('../text-utils');
const { classifyEntryPhase } = require('./automation-operation-classifier-entry');
const { classifyHazardPhase } = require('./automation-operation-classifier-hazards');
const { classifyDeliveryPhase } = require('./automation-operation-classifier-delivery');
const { classifyFallbackPhase } = require('./automation-operation-classifier-fallback');

// classifyAutomationOperation is one ordered if-chain: an earlier check
// establishes precedence over a later one for overlapping safety families.
// #2176 moved the chain into four phase modules without reordering a single
// branch -- each phase returns its finding or null, and the phases run in the
// original order, so the first matching check still wins. The shared local
// context (opType, opText, explicitApproval, approvedMergePath,
// secretDetected) is computed once here and handed to every phase.
function buildClassifierContext(context) {
  const normalized = isPlainObject(context) ? context : {};
  const opType = normalizeText(firstText(normalized.operationType, 'unknown'));
  const opText = normalizeText([
    opType,
    normalized.target,
    normalized.actor,
    normalized.branch,
    normalized.baseBranch,
    normalized.repoState && normalized.repoState.branch,
    normalized.repoState && normalized.repoState.baseBranch,
  ].filter(Boolean).join(' '));
  const explicitApproval = Boolean(normalized.approval && (normalized.approval.explicit || normalized.approval.approved || normalized.approval.mergeApproved || normalized.approval.deployApproved || normalized.approval.releaseApproved));
  const approvedMergePath = Boolean(normalized.approval && normalized.approval.mergeApproved);
  const secretDetected = isSecretLikeValue({
    operationType: opType,
    operation: normalized.operation,
    target: normalized.target,
    actor: normalized.actor,
    branch: normalized.branch,
    baseBranch: normalized.baseBranch,
    repoState: normalized.repoState,
    approval: normalized.approval ? normalized.approval.raw : undefined,
    ci: normalized.ci,
    release: normalized.release,
    deploy: normalized.deploy,
    github: normalized.github,
    metadata: normalized.metadata,
  });

  return { normalized, opType, opText, explicitApproval, approvedMergePath, secretDetected };
}

function classifyAutomationOperation(context = {}) {
  const ctx = buildClassifierContext(context);
  return classifyEntryPhase(ctx)
    || classifyHazardPhase(ctx)
    || classifyDeliveryPhase(ctx)
    || classifyFallbackPhase(ctx);
}

module.exports = {
  classifyAutomationOperation,
};
