'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PKG_ROOT, check, assert } = require('./consumer-harness');
const { validateSchema, V5_SCHEMAS } = require('./consumer-schema');

// External conformance cases: V5 shared-trust-package, C3/C4 and evidence
// reconciliation checks. Runs on require, in the order consumer.js requires
// the sections.

const HEX = 'a'.repeat(64);
const sharedPackage = {
  schemaVersion: 'v5-shared-trust-package/v0.1',
  packageId: 'package-1',
  issuer: { agentId: 'agent-a', workspaceId: 'workspace-1' },
  subject: { type: 'change', id: 'change-1' },
  verdict: { status: 'allow' },
  receipt: { receiptId: 'receipt-1', issuedAt: '2026-01-01T00:00:00Z' },
  evidence: [{ type: 'test', ref: 'sha256:test' }],
  nonClaims: ['No runtime enforcement claim.'],
};

function evidenceEnvelope() {
  const agent = (id) => ({ agentId: id, identityRef: `identity:${id}` });
  return {
    schemaVersion: 'v5-a2a-trust-evidence-v1', envelopeId: 'envelope-1',
    delegation: {
      sourceAgent: agent('source'), targetAgent: agent('target'), workspaceId: 'workspace-1',
      delegationScope: ['repo:read'],
      requestedAction: { capability: 'repo:read', target: 'repo-1' },
      requestedOutput: { kind: 'report', expectedOutcome: 'read completed' },
      constraints: {}, expiresAt: '2026-12-31T00:00:00Z', delegationChain: ['source', 'target'],
    },
    observation: {
      observedAction: { capability: 'repo:read', target: 'repo-1' },
      observedOutcome: { status: 'observed_completed', detail: 'read completed' },
      effectSummary: 'repository read', observedAt: '2026-01-01T00:00:00Z',
      observedBy: { observerRef: 'source', observerRelation: 'delegator_observed' },
    },
    evidence: { evidenceRefs: [{ ref: 'log-1', hash: HEX }], trustReceipt: {
      receiptId: 'receipt-1', receiptHash: HEX,
    } },
    reconciliation: {
      scopeMatch: 'pass', requestedVsObservedMatch: 'pass', delegationChainValid: 'pass',
      withinExpiry: 'pass', evidenceSufficient: 'pass', verdict: 'allow', reasonCodes: ['ok'],
    },
  };
}

function reconcileEvidence(envelope) {
  const reasonCodes = [];
  const { delegation, observation, evidence } = envelope;
  if (!delegation.delegationScope.includes(observation.observedAction.capability)) {
    reasonCodes.push('scope_exceeded');
  }
  if (!evidence.evidenceRefs.length || !evidence.trustReceipt) reasonCodes.push('evidence_missing');
  if (delegation.expiresAt !== null
      && Date.parse(observation.observedAt) > Date.parse(delegation.expiresAt)) {
    reasonCodes.push('delegation_expired');
  }
  return { verdict: reasonCodes.length ? 'block' : 'allow', reasonCodes: reasonCodes.length
    ? reasonCodes : ['ok'] };
}

check('v5', 'packaged Shared Trust Package schema accepts a conforming package', () => {
  assert(validateSchema(sharedPackage, V5_SCHEMAS['shared-trust-package.schema.json']).length === 0,
    'conforming shared package was rejected');
});

check('v5', 'packaged Shared Trust Package schema rejects a missing packageId', () => {
  const invalid = { ...sharedPackage };
  delete invalid.packageId;
  assert(validateSchema(invalid, V5_SCHEMAS['shared-trust-package.schema.json'])
    .some((error) => /packageId/.test(error)), 'missing packageId was accepted');
});

check('v5', 'packaged Shared Trust Package schema rejects unknown, type, and enum violations', () => {
  for (const [name, invalid] of [
    ['unknown', { ...sharedPackage, surprise: true }],
    ['type', { ...sharedPackage, evidence: {} }],
    ['enum', { ...sharedPackage, verdict: { status: 'maybe' } }],
  ]) {
    assert(validateSchema(invalid, V5_SCHEMAS['shared-trust-package.schema.json']).length > 0,
      `${name} violation was accepted`);
  }
});

check('v5', 'packaged Shared Trust Package schema enforces metadata scalar values', () => {
  const invalid = {
    ...sharedPackage,
    receipt: { ...sharedPackage.receipt, routeReceipt: {
      routeId: 'route-1', hopCount: 1, metadata: { nested: { forbidden: true } },
    } },
  };
  assert(validateSchema(invalid, V5_SCHEMAS['shared-trust-package.schema.json'])
    .some((error) => error.includes('metadata.nested')), 'nested metadata was accepted');
});

check('v5', 'packaged C3 and C4 schemas remain distinct and accept their own artifacts', () => {
  const evidence = evidenceEnvelope();
  const publicReceipt = {
    schemaVersion: 'v5-public-trust-receipt-v1', publicReceiptId: HEX,
    issuedAt: '2026-01-01T00:00:00Z',
    disclosure: { receiptKind: 'action', decision: 'allow', verdict: 'allow', status: 'complete',
      riskScore: 0, trustPolicyVersion: 'v1', createdAt: '2026-01-01T00:00:00Z' },
    binding: { internalReceiptHash: HEX },
    integrity: { checksumAlgorithm: 'sha256-canonical-json-v1', checksum: HEX,
      signed: false, signature: null },
  };
  const c3 = V5_SCHEMAS['a2a-trust-evidence.schema.json'];
  const c4 = V5_SCHEMAS['public-trust-receipt.schema.json'];
  assert(validateSchema(evidence, c3).length === 0, 'C3 artifact rejected');
  assert(validateSchema(publicReceipt, c4).length === 0, 'C4 artifact rejected');
  assert(validateSchema(evidence, c4).length > 0, 'C3 artifact accepted as C4');
  assert(validateSchema(publicReceipt, c3).length > 0, 'C4 artifact accepted as C3');
});

for (const [name, requiredField, mutate, expected] of [
  ['scope', 'delegationScope', (value) => {
    value.observation.observedAction.capability = 'repo:write';
  }, 'scope_exceeded'],
  ['evidence', 'evidence', (value) => {
    value.evidence.evidenceRefs = []; value.evidence.trustReceipt = null;
  },
    'evidence_missing'],
  ['expiry', 'expiresAt', (value) => {
    value.delegation.expiresAt = '2025-12-31T00:00:00Z';
  },
    'delegation_expired'],
]) {
  check('v5', `C3 ${name} absence is structurally recordable and semantically fails closed`, () => {
    const invalid = evidenceEnvelope();
    mutate(invalid);
    assert(validateSchema(invalid, V5_SCHEMAS['a2a-trust-evidence.schema.json']).length === 0,
      `${name} negative is not structurally recordable`);
    const derived = reconcileEvidence(invalid);
    assert(derived.verdict === 'block', `${name} did not derive block`);
    assert(derived.reasonCodes.includes(expected),
      `${expected} not derived: ${derived.reasonCodes.join(',')}`);
  });
  check('v5', `C3 missing required ${requiredField} is structurally rejected`, () => {
    const invalid = evidenceEnvelope();
    if (name === 'evidence') delete invalid.evidence;
    else delete invalid.delegation[requiredField];
    assert(validateSchema(invalid, V5_SCHEMAS['a2a-trust-evidence.schema.json'])
      .some((error) => error.includes(`required ${requiredField}`)),
    `missing ${requiredField} was accepted`);
  });
}

check('v5', 'C3 derivation ignores stale reconciliation fields and identity-governed expiry', () => {
  const value = evidenceEnvelope();
  value.delegation.expiresAt = null;
  value.reconciliation = {
    scopeMatch: 'fail', requestedVsObservedMatch: 'fail', delegationChainValid: 'fail',
    withinExpiry: 'fail', evidenceSufficient: 'fail', verdict: 'block',
    reasonCodes: ['scope_exceeded'],
  };
  assert(JSON.stringify(reconcileEvidence(value))
    === JSON.stringify({ verdict: 'allow', reasonCodes: ['ok'] }),
  'derivation trusted stale reconciliation or rejected identity-governed expiry');
});

check('v5', 'no schemas/ directory reached the installed package', () => {
  assert(!fs.existsSync(path.join(PKG_ROOT, 'schemas')),
    'schemas/ is present in the installed package, which the facade contract forbids');
});
