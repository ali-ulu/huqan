'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildFacts,
  buildRules,
  buildSnapshot,
  measureCrossRuleDedup,
  measureCrossSnapshotGrowth,
  measureSize,
} = require('./bench-derivation-record');

test('fixture is deterministic and scales linearly', () => {
  assert.deepEqual(buildFacts(10), buildFacts(10));
  assert.equal(buildFacts(10).length, 21); // 2 facts per index + the shared hub fact
  assert.equal(buildRules().length, 2);
});

test('record cost is measured against a linear, fully-derived fixture', () => {
  const row = measureSize(50);

  // Both rules fire once per index: 50 indices -> 100 candidates, no budget stop.
  assert.equal(row.candidates, 100);
  assert.equal(row.records, 100);
  assert.equal(row.facts, 101);

  // Every record is distinct and every id is a stable hash, so re-deriving the
  // same run collides rather than duplicates.
  assert.equal(row.uniqueIds, row.records);
  assert.equal(row.duplicateIds, 0);
  assert.equal(row.rerunStable, true);

  // A record is ~1.8 KB; guard the order of magnitude, not an exact byte count.
  assert.ok(row.bytesPerRecord > 1000 && row.bytesPerRecord < 4000);
  assert.ok(row.buildMs >= 0);
  assert.ok(row.recordOverEvaluationRatio === null || row.recordOverEvaluationRatio >= 0);
});

test('a fact derivable by two rules is emitted once', () => {
  const dedup = measureCrossRuleDedup();

  assert.equal(dedup.candidates, 1);
  assert.equal(dedup.uniqueFactKeys, 1);
  assert.ok(dedup.duplicateSuppressed >= 1);
});

test('cross-snapshot growth is not deduplicated, and is documented as such', () => {
  const growth = measureCrossSnapshotGrowth(6);

  assert.equal(growth.length, 6);
  // A new snapshot re-issues each derivation, so K distinct derivations become
  // more than K records: this is the measured cost the decision note accepts.
  const last = growth.at(-1);
  assert.ok(last.records > last.facts);
  assert.equal(growth[0].records, 1);
  // Triangular growth for one-new-fact-per-step: records == facts*(facts+1)/2.
  assert.equal(last.records, (last.facts * (last.facts + 1)) / 2);
});

test('snapshot carries the fields the record builder reads', () => {
  const snapshot = buildSnapshot(buildFacts(3));

  assert.ok(typeof snapshot.graphSnapshotId === 'string' && snapshot.graphSnapshotId.length > 0);
  assert.equal(snapshot.details.length, snapshot.facts.length);
  for (const detail of snapshot.details) {
    assert.ok(Array.isArray(detail.provenanceRefs) && Array.isArray(detail.sourceRefs));
  }
});
