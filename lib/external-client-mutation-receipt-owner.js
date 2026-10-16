'use strict';

// Commits an external client's candidate claim into quarantine and seals its
// admission receipt. The admission seams are built here on purpose: the
// mutation-admission contracts count them per file. Contract, JSON guards,
// input snapshots, the graph dependency, candidate selection and the derived
// records live in external-client-mutation-receipt-owner-*.js (#2149).

const { absent, createMutationAdmission } = require('./mutation-admission');
const { composeReceiverOwnedIdentityClaim, evaluateAgentIdentity } = require('./agent-identity-runtime');
const { ABSENCE_REASONS, ADMISSION_ACTION, EXTERNAL_CLIENT_MUTATION_KIND, EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS, EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION, EXTERNAL_CLIENT_RECEIPT_KIND } = require('./external-client-mutation-receipt-owner-contract');
const { selectCandidate } = require('./external-client-mutation-receipt-owner-candidate');
const { graphDependency } = require('./external-client-mutation-receipt-owner-dependencies');
const { deepFreeze, fail, isPlainObject } = require('./external-client-mutation-receipt-owner-json');
const { assertCommittedMatches, canonicalEquals, deriveCandidateRecords } = require('./external-client-mutation-receipt-owner-records');
const { snapshotContext, snapshotPackage } = require('./external-client-mutation-receipt-owner-snapshot');

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
    if (!canonicalEquals(context.identityClaim, composition.claim)
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

function commitExternalClientCandidateClaim(pkgInput, contextInput, options = {}) {
  const graph = graphDependency(options);
  const pkg = snapshotPackage(pkgInput);
  const authority = snapshotContext(contextInput);
  const identityBinding = identityAdmissionDependency(options, authority);
  const admission = identityBinding.admission || admissionDependency(options);
  const identityClaim = identityBinding.claim;
  const { candidate, externalCandidateId } = selectCandidate(pkg, authority);

  const {
    operationId, localCandidateId, receiptId, localCandidate, canonicalReceipt, expectedResult,
  } = deriveCandidateRecords(candidate, externalCandidateId, authority);

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

  assertCommittedMatches(committed, { operationId, receiptId, workspaceId: authority.workspaceId, canonicalReceipt, expectedResult });

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
