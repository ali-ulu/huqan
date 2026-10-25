'use strict';

// #4232 (CWE-345): the read index presented receipt metadata that the durable
// chain does not bind.
//
// `mutationOperationId` and `committedAt` are added to the *durable* payload
// (lib/graph-mutation-receipt-write.js writes the row; lib/conflict-detector.js
// and lib/kernel-learn-transaction.js fold them in) and are deliberately absent
// from the audit projection -- which is why `sameCanonicalReceipt` strips them
// before comparing. `readReceiptById` built `canonicalPayload` from the audit
// entry and returned it under `authoritative: true` once the chain validated,
// so editing those two fields in the projection changed what a caller saw
// while every chain check still passed.
//
// The read now presents the payload the chain actually binds.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');
const { readReceiptById } = require('../lib/receipt/receipt-read-index');

function makeKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4232-'));
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: true,
    loadPlugins: false,
    memoryPath: path.join(dir, 'memory.json'),
    dbPath: path.join(dir, 'memory.db'),
  });
  return { kernel, dir };
}

function learn(kernel, text, provenanceId) {
  const result = kernel.learn(text, {
    workspaceId: 'default',
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: `apr-${provenanceId}`,
    provenance: {
      provenanceId,
      sourceType: 'test',
      sourceRef: 'test:4232',
      actor: 'receipt-index-test',
      workspaceId: 'default',
      timestamp: new Date().toISOString(),
      trustPolicyVersion: '1.0.0',
    },
  });
  assert.equal(result.ok, true);
  return result.data.admission.receipt;
}

test('the read presents the durable metadata the chain binds, not the audit copy (#4232)', (t) => {
  const { kernel, dir } = makeKernel();
  t.after(() => {
    try { kernel.graph.close?.(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const receipt = learn(kernel, 'kedi hayvandir', 'prov-4232-durable');
  const durable = kernel.graph.getCommittedMutationReceiptById(receipt.receiptId);
  assert.ok(durable?.canonicalPayload, 'the durable receipt must be readable');

  // The durable row carries the mutation identity; the audit projection does
  // not. That asymmetry is the whole reason the fields were stripped from the
  // equality check.
  assert.match(durable.canonicalPayload.metadata.mutationOperationId, /^auto-mut-/);
  assert.equal(typeof durable.canonicalPayload.metadata.committedAt, 'string');

  const read = readReceiptById(kernel.graph, receipt.receiptId, { workspaceId: 'default' });
  assert.equal(read.status, 'found');
  assert.equal(read.authoritative, true);
  assert.equal(read.canonicalPayload.metadata.mutationOperationId,
    durable.canonicalPayload.metadata.mutationOperationId,
    'the presented mutation identity must be the one the chain binds');
  assert.equal(read.canonicalPayload.metadata.committedAt,
    durable.canonicalPayload.metadata.committedAt);
  assert.equal(read.canonicalPayload.metadata.mutationOperationId,
    read.chainedReceipt.metadata.mutationOperationId,
    'the presented payload and the chain record must agree');

  // The chain plumbing is not part of the canonical payload.
  assert.equal(Object.hasOwn(read.canonicalPayload, 'receiptHash'), false);
  assert.equal(Object.hasOwn(read.canonicalPayload, 'previousReceiptHash'), false);
});

test('editing the audit projection cannot change the authoritative metadata (#4232)', (t) => {
  const { kernel, dir } = makeKernel();
  t.after(() => {
    try { kernel.graph.close?.(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const receipt = learn(kernel, 'kopek hayvandir', 'prov-4232-projection');
  const durableBefore = kernel.graph.getCommittedMutationReceiptById(receipt.receiptId).canonicalPayload;

  // Tamper only the audit projection: the durable chain is untouched.
  const event = kernel.graph._auditEvents
    .find((candidate) => candidate.details?.receipt?.receiptId === receipt.receiptId);
  assert.ok(event, 'the materialization audit event must exist');
  event.details.receipt.metadata = {
    ...(event.details.receipt.metadata || {}),
    mutationOperationId: 'op-FORGED',
    committedAt: '2030-01-01T00:00:00.000Z',
  };
  // Force the entries cache to re-read the projection.
  kernel.graph.appendAuditEvent({
    eventType: 'noise', targetType: 'node', targetId: 'n1', workspaceId: 'default',
    timestamp: '2026-01-01T00:00:05.000Z', details: {},
  }, { workspaceId: 'default' });

  const read = readReceiptById(kernel.graph, receipt.receiptId, { workspaceId: 'default' });
  assert.equal(read.status, 'found', 'the durable chain is intact, so the receipt stays readable');
  assert.equal(read.canonicalPayload.metadata.mutationOperationId,
    durableBefore.metadata.mutationOperationId,
    'the forged projection value must not be presented as authoritative');
  assert.notEqual(read.canonicalPayload.metadata.mutationOperationId, 'op-FORGED');
  assert.notEqual(read.canonicalPayload.metadata.committedAt, '2030-01-01T00:00:00.000Z');
});
