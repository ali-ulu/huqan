'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CANONICAL_VERIFY_STATUSES,
  LEGACY_VERIFY_STATUSES,
  VERIFY_STATUS_KEYS,
  toCanonicalVerifyStatus,
  toLegacyVerifyStatus,
  isKnownVerifyStatus,
  toPublicVerifyPayload,
  toPublicVerifyEnvelope,
} = require('../lib/verify-status-vocabulary');
const { normalizeCheck, classifyLlmSor } = require('../lib/shield');

test('canonical verify vocabulary is English and complete', () => {
  assert.deepEqual([...CANONICAL_VERIFY_STATUSES].sort(), [
    'contradicted',
    'unknown',
    'verified',
  ]);
  assert.deepEqual([...LEGACY_VERIFY_STATUSES].sort(), [
    'bilinmiyor',
    'celiski',
    'dogrulandi',
  ]);
  assert.deepEqual(VERIFY_STATUS_KEYS, ['status', 'finalStatus']);
});

test('legacy status values map onto the canonical English values', () => {
  assert.equal(toCanonicalVerifyStatus('dogrulandi'), 'verified');
  assert.equal(toCanonicalVerifyStatus('celiski'), 'contradicted');
  assert.equal(toCanonicalVerifyStatus('bilinmiyor'), 'unknown');
});

test('canonical values are accepted unchanged (projection is idempotent)', () => {
  for (const status of CANONICAL_VERIFY_STATUSES) {
    assert.equal(toCanonicalVerifyStatus(status), status);
    assert.equal(toCanonicalVerifyStatus(toCanonicalVerifyStatus(status)), status);
  }
});

test('an unrecognized status degrades to unknown, never to verified', () => {
  for (const bogus of ['', 'nonsense', 'VERIFIED', null, undefined, 42, {}]) {
    assert.equal(toCanonicalVerifyStatus(bogus), 'unknown');
  }
});

test('the reverse mapping accepts both vocabularies', () => {
  assert.equal(toLegacyVerifyStatus('verified'), 'dogrulandi');
  assert.equal(toLegacyVerifyStatus('contradicted'), 'celiski');
  assert.equal(toLegacyVerifyStatus('unknown'), 'bilinmiyor');
  assert.equal(toLegacyVerifyStatus('dogrulandi'), 'dogrulandi');
  assert.equal(toLegacyVerifyStatus('celiski'), 'celiski');
  assert.equal(toLegacyVerifyStatus('bilinmiyor'), 'bilinmiyor');
  assert.equal(toLegacyVerifyStatus('nonsense'), 'bilinmiyor');
});

test('isKnownVerifyStatus recognizes both vocabularies and nothing else', () => {
  for (const status of [...CANONICAL_VERIFY_STATUSES, ...LEGACY_VERIFY_STATUSES]) {
    assert.equal(isKnownVerifyStatus(status), true, status);
  }
  for (const bogus of ['pending', 'done', 'active', '', null, 7]) {
    assert.equal(isKnownVerifyStatus(bogus), false, String(bogus));
  }
});

test('toPublicVerifyPayload translates status and preserves every other field', () => {
  const projected = toPublicVerifyPayload({
    status: 'dogrulandi',
    confidence: 0.85,
    evidence: ['a', 'b'],
    raw: { nested: true },
  });
  assert.equal(projected.status, 'verified');
  assert.equal(projected.confidence, 0.85);
  assert.deepEqual(projected.evidence, ['a', 'b']);
  assert.deepEqual(projected.raw, { nested: true });
});

test('envelope projection rewrites every verify status key at every depth', () => {
  const envelope = {
    ok: true,
    data: { status: 'celiski', confidence: 0.9 },
    meta: {
      semanticTrust: { status: 'celiski', classification: 'contradicted' },
      reasoningTrace: {
        status: 'celiski',
        steps: [
          { status: 'dogrulandi' },
          { status: 'bilinmiyor', semanticTrust: { status: 'bilinmiyor' } },
        ],
        trustReceiptPreview: { finalStatus: 'celiski' },
      },
      trustReceiptPreview: { finalStatus: 'celiski' },
    },
  };

  const projected = toPublicVerifyEnvelope(envelope);

  assert.equal(projected.data.status, 'contradicted');
  assert.equal(projected.meta.semanticTrust.status, 'contradicted');
  assert.equal(projected.meta.reasoningTrace.status, 'contradicted');
  assert.equal(projected.meta.reasoningTrace.steps[0].status, 'verified');
  assert.equal(projected.meta.reasoningTrace.steps[1].status, 'unknown');
  assert.equal(projected.meta.reasoningTrace.steps[1].semanticTrust.status, 'unknown');
  assert.equal(projected.meta.reasoningTrace.trustReceiptPreview.finalStatus, 'contradicted');
  assert.equal(projected.meta.trustReceiptPreview.finalStatus, 'contradicted');

  // No legacy value survives anywhere in the projected envelope.
  assert.equal(/dogrulandi|celiski|bilinmiyor/.test(JSON.stringify(projected)), false);
});

test('envelope projection leaves a non-verify status field byte-identical', () => {
  // Approval, phase and roadmap records also use a `status` key. Rewriting
  // those would be data corruption, so the value guard must skip them.
  const envelope = {
    approval: { status: 'pending' },
    phase: { status: 'done' },
    member: { status: 'active' },
    receipt: { status: 'admitted', decision: 'allow' },
    verdict: { status: 'bilinmiyor' },
  };

  const projected = toPublicVerifyEnvelope(envelope);

  assert.equal(projected.approval.status, 'pending');
  assert.equal(projected.phase.status, 'done');
  assert.equal(projected.member.status, 'active');
  assert.equal(projected.receipt.status, 'admitted');
  assert.equal(projected.receipt.decision, 'allow');
  // ...while the real verify status is still translated.
  assert.equal(projected.verdict.status, 'unknown');
});

test('envelope projection preserves structure, key order and non-status values', () => {
  const envelope = {
    ok: true,
    evidence: [{ kind: 'direct_edge', text: 'celiski is a word here', confidence: 0.4 }],
    meta: { thresholds: { supportVerified: 0.6 }, warnings: ['WEAK_SUPPORT'] },
    data: { status: 'dogrulandi' },
  };

  const projected = toPublicVerifyEnvelope(envelope);

  assert.deepEqual(Object.keys(projected), Object.keys(envelope));
  // A legacy token appearing as free text, not under a status key, is untouched.
  assert.equal(projected.evidence[0].text, 'celiski is a word here');
  assert.deepEqual(projected.meta, envelope.meta);
  assert.equal(projected.data.status, 'verified');
});

test('envelope projection does not mutate the kernel result it was given', () => {
  const envelope = { data: { status: 'dogrulandi' }, meta: { reasoningTrace: { status: 'dogrulandi' } } };
  const projected = toPublicVerifyEnvelope(envelope);

  assert.equal(envelope.data.status, 'dogrulandi', 'internal representation must stay legacy');
  assert.equal(envelope.meta.reasoningTrace.status, 'dogrulandi');
  assert.equal(projected.data.status, 'verified');
});

test('shield reads both vocabularies so boundary ordering cannot change a verdict', () => {
  // The same logical result, expressed in each vocabulary, must classify
  // identically. This is what makes the API-boundary adapter safe to apply
  // before or after lib/shield.js sees the value.
  assert.equal(normalizeCheck({ status: 'verified' }).status, 'verified');
  assert.equal(normalizeCheck({ status: 'contradicted' }).status, 'contradicted');
  assert.equal(normalizeCheck({ status: 'unknown' }).status, 'unknown');

  const pairs = [
    [{ status: 'dogrulandi' }, { status: 'verified' }],
    [{ status: 'celiski' }, { status: 'contradicted' }],
    [{ status: 'bilinmiyor' }, { status: 'unknown' }],
  ];
  for (const [legacy, canonical] of pairs) {
    assert.equal(
      classifyLlmSor(legacy, legacy),
      classifyLlmSor(canonical, canonical),
      `classification must not depend on vocabulary: ${JSON.stringify(legacy)}`,
    );
  }
  assert.equal(classifyLlmSor({ status: 'verified' }, { status: 'verified' }), 'graph-backed');
  assert.equal(classifyLlmSor({ status: 'contradicted' }, { status: 'unknown' }), 'contradicted');
});
