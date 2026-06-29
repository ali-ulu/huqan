'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');

function makeKernel() {
  return new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
}

function approvedAdmissionOpts(overrides = {}) {
  return {
    workspaceId: 'default',
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: 'apr_faz2_pr2_001',
    provenance: {
      provenanceId: 'prov-faz2-pr2-001',
      sourceType: 'manual',
      sourceRef: 'test:faz2-pr2',
      actor: 'kernel-test',
      workspaceId: 'default',
      timestamp: '2026-06-29T00:00:00.000Z',
      trustPolicyVersion: '1.0.0',
    },
    ...overrides,
  };
}

test('kernel.learn without admission options defaults to review and does not write graph', () => {
  const kernel = makeKernel();
  const result = kernel.learn('kedi hayvandir');

  assert.equal(result.ok, true);
  assert.equal(result.data.learned, 0);
  assert.equal(result.data.skipped, 1);
  assert.equal(result.data.admission.outcome, 'review');
  assert.equal(result.data.admission.graphWrite, false);
  assert.deepEqual(Object.keys(kernel.graph.getNodes('default')), []);
});

test('kernel.learn with admissionRequired:true keeps approved admission write behavior', () => {
  const kernel = makeKernel();
  const result = kernel.learn('kedi hayvandir', {
    ...approvedAdmissionOpts(),
    admissionRequired: true,
  });

  assert.equal(result.ok, true);
  assert.ok(result.data.learned > 0);
  assert.equal(result.data.admission.outcome, 'allow');
  assert.ok(kernel.graph.getEdge('kedi', 'hayvan', 'tür', 'default'));
});

test('kernel.learn admissionRequired:false without bypass reason does not bypass admission', () => {
  const kernel = makeKernel();
  const result = kernel.learn('kopek hayvandir', {
    workspaceId: 'default',
    admissionRequired: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.learned, 0);
  assert.equal(result.data.admission.outcome, 'review');
  assert.deepEqual(Object.keys(kernel.graph.getNodes('default')), []);
});

test('kernel.learn explicit bypass requires opt-out and reason', () => {
  const kernel = makeKernel();
  const result = kernel.learn('balik yüzer', {
    workspaceId: 'default',
    admissionRequired: false,
    admissionBypassReason: 'test_fixture_seed',
  });

  assert.equal(result.ok, true);
  assert.ok(result.data.learned > 0);
  assert.equal(result.data.admission, null);
  assert.ok(kernel.graph.getEdges('balik', 'default').length > 0);
});
