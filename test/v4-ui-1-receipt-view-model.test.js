'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('V4-UI-1 receipt view-model contract', async (t) => {
  const module = await import('../public/viewer/receipt-view-model.mjs');
  const { TERMINAL_STATES, mapReceiptResponse } = module;

  await t.test('exports only the frozen terminal states and mapper', () => {
    assert.deepEqual(Object.keys(module).sort(), ['TERMINAL_STATES', 'mapReceiptResponse']);
    assert.equal(Object.isFrozen(TERMINAL_STATES), true);
    assert.deepEqual(TERMINAL_STATES, [
      'unauthorized',
      'invalid_request',
      'not_found',
      // A receipt whose materialized chain fails validation is its own
      // terminal state, so the viewer cannot report it as found (#766).
      'chain_invalid',
      // A receipt that reads and chains cleanly but carries no classified
      // trust status is not an observation, so it cannot share the found
      // state (#1991).
      'unverified',
      'read_error',
      'found',
    ]);
  });

  await t.test('passes through a real found receipt without mutation or synthesis', () => {
    const receipt = Object.freeze({
      receiptId: 'receipt-1', status: 'canonical', verdict: 'ALLOW', reason: 'verified',
    });
    const input = Object.freeze({ statusCode: 200, body: Object.freeze({ ok: true, receipt }) });
    const result = mapReceiptResponse(input);
    assert.deepEqual(result, { state: 'found', receipt });
    assert.equal(result.receipt, receipt);
    assert.deepEqual(input, { statusCode: 200, body: { ok: true, receipt } });
  });

  for (const status of ['canonical', 'pending', 'flagged', 'rejected']) {
    await t.test(`reports a receipt classified '${status}' as found`, () => {
      const receipt = Object.freeze({ receiptId: 'receipt-1', status });
      const result = mapReceiptResponse({ statusCode: 200, body: { ok: true, receipt } });
      assert.equal(result.state, 'found');
      assert.equal(result.receipt, receipt);
    });
  }

  // normalizeTrustReceipt() rewrites any status it cannot classify to
  // 'unknown', and a receipt shell carries no status at all. Both used to
  // reach the found state, where the panel said "Canonical receipt observed."
  // over a receipt nothing had classified (#1991).
  for (const [label, receipt] of [
    ['an unknown status', Object.freeze({ receiptId: 'receipt-1', status: 'unknown' })],
    ['no status field', Object.freeze({ receiptId: 'receipt-1', verdict: 'ALLOW' })],
    ['a non-string status', Object.freeze({ receiptId: 'receipt-1', status: 3 })],
    ['a status outside the ladder', Object.freeze({ receiptId: 'receipt-1', status: 'canonical-ish' })],
  ]) {
    await t.test(`refuses to call a receipt with ${label} found`, () => {
      const result = mapReceiptResponse({ statusCode: 200, body: { ok: true, receipt } });
      assert.equal(
        result.state,
        'unverified',
        'a receipt with no classified trust status must not be reported as a canonical observation',
      );
      assert.equal(result.receipt, receipt);
    });
  }

  const failures = [
    ['unauthorized', { statusCode: 401, body: { ok: false, error: { code: 'unauthorized' } } }],
    ['invalid_request', { statusCode: 400, body: { ok: false, error: { code: 'invalid_receipt_id' } } }],
    ['not_found', { statusCode: 404, body: { ok: false, error: { code: 'receipt_not_found' } } }],
    ['read_error', { statusCode: 500, body: { ok: false, error: { code: 'receipt_read_failed' } } }],
  ];

  for (const [expectedState, input] of failures) {
    await t.test(`maps ${expectedState} without receipt-shaped fallback data`, () => {
      const result = mapReceiptResponse(input);
      assert.deepEqual(result, { state: expectedState, receipt: null });
      assert.deepEqual(Object.keys(result).sort(), ['receipt', 'state']);
      assert.equal(JSON.stringify(result).includes('receiptId'), false);
      assert.equal(JSON.stringify(result).includes('timestamp'), false);
      assert.equal(JSON.stringify(result).includes('verdict'), false);
      assert.equal(JSON.stringify(result).includes('evidence'), false);
    });
  }

  await t.test('fails closed for malformed success and every unmapped response', () => {
    const cases = [
      undefined,
      null,
      {},
      { statusCode: 200, body: { ok: true } },
      { statusCode: 200, body: { ok: true, receipt: null } },
      { statusCode: 200, body: { ok: true, receipt: [] } },
      { statusCode: 401, body: { error: { code: 'other' } } },
      { statusCode: 403, body: { error: { code: 'cross_origin' } } },
      { statusCode: 404, body: { error: { code: 'not_found' } } },
      { statusCode: 405, body: { error: { code: 'method_not_allowed' } } },
      { statusCode: 413, body: { error: { code: 'payload_too_large' } } },
      { statusCode: 415, body: { error: { code: 'unsupported_media_type' } } },
      { statusCode: 429, body: { error: { code: 'rate_limited' } } },
      { statusCode: 500, body: 'not-json' },
    ];
    for (const input of cases) {
      assert.deepEqual(mapReceiptResponse(input), { state: 'read_error', receipt: null });
    }
  });

  await t.test('rejects inherited and accessor-controlled response fields without invoking getters', () => {
    const inheritedReceipt = Object.create({ receipt: { receiptId: 'inherited' } });
    inheritedReceipt.ok = true;
    assert.deepEqual(
      mapReceiptResponse({ statusCode: 200, body: inheritedReceipt }),
      { state: 'read_error', receipt: null },
    );

    let getterCalls = 0;
    const getter = () => {
      getterCalls += 1;
      throw new Error('getter must not execute');
    };
    const accessorInputs = [];
    for (const [target, key, value] of [
      [{ body: {} }, 'statusCode', 200],
      [{ statusCode: 200 }, 'body', { ok: true, receipt: {} }],
    ]) {
      Object.defineProperty(target, key, { get: getter, enumerable: true });
      accessorInputs.push(target);
      void value;
    }
    const accessorBody = { ok: true };
    Object.defineProperty(accessorBody, 'receipt', { get: getter, enumerable: true });
    accessorInputs.push({ statusCode: 200, body: accessorBody });
    const accessorError = {};
    Object.defineProperty(accessorError, 'code', { get: getter, enumerable: true });
    accessorInputs.push({ statusCode: 401, body: { error: accessorError } });

    for (const input of accessorInputs) {
      assert.deepEqual(mapReceiptResponse(input), { state: 'read_error', receipt: null });
    }
    assert.equal(getterCalls, 0);
  });

  await t.test('contains proxy traps as read_error', () => {
    const hostile = new Proxy({}, {
      getOwnPropertyDescriptor() { throw new Error('proxy trap'); },
    });
    assert.deepEqual(mapReceiptResponse(hostile), { state: 'read_error', receipt: null });
    assert.deepEqual(
      mapReceiptResponse({ statusCode: 200, body: hostile }),
      { state: 'read_error', receipt: null },
    );
  });

  await t.test('is deterministic and adds no credential or session data', () => {
    const input = { statusCode: 404, body: { ok: false, error: { code: 'receipt_not_found' } } };
    const first = mapReceiptResponse(input);
    const second = mapReceiptResponse(input);
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first).includes('apiKey'), false);
    assert.equal(JSON.stringify(first).includes('cookie'), false);
    assert.equal(JSON.stringify(first).includes('session'), false);
  });
});
