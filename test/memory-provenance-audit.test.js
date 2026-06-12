const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { describe, it } = require('node:test');
const Kernel = require('../kernel');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeProvenance(workspaceId, sourceRef, actor, timestamp) {
  return {
    provenanceId: `${workspaceId}:${sourceRef}:prov`,
    sourceRef,
    sourceTitle: sourceRef,
    sourceType: 'document',
    actor,
    timestamp,
    confidence: 0.99,
    workspaceId,
    trustPolicyVersion: '1.0.0',
  };
}

describe('memory provenance and audit hardening', () => {
  it('preserves provenance fields and emits audit events across store, patch, tombstone, link, and supersede', () => {
    const dir = makeTempDir('axiom-m6-provenance-');
    const memoryPath = path.join(dir, 'memory.json');
    const kernel = new Kernel({
      noLoad: true,
      loadPlugins: false,
      memoryStorePath: memoryPath,
    });

    const stored = kernel.memory.store({
      content: { text: 'provenance root' },
      workspaceId: 'ws-audit',
      metadata: { tag: 'seed' },
      provenance: makeProvenance('ws-audit', 'docs/root.md#1', 'author-a', '2026-06-12T00:00:00.000Z'),
    });
    assert.strictEqual(stored.ok, true);
    assert.strictEqual(stored.memory.provenance.sourceRef, 'docs/root.md#1');
    assert.strictEqual(stored.memory.provenance.actor, 'author-a');
    assert.strictEqual(stored.memory.provenance.workspaceId, 'ws-audit');

    const patched = kernel.memory.patchMetadata(stored.memory.memoryId, { reviewed: true }, {
      workspaceId: 'ws-audit',
      actor: 'reviewer-a',
      provenance: makeProvenance('ws-audit', 'docs/patch.md#1', 'reviewer-a', '2026-06-12T00:01:00.000Z'),
    });
    assert.strictEqual(patched.ok, true);
    assert.strictEqual(patched.memory.metadata.reviewed, true);
    assert.strictEqual(patched.event.eventType, 'UPDATED');
    assert.strictEqual(patched.event.provenance.sourceRef, 'docs/patch.md#1');
    assert.strictEqual(patched.event.provenance.actor, 'reviewer-a');

    const tombstoned = kernel.memory.tombstone(stored.memory.memoryId, {
      workspaceId: 'ws-audit',
      actor: 'reviewer-b',
      provenance: makeProvenance('ws-audit', 'docs/tombstone.md#1', 'reviewer-b', '2026-06-12T00:02:00.000Z'),
    });
    assert.strictEqual(tombstoned.ok, true);
    assert.strictEqual(tombstoned.memory.status, 'deleted');
    assert.strictEqual(tombstoned.event.eventType, 'TOMBSTONE');
    assert.strictEqual(tombstoned.event.provenance.sourceRef, 'docs/tombstone.md#1');

    const replacement = kernel.memory.store({
      content: { text: 'replacement target' },
      workspaceId: 'ws-audit',
      provenance: makeProvenance('ws-audit', 'docs/replacement.md#1', 'author-b', '2026-06-12T00:03:00.000Z'),
    });
    assert.strictEqual(replacement.ok, true);

    const superseded = kernel.memory.supersede(replacement.memory.memoryId, { text: 'replacement v2' }, {
      workspaceId: 'ws-audit',
      actor: 'reviewer-c',
      provenance: makeProvenance('ws-audit', 'docs/supersede.md#1', 'reviewer-c', '2026-06-12T00:04:00.000Z'),
    });
    assert.strictEqual(superseded.ok, true);
    assert.strictEqual(superseded.newMemory.supersedesMemoryId, replacement.memory.memoryId);
    assert.strictEqual(superseded.link.relation, 'supersedes');
    assert.strictEqual(superseded.event.eventType, 'CREATED');
    assert.strictEqual(superseded.oldMemoryUpdateEvent.eventType, 'UPDATED');
    assert.strictEqual(superseded.oldMemoryUpdateEvent.details.newStatus, 'superseded');
    assert.strictEqual(superseded.oldMemoryUpdateEvent.provenance.sourceRef, 'docs/supersede.md#1');

    const supportTarget = kernel.memory.store({
      content: { text: 'support target' },
      workspaceId: 'ws-audit',
      provenance: makeProvenance('ws-audit', 'docs/support-target.md#1', 'author-c', '2026-06-12T00:05:00.000Z'),
    });
    assert.strictEqual(supportTarget.ok, true);

    const supportLink = kernel.memory.link({
      fromMemoryId: superseded.newMemory.memoryId,
      toMemoryId: supportTarget.memory.memoryId,
      relation: 'supports',
      workspaceId: 'ws-audit',
      actor: 'reviewer-d',
      provenance: makeProvenance('ws-audit', 'docs/link-support.md#1', 'reviewer-d', '2026-06-12T00:06:00.000Z'),
    });
    assert.strictEqual(supportLink.ok, true);
    assert.strictEqual(supportLink.link.provenance.sourceRef, 'docs/link-support.md#1');
    assert.strictEqual(supportLink.event.eventType, 'LINKED');

    const events = kernel.memory.getEvents(stored.memory.memoryId, { workspaceId: 'ws-audit' });
    assert.ok(events.some((event) => event.eventType === 'UPDATED'));
    assert.ok(events.some((event) => event.eventType === 'TOMBSTONE'));

    const supersedeEvents = kernel.memory.getEvents(replacement.memory.memoryId, { workspaceId: 'ws-audit' });
    assert.ok(supersedeEvents.some((event) => event.eventType === 'UPDATED'));
    assert.ok(supersedeEvents.some((event) => event.eventType === 'CREATED'));

    const saveResult = kernel.memory.save();
    assert.strictEqual(saveResult.ok, true);
    assert.strictEqual(saveResult.backend, 'json');

    const reopened = new Kernel({
      loadPlugins: false,
      memoryStorePath: memoryPath,
    });

    const reopenedStored = reopened.memory.get(stored.memory.memoryId, { workspaceId: 'ws-audit' });
    assert.strictEqual(reopenedStored.ok, true);
    assert.strictEqual(reopenedStored.memory.provenance.sourceRef, 'docs/root.md#1');
    assert.strictEqual(reopenedStored.memory.workspaceId, 'ws-audit');

    const reopenedEvents = reopened.memory.getEvents(stored.memory.memoryId, { workspaceId: 'ws-audit' });
    assert.ok(reopenedEvents.some((event) => event.eventType === 'UPDATED'));
    assert.ok(reopenedEvents.some((event) => event.eventType === 'TOMBSTONE'));

    const reopenedLinks = reopened.memory.getLinks(superseded.newMemory.memoryId, { workspaceId: 'ws-audit' });
    assert.ok(reopenedLinks.some((link) => link.relation === 'supersedes'));
    assert.ok(reopenedLinks.some((link) => link.relation === 'supports'));

    reopened.memory.close();
    kernel.memory.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
