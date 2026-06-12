const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const Kernel = require('../kernel');

function createKernel() {
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
  });
}

function sortByCreatedAtThenId(records) {
  return [...records].sort((left, right) => {
    const time = String(left.createdAt || '').localeCompare(String(right.createdAt || ''));
    if (time !== 0) return time;
    return String(left.memoryId || '').localeCompare(String(right.memoryId || ''));
  });
}

describe('memory query helpers', () => {
  it('exposes the query helper surface', () => {
    const kernel = createKernel();
    assert.strictEqual(typeof kernel.memory.findById, 'function');
    assert.strictEqual(typeof kernel.memory.findByContentHash, 'function');
    assert.strictEqual(typeof kernel.memory.findBySourceRef, 'function');
    assert.strictEqual(typeof kernel.memory.findByKind, 'function');
    assert.strictEqual(typeof kernel.memory.findByStatus, 'function');
    assert.strictEqual(typeof kernel.memory.findLinks, 'function');
    assert.strictEqual(typeof kernel.memory.findLinkedMemories, 'function');
    assert.strictEqual(typeof kernel.memory.history, 'function');
    assert.strictEqual(typeof kernel.memory.getEvents, 'function');
    assert.strictEqual(typeof kernel.memory.getLinks, 'function');
  });

  it('queries memories deterministically within a workspace and preserves isolation', () => {
    const kernel = createKernel();

    const alpha = kernel.memory.store({
      content: { text: 'alpha fact' },
      kind: 'note',
      workspaceId: 'ws-query',
      provenance: {
        provenanceId: 'prov-alpha',
        sourceRef: 'docs/alpha.md#1',
        sourceTitle: 'Alpha',
        sourceType: 'document',
        actor: 'system',
        timestamp: '2026-06-12T00:00:00.000Z',
        confidence: 0.95,
        workspaceId: 'ws-query',
        trustPolicyVersion: '1.0.0',
      },
    });
    assert.strictEqual(alpha.ok, true);

    const beta = kernel.memory.store({
      content: { text: 'beta fact' },
      kind: 'fact',
      workspaceId: 'ws-query',
      provenance: {
        provenanceId: 'prov-beta',
        sourceRef: 'docs/beta.md#1',
        sourceTitle: 'Beta',
        sourceType: 'document',
        actor: 'system',
        timestamp: '2026-06-12T00:00:01.000Z',
        confidence: 0.92,
        workspaceId: 'ws-query',
        trustPolicyVersion: '1.0.0',
      },
    });
    assert.strictEqual(beta.ok, true);

    const gamma = kernel.memory.store({
      content: { text: 'gamma fact' },
      kind: 'note',
      workspaceId: 'ws-query',
      provenance: {
        provenanceId: 'prov-gamma',
        sourceRef: 'docs/gamma.md#1',
        sourceTitle: 'Gamma',
        sourceType: 'document',
        actor: 'system',
        timestamp: '2026-06-12T00:00:02.000Z',
        confidence: 0.9,
        workspaceId: 'ws-query',
        trustPolicyVersion: '1.0.0',
      },
    });
    assert.strictEqual(gamma.ok, true);

    const otherWorkspace = kernel.memory.store({
      content: { text: 'alpha fact' },
      kind: 'note',
      workspaceId: 'ws-other',
      provenance: {
        provenanceId: 'prov-other',
        sourceRef: 'docs/alpha.md#1',
        sourceTitle: 'Alpha',
        sourceType: 'document',
        actor: 'system',
        timestamp: '2026-06-12T00:00:03.000Z',
        confidence: 0.88,
        workspaceId: 'ws-other',
        trustPolicyVersion: '1.0.0',
      },
    });
    assert.strictEqual(otherWorkspace.ok, true);

    const link = kernel.memory.link({
      fromMemoryId: alpha.memory.memoryId,
      toMemoryId: beta.memory.memoryId,
      relation: 'supports',
      workspaceId: 'ws-query',
    });
    assert.strictEqual(link.ok, true);

    const foundById = kernel.memory.findById(alpha.memory.memoryId, { workspaceId: 'ws-query' });
    assert.strictEqual(foundById.ok, true);
    assert.strictEqual(foundById.memory.memoryId, alpha.memory.memoryId);

    const missingCrossWorkspace = kernel.memory.findById(alpha.memory.memoryId, { workspaceId: 'ws-other' });
    assert.strictEqual(missingCrossWorkspace.ok, false);
    assert.strictEqual(missingCrossWorkspace.error.code, 'NOT_FOUND');

    const byHash = kernel.memory.findByContentHash(alpha.memory.contentHash, { workspaceId: 'ws-query' });
    assert.strictEqual(byHash.ok, true);
    assert.strictEqual(byHash.total, 1);
    assert.strictEqual(byHash.memories[0].memoryId, alpha.memory.memoryId);

    const bySource = kernel.memory.findBySourceRef('docs/alpha.md#1', { workspaceId: 'ws-query' });
    assert.strictEqual(bySource.ok, true);
    assert.strictEqual(bySource.total, 1);
    assert.strictEqual(bySource.memories[0].memoryId, alpha.memory.memoryId);

    const byKind = kernel.memory.findByKind('note', { workspaceId: 'ws-query' });
    assert.strictEqual(byKind.ok, true);
    const expectedKindOrder = sortByCreatedAtThenId([alpha.memory, gamma.memory]).map((record) => record.memoryId);
    assert.deepStrictEqual(byKind.memories.map((record) => record.memoryId), expectedKindOrder);

    const byStatus = kernel.memory.findByStatus('active', { workspaceId: 'ws-query' });
    assert.strictEqual(byStatus.ok, true);
    assert.deepStrictEqual(byStatus.memories.map((record) => record.memoryId), sortByCreatedAtThenId([alpha.memory, beta.memory, gamma.memory]).map((record) => record.memoryId));

    const links = kernel.memory.findLinks(alpha.memory.memoryId, { workspaceId: 'ws-query' });
    assert.strictEqual(links.ok, true);
    assert.strictEqual(links.total, 1);
    assert.strictEqual(links.links[0].relation, 'supports');

    const linkedMemories = kernel.memory.findLinkedMemories(alpha.memory.memoryId, { workspaceId: 'ws-query' });
    assert.strictEqual(linkedMemories.ok, true);
    assert.strictEqual(linkedMemories.total, 1);
    assert.strictEqual(linkedMemories.memories[0].memoryId, beta.memory.memoryId);

    const historyBeforeTombstone = kernel.memory.history(beta.memory.memoryId, { workspaceId: 'ws-query' });
    assert.strictEqual(historyBeforeTombstone.ok, true);
    assert.ok(historyBeforeTombstone.events.some((event) => event.eventType === 'CREATED'));
    assert.ok(historyBeforeTombstone.events.some((event) => event.eventType === 'LINKED'));

    const tombstoned = kernel.memory.tombstone(beta.memory.memoryId, { workspaceId: 'ws-query' });
    assert.strictEqual(tombstoned.ok, true);
    assert.strictEqual(tombstoned.memory.status, 'deleted');

    const deleted = kernel.memory.findByStatus('deleted', { workspaceId: 'ws-query' });
    assert.strictEqual(deleted.ok, true);
    assert.strictEqual(deleted.total, 1);
    assert.strictEqual(deleted.memories[0].memoryId, beta.memory.memoryId);

    const linkedIncludingDeleted = kernel.memory.findLinkedMemories(alpha.memory.memoryId, {
      workspaceId: 'ws-query',
      includeTombstoned: true,
    });
    assert.strictEqual(linkedIncludingDeleted.ok, true);
    assert.strictEqual(linkedIncludingDeleted.total, 1);
    assert.strictEqual(linkedIncludingDeleted.memories[0].memoryId, beta.memory.memoryId);

    const historyAfterTombstone = kernel.memory.history(beta.memory.memoryId, { workspaceId: 'ws-query' });
    assert.strictEqual(historyAfterTombstone.ok, true);
    assert.ok(historyAfterTombstone.events.some((event) => event.eventType === 'TOMBSTONE'));
    assert.ok(historyAfterTombstone.events.some((event) => event.eventType === 'CREATED'));

    const crossWorkspaceSource = kernel.memory.findBySourceRef('docs/alpha.md#1', { workspaceId: 'ws-other' });
    assert.strictEqual(crossWorkspaceSource.ok, true);
    assert.strictEqual(crossWorkspaceSource.total, 1);
    assert.strictEqual(crossWorkspaceSource.memories[0].memoryId, otherWorkspace.memory.memoryId);
  });

  it('rejects empty query helper inputs safely', () => {
    const kernel = createKernel();
    assert.strictEqual(kernel.memory.findById('', { workspaceId: 'ws-query' }).ok, false);
    assert.strictEqual(kernel.memory.findByContentHash('', { workspaceId: 'ws-query' }).ok, false);
    assert.strictEqual(kernel.memory.findBySourceRef('', { workspaceId: 'ws-query' }).ok, false);
    assert.strictEqual(kernel.memory.findByKind('', { workspaceId: 'ws-query' }).ok, false);
    assert.strictEqual(kernel.memory.findByStatus('', { workspaceId: 'ws-query' }).ok, false);
    assert.strictEqual(kernel.memory.findLinks('', { workspaceId: 'ws-query' }).ok, false);
    assert.strictEqual(kernel.memory.findLinkedMemories('', { workspaceId: 'ws-query' }).ok, false);
    assert.strictEqual(kernel.memory.history('', { workspaceId: 'ws-query' }).ok, false);
  });
});
