const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Kernel = require('../kernel');

function createKernel() {
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeProvenance(workspaceId, sourceRef, timestamp) {
  return {
    provenanceId: sourceRef + '-prov',
    sourceRef,
    sourceTitle: sourceRef,
    sourceType: 'document',
    actor: 'system',
    timestamp,
    confidence: 0.97,
    workspaceId,
    trustPolicyVersion: '1.0.0',
  };
}

describe('memory temporal queries', () => {
  it('queries createdAt windows deterministically', async () => {
    const kernel = createKernel();

    const first = kernel.memory.store({
      content: { text: 'first' },
      workspaceId: 'ws-time',
      provenance: makeProvenance('ws-time', 'docs/first.md#1', '2026-06-12T00:00:00.000Z'),
    });
    await delay(15);
    const second = kernel.memory.store({
      content: { text: 'second' },
      workspaceId: 'ws-time',
      provenance: makeProvenance('ws-time', 'docs/second.md#1', '2026-06-12T00:00:01.000Z'),
    });
    await delay(15);
    const third = kernel.memory.store({
      content: { text: 'third' },
      workspaceId: 'ws-time',
      provenance: makeProvenance('ws-time', 'docs/third.md#1', '2026-06-12T00:00:02.000Z'),
    });

    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, true);
    assert.strictEqual(third.ok, true);

    const all = kernel.memory.timeline({ workspaceId: 'ws-time' });
    assert.strictEqual(all.ok, true);
    assert.deepStrictEqual(all.memories.map((record) => record.memoryId), [
      first.memory.memoryId,
      second.memory.memoryId,
      third.memory.memoryId,
    ]);

    const sinceSecond = kernel.memory.since(second.memory.createdAt, { workspaceId: 'ws-time' });
    assert.strictEqual(sinceSecond.ok, true);
    assert.deepStrictEqual(sinceSecond.memories.map((record) => record.memoryId), [
      second.memory.memoryId,
      third.memory.memoryId,
    ]);

    const beforeSecond = kernel.memory.before(second.memory.createdAt, { workspaceId: 'ws-time' });
    assert.strictEqual(beforeSecond.ok, true);
    assert.deepStrictEqual(beforeSecond.memories.map((record) => record.memoryId), [
      first.memory.memoryId,
    ]);

    const betweenFirstAndSecond = kernel.memory.between(first.memory.createdAt, second.memory.createdAt, { workspaceId: 'ws-time' });
    assert.strictEqual(betweenFirstAndSecond.ok, true);
    assert.deepStrictEqual(betweenFirstAndSecond.memories.map((record) => record.memoryId), [
      first.memory.memoryId,
      second.memory.memoryId,
    ]);

    const otherWorkspace = kernel.memory.timeline({ workspaceId: 'ws-other' });
    assert.strictEqual(otherWorkspace.ok, true);
    assert.strictEqual(otherWorkspace.total, 0);
  });

  it('supports updatedAt windows after metadata writes and rejects unsupported fields', async () => {
    const kernel = createKernel();

    const first = kernel.memory.store({
      content: { text: 'first-update' },
      workspaceId: 'ws-update-time',
      provenance: makeProvenance('ws-update-time', 'docs/first-update.md#1', '2026-06-12T00:10:00.000Z'),
    });
    await delay(15);
    const second = kernel.memory.store({
      content: { text: 'second-update' },
      workspaceId: 'ws-update-time',
      provenance: makeProvenance('ws-update-time', 'docs/second-update.md#1', '2026-06-12T00:10:01.000Z'),
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(second.ok, true);

    await delay(15);
    const patch = kernel.memory.patchMetadata(second.memory.memoryId, { reviewed: true }, { workspaceId: 'ws-update-time' });
    assert.strictEqual(patch.ok, true);
    assert.ok(patch.memory.updatedAt);

    const updatedOnly = kernel.memory.timeline({ workspaceId: 'ws-update-time', field: 'updatedAt' });
    assert.strictEqual(updatedOnly.ok, true);
    assert.deepStrictEqual(updatedOnly.memories.map((record) => record.memoryId), [
      second.memory.memoryId,
    ]);

    const accessed = kernel.memory.timeline({ workspaceId: 'ws-update-time', field: 'accessedAt' });
    assert.strictEqual(accessed.ok, true);
    assert.deepStrictEqual(accessed.memories.map((record) => record.memoryId).sort(), [
      first.memory.memoryId,
      second.memory.memoryId,
    ].sort());

    const invalid = kernel.memory.timeline({ workspaceId: 'ws-update-time', field: 'unknownField' });
    assert.strictEqual(invalid.ok, false);
    assert.strictEqual(invalid.error.code, 'INVALID_INPUT');
  });
});

