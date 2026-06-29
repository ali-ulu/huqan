const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('./kernel');
const KernelV2 = require('./kernel.v2');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-provenance-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makePaths(name) {
  return {
    memoryPath: path.join(tempDir, `${name}.json`),
    dbPath: path.join(tempDir, `${name}.db`),
  };
}

function makeProvenance(overrides = {}) {
  return {
    provenanceId: 'prov-001',
    sourceRef: 'docs/adr.md#claim',
    sourceTitle: 'ADR Claim',
    sourceType: 'document',
    actor: 'system',
    timestamp: '2026-06-02T00:00:00Z',
    confidence: 0.91,
    workspaceId: 'default',
    trustPolicyVersion: 'trust-policy-v0',
    ...overrides,
  };
}

const APPROVED_TEST_ADMISSION = {
  admissionRequired: true,
  approvalRequired: true,
  approvalStatus: 'approved',
  approvalId: 'apr-provenance-test',
};

describe('Provenance System', () => {
  it('stores provenance on node and edge in memory mode', () => {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, ...makePaths('memory') });
    const provenance = makeProvenance();

    kernel.learn('kedi hayvandir', { provenance, ...APPROVED_TEST_ADMISSION });

    const node = kernel.graph.getNode('kedi');
    const edge = kernel.graph.getEdge('kedi', 'hayvan', 'tür');
    const learnEvents = kernel.graph.getAuditEvents({ eventType: 'LEARN' });

    assert.strictEqual(node.provenance.provenanceId, provenance.provenanceId);
    assert.strictEqual(edge.provenance.provenanceId, provenance.provenanceId);
    assert.strictEqual(node.provenance.confidence, 0.91);
    assert.strictEqual(edge.provenance.confidence, 0.91);
    assert.strictEqual(node.provenance.trustPolicyVersion, '0.8.0');
    assert.strictEqual(edge.provenance.trustPolicyVersion, '0.8.0');
    assert.strictEqual(node.provenance.sourceType, 'document');
    assert.ok(!Object.prototype.hasOwnProperty.call(node.provenance, 'sourceSubType'));
    assert.strictEqual(node.workspaceId, 'default');
    assert.strictEqual(edge.workspaceId, 'default');
    assert.ok(learnEvents.length >= 1);
    assert.strictEqual(learnEvents[0].provenanceId, provenance.provenanceId);
    assert.strictEqual(learnEvents[0].trustPolicyVersion, '0.8.0');
    assert.strictEqual(learnEvents[0].workspaceId, 'default');
  });

  it('preserves existing provenance when node or edge update passes null', () => {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, ...makePaths('preserve-null') });
    const provenance = makeProvenance({ provenanceId: 'prov-preserve-null' });

    kernel.learn('kedi hayvandir', { provenance, ...APPROVED_TEST_ADMISSION });

    kernel.graph.addNode('kedi', 'kedi', null, { workspaceId: 'default' });
    kernel.graph.addEdge('kedi', 'hayvan', 'tür', { provenance: null, workspaceId: 'default' });

    const node = kernel.graph.getNode('kedi');
    const edge = kernel.graph.getEdge('kedi', 'hayvan', 'tür');

    assert.strictEqual(node.provenance.provenanceId, provenance.provenanceId);
    assert.strictEqual(edge.provenance.provenanceId, provenance.provenanceId);
    assert.strictEqual(node.provenance.confidence, 0.91);
    assert.strictEqual(edge.provenance.confidence, 0.91);
  });

  it('preserves existing provenance when node or edge update passes null in SQLite mode', (t) => {
    const paths = makePaths('preserve-null-sqlite');
    const provenance = makeProvenance({ provenanceId: 'prov-preserve-null-sqlite' });
    const kernel = new Kernel({ noLoad: true, useSQLite: true, ...paths });

    if (kernel.graph.getStats().backend !== 'sqlite') {
      kernel.graph.close();
      return t.skip('better-sqlite3 is unavailable');
    }

    t.after(() => kernel.graph.close());

    kernel.learn('kedi hayvandir', { provenance, ...APPROVED_TEST_ADMISSION });
    kernel.graph.addNode('kedi', 'kedi', null, { workspaceId: 'default' });
    kernel.graph.addEdge('kedi', 'hayvan', 'tür', { provenance: null, workspaceId: 'default' });
    kernel.graph.save();

    const reader = new Kernel({ useSQLite: true, ...paths });
    if (reader.graph.getStats().backend !== 'sqlite') {
      reader.graph.close();
      return t.skip('better-sqlite3 is unavailable');
    }
    t.after(() => reader.graph.close());
    reader.graph.load();

    const node = reader.graph.getNode('kedi');
    const edge = reader.graph.getEdge('kedi', 'hayvan', 'tür');

    assert.strictEqual(node.provenance.provenanceId, provenance.provenanceId);
    assert.strictEqual(edge.provenance.provenanceId, provenance.provenanceId);
    assert.strictEqual(node.provenance.confidence, 0.91);
    assert.strictEqual(edge.provenance.confidence, 0.91);
  });

  it('keeps workspace scoped provenance isolated', () => {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, ...makePaths('workspace-scope') });
    const provenance = makeProvenance({ provenanceId: 'prov-workspace', workspaceId: 'workspace-a' });

    kernel.learn('kedi hayvandir', { provenance, ...APPROVED_TEST_ADMISSION });

    const scopedNode = kernel.graph.getNode('kedi', 'workspace-a');
    const defaultNode = kernel.graph.getNode('kedi', 'default');
    const scopedEdge = kernel.graph.getEdge('kedi', 'hayvan', 'tür', 'workspace-a');
    const defaultEdge = kernel.graph.getEdge('kedi', 'hayvan', 'tür', 'default');
    const learnEvents = kernel.graph.getAuditEvents({ eventType: 'LEARN', workspaceId: 'workspace-a' });

    assert.ok(scopedNode);
    assert.strictEqual(scopedNode.workspaceId, 'workspace-a');
    assert.ok(scopedEdge);
    assert.strictEqual(scopedEdge.workspaceId, 'workspace-a');
    assert.strictEqual(defaultNode, null);
    assert.strictEqual(defaultEdge, null);
    assert.strictEqual(learnEvents.length >= 1, true);
    assert.strictEqual(learnEvents[0].workspaceId, 'workspace-a');
    assert.strictEqual(learnEvents[0].provenanceId, provenance.provenanceId);
  });

  it('keeps same node id separate across workspaces', () => {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, ...makePaths('workspace-collision') });
    const provenanceA = makeProvenance({ provenanceId: 'prov-workspace-a', workspaceId: 'workspace-a' });
    const provenanceB = makeProvenance({ provenanceId: 'prov-workspace-b', workspaceId: 'workspace-b' });

    kernel.learn('kedi hayvandir', { provenance: provenanceA, ...APPROVED_TEST_ADMISSION });
    kernel.learn('kedi canlidir', { provenance: provenanceB, ...APPROVED_TEST_ADMISSION });

    const nodeA = kernel.graph.getNode('kedi', 'workspace-a');
    const nodeB = kernel.graph.getNode('kedi', 'workspace-b');
    const nodeDefault = kernel.graph.getNode('kedi', 'default');
    const edgeA = kernel.graph.getEdge('kedi', 'hayvan', 'tür', 'workspace-a');
    const edgeB = kernel.graph.getEdge('kedi', 'canli', 'tür', 'workspace-b');

    assert.ok(nodeA);
    assert.ok(nodeB);
    assert.strictEqual(nodeA.workspaceId, 'workspace-a');
    assert.strictEqual(nodeB.workspaceId, 'workspace-b');
    assert.strictEqual(nodeA.provenance.provenanceId, 'prov-workspace-a');
    assert.strictEqual(nodeB.provenance.provenanceId, 'prov-workspace-b');
    assert.ok(edgeA);
    assert.ok(edgeB);
    assert.strictEqual(edgeA.workspaceId, 'workspace-a');
    assert.strictEqual(edgeB.workspaceId, 'workspace-b');
    assert.strictEqual(nodeDefault, null);
  });

  it('persists provenance through JSON save/load roundtrip', () => {
    const paths = makePaths('json-roundtrip');
    const provenance = makeProvenance({ provenanceId: 'prov-json' });
    const writer = new Kernel({ noLoad: true, useSQLite: false, ...paths });

    writer.learn('kedi hayvandir', { provenance, ...APPROVED_TEST_ADMISSION });
    writer.graph.save();

    const reader = new Kernel({ noLoad: true, useSQLite: false, ...paths });
    reader.graph.load();
    const node = reader.graph.getNode('kedi');
    const edge = reader.graph.getEdge('kedi', 'hayvan', 'tür');
    const learnEvents = reader.graph.getAuditEvents({ eventType: 'LEARN' });

    assert.strictEqual(node.provenance.provenanceId, provenance.provenanceId);
    assert.strictEqual(edge.provenance.provenanceId, provenance.provenanceId);
    assert.strictEqual(node.provenance.confidence, 0.91);
    assert.strictEqual(edge.provenance.confidence, 0.91);
    assert.strictEqual(node.provenance.trustPolicyVersion, '0.8.0');
    assert.strictEqual(edge.provenance.trustPolicyVersion, '0.8.0');
    assert.strictEqual(node.workspaceId, 'default');
    assert.strictEqual(edge.workspaceId, 'default');
    assert.ok(learnEvents.length >= 1);
    assert.strictEqual(learnEvents[0].provenanceId, provenance.provenanceId);
  });

  it('defaults legacy JSON records to the default workspace', () => {
    const paths = makePaths('legacy-json');
    const provenance = makeProvenance({ provenanceId: 'prov-legacy' });
    const writer = new Kernel({ noLoad: true, useSQLite: false, ...paths });

    writer.learn('kedi hayvandir', { provenance, ...APPROVED_TEST_ADMISSION });
    writer.graph.save();

    const raw = JSON.parse(fs.readFileSync(paths.memoryPath, 'utf-8'));
    delete raw.nodes.kedi.workspaceId;
    delete raw.edges[0].workspaceId;
    delete raw.auditEvents[0].workspaceId;
    fs.writeFileSync(paths.memoryPath, JSON.stringify(raw));

    const reader = new Kernel({ useSQLite: false, ...paths });
    const node = reader.graph.getNode('kedi');
    const edge = reader.graph.getEdge('kedi', 'hayvan', 'tür');
    const learnEvents = reader.graph.getAuditEvents({ eventType: 'LEARN' });

    assert.strictEqual(node.workspaceId, 'default');
    assert.strictEqual(edge.workspaceId, 'default');
    assert.strictEqual(learnEvents[0].workspaceId, 'default');
  });

  it('persists provenance through SQLite save/load roundtrip', (t) => {
    const paths = makePaths('sqlite-roundtrip');
    const provenance = makeProvenance({ provenanceId: 'prov-sqlite' });
    const writer = new Kernel({ noLoad: true, useSQLite: true, ...paths });

    if (writer.graph.getStats().backend !== 'sqlite') {
      return t.skip('better-sqlite3 is unavailable');
    }

    const reader = new Kernel({ useSQLite: true, ...paths });
    t.after(() => {
      writer.graph.close();
      reader.graph.close();
    });

    writer.learn('kedi hayvandir', { provenance, ...APPROVED_TEST_ADMISSION });
    writer.graph.save();
    reader.graph.load();

    const node = reader.graph.getNode('kedi');
    const edge = reader.graph.getEdge('kedi', 'hayvan', 'tür');
    const learnEvents = reader.graph.getAuditEvents({ eventType: 'LEARN' });

    assert.strictEqual(node.provenance.provenanceId, provenance.provenanceId);
    assert.strictEqual(edge.provenance.provenanceId, provenance.provenanceId);
    assert.strictEqual(node.provenance.confidence, 0.91);
    assert.strictEqual(edge.provenance.confidence, 0.91);
    assert.strictEqual(node.provenance.trustPolicyVersion, '0.8.0');
    assert.strictEqual(edge.provenance.trustPolicyVersion, '0.8.0');
    assert.strictEqual(node.workspaceId, 'default');
    assert.strictEqual(edge.workspaceId, 'default');
    assert.ok(learnEvents.length >= 1);
    assert.strictEqual(learnEvents[0].provenanceId, provenance.provenanceId);
  });

  it('throws ProvenanceError in strict mode when provenance is missing', () => {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, strictProvenance: true });

    assert.throws(
      () => kernel.learn('aslan hayvandir', APPROVED_TEST_ADMISSION),
      (error) => error instanceof Kernel.ProvenanceError
        && error.code === 'PROVENANCE_REQUIRED'
        && /provenance is required/i.test(error.message),
    );

    const rejectEvents = kernel.graph.getAuditEvents({ eventType: 'REJECT' });
    assert.ok(rejectEvents.length >= 1);
    assert.strictEqual(rejectEvents[0].targetType, 'learn');
  });

  it('supports provenance through KernelV2 delegation', () => {
    const provenance = makeProvenance({ provenanceId: 'prov-v2' });
    const kernel = new KernelV2({ noLoad: true, useSQLite: false, ...makePaths('kernel-v2') });

    kernel.learn('kedi hayvandir', { provenance, ...APPROVED_TEST_ADMISSION });

    const node = kernel.graph.getNode('kedi');
    const edge = kernel.graph.getEdge('kedi', 'hayvan', 'tür');
    const learnEvents = kernel.graph.getAuditEvents({ eventType: 'LEARN' });

    assert.strictEqual(node.provenance.provenanceId, provenance.provenanceId);
    assert.strictEqual(edge.provenance.provenanceId, provenance.provenanceId);
    assert.strictEqual(node.provenance.confidence, 0.91);
    assert.strictEqual(edge.provenance.confidence, 0.91);
    assert.strictEqual(node.provenance.trustPolicyVersion, '0.8.0');
    assert.strictEqual(edge.provenance.trustPolicyVersion, '0.8.0');
    assert.ok(learnEvents.length >= 1);
    assert.strictEqual(learnEvents[0].provenanceId, provenance.provenanceId);
  });
});
