const { describe, it } = require('node:test');
const assert = require('node:assert');
const { buildCanonicalReceiptPayload } = require('../lib/receipt/canonical-receipt');
const { appendReceiptToChain } = require('../lib/receipt/receipt-chain');
const {
  BUNDLE_SEAL_VERSION,
  exportReceiptBundle,
  verifyExportedBundle,
} = require('../lib/receipt/receipt-export');

function receipt(index) {
  return buildCanonicalReceiptPayload({
    receiptId: `receipt-${index}`,
    receiptKind: 'memory_admission',
    decision: 'allow',
    status: 'admitted',
    admissionId: `admission-${index}`,
    workspaceId: 'workspace-alpha',
    actor: 'operator',
    agentId: 'agent',
    memoryDraftId: `draft-${index}`,
    provenanceId: `provenance-${index}`,
    trustPolicyVersion: '1.0.0',
    approvalId: `approval-${index}`,
    approvalStatus: 'approved',
    reason: 'seal-fixture',
    riskScore: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    metadata: {},
  }, { verdict: 'allow' });
}

function chain(length = 3) {
  const records = [];
  let previous = null;
  for (let i = 0; i < length; i++) {
    const record = appendReceiptToChain(receipt(i), previous);
    records.push(record);
    previous = record.receiptHash;
  }
  return records;
}

function freshBundle() {
  return exportReceiptBundle(chain(), {
    workspaceId: 'workspace-alpha',
    exportedAt: '2026-01-01T00:00:00.000Z',
  });
}

describe('receipt bundle envelope is authenticated (#735, #767)', () => {
  it('names the seal so an external verifier can reproduce the hash input', () => {
    const bundle = freshBundle();
    assert.strictEqual(bundle.sealVersion, BUNDLE_SEAL_VERSION);
    const verdict = verifyExportedBundle(bundle);
    assert.strictEqual(verdict.valid, true);
    assert.strictEqual(verdict.envelopeAuthenticated, true);
    assert.strictEqual(verdict.receiptCountValid, true);
  });

  it('rejects a bundle relabelled to another workspace', () => {
    const bundle = { ...freshBundle(), workspaceId: 'workspace-victim' };
    const verdict = verifyExportedBundle(bundle);
    assert.strictEqual(verdict.valid, false);
    assert.strictEqual(verdict.bundleHashValid, false);
  });

  it('rejects a rewritten export timestamp', () => {
    const bundle = { ...freshBundle(), exportedAt: '2030-06-01T12:00:00.000Z' };
    const verdict = verifyExportedBundle(bundle);
    assert.strictEqual(verdict.valid, false);
    assert.strictEqual(verdict.bundleHashValid, false);
  });

  it('rejects a false receipt count on both the seal and the count check', () => {
    const bundle = { ...freshBundle(), receiptCount: 99 };
    const verdict = verifyExportedBundle(bundle);
    assert.strictEqual(verdict.valid, false);
    assert.strictEqual(verdict.bundleHashValid, false);
    assert.strictEqual(verdict.receiptCountValid, false);
  });

  it('rejects a rewritten schema version', () => {
    const bundle = { ...freshBundle(), schemaVersion: 'v4-receipt-bundle-v2' };
    assert.strictEqual(verifyExportedBundle(bundle).valid, false);
  });

  it('still detects receipt-array tampering', () => {
    const bundle = freshBundle();
    bundle.receipts[1] = { ...bundle.receipts[1], decision: 'block' };
    const verdict = verifyExportedBundle(bundle);
    assert.strictEqual(verdict.valid, false);
    assert.strictEqual(verdict.bundleHashValid, false);
    assert.strictEqual(verdict.chainValidation.valid, false);
  });

  it('still detects a broken chain link', () => {
    const records = chain();
    records[2] = { ...records[2], previousReceiptHash: records[0].receiptHash };
    const bundle = exportReceiptBundle(chain(), { workspaceId: 'workspace-alpha' });
    bundle.receipts[2] = records[2];
    assert.strictEqual(verifyExportedBundle(bundle).chainValidation.valid, false);
  });

  it('two exports of the same receipts at different times differ', () => {
    const records = chain();
    const first = exportReceiptBundle(records, { workspaceId: 'w', exportedAt: '2026-01-01T00:00:00.000Z' });
    const second = exportReceiptBundle(records, { workspaceId: 'w', exportedAt: '2026-02-01T00:00:00.000Z' });
    assert.notStrictEqual(first.bundleHash, second.bundleHash,
      'exportedAt is inside the seal, so the digests must differ');
    assert.strictEqual(verifyExportedBundle(first).valid, true);
    assert.strictEqual(verifyExportedBundle(second).valid, true);
  });

  describe('legacy receipts-only seal', () => {
    /** A bundle as the previous format produced it: no sealVersion. */
    function legacyBundle() {
      const { stableStringify, sha256Hex } = require('../lib/receipt/canonical-receipt');
      const records = chain();
      return {
        schemaVersion: 'v4-receipt-bundle-v1',
        workspaceId: 'workspace-alpha',
        exportedAt: '2026-01-01T00:00:00.000Z',
        receiptCount: records.length,
        bundleHash: sha256Hex(stableStringify(records)),
        receipts: records,
      };
    }

    it('is not valid by default', () => {
      const verdict = verifyExportedBundle(legacyBundle());
      assert.strictEqual(verdict.valid, false);
      assert.strictEqual(verdict.bundleHashValid, true, 'its own seal is intact');
      assert.strictEqual(verdict.sealVersionAcceptable, false);
      assert.strictEqual(verdict.envelopeAuthenticated, false);
    });

    it('verifies only when the caller explicitly opts in, and is told the envelope is unauthenticated', () => {
      const verdict = verifyExportedBundle(legacyBundle(), { allowUnsealedEnvelope: true });
      assert.strictEqual(verdict.valid, true);
      assert.strictEqual(verdict.envelopeAuthenticated, false);
    });

    it('a relabelled legacy envelope still passes its own seal, which is why the envelope is not trusted', () => {
      const bundle = { ...legacyBundle(), workspaceId: 'workspace-victim' };
      const verdict = verifyExportedBundle(bundle, { allowUnsealedEnvelope: true });
      assert.strictEqual(verdict.bundleHashValid, true);
      assert.strictEqual(verdict.envelopeAuthenticated, false,
        'the caller must be told this envelope proves nothing');
    });

    it('a legacy bundle with an inconsistent receiptCount is rejected even when opted in', () => {
      const bundle = { ...legacyBundle(), receiptCount: 99 };
      const verdict = verifyExportedBundle(bundle, { allowUnsealedEnvelope: true });
      assert.strictEqual(verdict.valid, false);
      assert.strictEqual(verdict.receiptCountValid, false);
    });
  });
});
