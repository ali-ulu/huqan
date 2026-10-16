'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  verifyBundle,
  validateBundleEnvelope,
  emptyValidBundle,
  canonicalJson,
  sha256Hex,
  GENESIS,
} = require('../scripts/external-conformance/verify-bundle');

test('verify-bundle module exposes the bundle verification vocabulary (#2131)', () => {
  assert.deepEqual(
    Object.keys(require('../scripts/external-conformance/verify-bundle')).sort(),
    [
      'BUNDLE_FIELDS',
      'BUNDLE_SEAL_VERSION',
      'GENESIS',
      'canonicalJson',
      'canonicalize',
      'emptyValidBundle',
      'expectedEnvelopeVersion',
      'sha256Hex',
      'validateBundleEnvelope',
      'verifyBundle',
    ],
  );
});

function seal(envelope) {
  return { ...envelope, bundleHash: sha256Hex(canonicalJson(envelope)) };
}

function receiptChain(n) {
  const receipts = [];
  let previous = GENESIS;
  for (let i = 0; i < n; i += 1) {
    const rest = { id: `r${i}`, schemaVersion: 'v4-receipt-v1', previousReceiptHash: previous, index: i };
    const receiptHash = sha256Hex(canonicalJson(rest));
    receipts.push({ ...rest, receiptHash });
    previous = receiptHash;
  }
  return receipts;
}

function bundleWith(receipts) {
  const base = emptyValidBundle();
  const envelope = { ...base, receiptCount: receipts.length, receipts };
  delete envelope.bundleHash;
  return seal(envelope);
}

test('empty valid bundle has no findings', () => {
  assert.deepEqual(verifyBundle(emptyValidBundle()), []);
});

test('missing sealVersion fails closed', () => {
  const bundle = emptyValidBundle();
  delete bundle.sealVersion;
  assert.deepEqual(verifyBundle(bundle), ['invalid_bundle_envelope:missing:sealVersion']);
});

test('relabelled envelope breaks the seal', () => {
  const findings = verifyBundle({ ...emptyValidBundle(), workspaceId: 'someone-elses-workspace' });
  assert.deepEqual(findings, ['bundle_seal_mismatch']);
});

test('valid receipt chain verifies', () => {
  assert.deepEqual(verifyBundle(bundleWith(receiptChain(2))), []);
});

test('tampered receipt content is caught', () => {
  const receipts = receiptChain(2);
  receipts[1] = { ...receipts[1], index: 99 };
  assert.deepEqual(verifyBundle(bundleWith(receipts)), ['content_tampered@1']);
});

test('broken chain link is caught', () => {
  const receipts = receiptChain(2);
  receipts[1] = { ...receipts[1], previousReceiptHash: '0'.repeat(64) };
  const rest = { ...receipts[1] };
  delete rest.receiptHash;
  receipts[1] = { ...rest, receiptHash: sha256Hex(canonicalJson(rest)) };
  assert.deepEqual(verifyBundle(bundleWith(receipts)), ['chain_link_broken@1']);
});

test('wrong genesis is caught', () => {
  const receipts = receiptChain(1);
  receipts[0] = { ...receipts[0], previousReceiptHash: '0'.repeat(64) };
  const rest = { ...receipts[0] };
  delete rest.receiptHash;
  receipts[0] = { ...rest, receiptHash: sha256Hex(canonicalJson(rest)) };
  assert.deepEqual(verifyBundle(bundleWith(receipts)), ['genesis_mismatch@0']);
});

test('receipt count mismatch is reported alongside the seal break', () => {
  const bundle = bundleWith(receiptChain(1));
  bundle.receiptCount = 7;
  assert.deepEqual(verifyBundle(bundle), ['bundle_seal_mismatch', 'receipt_count_mismatch']);
});

test('envelope validator rejects non-objects', () => {
  assert.equal(validateBundleEnvelope(null), 'invalid_bundle_envelope:object');
  assert.equal(validateBundleEnvelope([]), 'invalid_bundle_envelope:object');
});
