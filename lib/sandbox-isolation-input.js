'use strict';

// Turns caller input and operator policy for the sandbox isolation gate into
// one shape (#2135). Unknown trust and runner values become 'unknown', which
// the classifier then refuses; nothing here decides.

const { normalizeText } = require('./text-utils');
const { isPlainObject } = require('./is-plain-object');
const { MAX_TIMEOUT_MS } = require('./sandbox-timeout-policy');
const {
  DEFAULT_WORKSPACE_ID,
  DEFAULT_TIMEOUT_MS,
  SOURCE_TRUST_LEVELS,
  RUNNER_TYPES,
  normalizeDecisionLabel,
} = require('./sandbox-isolation-vocabulary');

function normalizeSourceTrust(value) {
  const valid = new Set(Object.values(SOURCE_TRUST_LEVELS));
  const text = normalizeText(value);
  return valid.has(text) ? text : 'unknown';
}

function normalizeRunnerType(value) {
  const valid = new Set(Object.values(RUNNER_TYPES));
  const text = normalizeText(value);
  return valid.has(text) ? text : 'unknown';
}

function normalizePolicy(policy) {
  if (!isPlainObject(policy)) return {};
  const out = {};
  if (typeof policy.minimumDecision === 'string') {
    out.minimumDecision = normalizeDecisionLabel(policy.minimumDecision);
  }
  if (typeof policy.maximumTimeoutMs === 'number' && policy.maximumTimeoutMs > 0) {
    out.maximumTimeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.round(policy.maximumTimeoutMs)));
  }
  if (typeof policy.allowExternalNetwork === 'boolean') {
    out.allowExternalNetwork = policy.allowExternalNetwork;
  }
  // Handle allowUntrustedSource with backward compat for allowUntustedSource (typo alias)
  const hasCorrectKey = typeof policy.allowUntrustedSource === 'boolean';
  const hasLegacyKey = typeof policy.allowUntustedSource === 'boolean';
  if (hasCorrectKey || hasLegacyKey) {
    if (hasCorrectKey && hasLegacyKey) {
      // Both provided — fail-closed: if either is false, block
      out.allowUntrustedSource = policy.allowUntrustedSource && policy.allowUntustedSource;
    } else if (hasCorrectKey) {
      out.allowUntrustedSource = policy.allowUntrustedSource;
    } else {
      // Legacy alias only — accept it as a deprecated compatibility path
      out.allowUntrustedSource = policy.allowUntustedSource;
    }
  }
  if (typeof policy.maxSnapshotDepth === 'number' && policy.maxSnapshotDepth >= 0) {
    out.maxSnapshotDepth = Math.min(100, Math.max(0, Math.round(policy.maxSnapshotDepth)));
  }
  return out;
}

function normalizeSandboxInput(input) {
  if (!isPlainObject(input)) {
    return {
      source: '',
      sourceTrust: 'unknown',
      runner: 'unknown',
      timeoutMs: DEFAULT_TIMEOUT_MS,
      hasSnapshot: false,
      snapshotDepth: 0,
      snapshotCount: 0,
      isRollback: false,
      bindings: {},
      context: {},
      metadata: { workspaceId: DEFAULT_WORKSPACE_ID },
    };
  }

  const timeoutMs = typeof input.timeoutMs === 'number' && input.timeoutMs > 0
    ? Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.round(input.timeoutMs)))
    : DEFAULT_TIMEOUT_MS;

  const snapshotDepth = typeof input.snapshotDepth === 'number' && input.snapshotDepth >= 0
    ? Math.round(input.snapshotDepth)
    : 0;

  const snapshotCount = typeof input.snapshotCount === 'number' && input.snapshotCount >= 0
    ? Math.round(input.snapshotCount)
    : 0;

  return {
    source: String(input.source || ''),
    sourceTrust: normalizeSourceTrust(input.sourceTrust),
    runner: normalizeRunnerType(input.runner),
    timeoutMs,
    hasSnapshot: input.hasSnapshot === true,
    snapshotDepth,
    snapshotCount,
    isRollback: input.isRollback === true,
    bindings: isPlainObject(input.bindings) ? { ...input.bindings } : {},
    context: isPlainObject(input.context) ? { ...input.context } : {},
    metadata: isPlainObject(input.metadata) ? { ...input.metadata } : { workspaceId: DEFAULT_WORKSPACE_ID },
  };
}

module.exports = {
  normalizePolicy,
  normalizeSandboxInput,
};
