'use strict';

/**
 * Evidence ladder v1.
 *
 * This is an evidence-state contract, not a truth score. Moving upward means
 * HUQAN has stronger local admission/verification evidence for a claim; it
 * never means an external source became trustworthy by itself.
 */
const EVIDENCE_LADDER_SCHEMA_VERSION = 'huqan-evidence-ladder-v1';

const EVIDENCE_LADDER_LEVELS = Object.freeze([
  Object.freeze({
    id: 'external_research',
    rank: 10,
    evidenceStatus: 'external_unverified',
    verificationStatus: 'unverified',
    canonical: false,
    reviewRequired: true,
    next: 'review_candidate',
  }),
  Object.freeze({
    id: 'review_candidate',
    rank: 20,
    evidenceStatus: 'review_candidate',
    verificationStatus: 'candidate',
    canonical: false,
    reviewRequired: true,
    next: 'canonical_evidence',
  }),
  Object.freeze({
    id: 'canonical_evidence',
    rank: 30,
    evidenceStatus: 'canonical_evidence',
    verificationStatus: 'admitted',
    canonical: true,
    reviewRequired: false,
    next: 'verified_claim',
  }),
  Object.freeze({
    id: 'verified_claim',
    rank: 40,
    evidenceStatus: 'verified',
    verificationStatus: 'verified',
    canonical: true,
    reviewRequired: false,
    next: null,
  }),
]);

const LEVEL_BY_ID = new Map(EVIDENCE_LADDER_LEVELS.map(level => [level.id, level]));

function evidenceLadderAt(current) {
  const level = LEVEL_BY_ID.get(current);
  if (!level) throw new TypeError(`Unknown evidence ladder level: ${current}`);
  return Object.freeze({
    schemaVersion: EVIDENCE_LADDER_SCHEMA_VERSION,
    current: level.id,
    currentRank: level.rank,
    evidenceStatus: level.evidenceStatus,
    verificationStatus: level.verificationStatus,
    canonical: level.canonical,
    reviewRequired: level.reviewRequired,
    next: level.next,
    levels: EVIDENCE_LADDER_LEVELS,
  });
}

function externalResearchEvidenceLadder() {
  return evidenceLadderAt('external_research');
}

module.exports = {
  EVIDENCE_LADDER_SCHEMA_VERSION,
  EVIDENCE_LADDER_LEVELS,
  evidenceLadderAt,
  externalResearchEvidenceLadder,
};
