'use strict';

/**
 * The receipt chain and the receipt stamp must be built over the same order.
 *
 * receipt-stamp.js sorts its rows by (timestamp, auditId);
 * collectMaterializedReceiptEntries walked getAuditEvents in raw store order.
 * Any store that does not hand back audit events chronologically therefore
 * produced a chain whose headHash disagreed with the headHash getReceiptStamp
 * reported -- and receipt-validation-cache keys on (headHash, receiptCount), so
 * that disagreement becomes false cache hits and misses on the product's trust
 * inspection surface.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { buildMaterializedReceiptChain, listMaterializedReceiptEntries } = require('../lib/receipt/receipt-read-index');

const fixtureDir = path.join(__dirname, 'fixtures', 'receipt-trust-root');
const fixtures = fs.readdirSync(fixtureDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8')));
const baseReceipt = fixtures.find((fixture) => fixture.caseId === 'RTR-001-V1-CANONICAL-BYTES').input.receipt;

function receiptEvent(receiptId, timestamp, auditId) {
  const receipt = { ...structuredClone(baseReceipt), receiptId, admissionId: `${receiptId}-a` };
  return { workspaceId: receipt.workspaceId, auditId, timestamp, details: { receipt } };
}

const WORKSPACE = baseReceipt.workspaceId;

// Three receipts whose chronological order (a, b, c) is deliberately not the
// order the store hands them back in.
const CHRONOLOGICAL = [
  receiptEvent('chain-order-a', '2026-01-01T00:00:01.000Z', 'audit-1'),
  receiptEvent('chain-order-b', '2026-01-01T00:00:02.000Z', 'audit-2'),
  receiptEvent('chain-order-c', '2026-01-01T00:00:03.000Z', 'audit-3'),
];
const SHUFFLED = [CHRONOLOGICAL[2], CHRONOLOGICAL[0], CHRONOLOGICAL[1]];

function receiptIds(events) {
  return listMaterializedReceiptEntries(events, { workspaceId: WORKSPACE }).map((entry) => entry.receipt.receiptId);
}

test('entries come back in chronological order whatever order the store used', () => {
  const expected = ['chain-order-a', 'chain-order-b', 'chain-order-c'];

  assert.deepEqual(receiptIds(CHRONOLOGICAL), expected);
  assert.deepEqual(receiptIds(SHUFFLED), expected);
});

test('the chain head does not depend on store order', () => {
  const ordered = buildMaterializedReceiptChain(CHRONOLOGICAL, { workspaceId: WORKSPACE });
  const shuffled = buildMaterializedReceiptChain(SHUFFLED, { workspaceId: WORKSPACE });

  assert.equal(ordered.ok, true, JSON.stringify(ordered, null, 2));
  assert.equal(shuffled.ok, true, JSON.stringify(shuffled, null, 2));
  assert.equal(shuffled.chain.length, ordered.chain.length);
  assert.equal(
    shuffled.chain.at(-1).receiptHash,
    ordered.chain.at(-1).receiptHash,
    'headHash must be a property of the receipts, not of the read order',
  );
});

test('events sharing a timestamp are ordered by auditId', () => {
  const sameInstant = [
    receiptEvent('chain-order-y', '2026-01-01T00:00:01.000Z', 'audit-2'),
    receiptEvent('chain-order-x', '2026-01-01T00:00:01.000Z', 'audit-1'),
  ];

  assert.deepEqual(receiptIds(sameInstant), ['chain-order-x', 'chain-order-y']);
});

test('a single receipt is unaffected', () => {
  assert.deepEqual(receiptIds([CHRONOLOGICAL[1]]), ['chain-order-b']);
});
