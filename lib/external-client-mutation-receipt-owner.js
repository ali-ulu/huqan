'use strict';

// Commits an external client's candidate claim into quarantine and seals its
// admission receipt. The admission seams are built here on purpose: the
// mutation-admission contracts count them per file. Contract, JSON guards,
// input snapshots and the graph dependency live in
// external-client-mutation-receipt-owner-*.js (#2149).

const { stableStringify, sha256Hex } = require('./receipt/canonical-receipt');
const { buildCanonicalReceiptPayloadV2 } = require('./receipt/canonical-receipt-v2');
const { absent, createMutationAdmission } = require('./mutation-admission');
const { composeReceiverOwnedIdentityClaim, evaluateAgentIdentity } = require('./agent-identity-runtime');
const { ABSENCE_REASONS, ADMISSION_ACTION, CANDIDATE_KEYS, EXTERNAL_CLIENT_MUTATION_KIND, EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS, EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION, EXTERNAL_CLIENT_RECEIPT_KIND, HASH_PATTERN, OBJECT_COLLECTIONS, PROPOSED_EDGE_KEYS, PROVENANCE_KEYS, RESULT_KEYS } = require('./external-client-mutation-receipt-owner-contract');
const { graphDependency } = require('./external-client-mutation-receipt-owner-dependencies');
const { assertAllowedKeys, assertExactKeys, canonicalInstant, deepFreeze, fail, isPlainObject, text } = require('./external-client-mutation-receipt-owner-json');
const { snapshotContext, snapshotPackage } = require('./external-client-mutation-receipt-owner-snapshot');

function selectCandidate(pkg, authority) {
  assertExactKeys(
    pkg.objects,
    OBJECT_COLLECTIONS,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external package object collections are invalid',
  );
  for (const collection of OBJECT_COLLECTIONS) {
    if (!Array.isArray(pkg.objects[collection])) {
      fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID, 'external package collection must be an array', { collection });
    }
    const expected = collection === 'candidateClaims' ? 1 : 0;
    if (pkg.objects[collection].length !== expected) {
      fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID, 'external package must contain exactly one candidate claim and no other objects', { collection });
    }
  }

  const candidate = pkg.objects.candidateClaims[0];
  assertAllowedKeys(
    candidate,
    CANDIDATE_KEYS,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate shape is invalid',
  );
  assertAllowedKeys(
    candidate.proposedEdge,
    PROPOSED_EDGE_KEYS,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate proposed edge is invalid',
  );
  assertAllowedKeys(
    candidate.provenance,
    PROVENANCE_KEYS,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate provenance is invalid',
  );

  const externalCandidateId = text(candidate.candidateId,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate ID is required');
  text(candidate.claim, EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate claim is required');
  if (candidate.status !== 'pending' || candidate.canonical === true) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID, 'external candidate must be pending and non-canonical');
  }
  if (candidate.workspaceId !== authority.workspaceId
    || candidate.proposedEdge.workspaceId !== authority.workspaceId
    || candidate.provenance.workspaceId !== authority.workspaceId
    || candidate.provenance.actor !== authority.subject) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'candidate workspace or actor does not match authority');
  }
  for (const field of ['from', 'to', 'relation']) {
    text(candidate.proposedEdge[field],
      EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
      `external candidate proposedEdge.${field} is required`);
  }
  text(candidate.provenance.provenanceId,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate provenance ID is required');
  canonicalInstant(candidate.createdAt,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate createdAt is invalid');

  if (pkg.manifest.packageId !== authority.packageId
    || pkg.manifest.workspaceId !== authority.workspaceId
    || pkg.manifest.createdBy !== authority.subject
    || sha256Hex(stableStringify(pkg)) !== authority.packageHash) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'signed package does not match authority context');
  }
  return Object.freeze({ candidate, externalCandidateId });
}

function admissionDependency(options) {
  const descriptor = Object.getOwnPropertyDescriptor(options, 'admission');
  const injected = descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : null;
  if (injected === null || injected === undefined) {
    // The identity-enforcing seam is built in identityAdmissionDependency and
    // injected. Reaching here means no agentIdentityRuntime was configured, so
    // this fallback is the unenforced one, said out loud.
    return createMutationAdmission({
      identityEvaluator: absent(
        'no agentIdentityRuntime configured for this external client; the '
        + 'identity-enforcing seam is built only when one is',
      ),
    });
  }
  if (!isPlainObject(injected) || typeof injected.admit !== 'function') {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.GRAPH_REQUIRED, 'the mutation admission seam is required');
  }
  return injected;
}

function identityAdmissionDependency(options, verifiedAuthority) {
  if (!Object.hasOwn(options, 'agentIdentityRuntime')) return { admission: null, claim: null };
  if (Object.hasOwn(options, 'admission')) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.IDENTITY_CONFIG_INVALID,
      'agent identity runtime and injected admission cannot be combined ambiguously');
  }
  const config = options.agentIdentityRuntime;
  if (!isPlainObject(config)) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.IDENTITY_CONFIG_INVALID,
      'agent identity runtime configuration is required');
  }
  const composition = composeReceiverOwnedIdentityClaim({
    authority: config.authority,
    identityRef: config.identityRef,
    receiver: {
      subject: verifiedAuthority.subject,
      kind: verifiedAuthority.kind,
      workspaceId: verifiedAuthority.workspaceId,
    },
  });
  const action = config.action;
  const evaluator = (context) => {
    if (!composition.allowed) return composition;
    if (stableStringify(context.identityClaim) !== stableStringify(composition.claim)
        || context.workspaceId !== composition.claim.workspaceId) {
      return {
        decision: 'block',
        allowed: false,
        reason: 'identity.claim_binding_mismatch',
      };
    }
    return evaluateAgentIdentity({
      authority: config.authority,
      claim: composition.claim,
      action,
    });
  };
  const clock = () => new Date(config.authority.clock());
  return {
    claim: composition.allowed ? composition.claim : null,
    admission: createMutationAdmission({ clock, identityEvaluator: evaluator }),
  };
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

function commitExternalClientCandidateClaim(pkgInput, contextInput, options = {}) {
  const graph = graphDependency(options);
  const pkg = snapshotPackage(pkgInput);
  const authority = snapshotContext(contextInput);
  const identityBinding = identityAdmissionDependency(options, authority);
  const admission = identityBinding.admission || admissionDependency(options);
  const identityClaim = identityBinding.claim;
  const { candidate, externalCandidateId } = selectCandidate(pkg, authority);

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

  // The durable commit is the admitted effect, so a refusal leaves no journal
  // entry, no candidate row and no receipt. The workspace is the authoritative
  // one the authority bound, never a caller-supplied or defaulted value.
  //
  // The try/catch sits *inside* the callback deliberately. Admission returns a
  // refusal rather than throwing, and `admit` never invokes the callback on
  // that path, so a refusal cannot be swallowed into OUTCOME_UNKNOWN -- which
  // would report "this may not happen" as "this may have half-happened, go
  // reconcile", the single most misleading translation available here.
  const admissionOutcome = admission.admit({
    workspaceId: authority.workspaceId,
    action: ADMISSION_ACTION,
    identityClaim: identityClaim || absent(ABSENCE_REASONS.identityClaim),
    delegationContext: identityClaim
      ? { kind: 'delegation_chain', chain: identityClaim.delegationChain }
      : absent(ABSENCE_REASONS.delegationContext),
    connectorContext: identityClaim
      ? { kind: 'receiver_binding', connector: authority.kind }
      : absent(ABSENCE_REASONS.connectorContext),
  }, () => {
    try {
      return graph.runMutationOnce(operationId, () => {
        const existing = graph.getCandidateClaims({
          workspaceId: authority.workspaceId,
          candidateId: localCandidateId,
        });
        if (existing.length > 0) {
          const collision = new Error('derived local candidate ID already exists');
          collision.code = EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.LOCAL_CANDIDATE_COLLISION;
          collision.details = Object.freeze({ operationId, localCandidateId });
          throw collision;
        }
        const stored = graph.addCandidateClaim(localCandidate, {
          workspaceId: authority.workspaceId,
        });
        if (!stored || stored.candidateId !== localCandidateId
          || stored.workspaceId !== authority.workspaceId
          || stored.status !== 'pending' || stored.recommendation !== 'flag'
          || stored.conflict !== null) {
          throw new Error('local candidate projection was not stored exactly');
        }
        return expectedResult;
      }, {
        buildCanonicalReceipt: () => canonicalReceipt,
      });
    } catch (error) {
      if (error?.code === EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.LOCAL_CANDIDATE_COLLISION) {
        throw error;
      }
      fail(
        EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.OUTCOME_UNKNOWN,
        'external client mutation outcome is unknown; automatic retry is forbidden',
        { operationId, reconciliationRequired: true },
      );
    }
  });

  if (!admissionOutcome.admitted) {
    const refusal = new Error(`external client candidate claim refused by mutation admission: ${admissionOutcome.reason}`);
    refusal.code = 'MUTATION_ADMISSION_REFUSED';
    refusal.admissionReason = admissionOutcome.reason;
    throw refusal;
  }

  const committed = admissionOutcome.result;

  if (!committed || typeof committed.replayed !== 'boolean'
    || !exactStoredResult(committed.result, expectedResult)
    || committed.receipt?.operationId !== operationId
    || committed.receipt?.receiptId !== receiptId
    || committed.receipt?.workspaceId !== authority.workspaceId
    || stableStringify(committed.receipt?.canonicalPayload) !== stableStringify(canonicalReceipt)
    || typeof committed.receipt?.receiptHash !== 'string'
    || !HASH_PATTERN.test(committed.receipt.receiptHash)) {
    fail(
      EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.OUTCOME_UNKNOWN,
      'external client committed result could not be reconciled',
      { operationId, reconciliationRequired: true },
    );
  }

  return deepFreeze({
    ok: true,
    outcome: 'pending_review',
    replayed: committed.replayed,
    operationId,
    workspaceId: authority.workspaceId,
    packageId: authority.packageId,
    packageHash: authority.packageHash,
    externalCandidateId,
    localCandidateId,
    receiptId,
    receiptHash: committed.receipt.receiptHash,
    previousReceiptHash: committed.receipt.previousReceiptHash,
  });
}

module.exports = {
  ABSENCE_REASONS,
  ADMISSION_ACTION,
  EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION,
  EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS,
  EXTERNAL_CLIENT_MUTATION_KIND,
  EXTERNAL_CLIENT_RECEIPT_KIND,
  commitExternalClientCandidateClaim,
};
