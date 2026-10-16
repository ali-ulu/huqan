'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { VERDICTS, probeSelfEvolve } = require('../lib/self-evolve-probe');

function createKernel(label) {
  return new Kernel(isolatedKernelOptions(label));
}

function close(kernel) {
  kernel?.graph?.close?.();
  kernel?.memory?.close?.();
}

test('static detection finds the self-evolve and dream entry points that exist', () => {
  const kernel = createKernel('probe-static');
  try {
    const probe = probeSelfEvolve(kernel);
    assert.deepEqual(probe.symbols, {
      runSelfEvolve: true,
      buildSelfEvolveCollaborators: true,
      runDream: true,
    });
  } finally {
    close(kernel);
  }
});

test('with no invocation the probe measures nothing and stays undecided', () => {
  const kernel = createKernel('probe-static-only');
  try {
    const probe = probeSelfEvolve(kernel);
    assert.equal(probe.measurement, null);
    assert.equal(probe.verdict, VERDICTS.UNMEASURED);
  } finally {
    close(kernel);
  }
});

test('the probe itself changes nothing: before and after come only from the measured call', () => {
  const kernel = createKernel('probe-read-only');
  try {
    kernel.graph.addNode('a', 'a', null, { workspaceId: 'default' });
    const calls = [];
    for (const method of ['addNode', 'addEdge', 'addCandidateClaim', 'appendAuditEvent']) {
      const original = kernel.graph[method].bind(kernel.graph);
      kernel.graph[method] = (...args) => { calls.push(method); return original(...args); };
    }
    const probe = probeSelfEvolve(kernel, { invoke: () => {} });
    assert.deepEqual(calls, [], 'the probe observes; the invocation is the only thing allowed to act');
    assert.deepEqual(probe.measurement.before, probe.measurement.after);
  } finally {
    close(kernel);
  }
});

test('an invocation that changes nothing reads as inactive', () => {
  const kernel = createKernel('probe-inactive');
  try {
    const probe = probeSelfEvolve(kernel, { invoke: () => {} });
    assert.equal(probe.verdict, VERDICTS.INACTIVE);
    assert.deepEqual(probe.measurement.delta, { nodes: 0, edges: 0, candidates: 0, config: 0 });
  } finally {
    close(kernel);
  }
});

test('an invocation that writes graph content but no config reads as content-only', () => {
  const kernel = createKernel('probe-content');
  try {
    const probe = probeSelfEvolve(kernel, {
      invoke: () => {
        kernel.graph.addNode('x', 'x', null, { workspaceId: 'default' });
        kernel.graph.addNode('y', 'y', null, { workspaceId: 'default' });
        kernel.graph.addEdge('x', 'y', 'hipotez', { workspaceId: 'default', confidence: 0.3 });
      },
    });
    assert.equal(probe.verdict, VERDICTS.CONTENT_ONLY);
    assert.equal(probe.measurement.delta.nodes, 2);
    assert.equal(probe.measurement.delta.edges, 1);
    assert.equal(probe.measurement.delta.config, 0);
  } finally {
    close(kernel);
  }
});

test('an invocation that changes a threshold reads as writing config', () => {
  const kernel = createKernel('probe-config');
  try {
    // Injected so the config branch is exercised against a real observation
    // rather than asserted from prose. The shipped engine's thresholds are
    // frozen; that is the finding, not a limitation of the probe.
    const config = { confidenceFloor: 0.4, criticalInDegree: 5, smallComponentSize: 3 };
    const probe = probeSelfEvolve(kernel, {
      readConfig: () => ({ ...config }),
      invoke: () => { config.criticalInDegree = 7; },
    });
    assert.equal(probe.verdict, VERDICTS.WRITES_CONFIG);
    assert.equal(probe.measurement.delta.config, 1);
    assert.deepEqual(probe.measurement.configChanges, [
      { key: 'criticalInDegree', before: 5, after: 7 },
    ]);
  } finally {
    close(kernel);
  }
});

test('config is read from the shipped engine defaults when the caller supplies no reader', () => {
  const kernel = createKernel('probe-default-config');
  try {
    const probe = probeSelfEvolve(kernel, { invoke: () => {} });
    assert.deepEqual(probe.measurement.before.config, {
      confidenceFloor: 0.4,
      criticalInDegree: 5,
      smallComponentSize: 3,
    });
  } finally {
    close(kernel);
  }
});

test('a throwing invocation is reported, not swallowed, and still yields a measurement', () => {
  const kernel = createKernel('probe-throw');
  try {
    const probe = probeSelfEvolve(kernel, {
      invoke: () => { throw new Error('patladı'); },
    });
    assert.equal(probe.measurement.invocationError, 'patladı');
    assert.equal(probe.verdict, VERDICTS.INACTIVE);
  } finally {
    close(kernel);
  }
});

test('the probe is deterministic for the same observed state', () => {
  const kernel = createKernel('probe-deterministic');
  try {
    const first = probeSelfEvolve(kernel, { invoke: () => {} });
    const second = probeSelfEvolve(kernel, { invoke: () => {} });
    assert.deepEqual(first, second);
  } finally {
    close(kernel);
  }
});

test('workspace scope is honoured by the counts', () => {
  const kernel = createKernel('probe-workspace');
  try {
    const probe = probeSelfEvolve(kernel, {
      workspaceId: 'alpha',
      invoke: () => {
        kernel.graph.addNode('b1', 'b1', null, { workspaceId: 'beta' });
        kernel.graph.addNode('a1', 'a1', null, { workspaceId: 'alpha' });
      },
    });
    assert.equal(probe.measurement.delta.nodes, 1, 'only the probed workspace is counted');
  } finally {
    close(kernel);
  }
});
