'use strict';

/**
 * MemoryLifecycle composition (#3036).
 *
 * The six modules each have their own unit tests. What was never tested is the
 * seam between them — specifically that a record admitted through the
 * admission gate (flat `provenanceId`) reads back through the recall gate
 * (nested `provenance.provenanceId`) as admitted, rather than withheld as
 * `missing_provenance`. This file pins the composed write → read → score →
 * verify flow end-to-end against the real modules, no stubs on the seam.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  MemoryLifecycle,
  toRecallRecord,
  MEMORY_LIFECYCLE_POLICY_VERSION,
} = require('../lib/memory-lifecycle');
const { validateReceiptChain, appendReceiptToChain } = require('../lib/receipt/receipt-chain');

const CREATED_AT = '2026-06-11T12:00:00.000Z';
const OBSERVED_AT = '2026-06-11T13:00:00.000Z';

function writeRequest(overrides = {}) {
  return {
    admissionId: 'madm_compose_1',
    workspaceId: 'workspace-compose',
    actor: 'agent-1',
    agentId: 'agent-1',
    memoryDraftId: 'draft-compose-1',
    proposedMemory: { memoryId: 'mem-compose-1', workspaceId: 'workspace-compose', content: { title: 'alpha' } },
    provenanceId: 'prov-compose-1',
    trustPolicyVersion: '2026-06',
    approvalId: 'apr_compose-1',
    approvalStatus: 'approved',
    reason: 'write memory',
    riskScore: 20,
    createdAt: CREATED_AT,
    ...overrides,
  };
}

test('exports a stable policy version and the composition seam', () => {
  assert.equal(MEMORY_LIFECYCLE_POLICY_VERSION, 'huqan-memory-lifecycle-v0.1.0');
  assert.equal(typeof MemoryLifecycle, 'function');
  assert.equal(typeof toRecallRecord, 'function');
});

test('write → read: an admitted record reads back as admitted (the missing provenance bridge)', () => {
  const lifecycle = new MemoryLifecycle({});
  const admitted = lifecycle.admit(writeRequest());

  assert.equal(admitted.ok, true);
  assert.equal(admitted.decision.decision, 'allow');

  // The admission gate emits a flat provenanceId...
  assert.equal(admitted.receipt.provenanceId, 'prov-compose-1');
  // ...and the bridge projects it onto the nested shape the recall gate reads.
  assert.equal(admitted.record.provenance.provenanceId, 'prov-compose-1');
  assert.equal(admitted.record.provenance.workspaceId, 'workspace-compose');

  const recall = lifecycle.recall({ records: [admitted.record] }, {
    workspaceId: 'workspace-compose',
    currentTrustPolicyVersion: '2026-06',
    observedAt: OBSERVED_AT,
  });

  assert.equal(recall.ok, true);
  assert.equal(recall.summary.admitted, 1);
  assert.equal(recall.decisions[0].decision, 'admit');
  assert.equal(recall.decisions[0].reason, 'current_and_provenanced');
});

test('the bridge fills only missing provenance fields and keeps declared ones', () => {
  const admission = {
    decision: { provenanceId: 'prov-flat', workspaceId: 'ws', request: { provenanceId: 'prov-flat', workspaceId: 'ws' } },
    receipt: {},
  };
  const record = toRecallRecord(admission, {
    provenance: { confidence: 0.42, sourceRef: 'declared-ref' },
  });
  assert.equal(record.provenance.provenanceId, 'prov-flat');
  assert.equal(record.provenance.confidence, 0.42);
  assert.equal(record.provenance.sourceRef, 'declared-ref');
});

test('write → read: a record whose flat provenance was never bridged is withheld', () => {
  const lifecycle = new MemoryLifecycle({});
  const recall = lifecycle.recall({
    records: [{ memoryId: 'mem-raw', workspaceId: 'workspace-compose', trustPolicyVersion: '2026-06', provenanceId: 'prov-1' }],
  }, { workspaceId: 'workspace-compose', currentTrustPolicyVersion: '2026-06', observedAt: OBSERVED_AT });

  // Pins the defect the composition fixes: a flat provenanceId alone does not
  // satisfy the read-side gate.
  assert.equal(recall.decisions[0].decision, 'withhold');
  assert.equal(recall.decisions[0].reason, 'missing_provenance');
});

test('write → verify: chained receipts validate and tampering is detected', () => {
  const lifecycle = new MemoryLifecycle({});
  const first = lifecycle.admit(writeRequest());
  const second = lifecycle.admit(writeRequest({
    admissionId: 'madm_compose_2',
    memoryDraftId: 'draft-compose-2',
    proposedMemory: { memoryId: 'mem-compose-2', workspaceId: 'workspace-compose', content: { title: 'beta' } },
  }));

  const chain = [first.chainedReceipt, second.chainedReceipt];
  assert.deepEqual(lifecycle.verifyChain(chain), { valid: true, brokenAt: null, reason: null });
  assert.equal(second.chainedReceipt.previousReceiptHash, first.chainedReceipt.receiptHash);

  const tampered = [{ ...first.chainedReceipt, workspaceId: 'evil' }, second.chainedReceipt];
  assert.deepEqual(lifecycle.verifyChain(tampered), { valid: false, brokenAt: 0, reason: 'content_tampered' });

  // A self-consistent receipt that commits to the wrong predecessor is a link break.
  const forged = appendReceiptToChain({ ...second.chainedReceipt, previousReceiptHash: undefined }, undefined);
  const { receiptHash, ...forgedContent } = forged;
  const refForge = appendReceiptToChain(forgedContent, 'genesis:v4-receipt-chain');
  assert.equal(validateReceiptChain([first.chainedReceipt, refForge]).reason, 'chain_link_broken');
});

test('write → read: a dropped middle receipt breaks the chain link', () => {
  const lifecycle = new MemoryLifecycle({});
  const a = lifecycle.admit(writeRequest({ admissionId: 'a', memoryDraftId: 'a', proposedMemory: { memoryId: 'a' } }));
  const b = lifecycle.admit(writeRequest({ admissionId: 'b', memoryDraftId: 'b', proposedMemory: { memoryId: 'b' } }));
  const c = lifecycle.admit(writeRequest({ admissionId: 'c', memoryDraftId: 'c', proposedMemory: { memoryId: 'c' } }));

  assert.deepEqual(lifecycle.verifyChain([a.chainedReceipt, b.chainedReceipt, c.chainedReceipt]), {
    valid: true, brokenAt: null, reason: null,
  });
  assert.deepEqual(lifecycle.verifyChain([a.chainedReceipt, c.chainedReceipt]), {
    valid: false, brokenAt: 1, reason: 'chain_link_broken',
  });
});

test('write: a review/quarantine verdict is returned, not thrown', () => {
  const lifecycle = new MemoryLifecycle({});
  const quarantined = lifecycle.admit(writeRequest({
    admissionId: 'madm_high', memoryDraftId: 'draft-high', riskScore: 90,
    proposedMemory: { memoryId: 'mem-high', workspaceId: 'workspace-compose', content: { title: 'risky' } },
  }));
  assert.equal(quarantined.ok, true);
  assert.equal(quarantined.decision.decision, 'quarantine');
  assert.equal(quarantined.decision.allowed, false);
  // A non-allow verdict still yields a recall-ready record and a chained receipt.
  assert.ok(quarantined.record);
  assert.ok(quarantined.chainedReceipt);

  const missingProvenance = lifecycle.admit(writeRequest({
    admissionId: 'madm_noprov', memoryDraftId: 'draft-noprov', provenanceId: '',
    proposedMemory: { memoryId: 'mem-noprov', workspaceId: 'workspace-compose', content: { title: 'x' } },
  }));
  assert.equal(missingProvenance.decision.decision, 'review');
});

test('write: an expired-at-admission write is rejected', () => {
  const lifecycle = new MemoryLifecycle({});
  const expired = lifecycle.admit(writeRequest({
    admissionId: 'madm_expired',
    memoryDraftId: 'draft-expired',
    expiresAt: '2026-06-11T11:00:00.000Z', // before createdAt
    proposedMemory: { memoryId: 'mem-expired', workspaceId: 'workspace-compose', content: { title: 'old' } },
  }));
  assert.equal(expired.decision.decision, 'reject');
  assert.equal(expired.decision.reason, 'expired_before_admission');
});

test('write: the derived reverification horizon rides on the receipt by risk', () => {
  const lifecycle = new MemoryLifecycle({});
  const high = lifecycle.admit(writeRequest({
    admissionId: 'madm_h', memoryDraftId: 'draft-h', riskScore: 90,
    proposedMemory: { memoryId: 'mem-h', workspaceId: 'workspace-compose', content: { title: 'h' } },
  }));
  // riskScore 90 is critical → 24h horizon from createdAt.
  assert.equal(high.receipt.metadata.reverificationHorizon, '2026-06-12T12:00:00.000Z');
});

test('read: missing policy version warns rather than fabricating staleness', () => {
  const lifecycle = new MemoryLifecycle({});
  const recall = lifecycle.recall({ records: [] }, { workspaceId: 'workspace-compose' });
  assert.deepEqual(recall.warnings.map((w) => w.code), ['POLICY_VERSION_UNKNOWN']);
});

test('score: insufficient data is reported, never fabricated', () => {
  const emptyGraph = {
    getCommittedMutationResultsByPrefix: () => [],
    getCandidateClaims: () => [],
  };
  const lifecycle = new MemoryLifecycle(emptyGraph);
  const score = lifecycle.score('workspace-compose', { includeAiDependencyRatio: false });
  assert.equal(score.status, 'insufficient-data');
  assert.equal(score.score, null);
  assert.equal(score.certified, false);
});

test('score: a scored workspace returns a bounded score and certification gate', () => {
  const graph = {
    getCommittedMutationResultsByPrefix: (prefix) => {
      if (prefix !== 'llm-proxy:') return [];
      return Array.from({ length: 12 }, (_, i) => ({
        operationId: `llm-proxy:${i}`,
        status: 'completed',
        result: { proxied: true, model: 'gpt-4o-mini', upstreamStatus: i % 6 === 0 ? 500 : 200 },
        committedAt: CREATED_AT,
      }));
    },
    getCandidateClaims: () => [],
  };
  const lifecycle = new MemoryLifecycle(graph);
  const score = lifecycle.score('workspace-compose', { includeAiDependencyRatio: false });
  assert.equal(score.status, 'scored');
  assert.ok(score.score >= 0 && score.score <= 100);
  assert.equal(score.certified, false); // 2/12 errors + fewer than 100 actions
});

test('verify: the crypto adapter verifies a real Ed25519 vector', () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, 'fixtures', 'v5', 'cryptographic-adapter', '01-valid-rfc8032-one-octet.json'),
    'utf8',
  ));
  const lifecycle = new MemoryLifecycle({});
  const result = lifecycle.verifyCryptographicEvidence({
    algorithm: fixture.input.algorithm,
    messageBytes: Buffer.from(fixture.input.messageBytesHex, 'hex'),
    publicKeySpkiDer: Buffer.from(fixture.input.publicKeySpkiDerHex, 'hex'),
    signatureBytes: Buffer.from(fixture.input.signatureBytesHex, 'hex'),
  });
  assert.deepEqual(result, { cryptographicState: 'valid' });
});

test('full loop: write → read → score → verify in one flow', () => {
  const graph = {
    getCommittedMutationResultsByPrefix: () => [],
    getCandidateClaims: () => [],
  };
  const lifecycle = new MemoryLifecycle(graph);

  const written = lifecycle.admit(writeRequest());
  const read = lifecycle.recall({ records: [written.record] }, {
    workspaceId: 'workspace-compose',
    currentTrustPolicyVersion: '2026-06',
    observedAt: OBSERVED_AT,
  });
  const scored = lifecycle.score('workspace-compose', { includeAiDependencyRatio: false });
  const verified = lifecycle.verifyChain([written.chainedReceipt]);

  assert.equal(written.decision.decision, 'allow');
  assert.equal(read.summary.admitted, 1);
  assert.equal(scored.status, 'insufficient-data');
  assert.equal(verified.valid, true);
});
