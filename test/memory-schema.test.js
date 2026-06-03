const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  MEMORY_EVENT_TYPES,
  MEMORY_LINK_RELATIONS,
  MEMORY_OBJECT_TYPES,
  MEMORY_SCHEMAS,
  normalizeMemoryEvent,
  normalizeMemoryLink,
  normalizeMemoryRecord,
  validateMemoryEvent,
  validateMemoryEvolution,
  validateMemoryLink,
  validateMemoryPackage,
  validateMemoryRecord,
} = require('../lib/memory-schema');

function baseProvenance() {
  return {
    provenanceId: 'prov-1',
    sourceRef: 'doc://source/1',
    sourceTitle: 'Source 1',
    sourceType: 'document',
    actor: 'system',
    timestamp: '2026-06-03T00:00:00.000Z',
    confidence: 0.9,
    workspaceId: 'workspace-a',
    trustPolicyVersion: '0.9.0',
  };
}

function baseRecord(overrides = {}) {
  return {
    memoryId: 'mem-1',
    workspaceId: 'workspace-a',
    content: { text: 'Kedi hayvandir' },
    createdAt: '2026-06-03T00:00:00.000Z',
    provenance: baseProvenance(),
    trustPolicyVersion: '0.9.0',
    ...overrides,
  };
}

function baseEvent(overrides = {}) {
  return {
    eventId: 'evt-1',
    eventType: 'CREATED',
    memoryId: 'mem-1',
    workspaceId: 'workspace-a',
    createdAt: '2026-06-03T00:00:00.000Z',
    actor: 'system',
    provenance: baseProvenance(),
    trustPolicyVersion: '0.9.0',
    details: { reason: 'seed' },
    ...overrides,
  };
}

function baseLink(overrides = {}) {
  return {
    linkId: 'link-1',
    relation: 'supersedes',
    fromMemoryId: 'mem-2',
    toMemoryId: 'mem-1',
    workspaceId: 'workspace-a',
    createdAt: '2026-06-03T00:00:00.000Z',
    provenance: baseProvenance(),
    trustPolicyVersion: '0.9.0',
    ...overrides,
  };
}

describe('memory-schema', () => {
  it('exposes stable schema metadata', () => {
    assert.ok(MEMORY_SCHEMAS.memoryRecord.required.includes('memoryId'));
    assert.ok(MEMORY_SCHEMAS.memoryRecord.required.includes('provenance'));
    assert.ok(MEMORY_SCHEMAS.memoryEvent.required.includes('eventType'));
    assert.ok(MEMORY_SCHEMAS.memoryLink.required.includes('relation'));
    assert.strictEqual(MEMORY_OBJECT_TYPES.memoryRecord, 'memory-record');
    assert.ok(MEMORY_EVENT_TYPES.includes('TOMBSTONE'));
    assert.ok(MEMORY_LINK_RELATIONS.includes('contradicts'));
  });

  it('accepts a valid memory record and keeps JSON-safe content', () => {
    const record = baseRecord();
    const validation = validateMemoryRecord(record);

    assert.ok(validation.ok, JSON.stringify(validation.errors, null, 2));
    assert.strictEqual(validation.type, MEMORY_OBJECT_TYPES.memoryRecord);
    assert.deepStrictEqual(record, baseRecord());
  });

  it('rejects incomplete memory records', () => {
    const validation = validateMemoryRecord({
      workspaceId: 'workspace-a',
      content: { text: 'Kedi hayvandir' },
      createdAt: '2026-06-03T00:00:00.000Z',
      provenance: baseProvenance(),
      trustPolicyVersion: '0.9.0',
    });

    assert.strictEqual(validation.ok, false);
    assert.ok(validation.errors.some((error) => error.field === 'memoryId'));
  });

  it('accepts valid memory events and rejects unsupported event types', () => {
    const valid = validateMemoryEvent(baseEvent({ eventType: 'TOMBSTONE', details: { reason: 'deleted' } }));
    assert.ok(valid.ok, JSON.stringify(valid.errors, null, 2));

    const invalid = validateMemoryEvent(baseEvent({ eventType: 'NOT_REAL' }));
    assert.strictEqual(invalid.ok, false);
    assert.ok(invalid.errors.some((error) => error.field === 'eventType'));
  });

  it('accepts valid memory links and rejects unsupported relations', () => {
    const valid = validateMemoryLink(baseLink({ relation: 'contradicts' }));
    assert.ok(valid.ok, JSON.stringify(valid.errors, null, 2));

    const invalid = validateMemoryLink(baseLink({ relation: 'teleports_to' }));
    assert.strictEqual(invalid.ok, false);
    assert.ok(invalid.errors.some((error) => error.field === 'relation'));
  });

  it('keeps content immutable and requires supersedes links for new versions', () => {
    const previous = baseRecord({ memoryId: 'mem-1', content: { text: 'Kedi hayvandir' } });
    const same = baseRecord({ memoryId: 'mem-1', content: { text: 'Kedi hayvandir' } });
    const changedSameId = baseRecord({ memoryId: 'mem-1', content: { text: 'Kedi memelidir' } });
    const changedNewId = baseRecord({
      memoryId: 'mem-2',
      content: { text: 'Kedi memelidir' },
      supersedesMemoryId: 'mem-1',
    });
    const changedNoSupersedes = baseRecord({
      memoryId: 'mem-2',
      content: { text: 'Kedi memelidir' },
    });

    const stable = validateMemoryEvolution(previous, same);
    assert.ok(stable.ok, JSON.stringify(stable.errors, null, 2));

    const immutableFail = validateMemoryEvolution(previous, changedSameId);
    assert.strictEqual(immutableFail.ok, false);
    assert.ok(immutableFail.errors.some((error) => error.code === 'IMMUTABLE_CONTENT'));

    const supersededOk = validateMemoryEvolution(previous, changedNewId);
    assert.ok(supersededOk.ok, JSON.stringify(supersededOk.errors, null, 2));

    const supersedesFail = validateMemoryEvolution(previous, changedNoSupersedes);
    assert.strictEqual(supersedesFail.ok, false);
    assert.ok(supersedesFail.errors.some((error) => error.code === 'SUPERCEDES_REQUIRED'));
  });

  it('supports tombstone and contradictory package validation data', () => {
    const packageObject = {
      version: '0.9.1',
      workspaceId: 'workspace-a',
      memories: [baseRecord()],
      events: [
        baseEvent({ eventType: 'TOMBSTONE', details: { reason: 'delete' } }),
        baseEvent({ eventId: 'evt-2', eventType: 'UPDATED', details: { reason: 'superseded' } }),
      ],
      links: [
        baseLink({ relation: 'supersedes' }),
        baseLink({ linkId: 'link-2', relation: 'contradicts', fromMemoryId: 'mem-3', toMemoryId: 'mem-1' }),
      ],
    };

    const validation = validateMemoryPackage(packageObject);
    assert.ok(validation.ok, JSON.stringify(validation.errors, null, 2));
  });

  it('normalizes memory objects without mutating inputs', () => {
    const record = baseRecord({ workspaceId: '  workspace-a  ', trustPolicyVersion: ' 0.9.1 ' });
    const event = baseEvent({ workspaceId: '  workspace-a  ', trustPolicyVersion: ' 0.9.1 ' });
    const link = baseLink({ workspaceId: '  workspace-a  ', trustPolicyVersion: ' 0.9.1 ' });

    const normalizedRecord = normalizeMemoryRecord(record);
    const normalizedEvent = normalizeMemoryEvent(event);
    const normalizedLink = normalizeMemoryLink(link);

    assert.strictEqual(normalizedRecord.workspaceId, 'workspace-a');
    assert.strictEqual(normalizedRecord.trustPolicyVersion, '0.9.1');
    assert.strictEqual(normalizedEvent.workspaceId, 'workspace-a');
    assert.strictEqual(normalizedEvent.trustPolicyVersion, '0.9.1');
    assert.strictEqual(normalizedLink.workspaceId, 'workspace-a');
    assert.strictEqual(normalizedLink.trustPolicyVersion, '0.9.1');

    assert.strictEqual(record.workspaceId, '  workspace-a  ');
    assert.strictEqual(event.workspaceId, '  workspace-a  ');
    assert.strictEqual(link.workspaceId, '  workspace-a  ');
  });
});
