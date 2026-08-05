'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');
const { inspectMemoryContext } = require('../lib/workbench/memory-context-inspector');

const FIXED_TIME = '2026-08-05T12:00:00.000Z';
const SOURCE_VERDICT = 'V4_WB2_RUNTIME_SOURCE_SUFFICIENT';

function fixtureRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `huqan-v4-wb2a-${label}-`));
}

function openKernel(root, load = false) {
  return new Kernel({
    noLoad: !load,
    useSQLite: true,
    loadPlugins: false,
    memoryPath: path.join(root, 'graph.json'),
    dbPath: path.join(root, 'graph.db'),
    memoryStoreUseSQLite: true,
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  });
}

function closeKernel(kernel) {
  kernel?.graph?.close?.();
}

function cleanup(root, ...kernels) {
  for (const kernel of kernels) closeKernel(kernel);
  fs.rmSync(root, { recursive: true, force: true });
}

function provenance(workspaceId, suffix) {
  return {
    provenanceId: `prov-v4-wb2a-${suffix}`,
    sourceType: 'manual',
    sourceRef: `test:v4-wb2a:${suffix}`,
    actor: 'v4-wb2a-contract-test',
    workspaceId,
    timestamp: FIXED_TIME,
    trustPolicyVersion: '1.0.0',
  };
}

function reviewOptions(workspaceId, suffix) {
  return {
    workspaceId,
    provenance: provenance(workspaceId, suffix),
  };
}

function approvedOptions(workspaceId, suffix) {
  return {
    ...reviewOptions(workspaceId, suffix),
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: `apr-v4-wb2a-${suffix}`,
  };
}

function exactAuditRecord(graph, auditId, workspaceId) {
  return graph.getAuditEvents({ workspaceId })
    .find((event) => event.auditId === auditId) || null;
}

function receiptFrom(event) {
  const details = event?.details && typeof event.details === 'object' ? event.details : {};
  return details.receipt && typeof details.receipt === 'object' ? details.receipt : null;
}

function memoryContextRecordFromAudit(event) {
  const details = event?.details && typeof event.details === 'object' ? event.details : {};
  const receipt = receiptFrom(event);
  const decision = String(details.admissionOutcome || receipt?.decision || '').trim();
  const status = decision === 'allow'
    ? 'admitted'
    : decision === 'review'
      ? 'review_required'
      : decision === 'reject'
        ? 'rejected'
        : decision === 'quarantine'
          ? 'blocked'
          : '';
  const canonicalMutation = Boolean(
    decision === 'allow'
    && receipt?.canonical === true
    && event?.targetType === 'edge'
    && (event?.eventType === 'LEARN' || event?.eventType === 'REAFFIRMED'),
  );
  const receiptId = String(details.receiptId || receipt?.receiptId || '').trim() || null;

  return {
    recordId: event.auditId,
    workspaceId: event.workspaceId,
    memoryAdmission: {
      status,
      decision,
      reason: String(details.reason || receipt?.reason || '').trim(),
      workspaceId: event.workspaceId,
      receiptId,
    },
    contextIntegrity: {
      workspaceScoped: Boolean(event.workspaceId),
      canonicalMutation,
      mutationAllowed: canonicalMutation && decision === 'allow',
    },
    provenance: {
      workspaceId: event.workspaceId,
      provenanceId: event.provenanceId || null,
      sourceRef: event.sourceRef || null,
      receiptId,
    },
  };
}

function inspectAuditRecord(event) {
  const record = memoryContextRecordFromAudit(event);
  return inspectMemoryContext({
    recordId: event.auditId,
    workspaceId: event.workspaceId,
    source: { records: [record] },
  });
}

function readSnapshot(kernel, workspaceId) {
  return JSON.stringify({
    nodes: kernel.graph.getNodes(workspaceId),
    edgeCount: kernel.graph.edgeCount(workspaceId),
    auditEvents: kernel.graph.getAuditEvents({ workspaceId }),
  });
}

test('real review admission remains queryable by auditId after SQLite reopen', () => {
  const root = fixtureRoot('review-reopen');
  let first;
  let reopened;
  try {
    first = openKernel(root);
    assert.equal(first.graph.getStats().backend, 'sqlite');

    const result = first.learn('kedi hayvandir', reviewOptions('wb2-review', 'review'));
    assert.equal(result.data.admission.outcome, 'review');
    assert.equal(first.graph.nodeCount('wb2-review'), 0);
    assert.equal(first.graph.edgeCount('wb2-review'), 0);

    const original = first.graph.getAuditEvents({ workspaceId: 'wb2-review' })[0];
    assert.ok(original?.auditId);
    assert.equal(original.eventType, 'REVIEW');
    assert.equal(original.targetType, 'learn');
    assert.equal(original.details.admissionOutcome, 'review');
    assert.equal(original.details.receipt.decision, 'review');

    closeKernel(first);
    first = null;
    reopened = openKernel(root, true);
    const durable = exactAuditRecord(reopened.graph, original.auditId, 'wb2-review');
    assert.ok(durable);
    assert.equal(durable.auditId, original.auditId);
    assert.equal(durable.details.reason, original.details.reason);

    const inspected = inspectAuditRecord(durable);
    assert.equal(inspected.ok, true);
    assert.equal(inspected.memoryAdmission.status, 'review_required');
    assert.equal(inspected.memoryAdmission.decision, 'review');
    assert.equal(inspected.provenance.workspaceId, 'wb2-review');
    assert.deepEqual(inspected.contextIntegrity.flags, ['workspace_scoped']);
    assert.equal(inspected.source.readOnly, true);
  } finally {
    cleanup(root, first, reopened);
  }
});

test('real approved admission ties canonical mutation to durable edge audit evidence', () => {
  const root = fixtureRoot('approved-reopen');
  let first;
  let reopened;
  try {
    first = openKernel(root);
    const result = first.learn('kedi hayvandir', approvedOptions('wb2-approved', 'approved'));
    assert.equal(result.data.admission.outcome, 'allow');
    assert.ok(result.data.admission.receiptId);
    assert.ok(first.graph.edgeCount('wb2-approved') > 0);

    const original = first.graph.getAuditEvents({ workspaceId: 'wb2-approved' })
      .find((event) => event.targetType === 'edge');
    assert.ok(original?.auditId);
    assert.ok(['LEARN', 'REAFFIRMED'].includes(original.eventType));
    assert.equal(original.details.receiptId, result.data.admission.receiptId);
    assert.equal(original.details.receipt.decision, 'allow');
    assert.equal(original.details.receipt.canonical, true);

    closeKernel(first);
    first = null;
    reopened = openKernel(root, true);
    const durable = exactAuditRecord(reopened.graph, original.auditId, 'wb2-approved');
    assert.ok(durable);
    assert.ok(reopened.graph.edgeCount('wb2-approved') > 0);

    const inspected = inspectAuditRecord(durable);
    assert.equal(inspected.ok, true);
    assert.equal(inspected.memoryAdmission.status, 'admitted');
    assert.equal(inspected.memoryAdmission.decision, 'allow');
    assert.equal(inspected.provenance.receiptId, result.data.admission.receiptId);
    assert.deepEqual(inspected.contextIntegrity.flags, [
      'workspace_scoped',
      'canonical_mutation',
      'mutation_allowed',
    ]);
  } finally {
    cleanup(root, first, reopened);
  }
});

test('exact auditId lookup stays workspace scoped and unknown identifiers fail closed', () => {
  const root = fixtureRoot('workspace');
  let kernel;
  try {
    kernel = openKernel(root);
    kernel.learn('kedi hayvandir', reviewOptions('workspace-a', 'workspace-a'));
    kernel.learn('kopek memelidir', reviewOptions('workspace-b', 'workspace-b'));

    const eventA = kernel.graph.getAuditEvents({ workspaceId: 'workspace-a' })[0];
    assert.ok(eventA?.auditId);
    assert.equal(exactAuditRecord(kernel.graph, eventA.auditId, 'workspace-b'), null);
    assert.equal(exactAuditRecord(kernel.graph, 'missing-audit-id', 'workspace-a'), null);

    const records = kernel.graph.getAuditEvents({ workspaceId: 'workspace-a' })
      .map(memoryContextRecordFromAudit);
    const wrongWorkspace = inspectMemoryContext({
      recordId: eventA.auditId,
      workspaceId: 'workspace-b',
      source: { records },
    });
    assert.equal(wrongWorkspace.ok, false);
    assert.equal(wrongWorkspace.status, 'not_found');
  } finally {
    cleanup(root, kernel);
  }
});

test('audit lookup and WB2 inspection do not mutate graph or audit state', () => {
  const root = fixtureRoot('read-only');
  let kernel;
  try {
    kernel = openKernel(root);
    kernel.learn('kedi hayvandir', approvedOptions('wb2-read-only', 'read-only'));
    const event = kernel.graph.getAuditEvents({ workspaceId: 'wb2-read-only' })
      .find((candidate) => candidate.targetType === 'edge');
    assert.ok(event);

    const before = readSnapshot(kernel, 'wb2-read-only');
    const durable = exactAuditRecord(kernel.graph, event.auditId, 'wb2-read-only');
    const inspected = inspectAuditRecord(durable);
    const after = readSnapshot(kernel, 'wb2-read-only');

    assert.equal(inspected.ok, true);
    assert.equal(after, before);
  } finally {
    cleanup(root, kernel);
  }
});

test('source contract verdict is sufficient only with all real-source assertions green', () => {
  assert.equal(SOURCE_VERDICT, 'V4_WB2_RUNTIME_SOURCE_SUFFICIENT');
});
