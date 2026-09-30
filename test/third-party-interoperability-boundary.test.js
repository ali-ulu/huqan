'use strict';

/**
 * #3069 — the self-run / third-party boundary has to stay stated, and the two
 * blocked cells have to stay visibly blocked.
 *
 * The repository runs two conformance suites and both are green. That is
 * exactly the shape a false claim grows in: "conformance PASS" reads as
 * "someone outside verified us", and the difference is invisible unless a
 * reader is told. The README `## Limits` section carried no mention of the
 * suites at all, so the strongest evidence the repository owns and the
 * strongest claim it does not own were the same word.
 *
 * This file holds three things against the live source:
 *
 *   - the suites really are repository-run (their entry points live here and
 *     the scripts resolve into this checkout), so "self-run" is a fact and not
 *     a hedge;
 *   - the producer really carries a bundle signature, so the README's "no
 *     third-party attestation is bound into a bundle yet" is about a binding
 *     that does not exist rather than about a missing feature;
 *   - the published HTP 0.2 bundle contract really specifies no attestation
 *     field, so that cell is blocked on a protocol decision rather than on
 *     documentation.
 *
 * If any of the three moves, the test fails and the record beside it
 * (docs/audits/third-party-interoperability-attestation-boundary-3069.md) has
 * to be updated in the same PR — which is the point: a blocked cell may only
 * change together with the evidence that changed it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RECORD = 'docs/audits/third-party-interoperability-attestation-boundary-3069.md';

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/** The README's `## Limits` section, up to the next same-or-higher heading. */
function readmeLimits() {
  const readme = read('README.md');
  const start = readme.search(/^## Limits\b/m);
  assert.ok(start !== -1, 'the README must keep its Limits section');
  const rest = readme.slice(start);
  const next = rest.slice(1).search(/^##\s/m);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('the README Limits states the suites are self-run, not third-party', () => {
  const limits = readmeLimits();
  assert.match(limits, /self-run/i, 'Limits must say the suites are self-run');
  assert.match(limits, /not third-party verification/i,
    'Limits must say a green run is not third-party verification');
  assert.match(limits, /attestation/i,
    'Limits must say no third-party attestation is bound into a bundle yet');
  assert.match(limits, /third-party-interoperability-attestation-boundary-3069\.md/,
    'Limits must point at the boundary record');
});

test('both conformance suites are repository-run', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts['conformance:external'], 'node scripts/external-conformance/run.js');
  assert.equal(pkg.scripts['conformance:a2a'], 'node scripts/a2a-conformance/run.js');
  for (const relPath of ['scripts/external-conformance/run.js', 'scripts/a2a-conformance/run.js']) {
    assert.ok(fs.existsSync(path.join(ROOT, relPath)), `${relPath} must exist in this repository`);
  }
  // The runners read the tree they ship from; nothing about them is a remote
  // service or an out-of-repo party.
  for (const relPath of ['scripts/external-conformance/run.js', 'scripts/a2a-conformance/run.js']) {
    assert.doesNotMatch(read(relPath), /https?:\/\//,
      `${relPath} must not reach a remote endpoint; the run is local`);
  }
});

test('the producer carries a bundle signature, so the README claim is about binding', () => {
  const signedBundle = read('lib/receipt/signed-bundle.js');
  assert.match(signedBundle, /huqan\.receipt-bundle-signature\.v1/);
  assert.match(signedBundle, /signReceiptBundle/);
  const exporter = read('lib/receipt/receipt-export.js');
  assert.match(exporter, /signReceiptBundle/, 'the export path must still sign');
  assert.match(exporter, /signatureStatus/, 'the verify path must still report signature status');
});

test('the published HTP 0.2 bundle contract specifies no attestation field', () => {
  const published = read('specs/huqan-trust-protocol/0.2/RECEIPT-BUNDLE.md');
  assert.doesNotMatch(published, /bundleSignature/,
    'HTP 0.2 documents no issuer signature; adding one is a protocol decision, not a doc edit');
  // Match the signature identifier, not the word: a prose mention of
  // "signature" in a comment is not signature support, and asserting on the
  // bare word would fail on a harmless edit.
  const verifier = read('specs/huqan-trust-protocol/0.2/conformance/verify_bundle.py');
  assert.doesNotMatch(verifier, /bundleSignature|receipt-bundle-signature/,
    'the published 0.2 verifier implements no signature check');
  // The legacy copy does carry it, which is why the gap is specific to the
  // published lineage and not a missing capability.
  assert.match(read('specs/axiom-trust-protocol/0.1/RECEIPT-BUNDLE.md'), /bundleSignature/);
  assert.match(read('specs/axiom-trust-protocol/0.1/conformance/verify_bundle.py'),
    /bundleSignature/);
});

test('the boundary record names both blocked cells with their reopen conditions', () => {
  const record = read(RECORD);
  assert.match(record, /SELF_RUN_ONLY__TWO_CELLS_BLOCKED/);
  assert.match(record, /Independent external verification/i);
  assert.match(record, /attestation bound into the Trust Receipt bundle/i);
  assert.match(record, /Reopen condition/i);
  // The record must not present the cells as satisfied: it has to say the
  // external units are not repository work.
  assert.match(record, /not\*\* repository work/,
    'the record must say the external units are not repository work');
});
