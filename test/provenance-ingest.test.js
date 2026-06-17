'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Kernel = require('../kernel');
const { ingestWithProvenance } = require('../lib/provenance-ingest');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-provenance-ingest-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best effort
  }
});

function makePaths(label) {
  return {
    memoryPath: path.join(tempDir, `${label}.json`),
    dbPath: path.join(tempDir, `${label}.db`),
  };
}

function makeProvenance(overrides = {}) {
  return {
    provenanceId: 'prov-ingest-001',
    sourceRef: 'docs/ingest.md#fact',
    sourceTitle: 'Ingest Fact',
    sourceType: 'document',
    actor: 'connector-bot',
    timestamp: '2026-06-15T00:00:00Z',
    confidence: 0.91,
    workspaceId: 'workspace-a',
    ...overrides,
  };
}

test('ingestWithProvenance returns explicit graph admission for learned facts', async () => {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    ...makePaths('admitted'),
  });

  try {
    const result = await ingestWithProvenance(kernel, {
      text: 'kedi hayvandir',
      provenance: makeProvenance(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.admission.outcome, 'admitted');
    assert.equal(result.admission.graphWrite, true);
    assert.equal(result.admission.targetType, 'learn');
    assert.equal(result.admission.provenanceId, 'prov-ingest-001');
    assert.ok(result.admission.learned > 0);
    assert.ok(result.provenance);
    assert.equal(result.provenance.provenanceId, 'prov-ingest-001');
    assert.ok(kernel.graph.getNode('kedi', 'workspace-a'));
    assert.ok(kernel.graph.getEdge('kedi', 'hayvan', 'tür', 'workspace-a'));
  } finally {
    if (kernel && kernel.graph && typeof kernel.graph.close === 'function') {
      kernel.graph.close();
    }
  }
});

test('ingestWithProvenance keeps admission explicit when provenance is auto-filled in non-strict mode', async () => {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    ...makePaths('auto-filled'),
  });

  try {
    const result = await ingestWithProvenance(kernel, {
      text: 'balik yüzer',
      workspaceId: 'workspace-b',
    });

    assert.equal(result.ok, true);
    assert.equal(result.admission.outcome, 'admitted');
    assert.equal(result.admission.graphWrite, true);
    assert.equal(result.admission.workspaceId, 'workspace-b');
    assert.ok(result.provenance);
    assert.equal(result.provenance.workspaceId, 'workspace-b');
    assert.ok(result.provenanceWarnings.includes('provenanceId auto-filled'));
    assert.ok(result.provenanceWarnings.includes('sourceRef auto-filled'));
    assert.ok(result.provenanceWarnings.includes('sourceTitle auto-filled'));
  } finally {
    if (kernel && kernel.graph && typeof kernel.graph.close === 'function') {
      kernel.graph.close();
    }
  }
});
