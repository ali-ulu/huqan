'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const {
  TRUST_EVIDENCE_SCHEMA_VERSION,
  buildTrustEvidencePayload,
  createTrustEvidenceLedger,
  verifyTrustEvidenceReceipt,
} = require('../lib/trust-evidence-ledger');
const {
  createIngestApprovalAuditWriter,
} = require('../lib/workbench/ingest-approval-audit-writer');
const { absent, createMutationAdmission } = require('../lib/mutation-admission');

function makeTempGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-trust-ledger-'));
  const graph = new Graph({
    useSQLite: false,
    memoryPath: path.join(dir, 'memory.json'),
  });
  return { graph, dir };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function event(operationId, overrides = {}) {
  return {
    workspaceId: 'workspace-a',
    operationId,
    decision: 'allow',
    reason: 'policy_allow',
    actionFingerprint: `action-${operationId}`,
    identityRef: 'agent:worker-a',
    identityHash: 'hash-agent-a',
    authorityRef: 'authority:workspace-a',
    delegationRef: 'delegation:root',
    policyVersion: 'policy-v1',
    firewallVersion: 'agent-action-firewall-v1',
    connectorRef: 'connector:mcp-tool',
    resourceRef: 'resource:graph',
    approvalRef: '',
    executionOutcome: 'applied',
    sourceRefs: ['snapshot:abc'],
    provenanceRefs: ['prov:abc'],
    createdAt: '2026-08-19T10:00:00.000Z',
    metadata: { bounded: true },
    ...overrides,
  };
}

test('ledger payload is deterministic, bounded, and does not admit raw secrets', () => {
  const first = buildTrustEvidencePayload(event('op-1'));
  const second = buildTrustEvidencePayload({ ...event('op-1'), metadata: { bounded: true } });

  assert.equal(first.schemaVersion, TRUST_EVIDENCE_SCHEMA_VERSION);
  assert.equal(first.receiptKind, 'trust_evidence');
  assert.equal(first.receiptId, second.receiptId);
  assert.equal(first.eventId, second.eventId);
  assert.throws(() => buildTrustEvidencePayload({ ...event('op-2'), prompt: 'do not persist' }), /forbidden/);
  assert.throws(() => buildTrustEvidencePayload({ ...event('op-2'), unknownField: 'nope' }), /unknown trust evidence field/);
  assert.throws(() => buildTrustEvidencePayload({ ...event('op-2'), metadata: { token: 'secret' } }), /forbidden/);
});

test('ledger appends through Graph durability, returns a verified receipt, and replays idempotently', () => {
  const { graph, dir } = makeTempGraph();
  try {
    const ledger = createTrustEvidenceLedger({ graph });
    let mutations = 0;

    const first = ledger.append({
      operationId: 'trust-evidence:op-1',
      event: event('trust-evidence:op-1'),
      mutate: () => { mutations += 1; return { applied: true }; },
    });

    assert.equal(mutations, 1);
    assert.equal(first.replayed, false);
    assert.equal(first.receipt.canonicalPayload.receiptKind, 'trust_evidence');
    assert.equal(first.receipt.canonicalPayload.schemaVersion, TRUST_EVIDENCE_SCHEMA_VERSION);
    assert.equal(first.verification.valid, true);
    assert.equal(first.verification.selfIntegrity, true);

    const replay = ledger.append({
      operationId: 'trust-evidence:op-1',
      event: event('trust-evidence:op-1'),
      mutate: () => { mutations += 1; throw new Error('replay must not mutate'); },
    });

    assert.equal(replay.replayed, true);
    assert.equal(mutations, 1);
    assert.equal(replay.receipt.receiptId, first.receipt.receiptId);
    assert.equal(ledger.readByOperation('trust-evidence:op-1').verification.valid, true);
    assert.equal(ledger.readByReceiptId(first.receipt.receiptId).verification.valid, true);
  } finally {
    cleanup(dir);
  }
});

test('ledger chain links subsequent receipts and rejects tampering', () => {
  const { graph, dir } = makeTempGraph();
  try {
    const ledger = createTrustEvidenceLedger({ graph });
    const first = ledger.append({
      operationId: 'trust-evidence:chain-1',
      event: event('trust-evidence:chain-1'),
      mutate: () => ({ n: 1 }),
    });
    const second = ledger.append({
      operationId: 'trust-evidence:chain-2',
      event: event('trust-evidence:chain-2', { actionFingerprint: 'action-chain-2' }),
      mutate: () => ({ n: 2 }),
    });

    assert.equal(second.receipt.previousReceiptHash, first.receipt.receiptHash);
    const verified = verifyTrustEvidenceReceipt(second.receipt, {
      expectedPreviousReceiptHash: first.receipt.receiptHash,
    });
    assert.equal(verified.valid, true);
    assert.equal(verified.chainLinkage, true);

    const tampered = {
      ...second.receipt,
      canonicalPayload: { ...second.receipt.canonicalPayload, reason: 'tampered' },
    };
    assert.equal(verifyTrustEvidenceReceipt(tampered).valid, false);
    assert.equal(verifyTrustEvidenceReceipt(tampered).reason, 'content_tampered');
  } finally {
    cleanup(dir);
  }
});

test('ingest approval writer uses ledger only after admission and preserves old sink result', () => {
  const writes = [];
  const ledgerCalls = [];
  const graph = {
    appendAuditEvent(eventValue, opts) {
      writes.push({ event: eventValue, opts });
      return { auditId: 'audit-1' };
    },
  };
  const ledger = {
    append(args) {
      ledgerCalls.push(args);
      return { result: args.mutate() };
    },
  };
  const writer = createIngestApprovalAuditWriter({
    graph,
    admission: createMutationAdmission({
      clock: () => new Date('2026-08-19T10:00:00.000Z'),
      identityEvaluator: absent('test seam: this case exercises admission, not identity enforcement'),
    }),
    hashResult: () => 'hash-result',
    ledger,
  });

  const result = writer(
    { id: 'approval-1', context: { snapshot: { workspaceId: 'default', snapshotHash: 'snap-1' } } },
    { decision: 'approved', actionOutcome: 'applied', createdAt: '2026-08-19T10:00:00.000Z' },
    { plugin: 'result' },
  );

  assert.deepEqual(result, { auditId: 'audit-1' });
  assert.equal(ledgerCalls.length, 1);
  assert.equal(ledgerCalls[0].event.decision, 'allow');
  assert.equal(ledgerCalls[0].event.approvalRef, 'approval-1');
  assert.equal(writes.length, 1);
});

test('ingest approval writer does not reach ledger when admission refuses', () => {
  const ledgerCalls = [];
  const graph = { appendAuditEvent: () => { throw new Error('sink must not be reached'); } };
  const writer = createIngestApprovalAuditWriter({
    graph,
    admission: { admit: () => ({ admitted: false, reason: 'identity.invalid_claim' }) },
    hashResult: () => 'hash-result',
    ledger: { append: (args) => { ledgerCalls.push(args); } },
  });

  assert.throws(
    () => writer({ id: 'approval-2', context: { snapshot: { workspaceId: 'default' } } }, { decision: 'approved' }),
    (error) => error.code === 'MUTATION_ADMISSION_REFUSED',
  );
  assert.equal(ledgerCalls.length, 0);
});
