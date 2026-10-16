'use strict';

// #3492 (R37): search-time recency ranking is default-off, deterministic, and
// read-only. The factor is a closed-form half-life decay over the record's own
// createdAt, measured against one caller-supplied reference instant. These
// tests pin the leaf, the engine wiring and both store backends, including the
// negative case (an unusable timestamp is unresolved, not ancient).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, test } = require('node:test');

const MemoryStore = require('../lib/memory-store');
const { runQuery } = require('../lib/memory-query-engine');
const {
  DEFAULT_HALF_LIFE_DAYS,
  normalizeRecencyOptions,
  rankByRecency,
  recencyFactor,
} = require('../lib/memory-recency-decay');

const CURRENT_POLICY = '0.8.0';
const DAY = 24 * 60 * 60 * 1000;

function record(memoryId, createdAt, overrides = {}) {
  return {
    memoryId,
    workspaceId: 'default',
    kind: 'memory-record',
    content: `note ${memoryId}`,
    createdAt,
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

describe('memory recency: the decay leaf is a pure, deterministic function', () => {
  test('normalizeRecencyOptions resolves one reference instant and a default half-life', () => {
    const resolved = normalizeRecencyOptions({ asOf: '2026-02-01T00:00:00.000Z' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.halfLifeDays, DEFAULT_HALF_LIFE_DAYS);
    assert.equal(resolved.asOf, Date.parse('2026-02-01T00:00:00.000Z'));
    assert.equal(normalizeRecencyOptions().ok, true, 'an absent asOf means now, not a refusal');
  });

  test('normalizeRecencyOptions accepts a Date and refuses a malformed instant or half-life', () => {
    const date = new Date('2026-02-01T00:00:00.000Z');
    assert.equal(normalizeRecencyOptions({ asOf: date }).asOf, date.getTime());
    assert.match(normalizeRecencyOptions({ asOf: 'not-a-date' }).message, /ISO timestamp/);
    assert.match(normalizeRecencyOptions({ halfLifeDays: 0 }).message, /halfLifeDays/);
    assert.match(normalizeRecencyOptions({ halfLifeDays: 100000 }).message, /halfLifeDays/);
    assert.match(normalizeRecencyOptions({ halfLifeDays: 'abc' }).message, /halfLifeDays/);
    assert.match(normalizeRecencyOptions([]).message, /recency must be an object/);
  });

  test('the factor halves each half-life and never exceeds 1', () => {
    const resolved = normalizeRecencyOptions({ halfLifeDays: 10, asOf: '2026-01-11T00:00:00.000Z' });
    assert.equal(recencyFactor(record('m-now', '2026-01-11T00:00:00.000Z'), resolved), 1);
    assert.equal(recencyFactor(record('m-half', '2026-01-01T00:00:00.000Z'), resolved), 0.5);
    assert.equal(recencyFactor(record('m-two', '2025-12-22T00:00:00.000Z'), resolved), 0.25);
    // A future timestamp is age 0, never a boost above 1.
    assert.equal(recencyFactor(record('m-future', '2026-06-01T00:00:00.000Z'), resolved), 1);
  });

  test('the factor is a deterministic decimal, identical across runs', () => {
    const resolved = normalizeRecencyOptions({ halfLifeDays: 7, asOf: '2026-03-01T00:00:00.000Z' });
    const rec = record('m-1', '2026-02-20T00:00:00.000Z');
    const first = recencyFactor(rec, resolved);
    assert.equal(recencyFactor(rec, resolved), first);
    assert.match(String(first), /^\d+(\.\d+)?$/);
  });

  test('an absent or unparseable createdAt is unresolved (null), not ancient', () => {
    const resolved = normalizeRecencyOptions({ asOf: '2026-03-01T00:00:00.000Z' });
    assert.equal(recencyFactor(record('m-1', undefined), resolved), null);
    assert.equal(recencyFactor(record('m-1', ''), resolved), null);
    assert.equal(recencyFactor(record('m-1', 'yesterday-ish'), resolved), null);
    assert.equal(recencyFactor(record('m-1', 12345), resolved), null);
  });

  test('rankByRecency orders newest-first, unresolved last, ties by memoryId', () => {
    const resolved = normalizeRecencyOptions({ halfLifeDays: 30, asOf: '2026-03-01T00:00:00.000Z' });
    const ranked = rankByRecency([
      record('m-old', '2026-01-01T00:00:00.000Z'),
      record('m-unresolved', undefined),
      record('m-new', '2026-02-28T00:00:00.000Z'),
      record('m-tie-b', '2026-02-01T00:00:00.000Z'),
      record('m-tie-a', '2026-02-01T00:00:00.000Z'),
    ], resolved);
    assert.deepEqual(ranked.map((hit) => hit.record.memoryId), ['m-new', 'm-tie-a', 'm-tie-b', 'm-old', 'm-unresolved']);
    assert.equal(ranked[ranked.length - 1].recency, null);
  });
});

describe('memory recency: retrievalMode recency is opt-in and read-only', () => {
  const RECORDS = [
    record('m-old', '2025-01-01T00:00:00.000Z'),
    record('m-mid', '2025-06-01T00:00:00.000Z'),
    record('m-new', '2026-01-01T00:00:00.000Z'),
    record('m-gone', '2026-01-02T00:00:00.000Z', { status: 'tombstoned' }),
    record('m-other', '2026-01-03T00:00:00.000Z', { workspaceId: 'other' }),
  ];
  // `opts` are top-level query options; a nested `recency` merges over the
  // pinned reference instant, so a test can vary the half-life alone.
  const recency = (opts = {}) => {
    const { recency: recencyOpts, ...rest } = opts;
    return runQuery(contextWith(RECORDS), {
      retrievalMode: 'recency',
      ...rest,
      recency: { asOf: '2026-01-01T00:00:00.000Z', ...(recencyOpts || {}) },
    });
  };

  test('the default substring path is untouched and carries no recency field', () => {
    const result = runQuery(contextWith(RECORDS), { text: 'note' });
    assert.deepEqual(Object.keys(result).sort(), ['limit', 'memories', 'offset', 'ok', 'total']);
    assert.equal(result.recency, undefined);
  });

  test('ranks newest-first and reports the resolved instant and per-record factor', () => {
    const result = recency();
    assert.equal(result.ok, true);
    assert.deepEqual(result.memories.map((m) => m.memoryId), ['m-new', 'm-mid', 'm-old']);
    assert.equal(result.recency.mode, 'recency');
    assert.equal(result.recency.halfLifeDays, DEFAULT_HALF_LIFE_DAYS);
    assert.equal(result.recency.asOf, '2026-01-01T00:00:00.000Z');
    assert.deepEqual(result.recency.scores.map((s) => s.memoryId), ['m-new', 'm-mid', 'm-old']);
    assert.equal(result.recency.scores[0].recency, 1);
  });

  test('keeps the workspace boundary and the active filter', () => {
    const ids = recency().memories.map((m) => m.memoryId);
    assert.equal(ids.includes('m-gone'), false);
    assert.equal(ids.includes('m-other'), false);
    assert.deepEqual(recency({ workspaceId: 'other' }).memories.map((m) => m.memoryId), ['m-other']);
  });

  test('does not mutate a record and paginates by rank', () => {
    const context = contextWith(RECORDS);
    const before = JSON.stringify(context.memories.get('default:m-new'));
    const page = runQuery(context, { retrievalMode: 'recency', asOf: '2026-01-01T00:00:00.000Z', limit: 1, offset: 1 });
    assert.equal(page.total, 3);
    assert.deepEqual(page.memories.map((m) => m.memoryId), ['m-mid']);
    assert.equal(JSON.stringify(context.memories.get('default:m-new')), before);
  });

  test('recency options are refused on any other mode, and orderBy is refused on recency', () => {
    const onSubstring = runQuery(contextWith(RECORDS), { text: 'note', recency: { halfLifeDays: 5 } });
    assert.equal(onSubstring.ok, false);
    assert.match(onSubstring.error.message, /recency options require retrievalMode recency/);
    const ordered = recency({ orderBy: 'createdAt' });
    assert.equal(ordered.ok, false);
    assert.match(ordered.error.message, /omit orderBy and order/);
    const badHalfLife = recency({ recency: { halfLifeDays: 0 } });
    assert.equal(badHalfLife.ok, false);
    assert.match(badHalfLife.error.message, /halfLifeDays/);
  });

  test('a malformed asOf is a fail-closed refusal, not a silent fallback', () => {
    const result = recency({ recency: { asOf: 'whenever' } });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'VALIDATION_ERROR');
    assert.match(result.error.message, /asOf must be an ISO timestamp/);
  });
});

describe('memory recency: both store backends agree', () => {
  for (const useSQLite of [false, true]) {
    test(`ranks newest-first on the ${useSQLite ? 'SQLite' : 'in-memory'} store`, (t) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-recency-'));
      const store = new MemoryStore(useSQLite ? { useSQLite: true, dbPath: path.join(dir, 'memory.db') } : { useSQLite: false });
      t.after(() => {
        store.close();
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* Windows file lock */ }
      });
      for (const content of ['oldest note', 'middle note', 'newest note']) {
        assert.equal(store.store({ content, workspaceId: 'ws-r' }).ok, true);
      }
      const result = store.query({ workspaceId: 'ws-r', retrievalMode: 'recency', recency: { asOf: new Date(Date.now() + DAY).toISOString() } });
      assert.equal(result.ok, true);
      assert.equal(result.recency.mode, 'recency');
      assert.equal(result.total, 3);
      // Written through the store's own path, all three records land within a
      // millisecond of each other, so the contract to pin is the order rule
      // itself: the factor never increases down the page, and an equal factor
      // falls back to the memoryId tie-break. The factor is rounded to a fixed
      // decimal, so two records a millisecond apart are deliberately equal.
      const scores = result.recency.scores;
      assert.deepEqual(scores.map((s) => s.memoryId), result.memories.map((m) => m.memoryId));
      for (let i = 1; i < scores.length; i += 1) {
        const previous = scores[i - 1];
        const current = scores[i];
        assert.ok(current.recency <= previous.recency, 'the factor never increases down the page');
        if (current.recency === previous.recency) {
          assert.ok(previous.memoryId.localeCompare(current.memoryId) < 0, 'equal factors break by memoryId');
        }
      }
      assert.ok(scores.every((s) => s.recency > 0 && s.recency <= 1));
    });
  }
});
