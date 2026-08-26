'use strict';

const crypto = require('node:crypto');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildPilotTrustReceipt,
  canonicalHash,
  projectPilotTrustReceipt,
  verifyPilotPublicProjection,
  verifyPilotTrustReceipt,
} = require('../lib/pilot/trust-receipt-pilot');
const { createPilotReceiptArchive } = require('../lib/pilot/trust-receipt-pilot-archive');
const { assertPilotTestDatabaseBoundary } = require('../lib/pilot/test-database-boundary');
const { runPilot } = require('../scripts/run-trust-receipt-pilot');

const NOW = '2026-08-26T10:00:00.000Z';
const EXPIRES = '2026-08-26T10:10:00.000Z';

function setup() {
  const keys = crypto.generateKeyPairSync('ed25519');
  const input = {
    receiptId: 'receipt-pilot-001',
    issuedAt: NOW,
    expiresAt: EXPIRES,
    issuer: { id: 'agent-issuer', keyId: 'test-key:pilot-issuer' },
    receiver: { id: 'agent-receiver' },
    workspaceId: 'workspace-pilot',
    operation: { capability: 'memory.verify', target: 'claim-17', parametersHash: canonicalHash({ claimId: 17 }) },
    pilotRun: { pilotId: 'pilot-1614', runId: 'run-001', eventId: 'event-001' },
    evidence: { type: 'verification-result', digest: canonicalHash({ verdict: 'supported' }) },
    provenance: { source: 'local-pilot-fixture', digest: canonicalHash({ sourceId: 'source-1' }) },
    policyVersion: 'trust-policy-v1',
    verdict: 'allow',
    relay: { hop: 0, parentReceiptHash: null },
    signer: { privateKey: keys.privateKey },
  };
  const authority = { workspaceId: input.workspaceId, receiverId: input.receiver.id, capabilities: [input.operation.capability] };
  const trustedIssuers = [{ ...input.issuer, status: 'active', publicKey: keys.publicKey }];
  return { authority, input, keys, trustedIssuers };
}

function once() {
  const seen = new Set();
  return (hash) => seen.has(hash) ? false : (seen.add(hash), true);
}

function verify(receipt, context, overrides = {}) {
  return verifyPilotTrustReceipt(receipt, {
    evaluationTime: NOW,
    authority: context.authority,
    trustedIssuers: context.trustedIssuers,
    replayReserve: once(),
    ...overrides,
  });
}

describe('issue #1614 Trust Receipt pilot', () => {
  it('runs the packaged one-event pilot and returns every required artifact', () => {
    const output = runPilot();
    assert.equal(output.independentVerifier.valid, true);
    assert.deepEqual(output.independentVerifier.projection, { valid: true, reason: null });
    assert.equal(output.publicProjection.binding.internalReceiptHash, output.internalReceipt.receiptHash);
    assert.deepEqual(output.pilotReport, { totalEvents: 1, verifiedEvents: 1, successfulTrustSignals: 1, withheldTrustSignals: 0 });
  });

  it('turns one real pilot event into a canonical receipt and a bound redacted projection', () => {
    const context = setup();
    const receipt = buildPilotTrustReceipt(context.input);
    const projection = projectPilotTrustReceipt(receipt);
    const result = verify(receipt, context);

    assert.deepEqual(result, { valid: true, reason: null, trustSignal: true });
    assert.deepEqual(verifyPilotPublicProjection(projection, receipt), { valid: true, reason: null });
    assert.equal(projection.binding.internalReceiptHash, receipt.receiptHash);
    assert.equal(Object.hasOwn(projection.disclosure, 'workspaceId'), false);
    assert.equal(JSON.stringify(projection).includes(receipt.evidence.digest), false);
  });

  it('preserves all four verdicts but counts only allow as a successful trust signal', () => {
    const records = [];
    for (const verdict of ['allow', 'review', 'dry_run_only', 'block']) {
      const context = setup();
      const receipt = buildPilotTrustReceipt({ ...context.input, receiptId: `receipt-${verdict}`, verdict });
      records.push({ receipt, publicProjection: projectPilotTrustReceipt(receipt), verification: verify(receipt, context) });
    }
    const archive = createPilotReceiptArchive(records);
    assert.deepEqual(archive.report, { totalEvents: 4, verifiedEvents: 4, successfulTrustSignals: 1, withheldTrustSignals: 3 });
    assert.equal(Object.isFrozen(archive.report), true);
    assert.equal(archive.getByReceiptId('receipt-review').receipt.verdict, 'review');
  });

  it('fails closed on tamper, scope overreach, expiry, unknown issuer, and replay', () => {
    const context = setup();
    const receipt = buildPilotTrustReceipt(context.input);
    const tampered = structuredClone(receipt);
    tampered.verdict = 'block';
    assert.equal(verify(tampered, context).reason, 'receipt_tampered');
    assert.equal(verify(receipt, context, { authority: { ...context.authority, workspaceId: 'other' } }).reason, 'scope_overreach');
    assert.equal(verify(receipt, context, { evaluationTime: EXPIRES }).reason, 'receipt_expired');
    assert.equal(verify(receipt, context, { trustedIssuers: [] }).reason, 'unknown_issuer');
    const reserve = once();
    assert.equal(verify(receipt, context, { replayReserve: reserve }).valid, true);
    assert.equal(verify(receipt, context, { replayReserve: reserve }).reason, 'replay_detected');
  });

  it('binds relay receipts to the parent hash and exact next hop', () => {
    const context = setup();
    const parent = buildPilotTrustReceipt(context.input);
    const child = buildPilotTrustReceipt({
      ...context.input,
      receiptId: 'receipt-pilot-002',
      pilotRun: { ...context.input.pilotRun, eventId: 'event-002' },
      relay: { hop: 1, parentReceiptHash: parent.receiptHash },
    });
    assert.equal(verify(child, context, { parentReceipt: parent }).valid, true);
    assert.equal(verify(child, context).reason, 'relay_parent_invalid');
    assert.equal(verify(child, context, { parentReceipt: { ...parent, receiptHash: '0'.repeat(64) } }).reason, 'relay_parent_invalid');
    assert.equal(verify(child, context, { parentReceipt: { ...parent, verdict: 'block' } }).reason, 'relay_parent_invalid');
  });

  it('rejects sensitive receipt keys and a forged public projection', () => {
    const context = setup();
    assert.throws(
      () => buildPilotTrustReceipt({ ...context.input, evidence: { type: 'verification-result', digest: context.input.evidence.digest, rawToolOutput: 'hidden' } }),
      /receipt_shape_invalid|sensitive_data_detected/,
    );
    const receipt = buildPilotTrustReceipt(context.input);
    const projection = structuredClone(projectPilotTrustReceipt(receipt));
    projection.disclosure.verdict = 'block';
    assert.equal(verifyPilotPublicProjection(projection, receipt).valid, false);
    const extended = { ...projectPilotTrustReceipt(receipt), rawToolOutput: 'forbidden' };
    assert.equal(verifyPilotPublicProjection(extended, receipt).valid, false);
  });

  it('requires an isolated test database identity and rejects inherited production credentials', () => {
    const safe = {
      HUQAN_ENVIRONMENT: 'test',
      HUQAN_TEST_DB_NAME: 'huqan_pilot_test',
      HUQAN_TEST_DB_USER: 'huqan_test_principal',
      HUQAN_TEST_DB_SERVER: 'test-db.local',
      HUQAN_TEST_DB_MARKER: 'huqan-pilot-test-only',
    };
    assert.equal(assertPilotTestDatabaseBoundary(safe).environment, 'test');
    assert.throws(() => assertPilotTestDatabaseBoundary({ ...safe, DATABASE_URL: 'postgres://production' }), /production_database_credential_present/);
    assert.throws(() => assertPilotTestDatabaseBoundary({ ...safe, HUQAN_TEST_DB_NAME: 'production' }), /production_database_forbidden/);
    assert.throws(() => assertPilotTestDatabaseBoundary({ ...safe, HUQAN_ENVIRONMENT: 'production' }), /test_database_environment_invalid/);
  });
});
