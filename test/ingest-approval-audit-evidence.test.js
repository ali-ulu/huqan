'use strict';

/**
 * Audit persistence is part of ingest-approval completion (#769).
 *
 * safeAudit() caught every audit failure and turned it into an empty auditRef,
 * and both the approved and the rejected path returned HTTP 200 / ok:true
 * anyway. On the approved path that happened after the ingest capability may
 * already have mutated the Graph and after the approval was finalized with a
 * receipt: a committed mutation with no audit trail, reported to the product
 * as ordinary success. Audit availability failed open on the one path a human
 * had explicitly approved.
 *
 * The owner is driven directly with injected dependencies, which is the only
 * way to reach a branch a healthy audit sink never takes.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, before, after } = require('node:test');

const Kernel = require('../kernel');
const { decideIngestApproval } = require('../lib/workbench/ingest-approval-action');
const { auditOrGap, recordAuditEvidence } = require('../lib/workbench/ingest-approval-audit');
const { buildIngestApprovalSnapshot } = require('../lib/ingest');

let tempDir;
let kernel;

before(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-ingest-audit-'));
  kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, 'memory.json'),
    dbPath: path.join(tempDir, 'memory.db'),
  });
});

after(() => {
  try { kernel.graph.close(); } catch (_) {}
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

function payload(suffix) {
  return {
    sourceType: 'manual',
    sourceRef: `manual://audit-${suffix}`,
    workspaceId: 'default',
    entries: [{ entryKey: `entry-${suffix}`, content: `kedi ${suffix} hayvandir` }],
  };
}

function pendingApproval(id, suffix) {
  const snapshot = buildIngestApprovalSnapshot(payload(suffix));
  assert.equal(snapshot.ok, true, 'fixture snapshot must build');
  return {
    id,
    tool: 'http.ingest',
    status: 'pending',
    decision: 'review',
    context: { source: 'http-ingest', snapshot },
  };
}

function fakeStore(approval) {
  const calls = { finalized: [], failed: [] };
  return {
    calls,
    record: approval,
    getToolApprovalById: () => approval,
    claimToolApprovalWithLease: () => ({ claimed: true, approval }),
    renewToolApprovalLease: () => ({ renewed: true }),
    failToolApproval: (id, reason) => { calls.failed.push(reason); },
    finalizeToolApprovalWithReceipt: (id, opts) => {
      calls.finalized.push(opts);
      return { finalized: true, approval };
    },
  };
}

/** An ingest result with operation-owned evidence and no observed write. */
function allowResult(approval) {
  const workspaceId = approval.context.snapshot.workspaceId;
  return {
    ok: true,
    admission: {
      outcome: 'allow',
      graphWrite: false,
      evidence: [{
        workspaceId,
        receiptId: `receipt-${approval.id}`,
        auditId: `audit-${approval.id}`,
        graphWrite: false,
      }],
    },
  };
}

function deps({ store, decision = 'approved', recordAudit }) {
  return {
    store,
    kernel,
    approvalId: store.record.id,
    decision,
    handleIngest: async () => allowResult(store.record),
    ensureRuntime: () => {},
    recordAudit,
    toPublicApproval: (record) => ({ id: record.id, status: record.status }),
    workerId: 'ingest-audit-test',
    leaseMs: 60_000,
  };
}

const FAILING_SINKS = [
  ['throws', () => { throw new Error('hostile audit sink detail'); }, 'audit_append_failed'],
  ['returns no auditId', () => ({}), 'audit_reference_missing'],
  ['returns an empty auditId', () => ({ auditId: '   ' }), 'audit_reference_missing'],
  ['returns nothing at all', () => undefined, 'audit_reference_missing'],
];

describe('an approved ingest without audit evidence is not ordinary success (#769)', () => {
  for (const [label, recordAudit, expectedState] of FAILING_SINKS) {
    it(`reports reconciliation when the audit sink ${label}`, async () => {
      const store = fakeStore(pendingApproval(`approved-${expectedState}-${label.length}`, 'approved'));
      const outcome = await decideIngestApproval(deps({ store, recordAudit }));

      assert.notEqual(outcome.status, 200, 'a missing audit trail was reported as success');
      assert.equal(outcome.status, 409);
      assert.equal(outcome.json.ok, false);
      assert.equal(outcome.json.status, 'reconciliation_required');
      assert.equal(outcome.json.error.code, 'AUDIT_EVIDENCE_MISSING');
      assert.equal(outcome.json.reconciliation.state, expectedState);
      assert.equal(outcome.json.reconciliation.committed, 'ingest_executed_and_approval_finalized');
      // The approval really was finalized: this is a partial commit, and the
      // response has to say which one.
      assert.equal(store.calls.finalized.length, 1);
      assert.equal(store.calls.finalized[0].decision, 'approved');
    });
  }

  it('carries the identifiers an operator needs, and no raw sink error', async () => {
    const store = fakeStore(pendingApproval('approved-identifiers', 'ids'));
    const outcome = await decideIngestApproval(deps({
      store,
      recordAudit: () => { throw new Error('hostile audit sink detail'); },
    }));

    const { reconciliation } = outcome.json;
    assert.equal(reconciliation.approvalId, store.record.id);
    assert.match(reconciliation.receiptId, /\S/);
    assert.equal(reconciliation.decision, 'approved');
    assert.match(reconciliation.actionOutcome, /^admission_allow_/);
    assert.doesNotMatch(JSON.stringify(outcome), /hostile audit sink detail/);
  });

  it('does not ask for a retry, so an approved ingest is never run twice', async () => {
    const store = fakeStore(pendingApproval('approved-no-retry', 'retry'));
    let ingestRuns = 0;
    const outcome = await decideIngestApproval({
      ...deps({ store, recordAudit: () => ({}) }),
      handleIngest: async () => { ingestRuns += 1; return allowResult(store.record); },
    });

    assert.equal(ingestRuns, 1);
    assert.equal(outcome.json.reconciliation.retry, false);
    // The finalized approval is left alone: it is committed, not failed.
    assert.deepEqual(store.calls.failed, []);
  });

  it('still succeeds, with its reference, when the audit sink works', async () => {
    const store = fakeStore(pendingApproval('approved-ok', 'ok'));
    const outcome = await decideIngestApproval(deps({
      store,
      recordAudit: () => ({ auditId: 'audit-1' }),
    }));

    assert.equal(outcome.status, 200);
    assert.equal(outcome.json.ok, true);
    assert.equal(outcome.json.auditRef, 'audit-1');
  });
});

describe('a rejected ingest without audit evidence is not ordinary success (#769)', () => {
  it('reports reconciliation rather than a clean rejection', async () => {
    const store = fakeStore(pendingApproval('rejected-gap', 'rejected'));
    const outcome = await decideIngestApproval(deps({
      store,
      decision: 'rejected',
      recordAudit: () => { throw new Error('hostile audit sink detail'); },
    }));

    assert.equal(outcome.status, 409);
    assert.equal(outcome.json.ok, false);
    assert.equal(outcome.json.error.code, 'AUDIT_EVIDENCE_MISSING');
    assert.equal(outcome.json.reconciliation.committed, 'approval_rejected');
    assert.equal(outcome.json.reconciliation.decision, 'rejected');
    assert.equal(store.calls.finalized[0].decision, 'rejected');
  });

  it('still succeeds, with its reference, when the audit sink works', async () => {
    const store = fakeStore(pendingApproval('rejected-ok', 'rok'));
    const outcome = await decideIngestApproval(deps({
      store,
      decision: 'rejected',
      recordAudit: () => ({ auditId: 'audit-2' }),
    }));

    assert.equal(outcome.status, 200);
    assert.equal(outcome.json.ok, true);
    assert.equal(outcome.json.auditRef, 'audit-2');
  });
});

describe('the audit evidence helper itself (#769)', () => {
  it('separates a durable reference from every way of not having one', () => {
    assert.deepEqual(
      recordAuditEvidence(() => ({ auditId: ' audit-3 ' }), {}, {}, null),
      { ok: true, auditRef: 'audit-3' }
    );
    for (const sink of [() => ({}), () => null, () => 'audit-4', () => ({ auditId: 42 })]) {
      assert.equal(recordAuditEvidence(sink, {}, {}, null).ok, false);
    }
  });

  it('hands back the gap instead of a reference when the append fails', () => {
    const audited = auditOrGap(() => ({}), {
      approval: { id: 'approval-9' },
      receipt: { receiptId: 'receipt-9', decision: 'approved', actionOutcome: 'x' },
      result: null,
      committed: 'test_committed',
      message: 'test message',
    });

    assert.equal(audited.auditRef, '');
    assert.equal(audited.gap.status, 409);
    assert.equal(audited.gap.json.reconciliation.approvalId, 'approval-9');
    assert.equal(audited.gap.json.reconciliation.receiptId, 'receipt-9');
  });
});
