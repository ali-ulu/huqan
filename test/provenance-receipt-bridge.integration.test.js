'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Kernel = require('../kernel');
const {
  buildTrustReceipt,
  queryAuditTrail,
  queryProvenance,
} = require('../lib/provenance-query');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-provenance-receipt-bridge-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // Best effort only. Temp files are outside the repo.
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
    provenanceId: 'prov-bridge-001',
    sourceRef: 'docs/bridge.md#fact',
    sourceTitle: 'Bridge Fact',
    sourceType: 'document',
    actor: 'truth-2b',
    timestamp: '2026-06-14T00:00:00Z',
    confidence: 0.93,
    workspaceId: 'workspace-a',
    trustPolicyVersion: '0.8.0',
    ...overrides,
  };
}

function closeKernel(kernel) {
  if (kernel && kernel.graph && typeof kernel.graph.close === 'function') {
    kernel.graph.close();
  }
}

function stripVolatileReceiptFields(receipt) {
  const { receiptId, generatedAt, ...rest } = receipt;
  return rest;
}

test('provenance-backed learned fact is queryable through graph, receipt, and audit trail', () => {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    ...makePaths('bridge'),
  });

  try {
    const provenance = makeProvenance();
    const learn = kernel.learn('kedi hayvandir', { provenance });
    assert.equal(learn.ok, true);

    const node = kernel.graph.getNode('kedi', 'workspace-a');
    const edge = kernel.graph.getEdge('kedi', 'hayvan', 'tür', 'workspace-a');
    assert.ok(node);
    assert.ok(edge);
    assert.equal(node.provenance.provenanceId, provenance.provenanceId);
    assert.equal(edge.provenance.provenanceId, provenance.provenanceId);

    const provenanceRecords = queryProvenance(kernel.graph, {
      targetId: 'kedi|tür|hayvan',
      workspaceId: 'workspace-a',
    });
    assert.equal(provenanceRecords.length, 1);
    assert.equal(provenanceRecords[0].provenance.provenanceId, provenance.provenanceId);

    const receipt = buildTrustReceipt({
      targetId: 'kedi|tür|hayvan',
      workspaceId: 'workspace-a',
    }, { target: kernel.graph });
    assert.equal(receipt.status, 'canonical');
    assert.equal(receipt.canonical, true);
    assert.ok(receipt.provenance);
    assert.equal(receipt.provenance.provenanceId, provenance.provenanceId);
    assert.equal(receipt.targetId, 'kedi|tür|hayvan');

    const auditTrail = queryAuditTrail(kernel.graph, {
      targetId: 'kedi|tür|hayvan',
      workspaceId: 'workspace-a',
    });
    assert.ok(auditTrail.length >= 1);
    assert.equal(auditTrail[0].targetId, 'kedi|tür|hayvan');
    assert.equal(auditTrail[0].provenanceId, provenance.provenanceId);

    const receiptAgain = buildTrustReceipt({
      targetId: 'kedi|tür|hayvan',
      workspaceId: 'workspace-a',
    }, { target: kernel.graph });
    assert.deepEqual(
      stripVolatileReceiptFields(receiptAgain),
      stripVolatileReceiptFields(receipt),
      'receipt content should stay deterministic apart from volatile fields',
    );
  } finally {
    closeKernel(kernel);
  }
});

test('non-strict learn without provenance remains allowed and documents current policy', () => {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    ...makePaths('missing-provenance'),
  });

  try {
    const learn = kernel.learn('balik yüzer', { workspaceId: 'default' });
    assert.equal(learn.ok, true);

    const node = kernel.graph.getNode('balik', 'default');
    const edge = kernel.graph.getEdges('balik', 'default')[0];

    assert.ok(node);
    assert.ok(edge);
    assert.ok(node.provenance, 'current non-strict policy auto-fills system provenance');
    assert.ok(edge.provenance, 'current non-strict policy auto-fills system provenance');
    assert.equal(node.provenance.sourceType, 'system');
    assert.equal(edge.provenance.sourceType, 'system');
    assert.equal(node.provenance.workspaceId, 'default');
    assert.equal(edge.provenance.workspaceId, 'default');
  } finally {
    closeKernel(kernel);
  }
});

test('non-strict learn with invalid sourceType remains allowed as compatibility provenance', () => {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    ...makePaths('invalid-source-type-compat'),
  });

  try {
    const learn = kernel.learn('serce kustur', {
      provenance: makeProvenance({
        provenanceId: 'prov-bridge-invalid-type',
        sourceType: 'bogus',
      }),
    });
    assert.equal(learn.ok, true);

    const node = kernel.graph.getNode('serce', 'workspace-a');
    const edge = kernel.graph.getEdges('serce', 'workspace-a')[0];

    assert.ok(node);
    assert.ok(edge);
    assert.equal(node.provenance.sourceType, 'system');
    assert.equal(edge.provenance.sourceType, 'system');
  } finally {
    closeKernel(kernel);
  }
});

test('strict provenance fails closed when provenance is missing', () => {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    strictProvenance: true,
    ...makePaths('strict-missing-provenance'),
  });

  try {
    assert.throws(() => kernel.learn('serce kustur', {
      workspaceId: 'workspace-a',
    }), {
      name: 'ProvenanceError',
      code: 'PROVENANCE_REQUIRED',
    });
  } finally {
    closeKernel(kernel);
  }
});

test('strict provenance fails closed when sourceType is invalid', () => {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    strictProvenance: true,
    ...makePaths('strict-invalid-source-type'),
  });

  try {
    assert.throws(() => kernel.learn('serce kustur', {
      provenance: makeProvenance({
        provenanceId: 'prov-bridge-strict-invalid-type',
        sourceType: 'bogus',
      }),
    }), {
      name: 'ProvenanceError',
      code: 'PROVENANCE_REQUIRED',
    });
  } finally {
    closeKernel(kernel);
  }
});
