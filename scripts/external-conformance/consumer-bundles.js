'use strict';

const path = require('node:path');
const { verifyBundle, emptyValidBundle } = require('./verify-bundle');
const { EXAMPLES, check, assert, readJson } = require('./consumer-harness');
const { bundleFiles } = require('./consumer-objects');

// External conformance cases: receipt-bundle expectations and bundle fail-
// closed checks. Runs on require, in the order consumer.js requires the
// sections.

const BUNDLE_EXPECTATIONS = {
  'receipt-bundle.valid.json': [],
  'receipt-bundle.unicode.valid.json': [],
  'receipt-bundle.broken-chain.json': ['bundle_seal_mismatch', 'content_tampered@1'],
  'receipt-bundle.tampered-bundle-hash.json': ['bundle_seal_mismatch'],
  'receipt-bundle.tampered-receipt.json': ['bundle_seal_mismatch', 'content_tampered@2'],
};

check('bundles', 'every shipped bundle fixture has a declared expectation', () => {
  const undeclared = bundleFiles.filter((f) => BUNDLE_EXPECTATIONS[f] === undefined);
  assert(undeclared.length === 0, `undeclared bundle fixtures: ${undeclared.join(', ')}`);
  return `${bundleFiles.length} fixtures`;
});

for (const file of bundleFiles) {
  const expected = BUNDLE_EXPECTATIONS[file];
  if (expected === undefined) continue;
  check('bundles', `${file} verifies to ${expected.length ? expected.join(', ') : 'VALID'}`, () => {
    const findings = verifyBundle(readJson(path.join(EXAMPLES, file)));
    assert(JSON.stringify(findings) === JSON.stringify(expected),
      `expected ${JSON.stringify(expected)}, observed ${JSON.stringify(findings)}`);
  });
}

check('bundles', 'bundle without a sealVersion fails closed', () => {
  // A bundle sealed under the earlier receipts-only rule carries an
  // unauthenticated envelope, so this consumer refuses it outright (#735).
  const bundle = emptyValidBundle();
  delete bundle.sealVersion;
  assert(JSON.stringify(verifyBundle(bundle))
    === JSON.stringify(['invalid_bundle_envelope:missing:sealVersion']),
  `unexpected findings: ${JSON.stringify(verifyBundle(bundle))}`);
});

check('bundles', 'relabelled envelope fields break the seal', () => {
  for (const [patch, expected] of [
    [{ workspaceId: 'someone-elses-workspace' }, ['bundle_seal_mismatch']],
    [{ exportedAt: '2030-06-01T12:00:00.000Z' }, ['bundle_seal_mismatch']],
    [{ receiptCount: 7 }, ['bundle_seal_mismatch', 'receipt_count_mismatch']],
  ]) {
    const findings = verifyBundle({ ...emptyValidBundle(), ...patch });
    assert(JSON.stringify(findings) === JSON.stringify(expected),
      `${JSON.stringify(patch)}: unexpected findings ${JSON.stringify(findings)}`);
  }
});

check('bundles', 'bundle missing receipts fails closed before hash checks', () => {
  const bundle = emptyValidBundle();
  delete bundle.receipts;
  assert(JSON.stringify(verifyBundle(bundle))
    === JSON.stringify(['invalid_bundle_envelope:missing:receipts']),
  `unexpected findings: ${JSON.stringify(verifyBundle(bundle))}`);
});

check('bundles', 'bundle with non-array receipts fails closed', () => {
  const bundle = { ...emptyValidBundle(), receipts: {} };
  assert(JSON.stringify(verifyBundle(bundle))
    === JSON.stringify(['invalid_bundle_envelope:receipts']),
  `unexpected findings: ${JSON.stringify(verifyBundle(bundle))}`);
});

check('bundles', 'bundle missing another required envelope field fails closed', () => {
  const bundle = emptyValidBundle();
  delete bundle.workspaceId;
  assert(JSON.stringify(verifyBundle(bundle))
    === JSON.stringify(['invalid_bundle_envelope:missing:workspaceId']),
  `unexpected findings: ${JSON.stringify(verifyBundle(bundle))}`);
});

module.exports = { BUNDLE_EXPECTATIONS };
