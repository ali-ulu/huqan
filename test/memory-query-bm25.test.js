'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const MemoryStore = require('../lib/memory-store');
const { runQuery } = require('../lib/memory-query-engine');

const CURRENT_POLICY = '0.8.0';

function record(memoryId, content, overrides = {}) {
  return {
    memoryId,
    workspaceId: 'default',
    kind: 'memory-record',
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    trustPolicyVersion: CURRENT_POLICY,
    provenance: { provenanceId: `prov-${memoryId}`, sourceRef: 'doc://x', sourceType: 'document', actor: 'agent-1', confidence: 0.9 },
    ...overrides,
  };
}

function contextWith(records) {
  const memories = new Map();
  for (const rec of records) memories.set(`${rec.workspaceId}:${rec.memoryId}`, rec);
  return { memories, isActiveRecord: (rec) => rec.status === 'active' };
}

const RECORDS = [
  record('m-a', 'The recall gate withholds memories that lack provenance', { createdAt: '2026-01-01T00:00:00.000Z' }),
  record('m-b', 'Degraded recall results stay in the page', { createdAt: '2026-01-02T00:00:00.000Z' }),
  record('m-c', 'Trust receipts chain each approval', { createdAt: '2026-01-03T00:00:00.000Z' }),
  record('m-d', 'Recall gate provenance note, now tombstoned', { status: 'tombstoned' }),
  record('m-e', 'Recall gate provenance in another workspace', { workspaceId: 'other' }),
  record('m-f', { title: 'gate', body: 'provenance recall' }, { kind: 'note' }),
];

const bm25 = (opts) => runQuery(contextWith(RECORDS), { text: 'recall gate provenance', retrievalMode: 'bm25', ...opts });

describe('memory query: retrievalMode bm25 is opt-in', () => {
  test('the default substring path is unchanged and carries no retrieval field', () => {
    const result = runQuery(contextWith(RECORDS), { text: 'recall gate provenance' });
    assert.equal(result.total, 0);
    assert.deepEqual(Object.keys(result).sort(), ['limit', 'memories', 'offset', 'ok', 'total']);
    const explicit = runQuery(contextWith(RECORDS), { text: 'recall gate', retrievalMode: 'substring' });
    assert.deepEqual(explicit.memories.map((m) => m.memoryId), ['m-a']);
    assert.equal(explicit.retrieval, undefined);
  });

  test('bm25 finds multi-word matches the substring path misses, best first', () => {
    const result = bm25();
    assert.equal(result.ok, true);
    assert.deepEqual(result.memories.map((m) => m.memoryId), ['m-f', 'm-a', 'm-b']);
    assert.equal(result.total, 3);
    assert.equal(result.retrieval.mode, 'bm25');
    assert.deepEqual(result.retrieval.scores.map((s) => s.memoryId), ['m-f', 'm-a', 'm-b']);
    const scores = result.retrieval.scores.map((s) => s.score);
    assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
    assert.equal(Object.hasOwn(result.retrieval.scores[0], 'terms'), false);
  });

  test('keeps the workspace boundary, the active filter and other filters', () => {
    const ids = bm25().memories.map((m) => m.memoryId);
    assert.equal(ids.includes('m-d'), false);
    assert.equal(ids.includes('m-e'), false);
    assert.deepEqual(bm25({ kind: 'memory-record' }).memories.map((m) => m.memoryId), ['m-a', 'm-b']);
    assert.deepEqual(bm25({ workspaceId: 'other' }).memories.map((m) => m.memoryId), ['m-e']);
  });

  test('paginates by rank and reports scores for the returned page only', () => {
    const result = bm25({ limit: 1, offset: 1 });
    assert.equal(result.total, 3);
    assert.deepEqual(result.memories.map((m) => m.memoryId), ['m-a']);
    assert.deepEqual(result.retrieval.scores.map((s) => s.memoryId), ['m-a']);
  });

  test('explain adds per-term contributions that sum to the score', () => {
    const top = bm25({ explain: true }).retrieval.scores[1];
    assert.deepEqual(top.terms.map((t) => t.term), ['recall', 'gate', 'provenance']);
    const sum = top.terms.reduce((acc, t) => acc + t.contribution, 0);
    assert.ok(Math.abs(sum - top.score) < 1e-5);
  });

  test('breaks equal scores by memoryId', () => {
    const twins = [record('m-2', 'alpha beta'), record('m-1', 'alpha beta'), record('m-3', 'gamma')];
    const result = runQuery(contextWith(twins), { text: 'alpha', retrievalMode: 'bm25' });
    assert.deepEqual(result.memories.map((m) => m.memoryId), ['m-1', 'm-2']);
  });

  test('ranks only what the recall gate lets through', () => {
    const unprovenanced = record('m-x', 'recall gate provenance exact', { provenance: undefined });
    const result = runQuery(contextWith([...RECORDS, unprovenanced]), {
      text: 'recall gate provenance', retrievalMode: 'bm25', recall: { currentTrustPolicyVersion: CURRENT_POLICY },
    });
    assert.equal(result.memories.some((m) => m.memoryId === 'm-x'), false);
    assert.ok(result.recall.withheld.some((entry) => entry.memoryId === 'm-x'));
    assert.equal(result.retrieval.scores.length, result.memories.length);
  });
});

describe('memory query: retrievalMode validation fails closed', () => {
  for (const [opts, message] of [
    [{ text: 'x', retrievalMode: 'vector' }, /invalid retrievalMode option: vector/],
    [{ retrievalMode: 'bm25' }, /retrievalMode bm25 requires text/],
    [{ text: 'x', retrievalMode: 'bm25', orderBy: 'createdAt' }, /omit orderBy and order/],
    [{ text: 'x', retrievalMode: 'bm25', order: 'desc' }, /omit orderBy and order/],
    [{ text: 'x', explain: true }, /requires retrievalMode bm25/],
    [{ text: 'x', retrievalMode: 'bm25', explain: 'yes' }, /explain must be a boolean/],
  ]) {
    test(`rejects ${JSON.stringify(opts)}`, () => {
      const result = runQuery(contextWith(RECORDS), opts);
      assert.equal(result.ok, false);
      assert.equal(result.error.code, 'VALIDATION_ERROR');
      assert.match(result.error.message, message);
    });
  }
});

describe('memory query: bm25 through MemoryStore', () => {
  for (const useSQLite of [false, true]) {
    test(`ranks the same way on the ${useSQLite ? 'SQLite' : 'in-memory'} store`, (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-bm25-'));
      const store = new MemoryStore(useSQLite ? { useSQLite: true, dbPath: path.join(dir, 'memory.db') } : { useSQLite: false });
      t.after(() => {
        store.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
      });
      // Written through the store's own write path, so the SQLite backend
      // persists them; ids are generated, so the order is checked by content.
      for (const rec of RECORDS.slice(0, 3)) assert.equal(store.store({ content: rec.content, workspaceId: 'default' }).ok, true);
      store.store({ content: RECORDS[4].content, workspaceId: 'other' });
      const result = store.query({ text: 'recall gate provenance', retrievalMode: 'bm25' });
      assert.equal(result.ok, true);
      assert.deepEqual(result.memories.map((m) => m.content), [RECORDS[0].content, RECORDS[1].content]);
      assert.equal(result.retrieval.mode, 'bm25');
    });
  }
});
