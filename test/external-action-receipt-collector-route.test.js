'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { buildReceiptBatch } = require('../lib/external-action-receipt-shipper');
const { createExternalActionReceiptCollectorRoute } = require('../lib/http/external-action-receipt-collector-route');

function makeRequest({ method = 'POST', body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  process.nextTick(() => {
    if (body !== null) req.emit('data', Buffer.from(JSON.stringify(body)));
    req.emit('end');
  });
  return req;
}

function makeResponse() {
  const res = new EventEmitter();
  res.statusCode = null;
  res._headers = null;
  res._body = null;
  res.writeHead = (code, headers) => { res.statusCode = code; res._headers = headers; };
  res.end = (data) => { res._body = data ? JSON.parse(String(data)) : null; };
  return res;
}

function parseJsonRequest(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null));
  });
}

function receipt(overrides = {}) {
  return {
    receiptId: 'xact_adm_http_001', receiptKind: 'external_action_admission_receipt',
    decision: 'block', reason: 'DENYLISTED_COMMAND_BLOCKED', actor: 'codex',
    workspaceId: 'default', createdAt: '2026-09-03T00:00:00.000Z',
    metadata: { identity: { identityRef: 'agent:default:codex', agentId: 'codex', ownerActorId: 'owner-a', workspaceId: 'default', attested: false } },
    ...overrides,
  };
}

function batch(receipts = [receipt()], overrides = {}) {
  return buildReceiptBatch({
    tenant: { workspaceId: 'default', ownerActorId: 'owner-a' },
    source: { host: 'route-test' }, receipts, ...overrides,
  });
}

function handler(root) {
  return createExternalActionReceiptCollectorRoute({ parseJsonRequest, collectorRoot: root });
}

test('collector route ignores unrelated paths and consumes non-POST methods', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-collector-route-'));
  const route = handler(root);
  const ignored = await route(makeRequest(), makeResponse(), new URL('http://x/api/v5/other'));
  assert.equal(ignored, false);
  const res = makeResponse();
  assert.equal(await route(makeRequest({ method: 'GET' }), res, new URL('http://x/api/v5/receipts/batches')), true);
  assert.equal(res.statusCode, 405);
});

test('collector route stores a valid batch, deduplicates it, and does not expose its trail', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-collector-route-'));
  const route = handler(root);
  const receiptBatch = batch();
  const first = makeResponse();
  assert.equal(await route(makeRequest({ body: receiptBatch }), first, new URL('http://x/api/v5/receipts/batches')), true);
  assert.equal(first.statusCode, 202);
  assert.equal(first._body.status, 'stored');
  assert.equal(first._body.stored, 1);
  assert.equal(Object.hasOwn(first._body, 'trail'), false);

  const duplicate = makeResponse();
  assert.equal(await route(makeRequest({ body: receiptBatch }), duplicate, new URL('http://x/api/v5/receipts/batches')), true);
  assert.equal(duplicate.statusCode, 200);
  assert.equal(duplicate._body.status, 'duplicate');
  assert.equal(duplicate._body.stored, 0);
});

test('collector route fails closed for mixed-tenant data without reflecting receipt contents', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-collector-route-'));
  const route = handler(root);
  const res = makeResponse();
  const invalid = batch([receipt({ metadata: { identity: { identityRef: 'agent:default:other', agentId: 'other', ownerActorId: 'owner-b', workspaceId: 'default', attested: false } } })]);
  await route(makeRequest({ body: invalid }), res, new URL('http://x/api/v5/receipts/batches'));
  assert.equal(res.statusCode, 400);
  assert.equal(res._body.error.code, 'RECEIPT_BATCH_REJECTED');
  assert.equal(res._body.error.details.reason, 'mixed_tenant_batch');
  assert.equal(JSON.stringify(res._body).includes('owner-b'), false);
});
