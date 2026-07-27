'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const AxiomStorage = require('../storage');

test('expired HTTP ingest lease becomes visible failed state without re-execution', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-ingest-recovery-'));
  const memoryPath = path.join(tempDir, 'memory.json');
  const dbPath = path.join(tempDir, 'memory.db');
  const store = new AxiomStorage({ memoryPath, dbPath });
  let now = 10_000;
  store._now = () => now;

  try {
    const saved = store.saveToolApprovalIfAbsent({
      id: 'ingest-recovery-1',
      approvalKey: 'http.ingest.recovery-1',
      tool: 'http.ingest',
      input: '{"text":"sentinel"}',
      context: { snapshot: { snapshotHash: 'sha256:sentinel' } },
      status: 'pending',
      decision: 'review',
      reason: 'http_ingest_requires_review',
    });
    assert.equal(saved.inserted, true);

    const claim = store.claimToolApprovalWithLease(saved.approval.id, {
      owner: 'worker-a', leaseMs: 1_000,
    });
    assert.equal(claim.claimed, true);
    assert.equal(claim.approval.status, 'executing');
    assert.equal(claim.approval.context.executionClaim.owner, 'worker-a');

    now = 10_500;
    assert.equal(store.renewToolApprovalLease(saved.approval.id, 'worker-a', 1_000).renewed, true);
    assert.deepEqual(store.recoverExpiredToolApprovals({ tool: 'http.ingest', now: 11_499 }), []);

    now = 11_500;
    const recovered = store.recoverExpiredToolApprovals({
      tool: 'http.ingest', now, reason: 'execution_outcome_unknown:lease_expired',
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, 'failed');
    assert.equal(recovered[0].decision, 'execution_outcome_unknown');
    assert.equal(recovered[0].reason, 'execution_outcome_unknown:lease_expired');
    assert.equal(recovered[0].context.executionClaim.owner, 'worker-a');

    assert.equal(store.claimToolApprovalWithLease(saved.approval.id, { owner: 'worker-b' }).claimed, false);
    assert.equal(store.getToolApprovalById(saved.approval.id).status, 'failed');
  } finally {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
