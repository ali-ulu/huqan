'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { stableStringify } = require('../../lib/receipt/canonical-receipt');
const { encodeJsonStableV1 } = require('../../lib/v5/cryptographic-profile-contract');
const { exportPublicTrustReceipt } = require('../../lib/v5/public-trust-receipt');
const {
  SCHEMA_VERSION,
  canonicalHash,
  signingView,
  envelopeCoreView,
  delegationSigningView,
  evaluateBoundedExchange,
} = require('./verifier');

const EVALUATION_TIME = '2026-08-11T12:00:00.000Z';
const ISSUED_AT = '2026-08-11T11:59:00.000Z';
const OBSERVED_AT = '2026-08-11T11:59:30.000Z';
const EXPIRES_AT = '2026-08-11T12:10:00.000Z';
const KEY_EXPIRES_AT = '2027-08-11T12:00:00.000Z';
const CONSUMER = path.join(__dirname, 'consumer.js');
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

function identity(agentId, parentAgentId, chain) {
  return {
    agent_id: agentId,
    agent_type: parentAgentId === null ? 'local' : 'delegated',
    display_name: agentId,
    owner_actor_id: 'actor-owner-a2a',
    workspace_id: 'workspace-a2a',
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

function emptyPackage(source) {
  const objectCounts = {
    provenanceRecords: 0, auditEvents: 0, candidateClaims: 0, conflictResults: 0,
    verificationResults: 0, trustReceipts: 0, causalChains: 0, simulationResults: 0,
  };
  return {
    manifest: {
      packageId: 'pkg-a2a-001', format: 'huqan-package', formatVersion: '0.2',
      createdAt: ISSUED_AT, createdBy: 'agent-source', workspaceId: 'workspace-a2a',
      source, description: 'Bounded D6 conformance exchange evidence.',
      objectCounts, protocolVersion: '0.1',
    },
    objects: Object.fromEntries(Object.keys(objectCounts).map((key) => [key, []])),
    index: { byId: {}, bySourceRef: {}, byWorkspaceId: {}, byType: {} },
    metadata: { warnings: [] },
  };
}

function buildFixture() {
  const ids = ['agent-source', 'agent-middle', 'agent-target'];
  const keys = Object.fromEntries([...ids, 'receipt-signer'].map((id) => [id, createKey(id)]));
  const records = {
    'agent-source': identity('agent-source', null, ['agent-source']),
    'agent-middle': identity('agent-middle', 'agent-source', ['agent-source', 'agent-middle']),
    'agent-target': identity('agent-target', 'agent-middle', ids),
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
      workspaceId: 'workspace-a2a',
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
    capability: 'verify.claim', target: 'claim:bounded-a2a-001', riskTier: 'medium',
    tool: 'axiom.verify', connector: 'local_stdio_mcp',
    parametersHash: canonicalHash({ claimId: 'claim:bounded-a2a-001' }),
  };
  const actionHash = canonicalHash(action);
  const observation = {
    observedActionHash: actionHash,
    observedRiskTier: 'medium',
    usedTools: ['axiom.verify'],
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
    delegatorId, delegateId, workspaceId: 'workspace-a2a', scope: ['verify.claim'],
    target: 'claim:bounded-a2a-001', maxRiskTier: 'high',
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
    issuedAt: ISSUED_AT, expiresAt: EXPIRES_AT, workspaceId: 'workspace-a2a',
    source: participants[0], target: participants.at(-1), participants,
    delegation: { chain: ids, hops: [first, second] },
    requestedAction: action,
    constraints: {
      maxRiskTier: 'medium', allowedTools: ['axiom.verify', 'axiom.trace'],
      allowedConnectors: ['local_stdio_mcp', 'audit_file'],
    },
    observation,
    evidence: null,
    signature: { algorithm: 'ed25519-v1', keyReference: keys['agent-source'].keyReference, value: '' },
  };
  const sourceBinding = {
    type: 'a2a-conformance', exchangeId: request.exchangeId, workspaceId: request.workspaceId,
    sourceIdentityHash: request.source.identityHash, targetIdentityHash: request.target.identityHash,
    envelopeHash: canonicalHash(envelopeCoreView(request)), receiptHash,
    internalReceiptHash: INTERNAL_RECEIPT.receiptHash,
    bundleHash: RECEIPT_BUNDLE.bundleHash,
  };
  const pkg = emptyPackage(sourceBinding);
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

function invokeConsumer(authority, requests) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a2a-d6-'));
  try {
    const authorityPath = path.join(temp, 'receiver-authority.json');
    fs.writeFileSync(authorityPath, JSON.stringify(authority), { encoding: 'utf8', mode: 0o600 });
    const child = spawnSync(process.execPath, [CONSUMER, temp, authorityPath], {
      input: JSON.stringify({ requests }),
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(child.status, 0, child.stderr || 'consumer failed');
    return JSON.parse(child.stdout);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

function spawnConsumer(replayDirectory, authorityPath, request) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CONSUMER, replayDirectory, authorityPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (status) => {
      if (status !== 0) return reject(new Error(stderr || 'concurrent consumer failed'));
      try { return resolve(JSON.parse(stdout)); } catch (error) { return reject(error); }
    });
    child.stdin.end(JSON.stringify({ requests: [request] }));
  });
}

function mutated(mutator) {
  const fixture = buildFixture();
  const request = clone(fixture.request);
  const authority = clone(fixture.authority);
  mutator({ fixture, request, authority });
  return { authority, request };
}

const NEGATIVE_CASES = [
  ['identity_alone_insufficient', 'exchange_shape_invalid', ({ request }) => {
    for (const key of ['delegation', 'constraints', 'observation', 'evidence', 'expiresAt']) delete request[key];
  }],
  ['missing_scope', 'delegation_invalid', ({ fixture, request }) => {
    request.delegation.hops[1].scope = []; resignHops(fixture, request); rebindAll(fixture, request);
  }],
  ['missing_evidence', 'exchange_shape_invalid', ({ request }) => { delete request.evidence; }],
  ['missing_receipt', 'exchange_shape_invalid', ({ request }) => { delete request.evidence.receipt; }],
  ['missing_expiry', 'exchange_shape_invalid', ({ request }) => { delete request.expiresAt; }],
  ['missing_constraints', 'exchange_shape_invalid', ({ request }) => { delete request.constraints; }],
  ['missing_observation', 'exchange_shape_invalid', ({ request }) => { delete request.observation; }],
  ['delegation_signature_tampered', 'delegation_signature_invalid', ({ request }) => {
    const value = request.delegation.hops[0].signature.value;
    request.delegation.hops[0].signature.value = `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
  }],
  ['delegation_scope_escalation', 'delegation_scope_escalation', ({ fixture, request }) => {
    request.delegation.hops[1].scope.push('admin.write'); resignHops(fixture, request); rebindAll(fixture, request);
  }],
  ['delegation_child_target_changes', 'delegation_scope_escalation', ({ fixture, request }) => {
    request.delegation.hops[1].target = 'claim:other'; resignHops(fixture, request); rebindAll(fixture, request);
  }],
  ['delegation_expiry_equal', 'delegation_expired', ({ fixture, request }) => {
    request.delegation.hops[0].expiresAt = EVALUATION_TIME; resignHops(fixture, request); rebindAll(fixture, request);
  }],
  ['delegation_chain_link_broken', 'delegation_chain_invalid', ({ request }) => {
    request.delegation.hops[1].delegatorId = 'agent-source';
  }],
  ['delegation_parent_hash_broken', 'delegation_chain_invalid', ({ request }) => {
    request.delegation.hops[1].parentDelegationHash = '0'.repeat(64);
  }],
  ['delegation_loop', 'delegation_chain_invalid', ({ request }) => {
    request.delegation.chain = ['agent-source', 'agent-middle', 'agent-source'];
  }],
  ['capability_outside_scope', 'constraints_exceeded', ({ fixture, request }) => {
    request.requestedAction.capability = 'memory.write'; rebindAll(fixture, request);
  }],
  ['target_outside_delegation', 'constraints_exceeded', ({ fixture, request }) => {
    request.requestedAction.target = 'claim:other'; rebindAll(fixture, request);
  }],
  ['requested_risk_exceeded', 'constraints_exceeded', ({ fixture, request }) => {
    request.requestedAction.riskTier = 'high'; rebindAll(fixture, request);
  }],
  ['requested_tool_not_allowed', 'constraints_exceeded', ({ fixture, request }) => {
    request.requestedAction.tool = 'shell.exec'; rebindAll(fixture, request);
  }],
  ['requested_connector_not_allowed', 'constraints_exceeded', ({ fixture, request }) => {
    request.requestedAction.connector = 'network.http'; rebindAll(fixture, request);
  }],
  ['observed_risk_exceeded', 'constraints_exceeded', ({ fixture, request }) => {
    request.observation.observedRiskTier = 'high'; rebindAll(fixture, request);
  }],
  ['observed_tool_not_allowed', 'constraints_exceeded', ({ fixture, request }) => {
    request.observation.usedTools = ['shell.exec']; rebindAll(fixture, request);
  }],
  ['observed_tool_differs_but_is_allowed', 'constraints_exceeded', ({ fixture, request }) => {
    request.observation.usedTools = ['axiom.trace']; rebindAll(fixture, request);
  }],
  ['observed_connector_not_allowed', 'constraints_exceeded', ({ fixture, request }) => {
    request.observation.usedConnectors = ['network.http']; rebindAll(fixture, request);
  }],
  ['observed_connector_differs_but_is_allowed', 'constraints_exceeded', ({ fixture, request }) => {
    request.observation.usedConnectors = ['audit_file']; rebindAll(fixture, request);
  }],
  ['observed_at_expiry_equal', 'constraints_exceeded', ({ fixture, request }) => {
    request.observation.observedAt = request.expiresAt; rebindAll(fixture, request);
  }],
  ['workspace_confusion', 'identity_invalid', ({ fixture, request }) => {
    request.workspaceId = 'workspace-other'; rebindAll(fixture, request);
  }],
  ['source_identity_hash_mismatch', 'identity_invalid', ({ request }) => {
    request.source.identityHash = '0'.repeat(64); request.participants[0].identityHash = '0'.repeat(64);
  }],
  ['target_identity_hash_mismatch', 'identity_invalid', ({ request }) => {
    request.target.identityHash = '0'.repeat(64); request.participants[2].identityHash = '0'.repeat(64);
  }],
  ['source_target_binding_swapped', 'identity_binding_invalid', ({ request }) => {
    request.source = request.participants[1];
  }],
  ['action_tampered_after_binding', 'evidence_action_invalid', ({ request }) => {
    request.requestedAction.parametersHash = '0'.repeat(64);
  }],
  ['receipt_tampered_after_binding', 'evidence_receipt_invalid', ({ request }) => {
    request.evidence.receipt.issuedAt = '2026-08-11T11:58:00.000Z';
  }],
  ['receipt_independent_binding_mismatch', 'evidence_receipt_authority_invalid', ({ fixture, request }) => {
    request.evidence.package.manifest.source.internalReceiptHash = '0'.repeat(64);
    resignPackage(fixture, request); resignRequest(fixture, request);
  }],
  ['package_tampered_after_binding', 'evidence_package_invalid', ({ request }) => {
    request.evidence.package.manifest.description = 'tampered';
  }],
  ['package_wire_invalid', 'evidence_package_invalid', ({ fixture, request }) => {
    request.evidence.package.manifest.formatVersion = '0.1'; resignPackage(fixture, request); resignRequest(fixture, request);
  }],
  ['package_signature_invalid', 'evidence_package_invalid', ({ request }) => {
    const value = request.evidence.packageSignature.value;
    request.evidence.packageSignature.value = `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
  }],
  ['evidence_ref_bytes_invalid', 'evidence_refs_invalid', ({ fixture, request }) => {
    request.evidence.evidenceRefs[1].bytes += 1; resignRequest(fixture, request);
  }],
  ['receiver_package_allowlist_rejects_manifest', 'evidence_package_authority_invalid', ({ authority }) => {
    authority.identities.find((entry) => entry.ref === 'identity:agent-source').allowedPackageIds = ['pkg-other'];
  }],
  ['receipt_key_cannot_launder_through_agent_key', 'authority_invalid', ({ authority }) => {
    authority.receiptTrustedKeyRecords[0].keyReference = 'test-key:agent-source';
    authority.receiptTrustedKeyRecords[0].publicKeySpkiDerBase64 = authority.keys[0].publicKeySpkiDerBase64;
  }],
  ['package_envelope_binding_mismatch', 'evidence_package_binding_invalid', ({ fixture, request }) => {
    request.evidence.package.manifest.source.envelopeHash = '0'.repeat(64);
    resignPackage(fixture, request); resignRequest(fixture, request);
  }],
  ['package_receipt_binding_mismatch', 'evidence_package_binding_invalid', ({ fixture, request }) => {
    request.evidence.package.manifest.source.receiptHash = '0'.repeat(64);
    resignPackage(fixture, request); resignRequest(fixture, request);
  }],
  ['exchange_signature_tampered', 'exchange_signature_invalid', ({ request }) => {
    const value = request.signature.value;
    request.signature.value = `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
  }],
  ['revoked_source_key', 'delegation_signature_invalid', ({ authority }) => {
    authority.keys.find((entry) => entry.keyReference === 'test-key:agent-source').status = 'revoked';
  }],
  ['target_identity_expiry_equal', 'identity_invalid', ({ authority, request }) => {
    const entry = authority.identities.find((item) => item.ref === 'identity:agent-target');
    entry.record.expires_at = EVALUATION_TIME;
    request.target.identityHash = canonicalHash(entry.record);
    request.participants[2].identityHash = request.target.identityHash;
  }],
  ['exchange_expiry_equal', 'exchange_expired', ({ fixture, request }) => {
    request.expiresAt = EVALUATION_TIME; resignRequest(fixture, request);
  }],
];

async function run() {
  const fixture = buildFixture();
  const positive = invokeConsumer(fixture.authority, [fixture.request, fixture.request]);
  assert.deepEqual(positive.results[0], {
    decision: 'allow', reason: 'ok', effect: { performed: true, effectCount: 1 },
  });
  assert.deepEqual(positive.results[1], { decision: 'block', reason: 'replay_detected' });
  assert.equal(positive.effectCount, 1, 'replay must not execute an effect');

  const cases = [
    { caseId: 'valid_exchange_once', expected: 'allow/ok', actual: 'allow/ok', passed: true },
    { caseId: 'replay_same_exchange', expected: 'block/replay_detected', actual: 'block/replay_detected', passed: true },
  ];
  for (const [caseId, expectedReason, mutator] of NEGATIVE_CASES) {
    const specimen = mutated(mutator);
    const output = invokeConsumer(specimen.authority, [specimen.request]);
    const actual = output.results[0];
    assert.deepEqual(actual, { decision: 'block', reason: expectedReason }, caseId);
    assert.equal(output.effectCount, 0, `${caseId}: rejected exchange must have zero effects`);
    assert.equal(Object.hasOwn(actual, 'effect'), false, `${caseId}: rejected exchange must have no effect output`);
    cases.push({
      caseId,
      expected: `block/${expectedReason}`,
      actual: `${actual.decision}/${actual.reason}`,
      passed: true,
    });
  }
  {
    const one = buildFixture();
    const replayed = new Set();
    const reserve = ({ replayKey }) => {
      if (replayed.has(replayKey)) return Object.freeze({ reserved: false });
      replayed.add(replayKey);
      return Object.freeze({ reserved: true });
    };
    const failedEffect = evaluateBoundedExchange({
      request: one.request, authority: one.authority, evaluationTime: EVALUATION_TIME,
      replayReserve: reserve, effect: () => { throw new Error('synthetic effect failure'); },
    });
    assert.deepEqual(failedEffect, { decision: 'block', reason: 'verification_failed' });
    const afterFailure = evaluateBoundedExchange({
      request: one.request, authority: one.authority, evaluationTime: EVALUATION_TIME,
      replayReserve: reserve, effect: () => Object.freeze({ shouldNotRun: true }),
    });
    assert.deepEqual(afterFailure, { decision: 'block', reason: 'replay_detected' });
    cases.push({
      caseId: 'effect_failure_keeps_replay_marker', expected: 'block/replay_detected after failed effect',
      actual: `${failedEffect.reason}/${afterFailure.reason}`, passed: true,
    });
  }
  {
    const one = buildFixture();
    const replayed = new Set();
    const reserve = ({ replayKey }) => {
      if (replayed.has(replayKey)) return Object.freeze({ reserved: false });
      replayed.add(replayKey);
      return Object.freeze({ reserved: true });
    };
    const first = evaluateBoundedExchange({
      request: one.request, authority: one.authority, evaluationTime: one.authority.evaluationTime,
      replayReserve: reserve, effect: () => Object.freeze({ performed: true }),
    });
    const restartedAuthority = clone(one.authority);
    restartedAuthority.evaluationTime = '2026-08-11T12:01:00.000Z';
    const afterClockAdvance = evaluateBoundedExchange({
      request: one.request, authority: restartedAuthority, evaluationTime: restartedAuthority.evaluationTime,
      replayReserve: reserve, effect: () => Object.freeze({ shouldNotRun: true }),
    });
    assert.equal(first.decision, 'allow');
    assert.deepEqual(afterClockAdvance, { decision: 'block', reason: 'replay_detected' });
    cases.push({
      caseId: 'replay_survives_receiver_clock_advance', expected: 'block/replay_detected',
      actual: `${afterClockAdvance.decision}/${afterClockAdvance.reason}`, passed: true,
    });
  }
  {
    const one = buildFixture();
    const proxiedRequest = new Proxy(one.request, {});
    const accessorRequest = clone(one.request);
    Object.defineProperty(accessorRequest, 'exchangeId', {
      enumerable: true,
      get: () => one.request.exchangeId,
    });
    for (const request of [proxiedRequest, accessorRequest]) {
      const outcome = evaluateBoundedExchange({
        request, authority: one.authority, evaluationTime: EVALUATION_TIME,
        replayReserve: () => Object.freeze({ reserved: true }), effect: () => Object.freeze({}),
      });
      assert.deepEqual(outcome, { decision: 'block', reason: 'exchange_shape_invalid' });
    }
    cases.push({
      caseId: 'proxy_and_accessor_inputs_rejected_before_verification',
      expected: 'block/exchange_shape_invalid', actual: 'block/exchange_shape_invalid', passed: true,
    });
  }
  {
    const one = buildFixture();
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a2a-d6-concurrent-'));
    try {
      const authorityPath = path.join(temp, 'receiver-authority.json');
      fs.writeFileSync(authorityPath, JSON.stringify(one.authority), { encoding: 'utf8', mode: 0o600 });
      const outputs = await Promise.all([
        spawnConsumer(temp, authorityPath, one.request),
        spawnConsumer(temp, authorityPath, one.request),
      ]);
      const outcomes = outputs.map((output) => output.results[0]);
      assert.equal(outcomes.filter((result) => result.decision === 'allow').length, 1);
      assert.equal(outcomes.filter((result) => result.reason === 'replay_detected').length, 1);
      assert.equal(outputs.reduce((total, output) => total + output.effectCount, 0), 1);
      cases.push({
        caseId: 'concurrent_two_process_exactly_one_effect', expected: 'one allow and one replay block',
        actual: 'one allow and one replay block', passed: true,
      });
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
  const report = {
    schemaVersion: 'v5-d6-a2a-conformance-report-v1',
    suiteId: 'V5-D6',
    transport: 'local-child-process-stdio',
    productionTransportClaimed: false,
    evaluationTime: EVALUATION_TIME,
    caseCount: cases.length,
    passed: cases.length,
    failed: 0,
    effectsObserved: 1,
    rejectedEffectsObserved: 0,
    cases,
    verdict: 'V5_D6_BOUNDED_A2A_EXCHANGE_SUFFICIENT',
    nonClaims: [
      'production_transport_not_implemented',
      'external_counterparty_interoperability_not_proved',
      'network_discovery_routing_and_delivery_not_implemented',
      'effect_payload_bytes_not_exchanged_only_signed_hash_reference',
    ],
  };
  process.stdout.write(`${JSON.stringify({ report, reportSha256: canonicalHash(report) })}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
