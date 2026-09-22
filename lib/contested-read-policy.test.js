const test = require('node:test');
const assert = require('node:assert/strict');
const {
  READ_BEHAVIORS,
  UNSETTLED_REASONS,
  READ_BEHAVIOR_BY_RISK_LEVEL,
  resolveReaderRiskLevel,
  selectReadBehavior,
  isContestingCandidate,
} = require('./contested-read-policy');
const { ACTION_CATEGORIES, RISK_LEVELS } = require('./risk-policy-constants');

test('every RISK_LEVELS key maps to a declared behavior, with no gaps', () => {
  for (const level of Object.values(RISK_LEVELS)) {
    assert.ok(
      Object.values(READ_BEHAVIORS).includes(READ_BEHAVIOR_BY_RISK_LEVEL[level]),
      `no behavior mapped for risk level ${level}`,
    );
  }
  assert.strictEqual(Object.keys(READ_BEHAVIOR_BY_RISK_LEVEL).length, Object.keys(RISK_LEVELS).length);
});

test('every ACTION_CATEGORIES value resolves to a risk level via category intent', () => {
  for (const category of Object.values(ACTION_CATEGORIES)) {
    const resolution = resolveReaderRiskLevel({ category });
    assert.ok(resolution.level, `category ${category} did not resolve to a risk level`);
    assert.strictEqual(resolution.source, 'category');
  }
});

test('score boundaries land in the correct band', () => {
  const cases = [
    [24, RISK_LEVELS.LOW],
    [25, RISK_LEVELS.MEDIUM],
    [49, RISK_LEVELS.MEDIUM],
    [50, RISK_LEVELS.HIGH],
    [74, RISK_LEVELS.HIGH],
    [75, RISK_LEVELS.CRITICAL],
  ];
  for (const [score, expectedLevel] of cases) {
    const resolution = resolveReaderRiskLevel({ riskScore: score });
    assert.strictEqual(resolution.level, expectedLevel, `score ${score} expected ${expectedLevel}, got ${resolution.level}`);
    assert.strictEqual(resolution.source, 'riskScore');
  }
});

test('blastRadius intent resolves the same score bands', () => {
  const resolution = resolveReaderRiskLevel({ blastRadius: { score: 80 } });
  assert.strictEqual(resolution.level, RISK_LEVELS.CRITICAL);
  assert.strictEqual(resolution.source, 'blastRadius');
});

test('the highest resolved level wins when multiple intent fields are given', () => {
  const resolution = resolveReaderRiskLevel({ category: 'READ_ONLY', riskScore: 80 });
  assert.strictEqual(resolution.level, RISK_LEVELS.CRITICAL);
});

test('an unknown category resolves to no level with intent_unrecognized', () => {
  const resolution = resolveReaderRiskLevel({ category: 'NOT_A_REAL_CATEGORY' });
  assert.strictEqual(resolution.level, null);
  assert.strictEqual(resolution.reason, UNSETTLED_REASONS.INTENT_UNRECOGNIZED);
});

test('no intent argument at all resolves to no level with intent_absent', () => {
  assert.deepStrictEqual(resolveReaderRiskLevel(undefined), { level: null, source: null, reason: UNSETTLED_REASONS.INTENT_ABSENT });
  assert.deepStrictEqual(resolveReaderRiskLevel(null), { level: null, source: null, reason: UNSETTLED_REASONS.INTENT_ABSENT });
});

test('an intent object with no usable fields resolves to no level with intent_unrecognized', () => {
  assert.deepStrictEqual(resolveReaderRiskLevel({}), { level: null, source: null, reason: UNSETTLED_REASONS.INTENT_UNRECOGNIZED });
});

test('selectReadBehavior forces block with the resolution reason when no level resolved', () => {
  const resolution = resolveReaderRiskLevel(undefined);
  const result = selectReadBehavior(resolution, { hasLastKnownGood: true });
  assert.strictEqual(result.behavior, READ_BEHAVIORS.BLOCK);
  assert.strictEqual(result.reason, UNSETTLED_REASONS.INTENT_ABSENT);
});

test('selectReadBehavior escalates last_known_good to block when there is no canonical value', () => {
  const resolution = resolveReaderRiskLevel({ category: 'NETWORK_CALL' }); // MEDIUM -> last_known_good
  const result = selectReadBehavior(resolution, { hasLastKnownGood: false });
  assert.strictEqual(result.behavior, READ_BEHAVIORS.BLOCK);
  assert.strictEqual(result.reason, UNSETTLED_REASONS.NO_LAST_KNOWN_GOOD);
});

test('selectReadBehavior returns the mapped behavior when a last-known-good value exists', () => {
  const resolution = resolveReaderRiskLevel({ category: 'NETWORK_CALL' });
  const result = selectReadBehavior(resolution, { hasLastKnownGood: true });
  assert.strictEqual(result.behavior, READ_BEHAVIORS.LAST_KNOWN_GOOD);
  assert.strictEqual(result.reason, UNSETTLED_REASONS.CONTESTED_PENDING_TRIAGE);
});

test('isContestingCandidate is false for a graph-hypotheses diagnosis candidate (no conflict object)', () => {
  const canonical = { targetId: 'fire' };
  const hypothesisCandidate = {
    candidateId: 'hyp-1',
    proposedEdge: { from: 'fire', to: 'smoke', relation: 'CAUSES' },
    recommendation: 'flag',
    status: 'pending',
    // graph-hypotheses.js never sets a `conflict` key at all.
  };
  assert.strictEqual(isContestingCandidate(hypothesisCandidate, canonical), false);
});

test('isContestingCandidate is false for an external-client review-hold candidate (conflict: null)', () => {
  const canonical = { targetId: 'fire' };
  const externalClientCandidate = {
    candidateId: 'ext-1',
    proposedEdge: { from: 'fire', to: 'smoke', relation: 'CAUSES' },
    conflict: null,
    recommendation: 'flag',
    status: 'pending',
  };
  assert.strictEqual(isContestingCandidate(externalClientCandidate, canonical), false);
});

test('isContestingCandidate is false for an already-reviewed candidate that still carries recommendation: flag', () => {
  const canonical = { targetId: 'fire' };
  const base = {
    candidateId: 'cand-1',
    proposedEdge: { from: 'fire', to: 'smoke', relation: 'PREVENTS' },
    conflict: { conflict: true, type: 'agent-vs-causal' },
    recommendation: 'flag',
  };
  assert.strictEqual(isContestingCandidate({ ...base, status: 'accepted' }, canonical), false);
  assert.strictEqual(isContestingCandidate({ ...base, status: 'rejected' }, canonical), false);
});

test('isContestingCandidate is true for a live, unreviewed conflict-detector conflict targeting the canonical record', () => {
  const canonical = { targetId: 'fire' };
  const candidate = {
    candidateId: 'cand-1',
    proposedEdge: { from: 'fire', to: 'smoke', relation: 'PREVENTS' },
    conflict: { conflict: true, type: 'agent-vs-causal' },
    recommendation: 'flag',
    status: 'pending',
  };
  assert.strictEqual(isContestingCandidate(candidate, canonical), true);
});
