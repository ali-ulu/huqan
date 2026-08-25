'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const STORE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-store.js');
const DELEGATE_SOURCE = path.join(__dirname, '..', 'lib', 'memory-event-read.js');
const storeSource = fs.readFileSync(STORE_SOURCE, 'utf8');
const delegateSource = fs.readFileSync(DELEGATE_SOURCE, 'utf8');
const delegateCode = delegateSource
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n');

test('MS: event-read methods are delegated to lib/memory-event-read.js', () => {
  assert.ok(
    storeSource.includes("const { runEventsForMemory, runTimeline, runGetEvents } = require('./memory-event-read');"),
    'lib/memory-store.js imports both event-read delegates',
  );

  const eventsMatch = storeSource.match(/eventsForMemory\(memoryId, opts = \{\}\) \{[\s\S]*?\n  \}/);
  assert.ok(eventsMatch, 'eventsForMemory method still exists');
  assert.match(
    eventsMatch[0],
    /eventsForMemory\(memoryId, opts = \{\}\) \{\s*return runEventsForMemory\(this\._eventReadContext\(\), memoryId, opts\);/,
    'eventsForMemory is a one-line delegation',
  );

  const timelineMatch = storeSource.match(/timeline\(opts = \{\}\) \{[\s\S]*?\n  \}/);
  assert.ok(timelineMatch, 'timeline method still exists');
  assert.match(
    timelineMatch[0],
    /timeline\(opts = \{\}\) \{\s*return runTimeline\(this\._eventReadContext\(\), opts\);/,
    'timeline is a one-line delegation',
  );

  const getEventsMatch = storeSource.match(/getEvents\(memoryId, opts = \{\}\) \{[\s\S]*?\n  \}/);
  assert.ok(getEventsMatch, 'getEvents method still exists');
  assert.match(
    getEventsMatch[0],
    /getEvents\(memoryId, opts = \{\}\) \{\s*return runGetEvents\(this\._eventReadContext\(\), memoryId, opts\);/,
    'getEvents is a one-line delegation',
  );

  const contextMatch = storeSource.match(/_eventReadContext\(\) \{[\s\S]*?\n  \}/);
  assert.ok(contextMatch, '_eventReadContext exists');
  assert.match(contextMatch[0], /events: this\._events/);
  assert.match(contextMatch[0], /findMemory:/);
});

test('MS: pinned call sites — event-read delegation remains read-only', () => {
  assert.equal((storeSource.match(/require\('\.\/memory-event-read'\)/g) || []).length, 1, 'delegate require appears once');
  assert.equal((storeSource.match(/runEventsForMemory\(/g) || []).length, 1, 'runEventsForMemory has one call site');
  assert.equal((storeSource.match(/runTimeline\(/g) || []).length, 1, 'runTimeline has one call site');
  assert.equal((storeSource.match(/runGetEvents\(/g) || []).length, 1, 'runGetEvents has one call site');
  assert.equal((storeSource.match(/_eventReadContext\(\)/g) || []).length, 4, 'context factory has one definition plus three call sites');

  assert.equal((delegateCode.match(/this\./g) || []).length, 0, 'delegate has no this/store receiver access');
  assert.ok(!delegateCode.includes("require('./memory-store')"), 'delegate has no cycle back into memory-store');
  for (const banned of ['_db', '_stmts', '_links', '_events', '_withTransaction', '_persistenceError', 'appendEvent', 'persist(']) {
    assert.ok(!delegateCode.includes(banned), `delegate must not touch store internals (${banned})`);
  }

  assert.ok(delegateCode.indexOf('events.sort(sortByEventSignature)') >= 0, 'delegate owns deterministic event sorting');
  assert.ok(delegateCode.indexOf('events: page.map(cloneMemoryEvent)') >= 0, 'delegate clones returned events');
  assert.equal((delegateCode.match(/context\.events\.sort/g) || []).length, 0, 'delegate never sorts the store-owned event array');
});

test('MS: getEvents delegate preserves empty, trimmed, sorted, and cloned results', () => {
  const { runGetEvents } = require('../lib/memory-event-read');
  const events = [
    { memoryId: 'm1', workspaceId: 'default', eventType: 'late', createdAt: '2026-01-02T00:00:00.000Z', details: { n: 2 } },
    { memoryId: 'm2', workspaceId: 'default', eventType: 'other', createdAt: '2026-01-01T00:00:00.000Z' },
    { memoryId: 'm1', workspaceId: 'default', eventType: 'early', createdAt: '2026-01-01T00:00:00.000Z', details: { n: 1 } },
  ];
  const result = runGetEvents({ events }, ' m1 ', { workspaceId: 'default' });

  assert.deepEqual(result.map(event => event.eventType), ['early', 'late']);
  const scoped = runGetEvents({ events: [
    ...events,
    { memoryId: 'm1', workspaceId: 'tenant-a', eventType: 'tenant', createdAt: '2026-01-03T00:00:00.000Z' },
  ] }, ' m1 ', { workspaceId: 'tenant-a' });
  assert.deepEqual(scoped.map(event => event.eventType), ['tenant']);
  assert.notStrictEqual(result[0], events[2]);
  assert.notStrictEqual(result[0].details, events[2].details);
  assert.deepEqual(runGetEvents({ events }, ''), []);
});
