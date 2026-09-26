'use strict';

// Selects the one candidate claim an external package may carry and checks it
// against the verified authority, moved from
// external-client-mutation-receipt-owner.js (#2149).

const { CANDIDATE_KEYS, EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS, OBJECT_COLLECTIONS, PROPOSED_EDGE_KEYS, PROVENANCE_KEYS } = require('./external-client-mutation-receipt-owner-contract');
const { canonicalHash } = require('./external-client-mutation-receipt-owner-records');
const { assertAllowedKeys, assertExactKeys, canonicalInstant, fail, text } = require('./external-client-mutation-receipt-owner-json');

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
    || canonicalHash(pkg) !== authority.packageHash) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'signed package does not match authority context');
  }
  return Object.freeze({ candidate, externalCandidateId });
}

module.exports = { selectCandidate };
