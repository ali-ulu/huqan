'use strict';

/**
 * A V4 chain record must carry usable values, not just the right key set.
 *
 * validateV4RecordShape returned `{valid: true}` for a V1 record as soon as its
 * key set matched the allowlist. The key-set check proves every field is
 * *present*; it says nothing about the values, so a record whose hash is
 * internally consistent but whose receiptId is an empty string validated. V1 is
 * not a legacy curiosity here -- every chain from genesis carries V1 records.
 *
 * The same gap existed on the V2 branch (validateCanonicalReceiptV2 checks
 * presence, the allowlist, the schema version and the trust root, but not
 * emptiness), so the check applies to both.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { validateV4Chain, V4_RECEIPT_ERROR_CODES } = require('../lib/receipt/v4-receipt-family');
const { REQUIRED_RECEIPT_FIELDS } = require('../lib/receipt/canonical-receipt');
const { buildMaterializedReceiptChain } = require('../lib/receipt/receipt-read-index');

const fixtureDir = path.join(__dirname, 'fixtures', 'receipt-trust-root');
const fixtures = fs.readdirSync(fixtureDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8')));
const baseReceipt = fixtures.find((fixture) => fixture.caseId === 'RTR-001-V1-CANONICAL-BYTES').input.receipt;

/** Build a real, hash-consistent single-record chain from a raw receipt. */
function chainOf(receipt) {
  const built = buildMaterializedReceiptChain(
    [{ workspaceId: receipt.workspaceId, details: { receipt } }],
    { workspaceId: receipt.workspaceId },
  );
  assert.equal(built.ok, true, `the fixture chain must build: ${JSON.stringify(built.error || built, null, 2)}`);
  return built.chain;
}

test('a well-formed V1 chain still validates', () => {
  const result = validateV4Chain(chainOf(structuredClone(baseReceipt)));

  assert.equal(result.valid, true, JSON.stringify(result, null, 2));
});

test('an empty required field fails validation rather than passing on key shape', () => {
  const chain = chainOf(structuredClone(baseReceipt));
  const record = { ...chain[0], receiptId: '' };

  const result = validateV4Chain([record]);

  assert.equal(result.valid, false, 'an empty receiptId must not validate');
  assert.equal(result.code, V4_RECEIPT_ERROR_CODES.INVALID_RECEIPT_FIELDS);
});

test('every required field is checked, not just the first', () => {
  const chain = chainOf(structuredClone(baseReceipt));

  for (const field of REQUIRED_RECEIPT_FIELDS) {
    for (const emptyValue of ['', '   ', null, undefined]) {
      const record = { ...chain[0], [field]: emptyValue };

      const result = validateV4Chain([record]);

      assert.equal(result.valid, false, `${field} = ${JSON.stringify(emptyValue)} must not validate`);
      assert.equal(result.code, V4_RECEIPT_ERROR_CODES.INVALID_RECEIPT_FIELDS);
    }
  }
});

test('the key-set check still runs first for an unknown field', () => {
  const chain = chainOf(structuredClone(baseReceipt));
  const record = { ...chain[0], somethingElse: 'x' };

  const result = validateV4Chain([record]);

  assert.equal(result.valid, false);
  assert.equal(result.code, V4_RECEIPT_ERROR_CODES.UNSUPPORTED_SCHEMA_VERSION);
});
