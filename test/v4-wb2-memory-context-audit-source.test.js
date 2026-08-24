'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');
const { createMemoryContextAuditSource } = require('../lib/workbench/memory-context-audit-source');
const { inspectMemoryContext } = require('../lib/workbench/memory-context-inspector');

const FIXED_TIME = '2026-08-05T13:00:00.000Z';

function fixtureRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `huqan-v4-wb2b-${label}-`));
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
    provenanceId: `prov-v4-wb2b-${suffix}`,
    sourceType: 'manual',
    sourceRef: `test:v4-wb2b:${suffix}`,
    actor: 'v4-wb2b-contract-test',
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
    approvalId: `apr-v4-wb2b-${suffix}`,
  };
}

function inspect(source, recordId, workspaceId) {
  return inspectMemoryContext({ source, recordId, workspaceId });
}

function snapshot(kernel, workspaceId) {
  return JSON.stringify({
    nodes: kernel.graph.getNodes(workspaceId),
    edgeCount: kernel.graph.edgeCount(workspaceId),
    audit: kernel.graph.getAuditEvents({ workspaceId }),
  });
}

function fakeEvent(overrides = {}) {
  return {
    auditId: 'audit-fake',
    eventType: 'REVIEW',
    targetType: 'learn',
    targetId: 'fake',
    workspaceId: 'fake-workspace',
    actor: 'test',
    timestamp: FIXED_TIME,
    sourceRef: '',
    provenanceId: '',
    trustPolicyVersion: '1.0.0',
    details: {
      admissionOutcome: 'review',
      reason: 'approval_pending',
    },
    ...overrides,
  };
}

test('factory and input authority fail closed without fallback', () => {
  assert.throws(
    () => createMemoryContextAuditSource(null),
    (error) => error?.code === 'INVALID_AUDIT_OWNER',
  );
  assert.throws(
    () => createMemoryContextAuditSource({ getAuditEvents() { return []; } }, { maxAuditEvents: 0 }),
    (error) => error?.code === 'INVALID_AUDIT_SCAN_LIMIT',
  );

  let reads = 0;
  const source = createMemoryContextAuditSource({
    getAuditEvents() {
      reads += 1;
      return [];
    },
  });
  assert.deepEqual(Object.keys(source), ['readMemoryContext']);
  assert.equal(source.readMemoryContext(), null);
  assert.equal(source.readMemoryContext({ recordId: 'x' }), null);
  assert.equal(source.readMemoryContext({ workspaceId: 'x' }), null);
  assert.equal(source.readMemoryContext({ recordId: 'x', workspaceId: '   ' }), null);
  assert.equal(source.readMemoryContext({ recordId: ' x', workspaceId: 'x' }), null);
  assert.equal(source.readMemoryContext({ recordId: 'x ', workspaceId: 'x' }), null);
  assert.equal(source.readMemoryContext({ recordId: 'x', workspaceId: ' x' }), null);
  assert.equal(source.readMemoryContext({ recordId: 'x', workspaceId: 'x ' }), null);
  assert.equal(source.readMemoryContext({ recordId: 1, workspaceId: 'x' }), null);
  assert.equal(source.readMemoryContext({ recordId: 'x', workspaceId: 1 }), null);
  assert.equal(reads, 0);
});

test('real review admission maps through the adapter after SQLite reopen', () => {
  const root = fixtureRoot('review');
  let first;
  let reopened;
  try {
    first = openKernel(root);
    assert.equal(first.graph.getStats().backend, 'sqlite');
    const result = first.learn('kedi hayvandir', reviewOptions('wb2b-review', 'review'));
    assert.equal(result.data.admission.outcome, 'review');
    const event = first.graph.getAuditEvents({ workspaceId: 'wb2b-review' })[0];
    assert.ok(event?.auditId);

    closeKernel(first);
    first = null;
    reopened = openKernel(root, true);
    const source = createMemoryContextAuditSource(reopened.graph);
    const inspected = inspect(source, event.auditId, 'wb2b-review');

    assert.equal(inspected.ok, true);
    assert.equal(inspected.status, 'ok');
    assert.equal(inspected.memoryAdmission.status, 'review_required');
    assert.equal(inspected.memoryAdmission.decision, 'review');
    assert.equal(inspected.provenance.workspaceId, 'wb2b-review');
    assert.equal(inspected.provenance.traceId, null);
    assert.deepEqual(inspected.contextIntegrity.flags, ['workspace_scoped']);
  } finally {
    cleanup(root, first, reopened);
  }
});

test('real approved admission maps canonical mutation from durable edge evidence', () => {
  const root = fixtureRoot('approved');
  let first;
  let reopened;
  try {
    first = openKernel(root);
    const result = first.learn('kedi hayvandir', approvedOptions('wb2b-approved', 'approved'));
    assert.equal(result.data.admission.outcome, 'allow');
    const event = first.graph.getAuditEvents({ workspaceId: 'wb2b-approved' })
      .find((candidate) => candidate.targetType === 'edge');
    assert.ok(event?.auditId);

    closeKernel(first);
    first = null;
    reopened = openKernel(root, true);
    const source = createMemoryContextAuditSource(reopened.graph);
    const inspected = inspect(source, event.auditId, 'wb2b-approved');

    assert.equal(inspected.ok, true);
    assert.equal(inspected.memoryAdmission.status, 'admitted');
    assert.equal(inspected.memoryAdmission.decision, 'allow');
    assert.equal(inspected.provenance.receiptId, result.data.admission.receiptId);
    assert.equal(inspected.provenance.traceId, null);
    assert.deepEqual(inspected.contextIntegrity.flags, [
      'workspace_scoped',
      'canonical_mutation',
      'mutation_allowed',
    ]);
  } finally {
    cleanup(root, first, reopened);
  }
});

test('unknown and cross-workspace identifiers return not_found', () => {
  const root = fixtureRoot('workspace');
  let kernel;
  try {
    kernel = openKernel(root);
    kernel.learn('kedi hayvandir', reviewOptions('workspace-a', 'workspace-a'));
    const event = kernel.graph.getAuditEvents({ workspaceId: 'workspace-a' })[0];
    const source = createMemoryContextAuditSource(kernel.graph);

    assert.equal(inspect(source, 'missing-audit', 'workspace-a').status, 'not_found');
    assert.equal(inspect(source, event.auditId, 'workspace-b').status, 'not_found');
  } finally {
    cleanup(root, kernel);
  }
});

test('adapter read and inspector normalization do not mutate durable state', () => {
  const root = fixtureRoot('read-only');
  let kernel;
  try {
    kernel = openKernel(root);
    kernel.learn('kedi hayvandir', approvedOptions('wb2b-read-only', 'read-only'));
    const event = kernel.graph.getAuditEvents({ workspaceId: 'wb2b-read-only' })
      .find((candidate) => candidate.targetType === 'edge');
    const source = createMemoryContextAuditSource(kernel.graph);
    const before = snapshot(kernel, 'wb2b-read-only');

    assert.equal(inspect(source, event.auditId, 'wb2b-read-only').ok, true);
    assert.equal(snapshot(kernel, 'wb2b-read-only'), before);
  } finally {
    cleanup(root, kernel);
  }
});

test('malformed, duplicate and over-bound source results become read_error', () => {
  const malformed = createMemoryContextAuditSource({ getAuditEvents() { return {}; } });
  assert.equal(inspect(malformed, 'x', 'fake-workspace').status, 'read_error');

  const duplicate = createMemoryContextAuditSource({
    getAuditEvents() { return [fakeEvent(), fakeEvent()]; },
  });
  assert.equal(inspect(duplicate, 'audit-fake', 'fake-workspace').status, 'read_error');

  const bounded = createMemoryContextAuditSource({
    getAuditEvents() {
      return [fakeEvent(), fakeEvent({ auditId: 'audit-second' })];
    },
  }, { maxAuditEvents: 1 });
  assert.equal(inspect(bounded, 'audit-fake', 'fake-workspace').status, 'read_error');

  const malformedEvent = createMemoryContextAuditSource({ getAuditEvents() { return [null]; } });
  assert.equal(inspect(malformedEvent, 'x', 'fake-workspace').status, 'read_error');
});

test('maps audit and receipt trace ids into the memory-context record and provenance', () => {
  const fromDetails = fakeEvent({
    auditId: 'audit-trace-details',
    workspaceId: 'trace-workspace',
    details: {
      admissionOutcome: 'review',
      reason: 'approval_pending',
      traceId: 'trace-from-details',
      receiptId: 'receipt-from-details',
      receipt: {
        decision: 'review',
        traceId: 'trace-from-receipt',
        receiptId: 'receipt-from-receipt',
      },
    },
  });
  const fromReceipt = fakeEvent({
    auditId: 'audit-trace-receipt',
    workspaceId: 'trace-workspace',
    details: {
      admissionOutcome: 'allow',
      reason: 'approved',
      receipt: {
        decision: 'allow',
        traceId: 'trace-receipt-fallback',
        receiptId: 'receipt-receipt-fallback',
      },
    },
  });
  const source = createMemoryContextAuditSource({
    getAuditEvents(filters) {
      return [fromDetails, fromReceipt].filter((event) => (
        event.auditId === filters.auditId && event.workspaceId === filters.workspaceId
      ));
    },
  });

  const detailsRecord = source.readMemoryContext({
    recordId: fromDetails.auditId,
    workspaceId: fromDetails.workspaceId,
  });
  assert.equal(detailsRecord.traceId, 'trace-from-details');
  assert.equal(detailsRecord.memoryAdmission.traceId, 'trace-from-details');
  assert.equal(inspectMemoryContext({
    source,
    recordId: fromDetails.auditId,
    workspaceId: fromDetails.workspaceId,
  }).provenance.traceId, 'trace-from-details');

  const receiptRecord = source.readMemoryContext({
    recordId: fromReceipt.auditId,
    workspaceId: fromReceipt.workspaceId,
  });
  assert.equal(receiptRecord.traceId, 'trace-receipt-fallback');
  assert.equal(receiptRecord.memoryAdmission.traceId, 'trace-receipt-fallback');
  assert.equal(inspectMemoryContext({
    source,
    recordId: fromReceipt.auditId,
    workspaceId: fromReceipt.workspaceId,
  }).provenance.traceId, 'trace-receipt-fallback');
});

test('missing receipt stays null and provenance fields are not relabeled as traceId', () => {
  const root = fixtureRoot('minimal');
  let kernel;
  try {
    kernel = openKernel(root);
    const event = kernel.graph.appendAuditEvent({
      eventType: 'REVIEW',
      targetType: 'learn',
      targetId: 'minimal',
      workspaceId: 'wb2b-minimal',
      actor: 'test',
      sourceRef: 'source-not-trace',
      provenanceId: 'provenance-not-trace',
      details: {
        admissionOutcome: 'review',
        reason: 'manual_review',
      },
    });
    const source = createMemoryContextAuditSource(kernel.graph);
    const inspected = inspect(source, event.auditId, 'wb2b-minimal');

    assert.equal(inspected.ok, true);
    assert.equal(inspected.provenance.receiptId, null);
    assert.equal(inspected.provenance.traceId, null);
    assert.equal(JSON.stringify(inspected).includes('source-not-trace'), false);
    assert.equal(JSON.stringify(inspected).includes('provenance-not-trace'), false);
  } finally {
    cleanup(root, kernel);
  }
});
