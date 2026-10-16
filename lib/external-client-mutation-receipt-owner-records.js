'use strict';

// The records an external candidate claim commits as -- the local candidate,
// its canonical admission receipt and the exact result the durable commit must
// return -- and the reconciliation of what was actually committed against
// them. Moved from external-client-mutation-receipt-owner.js (#2149).

const { stableStringify, sha256Hex } = require('./receipt/canonical-receipt');
const { buildCanonicalReceiptPayloadV2 } = require('./receipt/canonical-receipt-v2');
const { EXTERNAL_CLIENT_MUTATION_KIND, EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS, EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION, EXTERNAL_CLIENT_RECEIPT_KIND, HASH_PATTERN, RESULT_KEYS } = require('./external-client-mutation-receipt-owner-contract');
const { assertExactKeys, deepFreeze, fail } = require('./external-client-mutation-receipt-owner-json');

// The one canonical-JSON seam for the owner: its sibling modules compare and
// hash through these two rather than importing the receipt module themselves.
const canonicalEquals = (a, b) => stableStringify(a) === stableStringify(b);
const canonicalHash = (value) => sha256Hex(stableStringify(value));

function deriveCandidateRecords(candidate, externalCandidateId, authority) {
  const operationId = `external-client-candidate-claim:${authority.replayKey}`;
  const localCandidateId = `external_candidate_${sha256Hex(stableStringify({
    ownerVersion: EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION,
    workspaceId: authority.workspaceId,
    packageHash: authority.packageHash,
    externalCandidateId,
  }))}`;
  const receiptId = `external_candidate_receipt_${sha256Hex(operationId)}`;
  const externalCandidateHash = sha256Hex(stableStringify(candidate));
  const localProvenanceId = `external:${authority.packageHash}:${candidate.provenance.provenanceId}`;
  const createdAt = new Date(authority.reservedAt).toISOString();

  const localCandidate = deepFreeze({
    candidateId: localCandidateId,
    claim: candidate.claim,
    proposedEdge: {
      ...candidate.proposedEdge,
      provenanceId: localProvenanceId,
      workspaceId: authority.workspaceId,
    },
    provenance: {
      ...candidate.provenance,
      provenanceId: localProvenanceId,
      workspaceId: authority.workspaceId,
      actor: authority.subject,
    },
    conflict: null,
    recommendation: 'flag',
    status: 'pending',
    workspaceId: authority.workspaceId,
    createdAt: candidate.createdAt,
    reviewedAt: '',
    reviewedBy: '',
    warnings: [],
  });

  const metadata = deepFreeze({
    mutationKind: EXTERNAL_CLIENT_MUTATION_KIND,
    operationId,
    packageId: authority.packageId,
    packageHash: authority.packageHash,
    replayKey: authority.replayKey,
    trustedKeyId: authority.trustedKeyId,
    externalCandidateId,
    localCandidateId,
    externalCandidateHash,
  });
  const canonicalReceipt = deepFreeze(buildCanonicalReceiptPayloadV2({
    receiptId,
    receiptKind: EXTERNAL_CLIENT_RECEIPT_KIND,
    decision: 'review',
    status: 'pending',
    admissionId: operationId,
    workspaceId: authority.workspaceId,
    actor: authority.subject,
    // V4 receipt-family identity is the verified actor and must remain equal to
    // actor. The receiver-owned agent claim is enforced at admission; it is not
    // smuggled into this existing receipt family or its exact metadata allowlist.
    agentId: authority.subject,
    memoryDraftId: localCandidateId,
    provenanceId: localProvenanceId,
    trustPolicyVersion: EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION,
    approvalId: '',
    approvalStatus: 'pending',
    reason: 'external_verified_candidate_requires_review',
    riskScore: 0,
    createdAt,
    metadata,
  }, {
    verdict: 'review',
    trustRoot: 'external_verified_client',
  }));

  const expectedResult = deepFreeze({
    outcome: 'pending_review',
    operationId,
    workspaceId: authority.workspaceId,
    packageId: authority.packageId,
    packageHash: authority.packageHash,
    externalCandidateId,
    localCandidateId,
    receiptId,
  });

  return { operationId, localCandidateId, receiptId, localCandidate, canonicalReceipt, expectedResult };
}

function exactStoredResult(value, expected) {
  try {
    assertExactKeys(
      value,
      RESULT_KEYS,
      EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.OUTCOME_UNKNOWN,
      'stored mutation result is invalid',
    );
    return stableStringify(value) === stableStringify(expected);
  } catch (_) {
    return false;
  }
}

function assertCommittedMatches(committed, { operationId, receiptId, workspaceId, canonicalReceipt, expectedResult }) {
  if (!committed || typeof committed.replayed !== 'boolean'
    || !exactStoredResult(committed.result, expectedResult)
    || committed.receipt?.operationId !== operationId
    || committed.receipt?.receiptId !== receiptId
    || committed.receipt?.workspaceId !== workspaceId
    || stableStringify(committed.receipt?.canonicalPayload) !== stableStringify(canonicalReceipt)
    || typeof committed.receipt?.receiptHash !== 'string'
    || !HASH_PATTERN.test(committed.receipt.receiptHash)) {
    fail(
      EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.OUTCOME_UNKNOWN,
      'external client committed result could not be reconciled',
      { operationId, reconciliationRequired: true },
    );
  }
}

module.exports = { assertCommittedMatches, canonicalEquals, canonicalHash, deriveCandidateRecords };
