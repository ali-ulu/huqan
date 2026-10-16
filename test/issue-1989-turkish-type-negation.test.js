'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');

test('KernelV2 preserves direct evidence for a negated Turkish type fact (#1989)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-1989-'));
  try {
    const kernel = new Kernel({
      noLoad: true,
      loadPlugins: false,
      useSQLite: false,
      memoryPath: path.join(dir, 'memory.json'),
      lang: 'tr',
    });
    kernel._autoMaintain = () => {};
    kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
    kernel._learnCount = 0;
    kernel.graph.addNode('ali', 'ali');
    kernel.graph.addNode('doktor', 'doktor');
    kernel.graph.addEdge('ali', 'doktor', 'tür', { confidence: 0.9, weight: 0.9 });

    const result = new KernelV2({ kernel }).verify('Ali doktor değildir', { workspaceId: 'default' });

    assert.equal(result.data.status, 'contradicted');
    assert.equal(result.data.confidence, 0.9);
    assert.equal(result.data.contradictionReason, 'negated_statement_conflicts_with_known_fact');
    assert.equal(result.evidence.length, 1);
    assert.equal(result.evidence[0].kind, 'direct_edge');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function freshMultiWordKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-1989-multi-'));
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(dir, 'memory.json'),
    lang: 'tr',
  });
  kernel._autoMaintain = () => {};
  kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  kernel._learnCount = 0;
  kernel.graph.addNode('kedi', 'kedi');
  kernel.graph.addNode('hayvan', 'hayvan');
  kernel.graph.addEdge('kedi', 'hayvan', 'tur', { confidence: 0.9, weight: 0.9 });
  return { dir, kernel, v2: new KernelV2({ kernel }) };
}

test('KernelV2 keeps a contradicted v1 verdict for a multi-word negated subject (#1989 guard exemption)', () => {
  const { dir, v2 } = freshMultiWordKernel();
  try {
    const result = v2.verify('kedi vahsi bir hayvan degildir', { workspaceId: 'default' });

    assert.equal(result.data.status, 'contradicted');
    assert.equal(result.data.confidence, 0.9);
    assert.equal(result.evidence.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KernelV2 keeps a contradicted v1 verdict for a multi-word affirmative subject (#1989 guard exemption)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-1989-multi-aff-'));
  try {
    const kernel = new Kernel({
      noLoad: true,
      loadPlugins: false,
      useSQLite: false,
      memoryPath: path.join(dir, 'memory.json'),
      lang: 'tr',
    });
    kernel._autoMaintain = () => {};
    kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
    kernel._learnCount = 0;
    kernel.learn('kedi hayvandir', Kernel.createAdmissionBypassOpts('test_fixture_seed'));
    const v2 = new KernelV2({ kernel });
    const result = v2.verify('kedi vahsi bir bitkidir', { workspaceId: 'default' });

    assert.equal(result.data.status, 'contradicted');
    assert.equal(result.data.confidence, 0.95);
    assert.equal(result.evidence.length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('KernelV2 still returns unknown for a multi-word subject v1 cannot contradict (#1989 guard intact)', () => {
  const { dir, v2 } = freshMultiWordKernel();
  try {
    const result = v2.verify('kedi mavi giyer', { workspaceId: 'default' });

    assert.equal(result.data.status, 'unknown');
    assert.equal((result.evidence || []).length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
