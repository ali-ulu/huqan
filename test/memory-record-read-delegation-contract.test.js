'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STORE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store.js');
const DELEGATE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-record-read.js');
const storeSource = fs.readFileSync(STORE_SOURCE, 'utf8');
const delegateSource = fs.readFileSync(DELEGATE_SOURCE, 'utf8');
const delegateCode = delegateSource
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');
const {
  findById,
  findByContentHash,
  findBySourceRef,
  findByKind,
  findByStatus,
} = require('../lib/memory-record-read');
const { getContentHash } = require('../lib/memory-store-utils');
const MemoryStore = require('../lib/memory-store');

function makeRecord({ memoryId, workspaceId = 'default', content, sourceRef, kind = 'memory-record', status = 'active', createdAt }) {
  return {
    memoryId,
    workspaceId,
    content,
    provenance: sourceRef ? { sourceRef } : {},
    kind,
    status,
    createdAt,
    metadata: {},
  };
}

function makeContext(records) {
  const memories = new Map(records.map((record) => [`${record.workspaceId}:${record.memoryId}`, record]));
  return {
    memories,
    findMemory: (memoryId, workspaceId) => memories.get(`${workspaceId}:${String(memoryId || '').trim()}`),
    isActiveRecord: (record) => !!record && record.status === 'active',
  };
}

const alpha = makeRecord({
  memoryId: 'm-alpha',
  content: { topic: 'alpha' },
  sourceRef: 'source-a',
  kind: 'note',
  createdAt: '2026-06-03T12:00:02.000Z',
});
const beta = makeRecord({
  memoryId: 'm-beta',
  content: { topic: 'beta' },
  sourceRef: 'source-a',
  kind: 'note',
  createdAt: '2026-06-03T12:00:01.000Z',
});
const deleted = makeRecord({
  memoryId: 'm-deleted',
  content: { topic: 'alpha' },
  sourceRef: 'source-a',
  kind: 'note',
  status: 'deleted',
  createdAt: '2026-06-03T12:00:03.000Z',
});
const otherWorkspace = makeRecord({
  memoryId: 'm-other',
  workspaceId: 'workspace-b',
  content: { topic: 'alpha' },
  sourceRef: 'source-a',
  kind: 'note',
  createdAt: '2026-06-03T12:00:00.000Z',
});
const context = makeContext([alpha, beta, deleted, otherWorkspace]);

 test('MS: record lookup methods are delegated to lib/memory-record-read.js', () => {
  assert.ok(
    storeSource.includes("} = require('./memory-record-read');"),
    'lib/memory-store.js imports the record-read delegate',
  );

  const wrappers = [
    ['findById', 'readFindById'],
    ['findByContentHash', 'readFindByContentHash'],
    ['findBySourceRef', 'readFindBySourceRef'],
    ['findByKind', 'readFindByKind'],
    ['findByStatus', 'readFindByStatus'],
  ];
  for (const [method, delegate] of wrappers) {
    const methodMatch = storeSource.match(new RegExp(`${method}\\([^\\n]+\\) \\{[\\s\\S]*?\\n  \\}`));
    assert.ok(methodMatch, `${method} method still exists`);
    assert.match(
      methodMatch[0],
      new RegExp(`return ${delegate}\\(this\\._recordReadContext\\(\\),`),
      `${method} is a one-line delegation`,
    );
  }

  const contextMatch = storeSource.match(/_recordReadContext\(\) \{[\s\S]*?\n  \}/);
  assert.ok(contextMatch, '_recordReadContext exists');
  assert.match(contextMatch[0], /memories: this\._memories/);
  assert.match(contextMatch[0], /findMemory:/);
  assert.match(contextMatch[0], /isActiveRecord:/);
});

test('MS: pinned record-read call sites remain read-only and acyclic', () => {
  assert.equal((storeSource.match(/require\('\.\/memory-record-read'\)/g) || []).length, 1, 'delegate require appears once');
  for (const delegate of ['readFindById', 'readFindByContentHash', 'readFindBySourceRef', 'readFindByKind', 'readFindByStatus']) {
    assert.equal((storeSource.match(new RegExp(`${delegate}\\(`, 'g')) || []).length, 1, `${delegate} has one call site`);
  }
  assert.equal((storeSource.match(/_recordReadContext\(\)/g) || []).length, 6, 'context factory has one definition plus five call sites');
  assert.equal((delegateCode.match(/this\./g) || []).length, 0, 'delegate has no this/store receiver access');
  assert.ok(!delegateCode.includes("require('./memory-store')"), 'delegate has no cycle back to memory-store');
  for (const banned of ['_db', '_stmts', '_events', '_links', '_withTransaction', '_persistenceError', 'appendEvent', 'persist(']) {
    assert.ok(!delegateCode.includes(banned), `delegate must not touch store internals (${banned})`);
  }
  assert.equal((delegateCode.match(/context\.memories\.values\(\)/g) || []).length, 4, 'collection scans remain local to delegate-owned result logic');
});

test('MS: record-read behavior preserves workspace, tombstone, ordering, and cloning semantics', () => {
  const idResult = findById(context, 'm-alpha', { workspaceId: 'default' });
  assert.equal(idResult.ok, true);
  assert.equal(idResult.memory.memoryId, 'm-alpha');
  idResult.memory.metadata.changed = true;
  assert.equal(alpha.metadata.changed, undefined, 'returned memory is cloned');

  assert.equal(findById(context, 'm-deleted', { workspaceId: 'default' }).error.code, 'NOT_FOUND');
  assert.equal(findById(context, 'm-deleted', { workspaceId: 'default', includeTombstoned: true }).ok, true);
  assert.equal(findById(context, 'm-other', { workspaceId: 'default' }).error.code, 'NOT_FOUND');

  const hashResult = findByContentHash(context, getContentHash(alpha.content), { workspaceId: 'default' });
  assert.deepEqual(hashResult.memories.map((memory) => memory.memoryId), ['m-alpha']);
  assert.equal(findByContentHash(context, getContentHash(alpha.content), { workspaceId: 'default', includeTombstoned: true }).total, 2);

  const sourceResult = findBySourceRef(context, ' source-a ', { workspaceId: 'default' });
  assert.deepEqual(sourceResult.memories.map((memory) => memory.memoryId), ['m-beta', 'm-alpha']);
  assert.equal(sourceResult.total, 2);

  const kindResult = findByKind(context, 'note', { workspaceId: 'default' });
  assert.deepEqual(kindResult.memories.map((memory) => memory.memoryId), ['m-beta', 'm-alpha']);
  const statusResult = findByStatus(context, 'deleted', { workspaceId: 'default' });
  assert.deepEqual(statusResult.memories.map((memory) => memory.memoryId), ['m-deleted']);
  assert.equal(findBySourceRef(context, 'source-a', { workspaceId: 'workspace-b' }).total, 1);
});

test('MS: record-read invalid inputs preserve existing error codes', () => {
  assert.equal(findById(context, '', {}).error.code, 'INVALID_INPUT');
  assert.equal(findByContentHash(context, ' ', {}).error.code, 'INVALID_INPUT');
  assert.equal(findBySourceRef(context, null, {}).error.code, 'INVALID_INPUT');
  assert.equal(findByKind(context, 7, {}).error.code, 'INVALID_INPUT');
  assert.equal(findByStatus(context, '', {}).error.code, 'INVALID_INPUT');
});

test('MS: public MemoryStore record-read wrappers use the injected context', () => {
  const store = new MemoryStore();
  const records = [
    makeRecord({ memoryId: 'wrapped-a', content: { value: 'a' }, sourceRef: 'wrapped-source', kind: 'note', createdAt: '2026-06-03T12:00:01.000Z' }),
    makeRecord({ memoryId: 'wrapped-b', content: { value: 'b' }, sourceRef: 'wrapped-source', kind: 'note', createdAt: '2026-06-03T12:00:00.000Z' }),
  ];
  for (const record of records) {
    store._memories.set(store._makeMemoryKey(record.workspaceId, record.memoryId), record);
  }

  assert.equal(store.findById('wrapped-a').ok, true);
  assert.deepEqual(store.findBySourceRef('wrapped-source').memories.map((memory) => memory.memoryId), ['wrapped-b', 'wrapped-a']);
  assert.deepEqual(store.findByKind('note').memories.map((memory) => memory.memoryId), ['wrapped-b', 'wrapped-a']);
  assert.equal(store.findByStatus('active').total, 2);
  assert.equal(store.findByContentHash(getContentHash(records[0].content)).total, 1);
});
