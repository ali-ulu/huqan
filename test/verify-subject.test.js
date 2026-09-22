'use strict';

// #2140: subject/predicate segmentation and contradiction-evidence shaping
// moved from VerifyService to lib/verify-subject.js and
// lib/verify-contradiction-evidence.js. The existing suite did not catch a
// reversed longest-match sort or a changed default relation, so this pins
// the moved behaviour directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { extractSubjectAndPredicate } = require('../lib/verify-subject');
const { buildContradictionEvidence } = require('../lib/verify-contradiction-evidence');

function stubKernel(nodes = {}) {
  return {
    graph: {
      getNodes: () => nodes,
    },
    normalizeWord: (word) => String(word || '').toLowerCase(),
  };
}

test('#2140: longest node-name match wins over a shorter prefix', () => {
  const kernel = stubKernel({
    a: { id: 'frankfurt' },
    b: { id: 'frankfurt havaalanı' },
  });
  const res = extractSubjectAndPredicate(kernel, 'frankfurt havaalanı büyüktür', 'default', null);
  assert.equal(res.subject, 'frankfurt havaalanı');
  // Matched through the lookup form, so the predicate comes sliced from the
  // normalized statement (verbatim moved behaviour, not a new decision).
  assert.equal(res.predicate, 'buyuktur');
  assert.equal(res.matchedSubject, true);
});

test('#2140: unknown subject falls back to first token, unmatched', () => {
  const kernel = stubKernel({ a: { id: 'ankara' } });
  const res = extractSubjectAndPredicate(kernel, 'zxyq bilinmeyen bir şeydir', 'default', null);
  assert.equal(res.subject, 'zxyq');
  assert.equal(res.matchedSubject, false);
});

test('#2140: explicit parts feed the fallback path', () => {
  const kernel = stubKernel({});
  const res = extractSubjectAndPredicate(kernel, 'kedi uyur', 'default', ['kedi', 'uyur']);
  assert.equal(res.subject, 'kedi');
  assert.equal(res.predicate, 'uyur');
  assert.equal(res.matchedSubject, false);
});

test('#2140: contradiction evidence defaults the relation and clamps confidence', () => {
  const host = { edgeRef: (edge) => ({ ref: edge.id || 'e' }) };
  const shaped = buildContradictionEvidence(host, {
    node: 'n1',
    targets: ['n2'],
    edges: [{ id: 'e1' }],
    confidence: 99,
  });
  assert.equal(shaped.kind, 'contradiction');
  assert.deepEqual(shaped.edges, [{ ref: 'e1' }]);
  assert.equal(shaped.confidence, 1);
  const fallback = buildContradictionEvidence(host, { node: 'n1', targets: ['n2'] });
  assert.deepEqual(fallback.edges, [{ from: 'n1', to: 'n2', relation: 'tür' }]);
  assert.equal(fallback.confidence, 0.7);
});

test('#2140: verify.js keeps thin delegations for the moved methods', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'verify.js'), 'utf8');
  assert.ok(source.includes('require("./verify-subject")'), 'verify requires the subject module');
  assert.match(source, /_extractSubjectAndPredicate\(statement, workspaceId, parts = null\) \{\s*return extractSubjectAndPredicate\(this\.kernel, statement, workspaceId, parts\);\s*\}/);
  assert.match(source, /contradictionEvidence\(contradiction\) \{\s*return buildContradictionEvidence\(this\.host, contradiction\);\s*\}/);
  assert.ok(!source.includes('matchedSubject: true,\n        };'), 'segmentation body moved out');
});
