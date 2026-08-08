'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.textContent = '';
    this.dataset = {};
    this.children = [];
    this.listeners = {};
    this.value = '';
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  addEventListener(type, listener) { this.listeners[type] = listener; }
}

const fakeDocument = { createElement: (tagName) => new FakeNode(tagName) };

test('V4-UI-2 renders bounded receipt fields with text nodes only', async () => {
  const module = await import('../public/viewer/app.mjs');
  const status = new FakeNode('p');
  const details = new FakeNode('dl');
  const attack = '<img src=x onerror=alert(1)>';
  const receipt = {
    receiptId: attack,
    decision: 'ALLOW',
    riskScore: 0,
    canonical: true,
    metadata: { apiKey: 'must-not-render' },
    unexpected: 'must-not-render',
  };

  module.renderViewState(fakeDocument, status, details, { state: 'found', receipt });
  assert.equal(status.textContent, 'Canonical receipt observed.');
  assert.equal(status.dataset.state, 'found');
  assert.deepEqual(details.children.map((pair) => [
    pair.children[0].textContent,
    pair.children[1].textContent,
  ]), [
    ['receiptId', attack],
    ['decision', 'ALLOW'],
    ['riskScore', '0'],
    ['canonical', 'true'],
  ]);

  const source = readFileSync(path.join(__dirname, '..', 'public', 'viewer', 'app.mjs'), 'utf8');
  assert.equal(source.includes('innerHTML'), false);
  assert.equal(source.includes('localStorage'), false);
  assert.equal(source.includes('sessionStorage'), false);
});

test('V4-UI-2 fails closed for hostile and non-found rendering inputs', async () => {
  const { renderViewState } = await import('../public/viewer/app.mjs');
  const status = new FakeNode('p');
  const details = new FakeNode('dl');
  details.append(new FakeNode('stale'));
  let getterCalls = 0;
  const hostile = {};
  Object.defineProperty(hostile, 'receiptId', { get() { getterCalls += 1; throw new Error('no'); } });

  assert.doesNotThrow(() => renderViewState(fakeDocument, status, details, { state: 'found', receipt: hostile }));
  assert.equal(getterCalls, 0);
  assert.equal(details.children.length, 0);
  renderViewState(fakeDocument, status, details, { state: 'unauthorized', receipt: { receiptId: 'hidden' } });
  assert.equal(status.dataset.state, 'unauthorized');
  assert.equal(details.children.length, 0);

  const hostileState = new Proxy({}, {
    getOwnPropertyDescriptor() { throw new Error('no state access'); },
  });
  assert.doesNotThrow(() => renderViewState(fakeDocument, status, details, hostileState));
  assert.equal(status.dataset.state, 'read_error');
});

test('V4-UI-2 builds only encoded same-origin receipt paths', async () => {
  const { buildReceiptPath } = await import('../public/viewer/app.mjs');
  assert.equal(buildReceiptPath('a/b?c', 'team one'), '/viewer/api/trust-receipt/a%2Fb%3Fc?workspaceId=team%20one');
  assert.equal(buildReceiptPath('receipt-1'), '/viewer/api/trust-receipt/receipt-1');
});

test('V4-UI-2 keeps credentials same-origin and clears the API key after login', async () => {
  const { startViewer } = await import('../public/viewer/app.mjs');
  const nodes = Object.fromEntries([
    'login-form', 'receipt-form', 'logout-button', 'api-key', 'login-workspace-id', 'receipt-id',
    'workspace-id', 'status', 'receipt-details',
  ].map((id) => [id, new FakeNode(id)]));
  const documentRef = {
    ...fakeDocument,
    getElementById: (id) => nodes[id],
  };
  const calls = [];
  const fetchRef = async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  startViewer(documentRef, fetchRef);

  nodes['api-key'].value = 'operator-secret';
  nodes['login-workspace-id'].value = 'workspace-a';
  await nodes['login-form'].listeners.submit({ preventDefault() {} });
  assert.equal(nodes['api-key'].value, '');
  assert.equal(nodes.status.textContent, 'Viewer session opened. Enter a receipt identifier.');
  assert.deepEqual(calls[0], {
    url: '/viewer/session',
    options: {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: 'operator-secret', workspaceId: 'workspace-a' }),
    },
  });

  nodes['receipt-id'].value = 'receipt/1';
  nodes['workspace-id'].value = 'team one';
  await nodes['receipt-form'].listeners.submit({ preventDefault() {} });
  assert.equal(calls[1].url, '/viewer/api/trust-receipt/receipt%2F1?workspaceId=team%20one');
  assert.equal(calls[1].options.credentials, 'same-origin');

  const rejectingFetch = async () => { throw new Error('offline'); };
  startViewer(documentRef, rejectingFetch);
  await assert.doesNotReject(() => nodes['logout-button'].listeners.click());
  assert.equal(nodes.status.dataset.state, 'unauthorized');
});
