'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { vectors, OUT_DIR } = require('../scripts/generate-protocol-vectors');
const { verifyExportedBundle } = require('../lib/receipt/receipt-export');

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (name) => JSON.parse(fs.readFileSync(path.join(OUT_DIR, name), 'utf8'));

const POSITIVE = ['receipt-bundle.valid.json', 'receipt-bundle.unicode.valid.json'];
const NEGATIVE = [
  'receipt-bundle.broken-chain.json',
  'receipt-bundle.tampered-bundle-hash.json',
  'receipt-bundle.tampered-receipt.json',
];

test('the committed vectors are exactly what the generator produces', () => {
  // A bundle is sealed by a SHA-256 over its canonical serialization and its
  // receipts are hash-chained, so a hand-edited vector is a vector with a wrong
  // hash. Worse, a negative fixture with a wrong hash still fails verification
  // -- for the wrong reason -- while looking like it works. Regenerating and
  // comparing is the only way to know the fixtures still describe the format.
  for (const [name, expected] of Object.entries(vectors())) {
    assert.deepEqual(read(name), expected,
      `${name} is stale; run node scripts/generate-protocol-vectors.js and commit`);
  }
});

test('0.2 carries its own vectors rather than borrowing 0.1&apos;s', () => {
  // The whole of #1820: the canonical protocol version was being
  // conformance-tested through its predecessor's fixtures.
  const shipped = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith('receipt-bundle.'));
  assert.equal(shipped.length, 5);
  for (const name of [...POSITIVE, ...NEGATIVE]) assert.ok(shipped.includes(name), name);
});

test('the positive vectors verify', () => {
  for (const name of POSITIVE) {
    const result = verifyExportedBundle(read(name));
    assert.equal(result.valid, true, `${name}: ${JSON.stringify(result)}`);
  }
});

test('each negative vector fails, and differs from the valid one by a single field', () => {
  // One corruption per fixture, so a verifier reporting an unexpected extra
  // finding is telling you something about the verifier rather than the vector.
  const valid = read('receipt-bundle.valid.json');
  for (const name of NEGATIVE) {
    const corrupted = read(name);
    assert.equal(verifyExportedBundle(corrupted).valid, false, `${name} must not verify`);

    const differences = [];
    const walk = (a, b, at) => {
      if (a && b && typeof a === 'object' && typeof b === 'object') {
        for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[key], b[key], `${at}.${key}`);
      } else if (a !== b) differences.push(at);
    };
    walk(valid, corrupted, name.replace('.json', ''));
    assert.equal(differences.length, 1, `${name} changes ${differences.length} fields: ${differences.join(', ')}`);
  }
});

test('a corruption is one bit of one hex digit, not a mangled document', () => {
  // A fixture that replaced a hash with "BROKEN" would test string validation,
  // not chain verification. These stay well-formed hashes that are simply the
  // wrong ones.
  const hash = /^[0-9a-f]{64}$/;
  for (const name of NEGATIVE) {
    const bundle = read(name);
    assert.match(bundle.bundleHash, hash, `${name}: bundleHash must stay hash-shaped`);
    for (const receipt of bundle.receipts) {
      assert.match(receipt.receiptHash, hash, `${name}: receiptHash must stay hash-shaped`);
      if (receipt.previousReceiptHash !== null && receipt.previousReceiptHash !== undefined) {
        assert.ok(hash.test(receipt.previousReceiptHash) || receipt.previousReceiptHash.startsWith('genesis:'),
          `${name}: previousReceiptHash must stay hash-shaped`);
      }
    }
  }
});

test('the unicode vector actually carries non-ASCII in a hashed field', () => {
  // Otherwise it is a second copy of the valid vector wearing a different name.
  // This is where two implementations diverge if one normalizes or escapes
  // differently, so the content has to be there to test anything.
  const bundle = read('receipt-bundle.unicode.valid.json');
  const serialized = JSON.stringify(bundle.receipts);
  // oxlint-disable-next-line no-control-regex -- deliberate: a negated ASCII range; the control characters in it are incidental to the intent (non-ASCII detection)
  assert.ok(/[^\u0000-\u007f]/.test(serialized), 'no non-ASCII content in the receipts');
});

test('the runner declares an expectation for every 0.2 vector', () => {
  // An undeclared fixture is silently skipped by the cross-implementation
  // comparison, which would look identical to passing.
  const consumer = fs.readFileSync(
    path.join(REPO_ROOT, 'scripts', 'external-conformance', 'consumer-bundles.js'), 'utf8');
  for (const name of [...POSITIVE, ...NEGATIVE]) {
    assert.ok(consumer.includes(`'${name}'`), `${name} has no BUNDLE_EXPECTATIONS entry`);
  }
});

test('the vectors ship in the package', () => {
  // The cross-implementation case runs against the installed tarball, so an
  // unpublished vector directory fails there with ENOENT rather than here.
  const files = new Set(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).files);
  for (const name of [...POSITIVE, ...NEGATIVE]) {
    assert.ok(files.has(`specs/huqan-trust-protocol/0.2/examples/${name}`), `${name} is not published`);
  }
});
