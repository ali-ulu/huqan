'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const {
  PARENT_WINDOW_MS,
  WORKSPACE_WINDOW_MS,
  recordSpawnStart,
  readSpawnRates,
} = require('../lib/delegation-rate-counter');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-rate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function memoryGraph(dir) {
  return new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
}

const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const SCOPE = Object.freeze({
  policyVersion: 'policy-v1',
  workspaceId: 'workspace-a',
  parentAgentId: 'parent-1',
});

test('window counts slide with explicit time', (t) => {
  const graph = memoryGraph(tempDir(t));
  recordSpawnStart(graph, { ...SCOPE, at: iso(BASE) });
  recordSpawnStart(graph, { ...SCOPE, at: iso(BASE + 30 * 1000) });
  recordSpawnStart(graph, { ...SCOPE, at: iso(BASE + 61 * 1000) });

  assert.deepEqual(readSpawnRates(graph, { ...SCOPE, at: iso(BASE + 61 * 1000) }), {
    parentStarts60s: 2,
    workspaceStartsHour: 3,
  });
  assert.deepEqual(readSpawnRates(graph, { ...SCOPE, at: iso(BASE + 90 * 1000) }), {
    parentStarts60s: 1,
    workspaceStartsHour: 3,
  });
  assert.deepEqual(PARENT_WINDOW_MS, 60 * 1000);
  assert.deepEqual(WORKSPACE_WINDOW_MS, 60 * 60 * 1000);
});

test('parents and policies are isolated, workspaces aggregate', (t) => {
  const graph = memoryGraph(tempDir(t));
  recordSpawnStart(graph, { ...SCOPE, at: iso(BASE) });
  recordSpawnStart(graph, { ...SCOPE, parentAgentId: 'parent-2', at: iso(BASE) });
  assert.deepEqual(readSpawnRates(graph, { ...SCOPE, at: iso(BASE) }), {
    parentStarts60s: 1,
    workspaceStartsHour: 2,
  });
  assert.deepEqual(readSpawnRates(graph, { ...SCOPE, policyVersion: 'policy-v2', at: iso(BASE) }), {
    parentStarts60s: 0,
    workspaceStartsHour: 0,
  });
  assert.deepEqual(readSpawnRates(graph, { ...SCOPE, workspaceId: 'workspace-b', at: iso(BASE) }), {
    parentStarts60s: 0,
    workspaceStartsHour: 0,
  });
});

test('a write observes its own row in the same call', (t) => {
  const graph = memoryGraph(tempDir(t));
  const first = recordSpawnStart(graph, { ...SCOPE, at: iso(BASE), childId: 'child-1' });
  assert.ok(first.startId.startsWith('start:'));
  assert.deepEqual([first.parentStarts60s, first.workspaceStartsHour], [1, 1]);
  const second = recordSpawnStart(graph, { ...SCOPE, at: iso(BASE + 1000) });
  assert.deepEqual([second.parentStarts60s, second.workspaceStartsHour], [2, 2]);
});

test('future-dated rows never count and state survives reopening', (t) => {
  const dir = tempDir(t);
  const first = memoryGraph(dir);
  recordSpawnStart(first, { ...SCOPE, at: iso(BASE + 3600 * 1000) });
  assert.deepEqual(readSpawnRates(first, { ...SCOPE, at: iso(BASE) }), {
    parentStarts60s: 0,
    workspaceStartsHour: 0,
  });
  const second = memoryGraph(dir);
  assert.deepEqual(readSpawnRates(second, { ...SCOPE, at: iso(BASE + 3600 * 1000) }), {
    parentStarts60s: 1,
    workspaceStartsHour: 1,
  });
});

test('malformed calls fail closed without writing rows', (t) => {
  const graph = memoryGraph(tempDir(t));
  assert.throws(() => recordSpawnStart(null, { ...SCOPE }), /graph/);
  assert.throws(() => recordSpawnStart(graph, { ...SCOPE, parentAgentId: '   ' }), /parentAgentId/);
  assert.throws(() => recordSpawnStart(graph, { ...SCOPE, at: 'not-a-time' }), /valid instant/);
  assert.throws(() => readSpawnRates(graph, { ...SCOPE, workspaceId: '' }), /workspaceId/);
  assert.deepEqual(readSpawnRates(graph, { ...SCOPE, at: iso(BASE) }), {
    parentStarts60s: 0,
    workspaceStartsHour: 0,
  });
});
