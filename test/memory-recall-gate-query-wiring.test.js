const assert = require('assert');
const { describe, test } = require('node:test');

const { runQuery } = require('../lib/memory-query-engine');

const CURRENT_POLICY = '0.8.0';

function record(memoryId, overrides = {}) {
  return {
    memoryId,
    workspaceId: 'default',
    kind: 'memory-record',
    content: { title: memoryId },
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    trustPolicyVersion: CURRENT_POLICY,
    provenance: {
      provenanceId: `prov-${memoryId}`,
      sourceRef: 'doc://x',
      sourceType: 'document',
      actor: 'agent-1',
      confidence: 0.9,
    },
    ...overrides,
  };
}

function contextWith(records) {
  const memories = new Map();
  for (const rec of records) memories.set(`${rec.workspaceId}:${rec.memoryId}`, rec);
  return { memories, isActiveRecord: (rec) => rec.status === 'active' };
}

const FRESH = record('mem-fresh');
const STALE = record('mem-stale', { trustPolicyVersion: '0.7.0' });

describe('query engine: recall gate is opt-in', () => {
  test('without opts.recall the response shape is unchanged', () => {
    const result = runQuery(contextWith([FRESH, STALE]), {});
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.total, 2);
    assert.strictEqual(result.recall, undefined);
    assert.deepStrictEqual(Object.keys(result).sort(), ['limit', 'memories', 'offset', 'ok', 'total']);
  });

  test('without opts.recall a stale record is still returned', () => {
    const result = runQuery(contextWith([STALE]), {});
    assert.strictEqual(result.memories.length, 1);
  });
});

describe('query engine: recall gate when enabled', () => {
  test('drops the stale record and reports why', () => {
    const result = runQuery(contextWith([FRESH, STALE]), {
      recall: { currentTrustPolicyVersion: CURRENT_POLICY },
    });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.memories.map((m) => m.memoryId), ['mem-fresh']);
    assert.strictEqual(result.recall.summary.degraded, 1);
    assert.strictEqual(result.recall.degraded[0].memoryId, 'mem-stale');
  });

  test('total counts admitted records, not withheld ones', () => {
    const result = runQuery(contextWith([FRESH, STALE]), {
      recall: { currentTrustPolicyVersion: CURRENT_POLICY },
    });
    assert.strictEqual(result.total, 1);
  });

  test('gating happens before pagination, so a page is never padded with withheld records', () => {
    const many = [STALE, FRESH, record('mem-fresh-2')];
    const result = runQuery(contextWith(many), {
      limit: 2,
      recall: { currentTrustPolicyVersion: CURRENT_POLICY },
    });
    assert.strictEqual(result.memories.length, 2);
    assert.ok(!result.memories.some((m) => m.memoryId === 'mem-stale'));
  });

  test('recall: true enables the gate but makes no staleness claim', () => {
    const result = runQuery(contextWith([STALE]), { recall: true });
    assert.strictEqual(result.memories.length, 1);
    assert.ok(result.recall.warnings.some((w) => w.code === 'POLICY_VERSION_UNKNOWN'));
  });

  test('a bad recall option fails the query closed', () => {
    const result = runQuery(contextWith([FRESH]), { recall: [] });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, 'VALIDATION_ERROR');
  });

  test('an out-of-range confidence floor fails the query closed', () => {
    const result = runQuery(contextWith([FRESH]), { recall: { minConfidence: 5 } });
    assert.strictEqual(result.ok, false);
  });
});
