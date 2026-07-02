'use strict';

/**
 * V4-PR2.6 - Receipt Materialization / Read Index.
 *
 * Proves PR3-API has a real prerequisite read path: admission receipts are
 * materialized as full receipt objects in the audit/log path and can be read
 * by receiptId without generating synthetic receipts.
 */

const fs = require('fs');
const path = require('path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const Kernel = require('../kernel');
const {
  buildMaterializedReceiptChain,
  exportMaterializedReceiptBundle,
  listMaterializedReceiptEntries,
  readReceiptById,
} = require('../lib/receipt/receipt-read-index');
const { validateReceiptChain } = require('../lib/receipt/receipt-chain');
const { verifyExportedBundle } = require('../lib/receipt/receipt-export');

function makeKernel() {
  return new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
}

function approvedAdmissionOpts(overrides = {}) {
  return {
    workspaceId: 'default',
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: overrides.approvalId || `apr-v4-pr2-6-${Math.random().toString(36).slice(2, 8)}`,
    provenance: {
      provenanceId: overrides.provenanceId || `prov-v4-pr2-6-${Math.random().toString(36).slice(2, 8)}`,
      sourceType: 'test',
      sourceRef: 'test:v4-pr2-6',
      actor: 'receipt-index-test',
      workspaceId: 'default',
      timestamp: overrides.timestamp || new Date().toISOString(),
      trustPolicyVersion: '1.0.0',
    },
  };
}

function learnApproved(kernel, text, overrides = {}) {
  const result = kernel.learn(text, approvedAdmissionOpts(overrides));
  assert.equal(result.ok, true);
  assert.equal(result.data.admission.outcome, 'allow');
  assert.ok(result.data.admission.receipt, 'learn admission must carry the full receipt for materialization');
  return result;
}

describe('V4-PR2.6: receipt materialization/read index', () => {
  it('real admission path produces and materializes a full receipt', () => {
    const kernel = makeKernel();
    const result = learnApproved(kernel, 'kedi hayvandir', { provenanceId: 'prov-materialized-1' });
    const receipt = result.data.admission.receipt;

    const entries = listMaterializedReceiptEntries(kernel.graph, { workspaceId: 'default' });
    const materialized = entries.find((entry) => entry.receipt.receiptId === receipt.receiptId);

    assert.ok(materialized, 'receipt must be materialized in the audit/log read index');
    assert.deepEqual(materialized.receipt, receipt, 'materialized receipt must be the original full receipt');
  });

  it('receiptId resolves to the same full receipt, not a reconstructed query receipt', () => {
    const kernel = makeKernel();
    const result = learnApproved(kernel, 'kopek hayvandir', { provenanceId: 'prov-read-1' });
    const receipt = result.data.admission.receipt;

    const read = readReceiptById(kernel.graph, receipt.receiptId, { workspaceId: 'default' });

    assert.equal(read.ok, true);
    assert.equal(read.status, 'found');
    assert.equal(read.chainStatus, 'valid');
    assert.deepEqual(read.receipt, receipt);
    assert.equal(read.canonicalPayload.receiptId, receipt.receiptId);
    assert.equal(read.chainedReceipt.receiptId, receipt.receiptId);
  });

  it('unknown receiptId returns not_found and never creates a synthetic receipt', () => {
    const kernel = makeKernel();
    learnApproved(kernel, 'kus hayvandir', { provenanceId: 'prov-unknown-1' });
    const before = listMaterializedReceiptEntries(kernel.graph, { workspaceId: 'default' }).length;

    const read = readReceiptById(kernel.graph, 'missing-receipt-id', { workspaceId: 'default' });
    const after = listMaterializedReceiptEntries(kernel.graph, { workspaceId: 'default' }).length;

    assert.equal(read.ok, false);
    assert.equal(read.status, 'not_found');
    assert.equal(read.error.code, 'NOT_FOUND');
    assert.equal(after, before, 'unknown reads must not materialize a placeholder receipt');
  });

  it('missing or empty receiptId fails closed without generating a new id', () => {
    const kernel = makeKernel();

    for (const candidate of ['', '   ', null, undefined]) {
      const read = readReceiptById(kernel.graph, candidate, { workspaceId: 'default' });
      assert.equal(read.ok, false);
      assert.equal(read.status, 'invalid_request');
      assert.equal(read.receiptId, '');
      assert.equal(read.error.code, 'RECEIPT_ID_REQUIRED');
    }
  });

  it('returned receipts are copies and cannot mutate the stored receipt', () => {
    const kernel = makeKernel();
    const result = learnApproved(kernel, 'kaplan hayvandir', { provenanceId: 'prov-clone-1' });
    const receiptId = result.data.admission.receipt.receiptId;

    const firstRead = readReceiptById(kernel.graph, receiptId, { workspaceId: 'default' });
    firstRead.receipt.reason = 'client-side mutation';

    const secondRead = readReceiptById(kernel.graph, receiptId, { workspaceId: 'default' });
    assert.notEqual(secondRead.receipt.reason, 'client-side mutation');
    assert.deepEqual(secondRead.receipt, result.data.admission.receipt);
  });

  it('incomplete materialized receipt is not treated as valid', () => {
    const incompleteReceipt = {
      receiptId: 'receipt-incomplete',
      decision: 'allow',
      status: 'admitted',
    };
    const auditEvents = [{
      auditId: 'audit-incomplete',
      eventType: 'LEARN',
      targetType: 'edge',
      targetId: 'a|tur|b',
      workspaceId: 'default',
      timestamp: '2026-07-02T00:00:00.000Z',
      details: { receipt: incompleteReceipt },
    }];

    const read = readReceiptById(auditEvents, 'receipt-incomplete', { workspaceId: 'default' });

    assert.equal(read.ok, false);
    assert.equal(read.status, 'invalid');
    assert.equal(read.error.code, 'INVALID_RECEIPT');
    assert.match(read.error.message, /receipt\.receiptKind|receipt\.admissionId/);
  });

  it('chain validation and export operate over stored real receipts', () => {
    const kernel = makeKernel();
    learnApproved(kernel, 'balik hayvandir', { provenanceId: 'prov-chain-1' });
    learnApproved(kernel, 'ari hayvandir', { provenanceId: 'prov-chain-2' });

    const chainResult = buildMaterializedReceiptChain(kernel.graph, { workspaceId: 'default' });
    assert.equal(chainResult.ok, true);
    assert.ok(chainResult.chain.length >= 2);
    assert.deepEqual(validateReceiptChain(chainResult.chain), {
      valid: true,
      brokenAt: null,
      reason: null,
    });

    const tampered = chainResult.chain.map((record) => ({ ...record }));
    tampered[0].reason = 'tampered after materialization';
    assert.equal(validateReceiptChain(tampered).valid, false);

    const exported = exportMaterializedReceiptBundle(kernel.graph, { workspaceId: 'default' });
    assert.equal(exported.ok, true);
    assert.equal(verifyExportedBundle(exported.bundle).valid, true);
  });

  it('does not add PR3 API or CLI surfaces', () => {
    const serverSource = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const cliSource = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');

    assert.equal(serverSource.includes('/v4/receipts'), false, 'PR2.6 must not add the PR3 API endpoint');
    assert.equal(cliSource.includes('receipt show'), false, 'PR2.6 must not add a receipt CLI command');
    assert.equal(cliSource.includes('receipt chain'), false, 'PR2.6 must not add a receipt CLI command');
  });
});
