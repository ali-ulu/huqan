const test = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');

function makeKernel() {
  return new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
}

test('kernel.learn with admissionRequired reviews direct write without approved context', () => {
  const kernel = makeKernel();
  const result = kernel.learn('kedi hayvandir', {
    workspaceId: 'default',
    admissionRequired: true,
    approvalRequired: true,
    sourceType: 'upload',
    sourceRef: 'test:kernel-admission',
    actor: 'kernel-test',
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.learned, 0);
  assert.equal(result.data.admission.outcome, 'review');
  assert.deepEqual(Object.keys(kernel.graph.getNodes('default')), []);
});

test('kernel.learn with approved admission context writes canonical graph state', () => {
  const kernel = makeKernel();
  const result = kernel.learn('kedi hayvandir', {
    workspaceId: 'default',
    admissionRequired: true,
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: 'apr_kernel_test_001',
    provenance: {
      provenanceId: 'prov-kernel-test-001',
      sourceType: 'manual',
      sourceRef: 'test:kernel-admission',
      actor: 'kernel-test',
      workspaceId: 'default',
      timestamp: '2026-06-16T00:00:00.000Z',
      trustPolicyVersion: '1.0.0',
    },
  });

  assert.equal(result.ok, true);
  assert.ok(result.data.learned > 0);
  assert.equal(result.data.admission.outcome, 'allow');
  assert.ok(kernel.graph.getEdges('kedi', 'default').length > 0);
});

test('kernel.learnFromLLM does not auto-write canonical graph without approved admission', () => {
  const kernel = makeKernel();
  const result = kernel.learnFromLLM('kedi hayvandir.');

  assert.equal(result.learned, 0);
  assert.ok(result.skipped >= 1);
  assert.deepEqual(Object.keys(kernel.graph.getNodes('default')), []);
});
