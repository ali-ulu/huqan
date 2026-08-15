'use strict';

/**
 * Chain integrity is part of the read verdict, not a footnote on it (#766).
 *
 * readReceiptById validated the selected receipt, rebuilt the full materialized
 * chain, and then returned ok:true / status:'found' regardless of what that
 * rebuild said -- the verdict lived in `chainStatus`, which the primary
 * ok/status contract does not mention. The viewer gateway forwards a receipt on
 * `ok === true` alone and the browser then prints "Canonical receipt observed."
 * So a receipt from a broken transcript was presented as canonical, and the
 * read index -- the product's trust inspection surface -- could not tell the
 * two apart.
 *
 * Reading such a receipt is still useful for working out what broke, so the
 * payload is kept; what changes is that the read refuses to call it found, and
 * every surface downstream names the failure.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildMaterializedReceiptChain,
  readReceiptById,
} = require('../lib/receipt/receipt-read-index');
const { receiptReadFailure } = require('../lib/http/receipt-read-failures');
const { inspectTrustReceipt } = require('../lib/workbench/trust-receipt-inspector');
const { handleWorkbenchTrustReceiptRequest } = require('../lib/workbench/trust-receipt-route');

const fixtureDir = path.join(__dirname, 'fixtures', 'receipt-trust-root');
const fixtures = fs.readdirSync(fixtureDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8')));
const baseReceipt = fixtures.find((fixture) => fixture.caseId === 'RTR-001-V1-CANONICAL-BYTES').input.receipt;

function receiptEvent(receipt) {
  return { workspaceId: receipt.workspaceId, details: { receipt } };
}

/** A receipt that parses on its own. */
function validReceipt(overrides) {
  return { ...structuredClone(baseReceipt), ...overrides };
}

/**
 * An audit sequence whose selected receipt is individually parseable but whose
 * chain does not validate: the second entry declares the V2 schema and then
 * omits the trustRoot that schema requires.
 */
function brokenChainEvents() {
  const selected = validReceipt({ receiptId: 'chain-read-selected', admissionId: 'chain-read-selected-a' });
  const breaker = validReceipt({
    receiptId: 'chain-read-breaker',
    admissionId: 'chain-read-breaker-a',
    canonicalReceiptSchemaVersion: 'v4-receipt-v2',
  });
  delete breaker.trustRoot;
  return { selected, events: [receiptEvent(selected), receiptEvent(breaker)] };
}

function validChainEvents() {
  const selected = validReceipt({ receiptId: 'chain-read-ok', admissionId: 'chain-read-ok-a' });
  return { selected, events: [receiptEvent(selected)] };
}

test('the fixture really does produce a broken chain with a readable receipt', () => {
  const { selected, events } = brokenChainEvents();
  const chain = buildMaterializedReceiptChain(events, { workspaceId: selected.workspaceId });
  assert.equal(chain.ok, false, 'the fixture chain was expected to be invalid');

  const read = readReceiptById(events, selected.receiptId, { workspaceId: selected.workspaceId });
  assert.ok(read.canonicalPayload, 'the selected receipt should still parse individually');
});

test('a receipt from a broken chain is not an ordinary found receipt', () => {
  const { selected, events } = brokenChainEvents();
  const read = readReceiptById(events, selected.receiptId, { workspaceId: selected.workspaceId });

  assert.equal(read.ok, false, 'a broken chain was reported as a successful read');
  assert.notEqual(read.status, 'found');
  assert.equal(read.status, 'chain_invalid');
  assert.equal(read.chainStatus, 'invalid');
  assert.equal(read.authoritative, false);
  assert.equal(read.error.code, 'INVALID_RECEIPT_CHAIN');
});

test('the forensic copy survives the refusal', () => {
  // Refusing to call it authoritative is not the same as hiding it: an
  // operator working out what broke still needs the record.
  const { selected, events } = brokenChainEvents();
  const read = readReceiptById(events, selected.receiptId, { workspaceId: selected.workspaceId });

  assert.equal(read.receipt.receiptId, selected.receiptId);
  assert.ok(read.canonicalPayload);
  assert.ok(read.chainValidation, 'the chain verdict must say why it failed');
  assert.equal(read.chainValidation.valid, false);
});

test('a valid chain still reads as found, and says so explicitly', () => {
  const { selected, events } = validChainEvents();
  const read = readReceiptById(events, selected.receiptId, { workspaceId: selected.workspaceId });

  assert.equal(read.ok, true);
  assert.equal(read.status, 'found');
  assert.equal(read.chainStatus, 'valid');
  assert.equal(read.authoritative, true);
  assert.equal(read.receipt.receiptId, selected.receiptId);
});

test('the viewer gateway answers the broken chain with its own code, never 200', () => {
  const failure = receiptReadFailure('chain_invalid');
  assert.equal(failure.statusCode, 409);
  assert.equal(failure.code, 'receipt_chain_invalid');

  // ...and it is not conflated with the two failures that already existed.
  assert.equal(receiptReadFailure('not_found').code, 'receipt_not_found');
  assert.equal(receiptReadFailure('invalid_request').code, 'invalid_receipt_id');
  // An unmapped status falls back to a refusal, not to success.
  assert.notEqual(receiptReadFailure('something_new').statusCode, 200);
});

test('the workbench inspector reports the integrity failure by name', () => {
  const { selected, events } = brokenChainEvents();
  const inspection = inspectTrustReceipt({
    receiptId: selected.receiptId,
    workspaceId: selected.workspaceId,
    source: events,
  });

  assert.equal(inspection.ok, false);
  assert.equal(inspection.status, 'chain_invalid');
  assert.equal(inspection.reason, 'receipt_chain_invalid');
  assert.equal(Object.hasOwn(inspection, 'receipt'), false, 'a non-authoritative receipt must not be served as data');
});

test('the workbench route maps the integrity failure to 409', () => {
  const { selected, events } = brokenChainEvents();
  const { statusCode, body } = handleWorkbenchTrustReceiptRequest({
    receiptId: selected.receiptId,
    workspaceId: selected.workspaceId,
    source: events,
  });

  assert.equal(statusCode, 409);
  assert.equal(body.ok, false);
  assert.equal(body.status, 'chain_invalid');
});

test('the viewer view-model gives the broken chain its own state', async () => {
  const { TERMINAL_STATES, mapReceiptResponse } = await import('../public/viewer/receipt-view-model.mjs');
  assert.ok(TERMINAL_STATES.includes('chain_invalid'));

  const mapped = mapReceiptResponse({
    statusCode: 409,
    body: { ok: false, error: { code: 'receipt_chain_invalid' } },
  });
  assert.deepEqual(mapped, { state: 'chain_invalid', receipt: null });
});

test('the viewer renders an integrity error, not a canonical observation', async () => {
  const { renderViewState } = await import('../public/viewer/app.mjs');
  const status = { textContent: '', dataset: {} };
  const details = { replaceChildren() { this.cleared = true; }, cleared: false };

  renderViewState({ createElement: () => ({}) }, status, details, { state: 'chain_invalid', receipt: null });

  assert.equal(status.dataset.state, 'chain_invalid');
  assert.notEqual(status.textContent, 'Canonical receipt observed.');
  assert.match(status.textContent, /integrity/i);
  assert.equal(details.cleared, true, 'no receipt fields may be rendered for a non-authoritative read');
});
