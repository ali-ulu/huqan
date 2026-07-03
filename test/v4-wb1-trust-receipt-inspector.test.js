'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Kernel = require('../kernel');
const { inspectTrustReceipt } = require('../lib/workbench/trust-receipt-inspector');
const { listMaterializedReceiptEntries } = require('../lib/receipt/receipt-read-index');

function makeKernel() {
  return new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
}

function approvedAdmissionOpts(workspaceId, overrides = {}) {
  return {
    workspaceId,
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: overrides.approvalId || `apr-v4-wb1-${Math.random().toString(36).slice(2, 8)}`,
    provenance: {
      provenanceId: overrides.provenanceId || `prov-v4-wb1-${Math.random().toString(36).slice(2, 8)}`,
      sourceType: 'test',
      sourceRef: 'test:v4-wb1-inspector',
      actor: 'wb1-inspector-test',
      workspaceId,
      timestamp: overrides.timestamp || new Date().toISOString(),
      trustPolicyVersion: '1.0.0',
    },
  };
}

function learnApproved(kernel, text, workspaceId, overrides = {}) {
  const result = kernel.learn(text, approvedAdmissionOpts(workspaceId, overrides));
  assert.equal(result.ok, true);
  assert.equal(result.data.admission.outcome, 'allow');
  assert.ok(result.data.admission.receipt);
  return result.data.admission.receipt;
}

function graphSnapshot(kernel, workspaceId) {
  return {
    nodes: kernel.graph.getNodes({ workspaceId }),
    edges: kernel.graph.getEdges({ workspaceId }),
    auditEvents: kernel.graph.getAuditEvents({ workspaceId }),
    receiptCount: listMaterializedReceiptEntries(kernel.graph, { workspaceId }).length,
  };
}

describe('V4-WB1: read-only Trust Receipt / Verdict Inspector helper', () => {
  it('missing receiptId returns explicit invalid_request', () => {
    const result = inspectTrustReceipt({ source: makeKernel().graph, receiptId: '   ' });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'invalid_request');
    assert.equal(result.reason, 'receiptId_required');
    assert.deepEqual(result.missingFields, ['receiptId']);
    assert.equal(result.source.readOnly, true);
  });

  it('unknown receiptId returns not_found without fake receipt data', () => {
    const kernel = makeKernel();
    learnApproved(kernel, 'serce hayvandir', 'wb1-unknown', { provenanceId: 'prov-wb1-unknown' });

    const result = inspectTrustReceipt({ source: kernel.graph, receiptId: 'missing-receipt-id', workspaceId: 'wb1-unknown' });

    assert.equal(result.ok, false);
    assert.equal(result.status, 'not_found');
    assert.equal(result.reason, 'receipt_not_found');
    assert.equal(result.receipt, undefined);
    assert.equal(result.verdict, undefined);
    assert.equal(result.source.readOnly, true);
  });

  it('inspects a real materialized receipt through the receipt read index', () => {
    const kernel = makeKernel();
    const receipt = learnApproved(kernel, 'atmaca hayvandir', 'wb1-real', { provenanceId: 'prov-wb1-real' });

    const result = inspectTrustReceipt({ source: kernel.graph, receiptId: receipt.receiptId, workspaceId: 'wb1-real' });

    assert.equal(result.ok, true);
    assert.equal(result.status, 'found');
    assert.equal(result.receiptId, receipt.receiptId);
    assert.equal(result.workspaceId, 'wb1-real');
    assert.deepEqual(result.receipt, receipt);
    assert.equal(result.source.kind, 'trust_receipt_read_index');
    assert.equal(result.source.readOnly, true);
  });

  it('exposes verdict and reason fields from real receipt data', () => {
    const kernel = makeKernel();
    const receipt = learnApproved(kernel, 'kartal hayvandir', 'wb1-verdict', { provenanceId: 'prov-wb1-verdict' });

    const result = inspectTrustReceipt({ source: kernel.graph, receiptId: receipt.receiptId, workspaceId: 'wb1-verdict' });

    assert.equal(result.verdict, 'allow');
    assert.equal(result.reason, 'provenance_present_low_risk');
    assert.equal(result.actor, 'wb1-inspector-test');
    assert.equal(result.timestamp, receipt.createdAt);
    assert.equal(result.chainStatus, 'valid');
  });

  it('reports missing optional inspector fields without synthesizing them', () => {
    const kernel = makeKernel();
    const receipt = learnApproved(kernel, 'doğan hayvandir', 'wb1-missing', { provenanceId: 'prov-wb1-missing' });

    const result = inspectTrustReceipt({ source: kernel.graph, receiptId: receipt.receiptId, workspaceId: 'wb1-missing' });

    assert.ok(result.missingFields.includes('action'));
    assert.ok(result.missingFields.includes('tool'));
    assert.ok(result.missingFields.includes('claim'));
    assert.ok(result.missingFields.includes('traceId'));
    assert.equal(result.action, '');
    assert.equal(result.tool, '');
  });

  it('does not create a new receipt during inspection', () => {
    const kernel = makeKernel();
    const workspaceId = 'wb1-no-new-receipt';
    const receipt = learnApproved(kernel, 'baykus hayvandir', workspaceId, { provenanceId: 'prov-wb1-no-new-receipt' });
    const before = listMaterializedReceiptEntries(kernel.graph, { workspaceId }).length;

    const result = inspectTrustReceipt({ source: kernel.graph, receiptId: receipt.receiptId, workspaceId });
    const after = listMaterializedReceiptEntries(kernel.graph, { workspaceId }).length;

    assert.equal(result.ok, true);
    assert.equal(after, before);
  });

  it('does not mutate memory, graph, or audit state during inspection', () => {
    const kernel = makeKernel();
    const workspaceId = 'wb1-readonly';
    const receipt = learnApproved(kernel, 'turna hayvandir', workspaceId, { provenanceId: 'prov-wb1-readonly' });
    const before = graphSnapshot(kernel, workspaceId);

    const result = inspectTrustReceipt({ source: kernel.graph, receiptId: receipt.receiptId, workspaceId });
    const after = graphSnapshot(kernel, workspaceId);

    assert.equal(result.ok, true);
    assert.deepEqual(after, before);
  });

  it('returned receipt mutation cannot mutate internal stored state', () => {
    const kernel = makeKernel();
    const workspaceId = 'wb1-clone';
    const receipt = learnApproved(kernel, 'anka hayvandir', workspaceId, { provenanceId: 'prov-wb1-clone' });

    const first = inspectTrustReceipt({ source: kernel.graph, receiptId: receipt.receiptId, workspaceId });
    first.receipt.reason = 'client mutation';
    first.canonicalPayload.reason = 'client mutation';

    const second = inspectTrustReceipt({ source: kernel.graph, receiptId: receipt.receiptId, workspaceId });
    assert.equal(second.receipt.reason, receipt.reason);
    assert.equal(second.canonicalPayload.reason, receipt.reason);
  });

  it('respects workspace boundary for explicit workspace filters', () => {
    const kernel = makeKernel();
    const receipt = learnApproved(kernel, 'leylek hayvandir', 'wb1-right-workspace', { provenanceId: 'prov-wb1-boundary' });

    const wrongWorkspace = inspectTrustReceipt({
      source: kernel.graph,
      receiptId: receipt.receiptId,
      workspaceId: 'wb1-wrong-workspace',
    });
    const noWorkspace = inspectTrustReceipt({ source: kernel.graph, receiptId: receipt.receiptId });

    assert.equal(wrongWorkspace.ok, false);
    assert.equal(wrongWorkspace.status, 'not_found');
    assert.equal(wrongWorkspace.receipt, undefined);
    assert.equal(noWorkspace.ok, true);
    assert.equal(noWorkspace.receiptId, receipt.receiptId);
  });
});
