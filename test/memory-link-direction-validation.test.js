'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  findLinks,
  linksForMemory,
  traverseLinks,
} = require('../lib/memory-link-read');

function createContext() {
  const records = new Map([
    ['a', { memoryId: 'a', workspaceId: 'w', status: 'active', createdAt: '2026-01-01T00:00:00.000Z' }],
    ['b', { memoryId: 'b', workspaceId: 'w', status: 'active', createdAt: '2026-01-01T00:00:01.000Z' }],
    ['c', { memoryId: 'c', workspaceId: 'w', status: 'active', createdAt: '2026-01-01T00:00:02.000Z' }],
  ]);
  return {
    links: [
      {
        linkId: 'out',
        fromMemoryId: 'a',
        toMemoryId: 'b',
        workspaceId: 'w',
        relation: 'supports',
        createdAt: '2026-01-01T00:00:03.000Z',
      },
      {
        linkId: 'in',
        fromMemoryId: 'c',
        toMemoryId: 'a',
        workspaceId: 'w',
        relation: 'supports',
        createdAt: '2026-01-01T00:00:04.000Z',
      },
    ],
    findMemory: (id, workspaceId) => {
      const record = records.get(id);
      return record && record.workspaceId === workspaceId ? record : undefined;
    },
    isActiveRecord: (record) => record && record.status === 'active',
  };
}

function linkIds(result) {
  assert.equal(result.ok, true);
  return result.links.map((link) => link.linkId).sort();
}

test('all public memory-link readers reject invalid direction values fail-closed', () => {
  const calls = [
    ['findLinks', (context, direction) => findLinks(context, 'a', { workspaceId: 'w', direction })],
    ['traverseLinks', (context, direction) => traverseLinks(context, 'a', { workspaceId: 'w', direction, maxDepth: 1 })],
    ['linksForMemory', (context, direction) => linksForMemory(context, 'a', { workspaceId: 'w', direction })],
  ];

  for (const invalidDirection of ['outgiong', '', null, 42]) {
    for (const [name, call] of calls) {
      const result = call(createContext(), invalidDirection);
      assert.equal(result.ok, false, `${name} should reject ${String(invalidDirection)}`);
      assert.equal(result.error.code, 'VALIDATION_ERROR', `${name} should use validation error`);
      assert.match(result.error.message, /invalid direction/);
    }
  }
});

test('direction normalization preserves both, outgoing, and incoming semantics', () => {
  const expected = {
    both: ['in', 'out'],
    outgoing: ['out'],
    incoming: ['in'],
  };
  const calls = [
    (context, direction) => findLinks(context, 'a', { workspaceId: 'w', direction }),
    (context, direction) => traverseLinks(context, 'a', { workspaceId: 'w', direction, maxDepth: 1 }),
    (context, direction) => linksForMemory(context, 'a', { workspaceId: 'w', direction }),
  ];

  for (const [direction, expectedLinkIds] of Object.entries(expected)) {
    for (const call of calls) {
      const result = call(createContext(), ` ${direction.toUpperCase()} `);
      assert.deepEqual(linkIds(result), expectedLinkIds, `${direction} filtering changed`);
    }
  }
});

test('direction defaults to both when omitted', () => {
  const context = createContext();
  assert.deepEqual(linkIds(findLinks(context, 'a', { workspaceId: 'w' })), ['in', 'out']);
  assert.deepEqual(linkIds(traverseLinks(context, 'a', { workspaceId: 'w', maxDepth: 1 })), ['in', 'out']);
  assert.deepEqual(linkIds(linksForMemory(context, 'a', { workspaceId: 'w' })), ['in', 'out']);
});
