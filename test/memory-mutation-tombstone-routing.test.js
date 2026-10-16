'use strict';

/**
 * A tombstone is a reversible soft delete and must reach the graph branch.
 *
 * normalizeEntry derived `deleted` from `raw.tombstoned`, and the classifier
 * checks isDestructiveDelete (`entry.deleted || ...`) before hasGraphMutation.
 * So every tombstone was routed into the hard-delete branch and blocked
 * unconditionally, with CANONICAL_GRAPH_MUTATION_BLOCKED as its reason -- and
 * hasGraphMutation's own `entry.tombstoned` check could never fire, which made
 * it dead code.
 *
 * This is over-blocking, not a bypass, but the classification contradicted the
 * code's own intent: the review / dry-run-only path exists for exactly this.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MEMORY_MUTATION_GATE_DECISIONS,
  MEMORY_MUTATION_GATE_REASONS,
  classifyMemoryMutation,
  normalizeMemoryMutationInput,
} = require('../lib/memory-mutation-gate');

function classify(entry, context = {}) {
  return classifyMemoryMutation({ id: 'mem_001', scope: 'default', ...entry }, { targetSpace: 'default', ...context });
}

test('a tombstone is reviewed as a graph mutation, not blocked as a delete', () => {
  for (const entry of [{ tombstoned: true }, { tombstone: true }, { action: 'tombstone' }]) {
    const result = classify(entry);

    assert.equal(result.category, 'graph', `${JSON.stringify(entry)} should reach the graph branch`);
    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.REVIEW);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.GRAPH_MUTATION_REQUIRES_REVIEW);
  }
});

test('the tombstoned flag no longer sets deleted', () => {
  const normalized = normalizeMemoryMutationInput({ entries: [{ id: 'mem_001', tombstoned: true }] });
  const [entry] = normalized.entries;

  assert.equal(entry.tombstoned, true);
  assert.equal(entry.deleted, false, 'a soft delete is not a hard delete');
});

test('a real delete is still blocked', () => {
  for (const entry of [{ deleted: true }, { deletedAt: '2026-01-01T00:00:00.000Z' }, { action: 'purge' }]) {
    const result = classify(entry);

    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.BLOCK, `${JSON.stringify(entry)} must stay blocked`);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.CANONICAL_GRAPH_MUTATION_BLOCKED);
  }
});

test('a tombstone that is also an explicit delete is still blocked', () => {
  const result = classify({ tombstoned: true, deleted: true });

  assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.BLOCK);
});

test('a broad tombstone batch is dry-run-only rather than blocked', () => {
  const result = classify({ tombstoned: true }, { mutationMetadata: { linkCount: 5 } });

  assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY);
  assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.GRAPH_MUTATION_REQUIRES_REVIEW);
});
