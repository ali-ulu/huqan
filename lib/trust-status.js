'use strict';

const { matchesCanonicalTarget } = require('./canonical-target-match');

// #2796: recommendation:'flag' survives review as audit history (never
// cleared by lib/hypothesis-review.js or lib/conflict-candidate-review.js),
// so it must not read as a live flag once status has moved to 'accepted'.
function isLiveFlag(candidate) {
  return candidate.status !== 'accepted' && (candidate.status === 'flagged' || candidate.recommendation === 'flag');
}

function deriveTrustStatus(canonicalRecord, candidateClaims = [], provenanceRecords = []) {
  const shadowingCandidates = canonicalRecord
    ? candidateClaims.filter((candidate) => matchesCanonicalTarget(candidate, canonicalRecord))
    : candidateClaims;
  if (shadowingCandidates.some((candidate) => candidate.status === 'rejected' || candidate.recommendation === 'reject')) {
    return 'rejected';
  }
  if (shadowingCandidates.some(isLiveFlag)) {
    return 'flagged';
  }
  if (shadowingCandidates.some((candidate) => candidate.status === 'pending')) {
    return 'pending';
  }
  if (canonicalRecord) {
    return 'canonical';
  }
  if (candidateClaims.some((candidate) => candidate.status === 'rejected' || candidate.recommendation === 'reject')) {
    return 'rejected';
  }
  if (candidateClaims.some(isLiveFlag)) {
    return 'flagged';
  }
  if (candidateClaims.some((candidate) => candidate.status === 'pending')) {
    return 'pending';
  }
  if (candidateClaims.some((candidate) => candidate.status !== 'accepted')) {
    return 'pending';
  }
  if (provenanceRecords.length > 0) {
    return 'pending';
  }
  return 'unknown';
}

module.exports = {
  deriveTrustStatus,
};
