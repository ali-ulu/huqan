'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  CANONICAL_RECEIPT_SCHEMA_VERSION,
  REQUIRED_RECEIPT_FIELDS,
  stableStringify,
  sha256Hex,
  buildCanonicalReceiptPayload,
  hashCanonicalReceiptPayload,
} = require('../lib/receipt/canonical-receipt');

function receipt(overrides = {}) {
  return {
    receiptId: 'r1',
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: 'a1',
    workspaceId: 'w1',
    actor: 'actor',
    agentId: 'agent',
    memoryDraftId: 'draft',
    provenanceId: 'p1',
    trustPolicyVersion: 'v1',
    approvalId: 'ap1',
    approvalStatus: 'approved',
    reason: 'reason',
    riskScore: 17,
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: { z: 1, nested: { b: 2, a: 1 } },
    ...overrides,
  };
}


test('canonical receipt schema vocabulary is independently pinned', () => {
  assert.equal(CANONICAL_RECEIPT_SCHEMA_VERSION, 'v4-receipt-v1');
  assert.deepEqual(REQUIRED_RECEIPT_FIELDS, [
    'receiptId',
    'receiptKind',
    'decision',
    'status',
    'admissionId',
    'workspaceId',
    'provenanceId',
    'trustPolicyVersion',
    'createdAt',
  ]);
});

test('stableStringify pins primitives, array order and recursively sorted object keys', () => {
  assert.equal(stableStringify(null), 'null');
  assert.equal(stableStringify(true), 'true');
  assert.equal(stableStringify([3, 2, 1]), '[3,2,1]');
  assert.equal(
    stableStringify({ z: 1, a: { y: 2, x: 1 }, m: [{ b: 2, a: 1 }] }),
    '{"a":{"x":1,"y":2},"m":[{"a":1,"b":2}],"z":1}',
  );
  assert.equal(
    sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('canonical payload projects every field exactly and clones metadata', () => {
  const source = receipt();
  const payload = buildCanonicalReceiptPayload(source, { verdict: 'allow' });
  assert.deepEqual(payload, {
    schemaVersion: CANONICAL_RECEIPT_SCHEMA_VERSION,
    receiptId: 'r1',
    receiptKind: 'memory_admission_receipt',
    decision: 'allow',
    verdict: 'allow',
    status: 'admitted',
    admissionId: 'a1',
    workspaceId: 'w1',
    actor: 'actor',
    agentId: 'agent',
    memoryDraftId: 'draft',
    provenanceId: 'p1',
    trustPolicyVersion: 'v1',
    approvalId: 'ap1',
    approvalStatus: 'approved',
    reason: 'reason',
    riskScore: 17,
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: { z: 1, nested: { b: 2, a: 1 } },
  });
  source.metadata.nested.a = 99;
  assert.equal(payload.metadata.nested.a, 1);
  assert.equal(Object.hasOwn(payload, 'unknown'), false);
});

test('canonical payload uses documented optional fallbacks without weakening required fields', () => {
  const source = receipt({
    actor: null,
    agentId: undefined,
    memoryDraftId: '',
    approvalId: null,
    approvalStatus: undefined,
    reason: null,
    riskScore: '17',
    metadata: null,
  });
  const payload = buildCanonicalReceiptPayload(source, { verdict: 'allow' });
  assert.equal(payload.actor, '');
  assert.equal(payload.agentId, '');
  assert.equal(payload.memoryDraftId, '');
  assert.equal(payload.approvalId, '');
  assert.equal(payload.approvalStatus, '');
  assert.equal(payload.reason, '');
  assert.equal(payload.riskScore, 0);
  assert.deepEqual(payload.metadata, {});
});

test('canonical receipt input guards identify every required field and bad payload type', () => {
  assert.throws(() => buildCanonicalReceiptPayload(null, { verdict: 'allow' }), /requires an existing receipt object/);
  for (const field of REQUIRED_RECEIPT_FIELDS) {
    for (const value of [undefined, null, '', '   ']) {
      const input = receipt({ [field]: value });
      assert.throws(
        () => buildCanonicalReceiptPayload(input, { verdict: 'allow' }),
        new RegExp(`receipt\\.${field}`),
        `${field} / ${String(value)}`,
      );
    }
  }
  assert.throws(() => buildCanonicalReceiptPayload(receipt(), { verdict: 'bogus' }), /canonical verdict/);
  assert.throws(() => hashCanonicalReceiptPayload(null), /requires a canonical receipt payload/);
  assert.throws(() => hashCanonicalReceiptPayload('x'), /requires a canonical receipt payload/);
});

test('canonical receipt hash is exactly sha256 of stable bytes', () => {
  const payload = buildCanonicalReceiptPayload(receipt(), { verdict: 'allow' });
  assert.equal(hashCanonicalReceiptPayload(payload), sha256Hex(stableStringify(payload)));
});
