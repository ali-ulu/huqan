'use strict';

// #2149: the owner's versioned contract -- kinds, error codes, admission
// action, absence reasons and the exact key sets every input must match.

const EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION =
  'external-client-mutation-receipt-owner-0-v1';
const EXTERNAL_CLIENT_MUTATION_KIND = 'external_client_candidate_claim_quarantine';
const EXTERNAL_CLIENT_RECEIPT_KIND = 'external_client_candidate_claim_admission';
const AUTHORITY_VERSION = 'external-client-authority-0-v1';
const REPLAY_KEY_PATTERN = /^external-client-authority-0-v1:[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS = Object.freeze({
  INPUT_INVALID: 'EXTERNAL_CLIENT_MUTATION_INPUT_INVALID',
  AUTHORITY_MISMATCH: 'EXTERNAL_CLIENT_MUTATION_AUTHORITY_MISMATCH',
  CANDIDATE_INVALID: 'EXTERNAL_CLIENT_MUTATION_CANDIDATE_INVALID',
  GRAPH_REQUIRED: 'EXTERNAL_CLIENT_MUTATION_GRAPH_REQUIRED',
  LOCAL_CANDIDATE_COLLISION: 'EXTERNAL_CLIENT_MUTATION_LOCAL_CANDIDATE_COLLISION',
  OUTCOME_UNKNOWN: 'EXTERNAL_CLIENT_MUTATION_OUTCOME_UNKNOWN',
  IDENTITY_CONFIG_INVALID: 'EXTERNAL_CLIENT_MUTATION_IDENTITY_CONFIG_INVALID',
});

/**
 * Naming collision, flagged because it reads as the opposite of what it is.
 *
 * This function is reached as `packageAdmissionHandler` from
 * `lib/external-client-production-boundary.js`. That "admission" is *package*
 * admission — the signed-package authority gate — and is unrelated to
 * `lib/mutation-admission.js`. The mutation seam below is a second, separate
 * boundary that happens to live inside a function the caller already calls an
 * admission handler. Reading the call chain and concluding the mutation seam
 * was already present would be an easy and wrong inference.
 *
 * A second trap in the same chain: `graphDependency` duck-types its sink on
 * three methods and the production boundary passes `options.graph` straight
 * through, so this call site cannot know statically which sink it writes to.
 * That is also why sink-level admission could not work here.
 */
const ADMISSION_ACTION = 'external-client.commitCandidateClaim';

/**
 * Why each context field is declared absent at this call site.
 *
 * These reasons are **not** the ones the kernel callers use, and the difference
 * is the point. Everywhere else in P1 the absence is real: the caller carries a
 * label it made up about itself, so no receiver-owned identity exists to pass.
 * Here one does. `enforceExternalClientAuthority` runs before this function is
 * reached and, against receiver-owned configuration rather than request bytes,
 * enforces: signature over the package against `trustedKeys`, the identity
 * subject and kind against the operator's trust profile, key presence,
 * revocation and validity window, workspace binding, package staleness and
 * future-skew against a receiver clock, and an atomic replay reservation. The
 * HTTP adapter takes only `package` and `signature` from the request; identity
 * and workspace come from the profile file. The request cannot describe who it
 * is.
 *
 * So what is absent here is a **carrier, not an identity**. The seam has no
 * `identityClaim` shape yet — that is gate 3's contract — and inventing one to
 * fill the field would be worse than declaring the absence: `admit()` accepts
 * any non-array object without validating it (see `lib/mutation-admission.js`),
 * so a made-up shape would be silently accepted today, drop this call site out
 * of the "places lacking a claim" enumeration the seam exists to keep, and
 * surface only when enforcement is switched on -- which is precisely the
 * archaeology that module was written to avoid.
 *
 * Recording it this way keeps the count honest and leaves this call site as the
 * first real design input for gate 3: it is the only routed caller that has
 * verified material (subject, kind, trustedKeyId, packageHash, signature) for a
 * claim shape to be modelled on.
 */
const ABSENCE_REASONS = Object.freeze({
  identityClaim: 'external-client ingress verifies a receiver-owned identity in enforceExternalClientAuthority -- signature against trustedKeys, expectedIdentitySubject/Kind, key state, workspace binding, expiry and replay reservation -- before this seam is reached; that verified identity is not yet expressed as an identityClaim because the claim shape is gate 3\'s contract',
  delegationContext: 'the authority grants a single fixed permission rather than a delegation chain; no delegation is modelled to carry',
  connectorContext: 'the external client endpoint is a signed-package ingress, not a connector; its provenance travels in the authority receipt',
});

const PACKAGE_KEYS = Object.freeze(['manifest', 'objects', 'index', 'metadata']);
const OBJECT_COLLECTIONS = Object.freeze([
  'provenanceRecords',
  'auditEvents',
  'candidateClaims',
  'conflictResults',
  'verificationResults',
  'trustReceipts',
  'causalChains',
  'simulationResults',
]);
const CONTEXT_KEYS = Object.freeze([
  'identity', 'workspaceId', 'packageId', 'packageHash', 'signature',
  'gateVersion', 'gateReceipt', 'authorityVersion', 'permission', 'replayKey',
  'authorityReceipt', 'authority',
]);
const CANDIDATE_KEYS = Object.freeze([
  'candidateId', 'claim', 'proposedEdge', 'provenance', 'conflict',
  'recommendation', 'status', 'workspaceId', 'createdAt', 'reviewedAt',
  'reviewedBy', 'warnings', 'canonical',
]);
const PROPOSED_EDGE_KEYS = Object.freeze([
  'from', 'to', 'relation', 'polarity', 'confidence', 'strength',
  'provenanceId', 'workspaceId',
]);
const PROVENANCE_KEYS = Object.freeze([
  'provenanceId', 'sourceRef', 'sourceTitle', 'sourceType', 'sourceSubType',
  'actor', 'timestamp', 'workspaceId', 'confidence', 'trustPolicyVersion',
]);
const RESULT_KEYS = Object.freeze([
  'outcome', 'operationId', 'workspaceId', 'packageId', 'packageHash',
  'externalCandidateId', 'localCandidateId', 'receiptId',
]);

module.exports = {
  ABSENCE_REASONS,
  ADMISSION_ACTION,
  AUTHORITY_VERSION,
  CANDIDATE_KEYS,
  CONTEXT_KEYS,
  EXTERNAL_CLIENT_MUTATION_KIND,
  EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS,
  EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION,
  EXTERNAL_CLIENT_RECEIPT_KIND,
  HASH_PATTERN,
  OBJECT_COLLECTIONS,
  PACKAGE_KEYS,
  PROPOSED_EDGE_KEYS,
  PROVENANCE_KEYS,
  REPLAY_KEY_PATTERN,
  RESULT_KEYS,
};
