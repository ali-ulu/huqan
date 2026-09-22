'use strict';

// #2138: pure evidence-shaping helpers moved from kernel.v2.js to
// lib/kernel-v2-evidence.js. Pins the moved behaviour directly:
// normalization (incl. the #1167 kültür/kül guard), confidence clamps,
// reasoning-path shape, and the four-item summary cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  normalizeCopulaTail,
  normalizePredicateToken,
  toPathEvidence,
  aggregatePathConfidence,
  buildReasoningPath,
  summarizeEvidence,
} = require('../lib/kernel-v2-evidence');

test('#2138: copula tail strips without collapsing distinct words (#1167)', () => {
  assert.equal(normalizeCopulaTail('kitaptır'), 'kitap');
  assert.equal(normalizeCopulaTail('kitap'), 'kitap');
  assert.notEqual(normalizePredicateToken('kültür'), normalizePredicateToken('kül'));
});

test('#2138: path evidence clamps confidence into [0.4, 0.9]', () => {
  const [low, high, mid] = toPathEvidence([
    { from: 'a', to: 'b', relation: 'r', weight: 0.05 },
    { from: 'a', to: 'c', relation: 'r', weight: 0.99 },
    { from: 'a', to: 'd', relation: 'r', weight: 0.6 },
  ]);
  assert.equal(low.confidence, 0.4);
  assert.equal(high.confidence, 0.9);
  assert.equal(mid.confidence, 0.6);
  assert.equal(low.kind, 'path');
  assert.deepEqual(low.nodes, ['a', 'b']);
});

test('#2138: aggregate confidence averages then clamps, empty is 0.5', () => {
  assert.equal(aggregatePathConfidence([]), 0.5);
  assert.equal(aggregatePathConfidence(null), 0.5);
  assert.equal(aggregatePathConfidence([{ weight: 0.6 }, { weight: 0.8 }]), 0.7);
  assert.equal(aggregatePathConfidence([{ weight: 0 }, { weight: 0 }]), 0.5);
});

test('#2138: reasoning path keeps from/relation/to triples', () => {
  assert.deepEqual(
    buildReasoningPath([{ from: 'a', to: 'b', relation: 'r', weight: 1 }]),
    [{ from: 'a', relation: 'r', to: 'b' }],
  );
});

test('#2138: summary dedupes, caps at four, falls back to the path', () => {
  const dupes = summarizeEvidence([{ text: 'x' }, { text: 'x' }, {}, { text: 'y' }], []);
  assert.deepEqual(dupes, ['x', 'y']);
  const many = summarizeEvidence([{ text: '1' }, { text: '2' }, { text: '3' }, { text: '4' }, { text: '5' }], []);
  assert.equal(many.length, 4);
  const fallback = summarizeEvidence([], [{ from: 'a', relation: 'r', to: 'b' }]);
  assert.deepEqual(fallback, ['a --[r]--> b']);
  assert.deepEqual(summarizeEvidence([], []), []);
});

test('#2138: kernel.v2.js delegates, keeps the public token method', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'kernel.v2.js'), 'utf8');
  assert.ok(source.includes("require('./lib/kernel-v2-evidence')"), 'kernel requires the evidence module');
  assert.ok(!source.includes("require('./lib/turkish-copula')"), 'copula require moved out with its use');
  assert.match(source, /normalizePredicateToken\(predicate\) \{\s*return evidenceNormalizePredicateToken\(predicate\);\s*\}/);
  for (const gone of ['_normalizeCopulaTail(', '_toPathEvidence(', '_aggregatePathConfidence(', '_buildReasoningPath(', '_summarizeEvidence(']) {
    assert.ok(!source.includes(gone), `moved helper gone from kernel.v2.js (${gone})`);
  }
});
