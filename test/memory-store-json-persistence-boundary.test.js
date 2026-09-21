'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const jsonPersistence = require('../lib/memory-store-json-persistence');

const repoRoot = path.join(__dirname, '..');

test('#2272: JSON persistence has no cross-module private MemoryStore calls', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'lib/memory-store-json-persistence.js'), 'utf8');
  const privateSeams = [
    [/\._persistenceError\s*\(/, '_persistenceError'],
    [/\._withTransaction\s*\(/, '_withTransaction'],
    [/\._makeMemoryKey\s*\(/, '_makeMemoryKey'],
  ];
  for (const [pattern, member] of privateSeams) {
    assert.doesNotMatch(source, pattern, `JSON persistence must not call MemoryStore.${member}`);
  }
});

test('#2272: JSON state application uses the public memory-key contract', () => {
  const store = {
    _memories: new Map(),
    _events: [],
    _links: [],
    makeMemoryKey(workspaceId, memoryId) {
      return `public:${workspaceId}:${memoryId}`;
    },
    _makeMemoryKey() {
      throw new Error('private memory-key seam reached');
    },
  };

  jsonPersistence.applyJsonMemoryStore(store, {
    memories: [{ workspaceId: 'ws-a', memoryId: 'mem-a' }],
    events: [],
    links: [],
  });

  assert.equal(store._memories.has('public:ws-a:mem-a'), true);
});

test('#2272: JSON transaction orchestration receives its transaction boundary', () => {
  const store = {
    _db: null,
    _jsonPath: null,
    _withTransaction() {
      throw new Error('private transaction seam reached');
    },
  };

  let calls = 0;
  const result = jsonPersistence.withJsonTransaction(
    store,
    () => 'committed',
    (fn) => {
      calls += 1;
      return fn();
    },
  );

  assert.equal(result, 'committed');
  assert.equal(calls, 1);
});

test('#2272: JSON persistence shapes write errors without a private store callback', () => {
  const missingDir = path.join(
    os.tmpdir(),
    `huqan-json-boundary-${process.pid}-${Date.now()}`,
    'missing',
  );
  const store = {
    _jsonPath: path.join(missingDir, 'memory.json'),
    _persistenceError() {
      throw new Error('private persistence-error seam reached');
    },
  };

  const result = jsonPersistence.persistJsonState(store, 'boundary-test', {
    memories: [],
    events: [],
    links: [],
  });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'PERSISTENCE_ERROR');
  assert.equal(result.error.operation, 'boundary-test');
  assert.equal(typeof result.error.message, 'string');
  assert.ok(result.error.message.length > 0);
});
