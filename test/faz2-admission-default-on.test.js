'use strict';
const { isolatedKernelOptions, isolatedGraphOptions } = require('./helpers/isolated-persistence');

const test = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');

function makeKernel() {
  return new Kernel(isolatedKernelOptions('faz2-admission-default-on', { noLoad: true, useSQLite: false, loadPlugins: false }));
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

test('kernel.learn explicit bypass requires the internal token, not just opts fields', () => {
  const kernel = makeKernel();
  const result = kernel.learn('balik yüzer', {
    workspaceId: 'default',
    ...Kernel.createAdmissionBypassOpts('test_fixture_seed'),
  });

  assert.equal(result.ok, true);
  assert.ok(result.data.learned > 0);
  assert.equal(result.data.admission, null);
  assert.ok(kernel.graph.getEdges('balik', 'default').length > 0);
});

// #357: the bypass used to be gated purely on
// `opts.admissionRequired === false` plus a non-empty
// `opts.admissionBypassReason` string -- both plain, string-keyed opts
// fields that ANY caller could produce, including one spreading decoded
// JSON from an untrusted source straight into opts. This is the
// regression test for that closure: the exact old-style literal, with a
// non-empty reason and everything, must NOT bypass admission anymore.
test('the old string-keyed bypass shape (admissionRequired:false + a reason) no longer bypasses admission (#357)', () => {
  const kernel = makeKernel();
  const result = kernel.learn('kus ucar', {
    workspaceId: 'default',
    admissionRequired: false,
    admissionBypassReason: 'test_fixture_seed',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.learned, 0);
  assert.equal(result.data.admission.outcome, 'review');
  assert.deepEqual(Object.keys(kernel.graph.getNodes('default')), []);
});

test('a JSON round-trip of a valid bypass opts object loses its authority (#357)', () => {
  // The Symbol-keyed token cannot survive JSON.stringify/JSON.parse, so an
  // opts object that arrived over any JSON wire (HTTP body, MCP tool args)
  // can never carry a genuine bypass, no matter how faithfully the sender
  // copied a previously-seen bypass object's shape.
  const kernel = makeKernel();
  const genuine = Kernel.createAdmissionBypassOpts('test_fixture_seed');
  const roundTripped = JSON.parse(JSON.stringify(genuine));

  assert.deepEqual(roundTripped, { admissionBypassReason: 'test_fixture_seed' });

  const result = kernel.learn('deniz mavidir', { workspaceId: 'default', ...roundTripped });

  assert.equal(result.ok, true);
  assert.equal(result.data.learned, 0);
  assert.equal(result.data.admission.outcome, 'review');
});

test('createAdmissionBypassOpts rejects a missing or empty reason', () => {
  assert.throws(() => Kernel.createAdmissionBypassOpts(''), TypeError);
  assert.throws(() => Kernel.createAdmissionBypassOpts('   '), TypeError);
  assert.throws(() => Kernel.createAdmissionBypassOpts(undefined), TypeError);
  assert.throws(() => Kernel.createAdmissionBypassOpts(null), TypeError);
});
