const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { runCrossLink } = require('../lib/kernel-cross-link');

const kernelSource = fs.readFileSync(path.join(__dirname, '..', 'kernel.js'), 'utf8').replace(/\r\n/g, '\n');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'kernel-cross-link.js'), 'utf8').replace(/\r\n/g, '\n');

test('Kernel._crossLink is a one-line, cycle-free delegation (#2127)', () => {
  assert.match(
    kernelSource,
    /_crossLink\(subject, object, relation, workspaceId = 'default', context = \{\}\) \{\n    return runCrossLink\(\{ graph: this\.graph, appendAuditEvent: \(\.\.\.args\) => this\._appendAuditEvent\(\.\.\.args\), admissionReceiptDetails: admission => this\._admissionReceiptDetails\(admission\), commitBackgroundEdge: \(\.\.\.args\) => this\._commitBackgroundEdge\(\.\.\.args\) \}, subject, object, relation, workspaceId, context\);\n  \}/,
  );
  assert.doesNotMatch(delegateSource, /require\(['"].*kernel/);
  assert.doesNotMatch(delegateSource, /\bthis\./);
  assert.doesNotMatch(delegateSource, /\._(nodes|edges|db|stmts)/);
  assert.deepEqual(Object.keys(require('../lib/kernel-cross-link')), ['runCrossLink']);
});

function stubGraph(nodes) {
  const edges = [];
  return {
    edges,
    getNode: id => (Object.prototype.hasOwnProperty.call(nodes, id) ? nodes[id] : null),
    getEdge: (from, to, relation) => edges.find(e => e.from === from && e.to === to && e.relation === relation) || null,
    addEdge: (from, to, relation, edgeOptions) => {
      const edge = { from, to, relation, ...edgeOptions };
      edges.push(edge);
      return edge;
    },
  };
}

test('cross-link parent-allowed path writes benzer edge with parent provenance and audit', () => {
  const graph = stubGraph({
    kedi: { id: 'kedi', vector: { hayvan: 1 } },
    sut: { id: 'sut', vector: { hayvan: 1 } },
    hayvan: { id: 'hayvan', vector: {} },
  });
  const audits = [];
  const provenance = { provenanceId: 'p1', actor: 'tester' };
  const admission = { outcome: 'allow', reason: 'test' };

  const result = runCrossLink(
    {
      graph,
      appendAuditEvent: (event, prov, workspaceId) => {
        audits.push({ event, prov, workspaceId });
        return { auditId: 'a1' };
      },
      admissionReceiptDetails: () => ({ receipt: 'r1' }),
      commitBackgroundEdge: () => { throw new Error('parent-allowed path must not touch the background gate'); },
    },
    'kedi',
    'sut',
    'tur',
    'default',
    { parentAdmissionAllowed: true, parentProvenance: provenance, parentAdmission: admission, derivedSource: 'learn' },
  );

  assert.deepEqual(result, { written: 1, audits: 1, skipped: 0 });
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].relation, 'benzer');
  assert.equal(graph.edges[0].provenance, provenance);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].event.eventType, 'LEARN');
  assert.equal(audits[0].event.targetType, 'derived_edge');
  assert.equal(audits[0].workspaceId, 'default');
});

test('cross-link returns zero counts when either endpoint node is missing', () => {
  const graph = stubGraph({ kedi: { id: 'kedi', vector: {} } });
  let gateCalls = 0;
  const result = runCrossLink(
    {
      graph,
      appendAuditEvent: () => ({ auditId: 'a1' }),
      admissionReceiptDetails: () => ({}),
      commitBackgroundEdge: () => { gateCalls += 1; return {}; },
    },
    'kedi',
    'yok',
    'tur',
  );
  assert.deepEqual(result, { written: 0, audits: 0, skipped: 0 });
  assert.equal(gateCalls, 0);
});

test('cross-link background path routes through the admission gate per shared tag', () => {
  const graph = stubGraph({
    kedi: { id: 'kedi', vector: { hayvan: 1 } },
    sut: { id: 'sut', vector: { hayvan: 1 } },
    hayvan: { id: 'hayvan', vector: {} },
  });
  const gateCalls = [];
  const result = runCrossLink(
    {
      graph,
      appendAuditEvent: () => { throw new Error('background path audits via the gate result'); },
      admissionReceiptDetails: () => ({}),
      commitBackgroundEdge: (from, to, relation, source, opts) => {
        gateCalls.push([from, to, relation, source, opts]);
        return { decision: 'review', edge: null, audit: { auditId: 'a9' } };
      },
    },
    'kedi',
    'sut',
    'tur',
    'default',
    {},
  );

  assert.deepEqual(result, { written: 0, audits: 1, skipped: 1 });
  assert.equal(gateCalls.length, 1);
  assert.deepEqual(gateCalls[0], [
    'kedi',
    'sut',
    'benzer',
    '_crossLink',
    { workspaceId: 'default', edgeOptions: { source: 'cross-link' }, provenanceExtra: { derivation: 'cross_link', via: 'hayvan' } },
  ]);
});
