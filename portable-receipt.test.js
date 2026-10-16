'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const HTP = path.join(__dirname, 'specs', 'huqan-trust-protocol', '0.2');

describe('portable receipt contract', () => {
  it('valid example bundle keeps its portable shape', () => {
    const bundle = JSON.parse(
      fs.readFileSync(path.join(HTP, 'examples', 'receipt-bundle.valid.json'), 'utf8')
    );
    assert.strictEqual(bundle.schemaVersion, 'v4-receipt-bundle-v1');
    assert.ok(Array.isArray(bundle.receipts));
    assert.strictEqual(bundle.receiptCount, bundle.receipts.length);
    for (const receipt of bundle.receipts) {
      assert.ok(receipt.receiptId);
      assert.ok(receipt.receiptHash);
    }
  });

  it('independent verifier entry point ships with the spec', () => {
    assert.ok(fs.existsSync(path.join(HTP, 'conformance', 'verify_bundle.py')));
    assert.ok(fs.existsSync(path.join(HTP, 'RECEIPT-BUNDLE.md')));
    assert.ok(fs.existsSync(path.join(HTP, 'schemas', 'public-trust-receipt.schema.json')));
  });
});
