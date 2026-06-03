const { describe, it, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-reasoning-trace-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeKernel(name) {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${name}.json`),
    lang: 'en',
  });
  kernel._autoMaintain = () => {};
  kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  kernel._learnCount = 0;
  return kernel;
}

function unwrap(result) {
  return result && typeof result === 'object' && result.data && typeof result.data === 'object'
    ? result.data
    : result;
}

function withMutedConsole(fn) {
  const originalLog = console.log;
  const originalInfo = console.info;
  console.log = () => {};
  console.info = () => {};
  try {
    return fn();
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
  }
}

function seedReactNativeGraph(kernel) {
  kernel.graph.addNode('react native', 'react native', null, { workspaceId: 'default' });
  kernel.graph.addNode('used in production', 'used in production', null, { workspaceId: 'default' });
  kernel.graph.addNode('performant', 'performant', null, { workspaceId: 'default' });
  kernel.graph.addNode('cheap', 'cheap', null, { workspaceId: 'default' });
  kernel.graph.addNode('production ready', 'production ready', null, { workspaceId: 'default' });
  kernel.graph.addNode('according to react native', 'according to react native', null, { workspaceId: 'default' });
  kernel.graph.addEdge('react native', 'used in production', 'is', { workspaceId: 'default', confidence: 0.95 });
  kernel.graph.addEdge('react native', 'performant', 'is', { workspaceId: 'default', confidence: 0.9 });
}

describe('verify reasoning trace integration', () => {
  it('attaches a trace for single claims without breaking existing verify behavior', () => {
    const kernel = makeKernel('single');
    withMutedConsole(() => {
      seedReactNativeGraph(kernel);
    });

    const raw = kernel.verify('React Native is used in production', { workspaceId: 'default' });
    const result = unwrap(raw);

    assert.strictEqual(result.status, 'dogrulandi');
    assert.ok(raw.meta.reasoningTrace);
    assert.strictEqual(raw.meta.reasoningTrace.summary.total, 1);
    assert.strictEqual(raw.meta.trustReceiptPreview.subclaimCount, 1);
    assert.strictEqual(raw.meta.trustReceiptPreview.finalStatus, 'dogrulandi');
  });

  it('builds a reasoning trace for compound claims with supported and contradicted subclaims', () => {
    const kernel = makeKernel('compound-contradiction');
    withMutedConsole(() => {
      seedReactNativeGraph(kernel);
      kernel.graph.addNode('not performant', 'not performant', null, { workspaceId: 'default' });
      kernel.graph.addEdge('react native', 'not performant', 'is', { workspaceId: 'default', confidence: 0.9 });
    });

    const raw = kernel.verify('React Native is used in production and React Native performant değil', { workspaceId: 'default' });
    const result = unwrap(raw);

    assert.ok(['celiski', 'bilinmiyor'].includes(result.status));
    assert.ok(raw.meta.reasoningTrace);
    assert.strictEqual(raw.meta.reasoningTrace.summary.total, 2);
    assert.ok(raw.meta.reasoningTrace.summary.supported >= 1);
    assert.ok(raw.meta.reasoningTrace.steps.some(step => step.type === 'subclaim_verification'));
    assert.ok(raw.meta.trustReceiptPreview.subclaimCount >= 2);
    assert.ok(raw.meta.trustReceiptPreview.downgradeReasons.length >= 0);
  });

  it('keeps compound claims with unknown subclaims as bilinmiyor', () => {
    const kernel = makeKernel('compound-unknown');
    withMutedConsole(() => {
      seedReactNativeGraph(kernel);
    });

    const raw = kernel.verify('React Native is used in production and Vue is performant', { workspaceId: 'default' });
    const result = unwrap(raw);

    assert.strictEqual(result.status, 'bilinmiyor');
    assert.ok(raw.meta.reasoningTrace);
    assert.strictEqual(raw.meta.reasoningTrace.summary.total, 2);
    assert.ok(raw.meta.reasoningTrace.summary.unknown >= 1);
    assert.strictEqual(raw.meta.trustReceiptPreview.finalStatus, 'bilinmiyor');
  });

  it('preserves confidence floor downgrades in the trace', () => {
    const kernel = makeKernel('confidence-floor');
    withMutedConsole(() => {
      seedReactNativeGraph(kernel);
    });

    const raw = kernel.verify('React Native is used in production and React Native is performant', {
      workspaceId: 'default',
      confidenceFloor: 0.96,
    });

    assert.notStrictEqual(unwrap(raw).status, 'dogrulandi');
    assert.ok(raw.meta.reasoningTrace);
    assert.ok(
      raw.meta.reasoningTrace.trustReceiptPreview.downgradeReasons.includes('CONFIDENCE_FLOOR') ||
      raw.meta.reasoningTrace.trustReceiptPreview.downgradeReasons.includes('UNKNOWN_SUBCLAIM'),
    );
  });

  it('propagates adversarial signals into trace metadata without unsafe verified status', () => {
    const kernel = makeKernel('adversarial');
    withMutedConsole(() => {
      seedReactNativeGraph(kernel);
    });

    const raw = kernel.verify('According to React Native it is performant', { workspaceId: 'default' });
    const result = unwrap(raw);

    assert.ok(['bilinmiyor', 'celiski'].includes(result.status));
    assert.ok(raw.meta.reasoningTrace);
    assert.ok(
      raw.meta.semanticTrust.risk.flags.includes('STRAWMAN_ATTRIBUTION') ||
      raw.meta.semanticTrust.risk.flags.includes('WEASEL_WORDS'),
    );
    assert.ok(
      raw.meta.reasoningTrace.trustReceiptPreview.semanticFlags.includes('STRAWMAN_ATTRIBUTION') ||
      raw.meta.reasoningTrace.trustReceiptPreview.semanticFlags.includes('WEASEL_WORDS'),
    );
  });

  it('is deterministic for the same input and graph state', () => {
    const kernel = makeKernel('deterministic');
    withMutedConsole(() => {
      seedReactNativeGraph(kernel);
    });

    const first = kernel.verify('React Native is used in production and React Native is performant', { workspaceId: 'default' });
    const second = kernel.verify('React Native is used in production and React Native is performant', { workspaceId: 'default' });

    assert.deepStrictEqual(first.meta.reasoningTrace, second.meta.reasoningTrace);
    assert.deepStrictEqual(first.meta.trustReceiptPreview, second.meta.trustReceiptPreview);
  });
});
