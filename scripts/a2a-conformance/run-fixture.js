'use strict';

const crypto = require('node:crypto');

const { stableStringify } = require('../../lib/receipt/canonical-receipt');
const { exportPublicTrustReceipt } = require('../../lib/receipt/public-trust-receipt');
const { buildInterAgentRouteReceipt } = require('../../lib/a2a/inter-agent-receipt-chain');
const {
  SCHEMA_VERSION, canonicalHash, signingView, envelopeCoreView, delegationSigningView,
} = require('./verifier');

const {
  A2A_WORKSPACE, EVALUATION_TIME, ISSUED_AT, OBSERVED_AT, EXPIRES_AT, KEY_EXPIRES_AT,
  RECEIPT_BUNDLE, INTERNAL_RECEIPT, signStable, createKey, identity, emptyPackage, updateEvidenceRefs,
} = require('./run-support');

function buildFixture(workspaceId = A2A_WORKSPACE, options = {}) {
  const ids = ['agent-source', 'agent-middle', 'agent-target'];
  const keys = Object.fromEntries([...ids, 'receipt-signer'].map((id) => [id, createKey(id)]));
  const records = {
    'agent-source': identity('agent-source', null, ['agent-source'], workspaceId),
    'agent-middle': identity('agent-middle', 'agent-source', ['agent-source', 'agent-middle'], workspaceId),
    'agent-target': identity('agent-target', 'agent-middle', ids, workspaceId),
  };
  const participants = ids.map((agentId) => ({
    agentId, identityRef: `identity:${agentId}`, identityHash: canonicalHash(records[agentId]),
  }));
  const authority = {
    identities: ids.map((agentId) => ({
      ref: `identity:${agentId}`, keyReference: keys[agentId].keyReference, record: records[agentId],
      allowedPackageIds: ['pkg-a2a-001'],
    })),
    keys: ids.map((agentId) => ({
      keyReference: keys[agentId].keyReference, status: 'active', expiresAt: KEY_EXPIRES_AT,
      publicKeySpkiDerBase64: keys[agentId].publicKeySpkiDerBase64,
    })),
    expectedTarget: {
      agentId: participants.at(-1).agentId,
      identityRef: participants.at(-1).identityRef,
      identityHash: participants.at(-1).identityHash,
      workspaceId,
    },
    evaluationTime: EVALUATION_TIME,
    authorityId: 'receiver-authority-a2a-v1',
    receiptBindings: [],
    receiptTrustedKeyRecords: [{
      keyReference: keys['receipt-signer'].keyReference,
      status: 'active',
      expiresAt: KEY_EXPIRES_AT,
      publicKeySpkiDerBase64: keys['receipt-signer'].publicKeySpkiDerBase64,
      purpose: 'a2a-public-trust-receipt',
    }],
  };
  const action = {
    capability: 'verify.claim', target: options.target || 'claim:bounded-a2a-001', riskTier: 'medium',
    tool: options.tool || 'axiom.verify', connector: 'local_stdio_mcp',
    parametersHash: canonicalHash({ claimId: 'claim:bounded-a2a-001' }),
  };
  const actionHash = canonicalHash(action);
  const observation = {
    observedActionHash: actionHash,
    observedRiskTier: 'medium',
    usedTools: [action.tool],
    usedConnectors: ['local_stdio_mcp'],
    observedAt: OBSERVED_AT,
    effectHash: canonicalHash({ effect: 'verified', claimId: 'claim:bounded-a2a-001' }),
  };
  const publicReceipt = exportPublicTrustReceipt({
    internalReceipt: INTERNAL_RECEIPT,
    issuedAt: ISSUED_AT,
    signer: { keyId: keys['receipt-signer'].keyReference, privateKey: keys['receipt-signer'].privateKey },
    sourceBundle: RECEIPT_BUNDLE,
  });
  authority.receiptBindings.push({
    publicReceiptId: publicReceipt.publicReceiptId,
    expectedInternalReceiptHash: INTERNAL_RECEIPT.receiptHash,
    expectedBundleHash: RECEIPT_BUNDLE.bundleHash,
    keyId: keys['receipt-signer'].keyReference,
    purpose: 'a2a-public-trust-receipt',
  });
  const receiptHash = canonicalHash(publicReceipt);

  const baseHop = (delegatorId, delegateId, parentDelegationHash) => ({
    delegatorId, delegateId, workspaceId, scope: ['verify.claim'],
    target: action.target, maxRiskTier: 'high',
    allowedTools: ['axiom.verify', 'axiom.trace'], allowedConnectors: ['local_stdio_mcp', 'audit_file'],
    expiresAt: EXPIRES_AT, parentDelegationHash,
    keyReference: keys[delegatorId].keyReference,
    signature: { algorithm: 'ed25519-v1', keyReference: keys[delegatorId].keyReference, value: '' },
  });
  const first = baseHop('agent-source', 'agent-middle', null);
  first.signature.value = signStable(keys['agent-source'].privateKey, delegationSigningView(first));
  const second = baseHop('agent-middle', 'agent-target', canonicalHash(first));
  second.signature.value = signStable(keys['agent-middle'].privateKey, delegationSigningView(second));

  const request = {
    schemaVersion: SCHEMA_VERSION, exchangeId: 'exchange-a2a-001', nonce: 'nonce-a2a-001',
    issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, workspaceId,
    source: participants[0], target: participants.at(-1), participants,
    delegation: { chain: ids, hops: [first, second] },
    requestedAction: action,
    constraints: {
      maxRiskTier: 'medium', allowedTools: ['axiom.verify', 'axiom.trace'],
      allowedConnectors: ['local_stdio_mcp', 'audit_file'],
    },
    observation,
    routeReceipt: null,
    evidence: null,
    signature: { algorithm: 'ed25519-v1', keyReference: keys['agent-source'].keyReference, value: '' },
  };
  request.routeReceipt = buildInterAgentRouteReceipt(
    request,
    publicReceipt,
    records['agent-source'].policy_version,
  );
  const sourceBinding = {
    type: 'a2a-conformance', exchangeId: request.exchangeId, workspaceId: request.workspaceId,
    sourceIdentityHash: request.source.identityHash, targetIdentityHash: request.target.identityHash,
    envelopeHash: canonicalHash(envelopeCoreView(request)), receiptHash,
    internalReceiptHash: INTERNAL_RECEIPT.receiptHash,
    bundleHash: RECEIPT_BUNDLE.bundleHash,
  };
  const pkg = emptyPackage(sourceBinding, workspaceId);
  request.evidence = {
    actionHash, receipt: publicReceipt, receiptHash, package: pkg,
    packageHash: canonicalHash(pkg),
    packageSignature: {
      algorithm: 'ed25519', keyId: 'agent-source',
      value: crypto.sign(null, Buffer.from(stableStringify(pkg), 'utf8'), keys['agent-source'].privateKey).toString('base64'),
    },
  };
  updateEvidenceRefs(request);
  request.signature.value = signStable(keys['agent-source'].privateKey, signingView(request));
  return { authority, request, keys };
}

module.exports = Object.freeze({ buildFixture });
