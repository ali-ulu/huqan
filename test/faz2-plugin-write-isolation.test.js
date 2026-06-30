'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

function makeKernel(opts = {}) {
  const Kernel = require('../kernel');
  return new Kernel({
    noLoad: true,
    useSQLite: false,
    paranoidMode: false,
    capabilities: {
      companyMode: true,
      pluginCapabilities: true,
      temporal: true,
      ...(opts.capabilities || {}),
    },
    ...opts,
  });
}

function countNodes(kernel) {
  return Object.keys(kernel.graph._nodes || {}).length;
}

function countEdges(kernel) {
  return (kernel.graph._edges || []).length;
}

describe('FAZ2-PR4: plugin write isolation (F-003)', () => {
  it('kernel exposes proposeEdge and proposeNode as public admission-aware methods', () => {
    const kernel = makeKernel();
    assert.strictEqual(typeof kernel.proposeEdge, 'function', 'proposeEdge missing');
    assert.strictEqual(typeof kernel.proposeNode, 'function', 'proposeNode missing');
  });

  it('allow node proposal writes canonical node with provenance and LEARN audit', () => {
    const kernel = makeKernel();
    const result = kernel.proposeNode('plugin-node', 'Plugin Node', null, {
      sourceType: 'plugin',
      sourceRef: 'plugin:test',
      sessionId: 'plugin-session',
    });

    assert.strictEqual(result.decision, 'allow');
    assert.ok(result.node, 'allow node proposal must return node');
    assert.ok(result.audit, 'allow node proposal must emit audit');
    assert.strictEqual(result.audit.eventType, 'LEARN');

    const stored = kernel.graph.getNode('plugin-node');
    assert.ok(stored, 'canonical node must exist after allow');
    assert.strictEqual(stored.label, 'Plugin Node');
    assert.ok(stored.provenance, 'stored node must include provenance');
    assert.strictEqual(stored.provenance.sourceType, 'plugin');
    assert.strictEqual(stored.provenance.sourceRef, 'plugin:test');
  });

  it('allow edge proposal writes canonical edge with provenance and LEARN audit', () => {
    const kernel = makeKernel();
    kernel.proposeNode('edge-from', 'edge-from', null, { sourceType: 'plugin', sourceRef: 'plugin:test' });
    kernel.proposeNode('edge-to', 'edge-to', null, { sourceType: 'plugin', sourceRef: 'plugin:test' });

    const result = kernel.proposeEdge('edge-from', 'edge-to', 'relatesTo', {
      sourceType: 'plugin',
      sourceRef: 'plugin:test',
      sessionId: 'plugin-session',
    });

    assert.strictEqual(result.decision, 'allow');
    assert.ok(result.edge, 'allow edge proposal must return edge');
    assert.ok(result.audit, 'allow edge proposal must emit audit');
    assert.strictEqual(result.audit.eventType, 'LEARN');
    assert.strictEqual(result.edge.provenance.sourceType, 'plugin');
    assert.strictEqual(result.edge.provenance.sourceRef, 'plugin:test');
  });

  it('review node proposal does not write canonical node', () => {
    const kernel = makeKernel();
    kernel._evaluateLearnAdmission = () => ({ outcome: 'review', reason: 'manual_review', approvalStatus: 'pending' });
    const beforeNodes = countNodes(kernel);

    const result = kernel.proposeNode('review-node', 'Review Node', null, {
      sourceType: 'plugin',
      sourceRef: 'plugin:review',
    });

    assert.strictEqual(result.decision, 'review');
    assert.strictEqual(result.node, null);
    assert.ok(result.audit, 'review node proposal must emit audit');
    assert.strictEqual(result.audit.eventType, 'REVIEW');
    assert.strictEqual(countNodes(kernel), beforeNodes, 'review decision must not write canonical node');
  });

  it('reject node proposal does not write canonical node', () => {
    const kernel = makeKernel();
    kernel._evaluateLearnAdmission = () => ({ outcome: 'reject', reason: 'policy_reject', approvalStatus: 'rejected' });
    const beforeNodes = countNodes(kernel);

    const result = kernel.proposeNode('reject-node', 'Reject Node', null, {
      sourceType: 'plugin',
      sourceRef: 'plugin:reject',
    });

    assert.strictEqual(result.decision, 'reject');
    assert.strictEqual(result.node, null);
    assert.ok(result.audit, 'reject node proposal must emit audit');
    assert.strictEqual(result.audit.eventType, 'REJECT');
    assert.strictEqual(countNodes(kernel), beforeNodes, 'reject decision must not write canonical node');
  });

  it('review edge proposal does not write canonical edge', () => {
    const kernel = makeKernel();
    kernel.proposeNode('review-edge-from', 'review-edge-from', null, { sourceType: 'plugin', sourceRef: 'plugin:review' });
    kernel.proposeNode('review-edge-to', 'review-edge-to', null, { sourceType: 'plugin', sourceRef: 'plugin:review' });
    kernel._evaluateLearnAdmission = () => ({ outcome: 'review', reason: 'manual_review', approvalStatus: 'pending' });
    const beforeEdges = countEdges(kernel);

    const result = kernel.proposeEdge('review-edge-from', 'review-edge-to', 'blocks', {
      sourceType: 'plugin',
      sourceRef: 'plugin:review',
    });

    assert.strictEqual(result.decision, 'review');
    assert.strictEqual(result.edge, null);
    assert.ok(result.audit, 'review edge proposal must emit audit');
    assert.strictEqual(result.audit.eventType, 'REVIEW');
    assert.strictEqual(countEdges(kernel), beforeEdges, 'review decision must not write canonical edge');
  });

  it('reject edge proposal does not write canonical edge', () => {
    const kernel = makeKernel();
    kernel.proposeNode('reject-edge-from', 'reject-edge-from', null, { sourceType: 'plugin', sourceRef: 'plugin:reject' });
    kernel.proposeNode('reject-edge-to', 'reject-edge-to', null, { sourceType: 'plugin', sourceRef: 'plugin:reject' });
    kernel._evaluateLearnAdmission = () => ({ outcome: 'reject', reason: 'policy_reject', approvalStatus: 'rejected' });
    const beforeEdges = countEdges(kernel);

    const result = kernel.proposeEdge('reject-edge-from', 'reject-edge-to', 'blocks', {
      sourceType: 'plugin',
      sourceRef: 'plugin:reject',
    });

    assert.strictEqual(result.decision, 'reject');
    assert.strictEqual(result.edge, null);
    assert.ok(result.audit, 'reject edge proposal must emit audit');
    assert.strictEqual(result.audit.eventType, 'REJECT');
    assert.strictEqual(countEdges(kernel), beforeEdges, 'reject decision must not write canonical edge');
  });

  it('company-brain manual ingest path uses proposeNode and proposeEdge', async () => {
    const kernel = makeKernel();
    const nodeCalls = [];
    const edgeCalls = [];
    const originalNode = kernel.proposeNode.bind(kernel);
    const originalEdge = kernel.proposeEdge.bind(kernel);
    kernel.proposeNode = function (...args) {
      nodeCalls.push(args[0]);
      return originalNode(...args);
    };
    kernel.proposeEdge = function (...args) {
      edgeCalls.push(args[2]);
      return originalEdge(...args);
    };

    const result = await kernel.runCapability('companyBrain', {
      action: 'manual',
      text: 'AXIOM bir sistemdir',
      author: 'tester',
      sourceType: 'manual',
    });

    assert.strictEqual(result.ok, true);
    assert.ok(nodeCalls.length > 0, 'company-brain path must invoke proposeNode');
    assert.ok(edgeCalls.length > 0, 'company-brain path must invoke proposeEdge');
  });

  it('repo-memory ingest path uses proposeNode and proposeEdge', async () => {
    const kernel = makeKernel();
    const nodeCalls = [];
    const edgeCalls = [];
    const originalNode = kernel.proposeNode.bind(kernel);
    const originalEdge = kernel.proposeEdge.bind(kernel);
    kernel.proposeNode = function (...args) {
      nodeCalls.push(args[0]);
      return originalNode(...args);
    };
    kernel.proposeEdge = function (...args) {
      edgeCalls.push(args[2]);
      return originalEdge(...args);
    };

    const result = await kernel.runCapability('repoMemory', {
      action: 'ingest',
      sourceType: 'github',
      repoUrl: 'https://github.com/acme/demo',
      branch: 'main',
      fetchRepoFiles: async () => ([
        { path: 'README.md', content: '# Intro\n\n## Setup\nInstall it.', lastModified: '2026-06-30T00:00:00.000Z' },
      ]),
      parseRepoUrl: () => ({ owner: 'acme', repo: 'demo' }),
    });

    assert.strictEqual(result.ok, true);
    assert.ok(nodeCalls.length > 0, 'repo-memory path must invoke proposeNode');
    assert.ok(edgeCalls.length > 0, 'repo-memory path must invoke proposeEdge');
  });

  it('forbidden plugin bypass pattern is absent from proposeEdge and proposeNode', () => {
    const kernel = makeKernel();
    const captured = [];
    const originalCommit = kernel._commitBackgroundEdge.bind(kernel);
    kernel._commitBackgroundEdge = function (from, to, relation, source, opts) {
      captured.push(opts && opts.admissionOpts ? opts.admissionOpts : null);
      return originalCommit(from, to, relation, source, opts);
    };

    kernel.proposeNode('no-bypass-node', 'No Bypass Node', null, { sourceType: 'plugin', sourceRef: 'plugin:nobypass' });
    kernel.proposeNode('no-bypass-from', 'no-bypass-from', null, { sourceType: 'plugin', sourceRef: 'plugin:nobypass' });
    kernel.proposeNode('no-bypass-to', 'no-bypass-to', null, { sourceType: 'plugin', sourceRef: 'plugin:nobypass' });
    kernel.proposeEdge('no-bypass-from', 'no-bypass-to', 'tests', { sourceType: 'plugin', sourceRef: 'plugin:nobypass' });

    for (const opts of captured.filter(Boolean)) {
      assert.notStrictEqual(opts.admissionBypassReason, 'plugin');
      assert.notStrictEqual(opts.admissionRequired, false);
    }
  });

  it('ingest path routes through kernel.runCapability', async () => {
    const { handleIngest } = require('../lib/ingest');
    let runCapabilityCalled = false;
    const fakeKernel = {
      runCapability: async () => {
        runCapabilityCalled = true;
        return { ok: true };
      },
    };

    await handleIngest({
      kernel: fakeKernel,
      data: { text: 'AXIOM causes reasoning', author: 'test', sourceType: 'manual' },
    });

    assert.ok(runCapabilityCalled, 'handleIngest must call kernel.runCapability');
  });
});
