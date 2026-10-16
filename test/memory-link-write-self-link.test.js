'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { runLinkMemories } = require('../lib/memory-link-write');

function createStoreApi() {
  const records = new Map([
    ['a', { memoryId: 'a', workspaceId: 'default', status: 'active' }],
    ['b', { memoryId: 'b', workspaceId: 'default', status: 'active' }],
  ]);
  const calls = { persist: 0, appendLink: 0, appendEvent: 0 };
  return {
    calls,
    defaultTrustPolicyVersion: 'test-policy',
    findMemory: (memoryId, workspaceId) => {
      const record = records.get(memoryId);
      return record && record.workspaceId === workspaceId ? record : undefined;
    },
    findLink: () => undefined,
    persist: () => {
      calls.persist += 1;
      return undefined;
    },
    appendLink: () => {
      calls.appendLink += 1;
    },
    appendEvent: () => {
      calls.appendEvent += 1;
    },
  };
}

test('runLinkMemories rejects a self-link for every relation', () => {
  for (const relation of ['supersedes', 'contradicts', 'supports', 'references', 'related_to']) {
    const storeApi = createStoreApi();
    const result = runLinkMemories(storeApi, {
      fromMemoryId: 'a',
      toMemoryId: 'a',
      relation,
      workspaceId: 'default',
    });

    assert.equal(result.ok, false, `${relation} self-link should be rejected`);
    assert.equal(result.error.code, 'VALIDATION_ERROR');
    assert.match(result.error.message, /cannot link a memory to itself/);
    assert.equal(storeApi.calls.persist, 0, 'a rejected self-link must not persist');
    assert.equal(storeApi.calls.appendLink, 0);
    assert.equal(storeApi.calls.appendEvent, 0);
  }
});

test('runLinkMemories rejects a self-link that differs only by surrounding whitespace', () => {
  const storeApi = createStoreApi();
  const result = runLinkMemories(storeApi, {
    fromMemoryId: '  a  ',
    toMemoryId: 'a',
    relation: 'supports',
    workspaceId: 'default',
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'VALIDATION_ERROR');
  assert.match(result.error.message, /cannot link a memory to itself/);
});

test('runLinkMemories still accepts a link between two distinct memories', () => {
  const storeApi = createStoreApi();
  const result = runLinkMemories(storeApi, {
    fromMemoryId: 'a',
    toMemoryId: 'b',
    relation: 'supports',
    workspaceId: 'default',
  });

  assert.equal(result.ok, true);
  assert.equal(result.link.fromMemoryId, 'a');
  assert.equal(result.link.toMemoryId, 'b');
  assert.equal(storeApi.calls.appendLink, 1);
  assert.equal(storeApi.calls.appendEvent, 1);
});
