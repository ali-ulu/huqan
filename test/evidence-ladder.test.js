'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EVIDENCE_LADDER_SCHEMA_VERSION,
  EVIDENCE_LADDER_LEVELS,
  evidenceLadderAt,
  externalResearchEvidenceLadder,
} = require('../lib/evidence-ladder');

test('evidence ladder has a stable monotonic admission and verification order', () => {
  assert.equal(EVIDENCE_LADDER_SCHEMA_VERSION, 'huqan-evidence-ladder-v1');
  assert.deepEqual(
    EVIDENCE_LADDER_LEVELS.map(level => [level.rank, level.id]),
    [
      [10, 'external_research'],
      [20, 'review_candidate'],
      [30, 'canonical_evidence'],
      [40, 'verified_claim'],
    ]
  );
  assert.equal(Object.isFrozen(EVIDENCE_LADDER_LEVELS), true);
  assert.equal(EVIDENCE_LADDER_LEVELS.every(Object.isFrozen), true);
});

test('external research is explicitly unverified, review-gated and non-canonical', () => {
  const ladder = externalResearchEvidenceLadder();
  assert.deepEqual(
    {
      current: ladder.current,
      evidenceStatus: ladder.evidenceStatus,
      verificationStatus: ladder.verificationStatus,
      canonical: ladder.canonical,
      reviewRequired: ladder.reviewRequired,
      next: ladder.next,
    },
    {
      current: 'external_research',
      evidenceStatus: 'external_unverified',
      verificationStatus: 'unverified',
      canonical: false,
      reviewRequired: true,
      next: 'review_candidate',
    }
  );
});

test('unknown evidence ladder levels fail closed', () => {
  assert.throws(() => evidenceLadderAt('made_up_level'), /Unknown evidence ladder level/);
});
