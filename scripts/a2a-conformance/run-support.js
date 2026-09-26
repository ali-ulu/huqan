'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { stableStringify } = require('../../lib/receipt/canonical-receipt');
const { encodeJsonStableV1 } = require('../../lib/receipt/cryptographic-profile-contract');
const { buildInterAgentRouteReceipt } = require('../../lib/a2a/inter-agent-receipt-chain');
const {
  canonicalHash, signingView, envelopeCoreView, delegationSigningView,
} = require('./verifier');

const A2A_WORKSPACE = 'workspace-a2a';
const EVALUATION_TIME = '2026-08-11T12:00:00.000Z';
const ISSUED_AT = '2026-08-11T11:59:00.000Z';
const OBSERVED_AT = '2026-08-11T11:59:30.000Z';
const EXPIRES_AT = '2026-08-11T12:10:00.000Z';
const KEY_EXPIRES_AT = '2027-08-11T12:00:00.000Z';
const CONSUMER = path.join(__dirname, 'consumer.js');
const CLEAN_ROOM_RECEIVER = path.join(
  __dirname, '..', '..', 'examples', 'a2a-third-party-agent', 'receiver.js',
);
const RECEIPT_BUNDLE = JSON.parse(fs.readFileSync(path.join(
  __dirname, '..', '..', 'specs', 'axiom-trust-protocol', '0.1',
  'examples', 'receipt-bundle.valid.json',
), 'utf8'));
const INTERNAL_RECEIPT = RECEIPT_BUNDLE.receipts[0];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function signStable(privateKey, value, encoding = 'base64url') {
  return crypto.sign(null, encodeJsonStableV1(value), privateKey).toString(encoding);
}

function createKey(agentId) {
  const pair = crypto.generateKeyPairSync('ed25519');
  return {
    keyReference: `test-key:${agentId}`,
    privateKey: pair.privateKey,
    publicKeySpkiDerBase64: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
  };
}

function identity(agentId, parentAgentId, chain, workspaceId = A2A_WORKSPACE) {
  return {
    agent_id: agentId,
    agent_type: parentAgentId === null ? 'local' : 'delegated',
    display_name: agentId,
    owner_actor_id: 'actor-owner-a2a',
    workspace_id: workspaceId,
    delegation_scope: ['verify.claim'],
    allowed_tools: ['axiom.verify', 'axiom.trace'],
    allowed_memory_scopes: ['read_only_context'],
    allowed_connectors: ['local_stdio_mcp', 'audit_file'],
    risk_tier: 'high',
    trust_tier: 'trusted',
    policy_version: 'v5-d6-1',
    issued_at: '2026-08-11T11:00:00.000Z',
    expires_at: KEY_EXPIRES_AT,
    revoked_at: null,
    revocation_reason: null,
    parent_agent_id: parentAgentId,
    delegation_chain: chain,
    receipt_refs: ['receipt-a2a-delegation'],
    provenance_refs: ['provenance-a2a-conformance'],
    audit_requirements: ['trust_receipt', 'replay_protection'],
    verification_status: 'valid',
    expected_status: 'valid',
    expected_reason_code: null,
  };
}

function emptyPackage(source, workspaceId = A2A_WORKSPACE) {
  const objectCounts = {
    provenanceRecords: 0, auditEvents: 0, candidateClaims: 0, conflictResults: 0,
    verificationResults: 0, trustReceipts: 0, causalChains: 0, simulationResults: 0,
  };
  return {
    manifest: {
      packageId: 'pkg-a2a-001', format: 'huqan-package', formatVersion: '0.2',
      createdAt: ISSUED_AT, createdBy: 'agent-source', workspaceId,
      source, description: 'Bounded D6 conformance exchange evidence.',
      objectCounts, protocolVersion: '0.1',
    },
    objects: Object.fromEntries(Object.keys(objectCounts).map((key) => [key, []])),
    index: { byId: {}, bySourceRef: {}, byWorkspaceId: {}, byType: {} },
    metadata: { warnings: [] },
  };
}

function updateEvidenceRefs(request) {
  request.evidence.evidenceRefs = [
    {
      kind: 'requested-action', digest: request.evidence.actionHash,
      bytes: encodeJsonStableV1(request.requestedAction).length,
    },
    {
      kind: 'public-trust-receipt', digest: request.evidence.receiptHash,
      bytes: encodeJsonStableV1(request.evidence.receipt).length,
    },
    {
      kind: 'huqan-package', digest: request.evidence.packageHash,
      bytes: encodeJsonStableV1(request.evidence.package).length,
    },
  ];
}

function resignHops(fixture, request) {
  let parentDelegationHash = null;
  for (const hop of request.delegation.hops) {
    hop.parentDelegationHash = parentDelegationHash;
    if (fixture.keys[hop.delegatorId]) {
      hop.keyReference = fixture.keys[hop.delegatorId].keyReference;
      hop.signature.keyReference = fixture.keys[hop.delegatorId].keyReference;
      hop.signature.value = signStable(
        fixture.keys[hop.delegatorId].privateKey,
        delegationSigningView(hop),
      );
    }
    parentDelegationHash = canonicalHash(hop);
  }
}

function resignPackage(fixture, request) {
  request.evidence.packageHash = canonicalHash(request.evidence.package);
  request.evidence.packageSignature.value = crypto.sign(
    null,
    Buffer.from(stableStringify(request.evidence.package), 'utf8'),
    fixture.keys['agent-source'].privateKey,
  ).toString('base64');
  updateEvidenceRefs(request);
}

function resignRequest(fixture, request) {
  request.signature.value = signStable(fixture.keys['agent-source'].privateKey, signingView(request));
}

function rebindAll(fixture, request) {
  request.evidence.actionHash = canonicalHash(request.requestedAction);
  request.observation.observedActionHash = request.evidence.actionHash;
  const sourceIdentity = fixture.authority.identities.find(
    (entry) => entry.ref === request.source.identityRef,
  );
  request.routeReceipt = buildInterAgentRouteReceipt(
    request,
    request.evidence.receipt,
    sourceIdentity.record.policy_version,
  );
  const source = request.evidence.package.manifest.source;
  source.exchangeId = request.exchangeId;
  source.workspaceId = request.workspaceId;
  source.sourceIdentityHash = request.source.identityHash;
  source.targetIdentityHash = request.target.identityHash;
  source.envelopeHash = canonicalHash(envelopeCoreView(request));
  source.receiptHash = request.evidence.receiptHash;
  request.evidence.package.manifest.workspaceId = request.workspaceId;
  resignPackage(fixture, request);
  updateEvidenceRefs(request);
  resignRequest(fixture, request);
}

module.exports = Object.freeze({
  A2A_WORKSPACE, EVALUATION_TIME, ISSUED_AT, OBSERVED_AT, EXPIRES_AT, KEY_EXPIRES_AT,
  CONSUMER, CLEAN_ROOM_RECEIVER, RECEIPT_BUNDLE, INTERNAL_RECEIPT,
  clone, signStable, createKey, identity, emptyPackage,
  updateEvidenceRefs, resignHops, resignPackage, resignRequest, rebindAll,
});
