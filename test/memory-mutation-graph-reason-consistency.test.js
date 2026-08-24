'use strict';

/**
 * A decision and the reason printed next to it must agree.
 *
 * The graph branch of classifyMemoryMutation answers review or dry-run-only --
 * it never blocks -- but it picked its reason with a second, narrower keyword
 * match over the same signal hasGraphMutation had already matched. An entry
 * that qualified only through linksChanged / tombstoned / superseded, or
 * through a GRAPH_ACTION outside that narrower list, came back as
 * `decision: review` with `reason: CANONICAL_GRAPH_MUTATION_BLOCKED`. Anything
 * downstream reading the reason -- audit records, the MCP surface, telemetry --
 * saw a review reported as a block.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MEMORY_MUTATION_GATE_DECISIONS,
  MEMORY_MUTATION_GATE_REASONS,
  classifyMemoryMutation,
} = require('../lib/memory-mutation-gate');

function classify(entry, context = {}) {
  return classifyMemoryMutation({ id: 'mem_001', scope: 'default', ...entry }, { targetSpace: 'default', ...context });
}

// `tombstoned` joined this list in #1257: a tombstone is a reversible soft
// delete, and `deleted` no longer inherits it, so it reaches the graph branch
// instead of the hard-delete one.
const FLAG_ONLY_ENTRIES = [
  { linksChanged: true },
  { superseded: true },
  { tombstoned: true },
];

test('a graph mutation known only by its flags is not reported as blocked', () => {
  for (const entry of FLAG_ONLY_ENTRIES) {
    const result = classify(entry);

    assert.equal(result.category, 'graph', `${JSON.stringify(entry)} should classify as a graph mutation`);
    assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.REVIEW);
    assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.GRAPH_MUTATION_REQUIRES_REVIEW);
  }
});

test('every graph action reports a review reason, not a block reason', () => {
  for (const action of ['link', 'unlink', 'supersede', 'tombstone', 'reference', 'related', 'contradict', 'support', 'edge', 'relation', 'graph']) {
    const result = classify({ action });

    assert.equal(result.category, 'graph', `${action} should classify as a graph mutation`);
    assert.notEqual(
      result.reason,
      MEMORY_MUTATION_GATE_REASONS.CANONICAL_GRAPH_MUTATION_BLOCKED,
      `${action} answers ${result.decision}, so its reason must not read as blocked`,
    );
  }
});

test('a broad graph mutation is dry-run-only and still not reported as blocked', () => {
  const result = classify({ linksChanged: true }, { mutationMetadata: { linkCount: 5 } });

  assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY);
  assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.GRAPH_MUTATION_REQUIRES_REVIEW);
});

test('the destructive delete branch still blocks with the canonical block reason', () => {
  const result = classify({ deleted: true });

  assert.equal(result.decision, MEMORY_MUTATION_GATE_DECISIONS.BLOCK);
  assert.equal(result.reason, MEMORY_MUTATION_GATE_REASONS.CANONICAL_GRAPH_MUTATION_BLOCKED);
});
