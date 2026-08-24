'use strict';

/**
 * `learned` must count edges that were actually written.
 *
 * The normal learn branch incremented it unconditionally while the `değil` and
 * `tür`-conflict branches guarded it with `if (edge)`. When graph.addEdge
 * returned null the count still went up, so `skipped` came out short,
 * graph.save() and the auto-maintain pass ran for a write that never happened,
 * and response-builders reported a canonicalWrite off `learned > 0`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { runLearnUseCase } = require('../lib/learn-use-case');

const DEPENDENCIES = {
  normalizeWorkspaceId: (value) => (typeof value === 'string' && value.trim() ? value.trim() : 'default'),
  ProvenanceError: class ProvenanceError extends Error {},
};

/**
 * A kernel stub exposing only what the normal learn branch touches.
 *
 * @param {{addEdgeReturns: (from: string, to: string) => object|null}} options
 */
function makeKernel({ addEdgeReturns }) {
  const calls = { save: 0, autoMaintain: 0, audit: [] };
  return {
    calls,
    plugins: { emit: () => {} },
    extractFacts: () => [
      { subject: 'kedi', predicate: 'hayvandır' },
      { subject: 'köpek', predicate: 'hayvandır' },
    ],
    isStopWord: () => false,
    graph: {
      getNodes: () => [],
      getEdges: () => [],
      addNode: () => {},
      addTag: () => {},
      addEdge: (from, to) => addEdgeReturns(from, to),
      save: () => { calls.save += 1; },
    },
    _ok: (_operation, data, evidence = []) => ({ ok: true, data, evidence }),
    _resolveLearnMetadata: () => ({}),
    _parsePredicate: () => ({ object: 'hayvan', relation: 'tür' }),
    _learnEdgeOptions: () => ({}),
    _crossLink: () => {},
    _edgeEvidence: (edge) => ({ edge: `${edge.from}|${edge.to}` }),
    _appendAuditEvent: (event) => { calls.audit.push(event.eventType); },
    _evaluateLearnAdmission: () => ({ outcome: 'allow' }),
    _admissionReceiptDetails: () => ({}),
    _autoMaintain: () => { calls.autoMaintain += 1; },
  };
}

function learn(kernel) {
  return runLearnUseCase(kernel, 'kedi hayvandır. köpek hayvandır.', {}, DEPENDENCIES);
}

test('a null addEdge does not count as learned', () => {
  const kernel = makeKernel({ addEdgeReturns: () => null });

  const result = learn(kernel);

  assert.equal(result.data.learned, 0, 'no edge was written, so nothing was learned');
  assert.equal(result.data.skipped, 2, 'both parsed facts were skipped');
});

test('a null addEdge does not trigger the save or the auto-maintain pass', () => {
  const kernel = makeKernel({ addEdgeReturns: () => null });

  learn(kernel);

  assert.equal(kernel.calls.save, 0, 'nothing was written, so nothing needs saving');
  assert.equal(kernel.calls.autoMaintain, 0);
  assert.deepEqual(kernel.calls.audit, [], 'no LEARN audit event for an edge that does not exist');
});

test('written edges are still counted and audited', () => {
  const kernel = makeKernel({ addEdgeReturns: (from, to) => ({ from, to, relation: 'tür' }) });

  const result = learn(kernel);

  assert.equal(result.data.learned, 2);
  assert.equal(result.data.skipped, 0);
  assert.equal(kernel.calls.save, 1);
  assert.deepEqual(kernel.calls.audit, ['LEARN', 'LEARN']);
  assert.equal(result.evidence.length, 2);
});

test('a partially written batch counts only what was written', () => {
  const kernel = makeKernel({ addEdgeReturns: (from) => (from === 'kedi' ? { from, to: 'hayvan', relation: 'tür' } : null) });

  const result = learn(kernel);

  assert.equal(result.data.learned, 1);
  assert.equal(result.data.skipped, 1);
  assert.deepEqual(kernel.calls.audit, ['LEARN']);
});
