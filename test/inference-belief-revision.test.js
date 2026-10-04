'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const {
  recordPrediction,
  recordOutcome,
} = require('../lib/prediction-outcome-pairs');
const {
  DERIVED_RECORD_SCHEMA_VERSION,
} = require('../lib/inference-derived-record');
const {
  RULE_BELIEF_SCHEMA_VERSION,
  DERIVED_BELIEF_SCHEMA_VERSION,
  CALIBRATION_STATUS,
  EFFECT_KIND,
  COUNTER_EVIDENCE_KIND,
  calibrateRuleBelief,
  calibrateRuleBeliefFromStore,
  ruleBeliefAt,
  reviseDerivedConclusionBeliefs,
  reconcileDerivedConclusionBeliefs,
  derivedBeliefAt,
  ruleAdmissionBlocked,
} = require('../lib/inference-belief-revision');

function pair(decisionId, ruleId, outcomeState) {
  return {
    decisionId,
    prediction: {
      score: 50,
      unknown: '',
      actionClass: `inference-rule:${ruleId}`,
      at: '2026-09-01T00:00:00.000Z',
    },
    outcome: outcomeState
      ? { state: outcomeState, at: '2026-09-02T00:00:00.000Z' }
      : null,
  };
}

function pairsObject(entries) {
  return Object.fromEntries(entries.map((entry) => [entry.decisionId, entry]));
}

function observed(...ids) {
  return ids.map((decisionId) => ({
    decisionId,
    kind: EFFECT_KIND.OBSERVED,
  }));
}

test('insufficient observed data remains explicit and preserves declared confidence', () => {
  const ruleId = 'rule:weather';
  const result = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.8,
    at: '2026-09-10T00:00:00.000Z',
    pairs: pairsObject([
      pair('d1', ruleId, 'confirmed'),
      pair('d2', ruleId, 'incident'),
    ]),
    effectEvidence: observed('d1', 'd2'),
  });

  assert.equal(result.schemaVersion, RULE_BELIEF_SCHEMA_VERSION);
  assert.equal(result.status, CALIBRATION_STATUS.INSUFFICIENT);
  assert.equal(result.reason, 'minimum_observed_samples_not_met');
  assert.equal(result.declaredConfidence, 0.8);
  assert.equal(result.calibratedConfidence, null);
  assert.equal(result.systemConfidence, 0.8);
  assert.equal(result.observedSamples, 2);
});

test('missing, censored and reported-only outcomes never count as observed success', () => {
  const ruleId = 'rule:effects';
  const pairs = pairsObject([
    pair('missing', ruleId, null),
    pair('censored', ruleId, 'censored'),
    pair('reported', ruleId, 'confirmed'),
    pair('observed-confirmed', ruleId, 'confirmed'),
  ]);

  const result = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.9,
    at: '2026-09-10T00:00:00.000Z',
    pairs,
    effectEvidence: [
      { decisionId: 'reported', kind: EFFECT_KIND.REPORTED },
      { decisionId: 'observed-confirmed', kind: EFFECT_KIND.OBSERVED },
    ],
  }, { minSamples: 1 });

  assert.equal(result.observedSamples, 1);
  assert.equal(result.observedSuccesses, 1);
  assert.equal(result.observedFailures, 0);
  assert.deepEqual(result.countedDecisionIds, ['observed-confirmed']);
  assert.deepEqual(
    result.ignoredDecisionIds,
    ['censored', 'missing', 'reported'],
  );
});

test('correlated observations from one source event count as one independent trial', () => {
  const ruleId = 'rule:source-independence';
  const pairs = pairsObject(['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => pair(id, ruleId, 'confirmed')));
  const result = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.9,
    at: '2026-09-10T00:00:00.000Z',
    pairs,
    effectEvidence: ['d1', 'd2', 'd3', 'd4', 'd5'].map((decisionId) => ({
      decisionId,
      kind: EFFECT_KIND.OBSERVED,
      sourceEventRefs: ['event:one-report'],
    })),
  }, { minSamples: 1 });

  assert.equal(result.observedSamples, 1);
  assert.equal(result.observedSuccesses, 1);
  assert.equal(result.observedFailures, 0);
  assert.deepEqual(result.countedDecisionIds, ['d1']);
  assert.deepEqual(result.correlatedDecisionIds, ['d2', 'd3', 'd4', 'd5']);
  assert.ok(result.ignoredDecisionIds.includes('d5'));
  assert.equal(result.history[0].correlatedSamples, 4);
});

test('support invalidation counter-evidence overrides prior confirmation per source event', () => {
  const ruleId = 'rule:invalidated-support';
  const ids = ['d1', 'd2', 'd3', 'd4', 'd5'];
  const result = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.9,
    at: '2026-09-20T00:00:00.000Z',
    pairs: pairsObject(ids.map((id) => pair(id, ruleId, 'confirmed'))),
    effectEvidence: ids.map((decisionId, index) => ({
      decisionId,
      kind: EFFECT_KIND.OBSERVED,
      sourceEventRefs: [`event:${index + 1}`],
    })),
    counterEvidence: ids.map((decisionId, index) => ({
      evidenceId: `withdraw:${index + 1}`,
      ruleId,
      decisionId,
      kind: COUNTER_EVIDENCE_KIND.SUPPORT_INVALIDATION,
      sourceEventRefs: [`event:${index + 1}`],
    })),
  });

  assert.equal(result.observedSamples, 5);
  assert.equal(result.observedSuccesses, 0);
  assert.equal(result.observedFailures, 5);
  assert.equal(result.status, CALIBRATION_STATUS.DEFEATED);
  assert.ok(result.systemConfidence < 0.25);
});

test('counter-evidence without source-event identity fails closed', () => {
  const result = calibrateRuleBelief({
    ruleId: 'rule:bad-counter',
    declaredConfidence: 0.8,
    at: '2026-09-20T00:00:00.000Z',
    pairs: {},
    counterEvidence: [{
      evidenceId: 'counter-1',
      ruleId: 'rule:bad-counter',
      decisionId: 'd1',
      kind: COUNTER_EVIDENCE_KIND.SUPPORT_INVALIDATION,
      sourceEventRefs: [],
    }],
  }, { minSamples: 1 });
  assert.equal(result.status, CALIBRATION_STATUS.INVALID);
  assert.match(result.reason, /source event/);
});

test('known observed fixture produces reproducible calibration', () => {
  const ruleId = 'rule:repro';
  const pairs = pairsObject([
    pair('d1', ruleId, 'confirmed'),
    pair('d2', ruleId, 'confirmed'),
    pair('d3', ruleId, 'confirmed'),
    pair('d4', ruleId, 'incident'),
    pair('d5', ruleId, 'rollback'),
  ]);
  const input = {
    ruleId,
    declaredConfidence: 0.9,
    at: '2026-09-10T00:00:00.000Z',
    pairs,
    effectEvidence: observed('d1', 'd2', 'd3', 'd4', 'd5'),
  };

  const left = calibrateRuleBelief(input);
  const right = calibrateRuleBelief(input);

  assert.deepEqual(left, right);
  assert.equal(left.observedSamples, 5);
  assert.equal(left.observedSuccesses, 3);
  assert.equal(left.observedFailures, 2);
  assert.equal(left.calibratedConfidence, 4 / 7);
  assert.equal(left.systemConfidence, Number((4 / 7).toFixed(6)));
});

test('adverse observed outcomes can degrade and defeat rule belief', () => {
  const ruleId = 'rule:fragile';
  const pairs = pairsObject([
    pair('d1', ruleId, 'incident'),
    pair('d2', ruleId, 'rollback'),
    pair('d3', ruleId, 'contradiction'),
    pair('d4', ruleId, 'reviewer-rejection'),
    pair('d5', ruleId, 'compensation'),
  ]);

  const result = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.95,
    at: '2026-09-10T00:00:00.000Z',
    pairs,
    effectEvidence: observed('d1', 'd2', 'd3', 'd4', 'd5'),
  });

  assert.equal(result.status, CALIBRATION_STATUS.DEFEATED);
  assert.equal(result.observedFailures, 5);
  assert.equal(result.observedSuccesses, 0);
  assert.equal(result.calibratedConfidence, 1 / 7);
  assert.ok(result.systemConfidence < 0.25);
});

test('tighten-only default never raises system confidence after a previous revision', () => {
  const ruleId = 'rule:tighten';
  const first = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.8,
    at: '2026-09-10T00:00:00.000Z',
    pairs: pairsObject([
      pair('a1', ruleId, 'confirmed'),
      pair('a2', ruleId, 'confirmed'),
      pair('a3', ruleId, 'incident'),
      pair('a4', ruleId, 'incident'),
      pair('a5', ruleId, 'incident'),
    ]),
    effectEvidence: observed('a1', 'a2', 'a3', 'a4', 'a5'),
  });

  const second = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.8,
    at: '2026-09-20T00:00:00.000Z',
    previous: first,
    pairs: pairsObject([
      pair('b1', ruleId, 'confirmed'),
      pair('b2', ruleId, 'confirmed'),
      pair('b3', ruleId, 'confirmed'),
      pair('b4', ruleId, 'confirmed'),
      pair('b5', ruleId, 'confirmed'),
    ]),
    effectEvidence: observed('b1', 'b2', 'b3', 'b4', 'b5'),
  });

  assert.ok(second.calibratedConfidence > first.systemConfidence);
  assert.equal(second.systemConfidence, first.systemConfidence);
  assert.equal(second.history.length, 2);
});

test('declared confidence remains separate from calibrated and system confidence', () => {
  const ruleId = 'rule:separate';
  const result = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.92,
    at: '2026-09-10T00:00:00.000Z',
    pairs: pairsObject([
      pair('d1', ruleId, 'confirmed'),
      pair('d2', ruleId, 'confirmed'),
      pair('d3', ruleId, 'incident'),
      pair('d4', ruleId, 'incident'),
      pair('d5', ruleId, 'incident'),
    ]),
    effectEvidence: observed('d1', 'd2', 'd3', 'd4', 'd5'),
  });

  assert.equal(result.declaredConfidence, 0.92);
  assert.notEqual(result.calibratedConfidence, result.declaredConfidence);
  assert.equal(
    result.systemConfidence,
    Number(Math.min(result.declaredConfidence, result.calibratedConfidence).toFixed(6)),
  );
});

test('rule belief history is queryable without rewriting the previous value', () => {
  const ruleId = 'rule:history';
  const first = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.9,
    at: '2026-09-10T00:00:00.000Z',
    pairs: pairsObject([
      pair('a1', ruleId, 'confirmed'),
      pair('a2', ruleId, 'confirmed'),
      pair('a3', ruleId, 'confirmed'),
      pair('a4', ruleId, 'incident'),
      pair('a5', ruleId, 'incident'),
    ]),
    effectEvidence: observed('a1', 'a2', 'a3', 'a4', 'a5'),
  });

  const second = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.9,
    at: '2026-09-20T00:00:00.000Z',
    previous: first,
    pairs: pairsObject([
      pair('b1', ruleId, 'incident'),
      pair('b2', ruleId, 'incident'),
      pair('b3', ruleId, 'incident'),
      pair('b4', ruleId, 'incident'),
      pair('b5', ruleId, 'incident'),
    ]),
    effectEvidence: observed('b1', 'b2', 'b3', 'b4', 'b5'),
  });

  const before = ruleBeliefAt(second, '2026-09-15T00:00:00.000Z');
  const after = ruleBeliefAt(second, '2026-09-21T00:00:00.000Z');

  assert.equal(before.systemConfidence, first.systemConfidence);
  assert.equal(after.systemConfidence, second.systemConfidence);
  assert.notEqual(before.systemConfidence, after.systemConfidence);
});

test('derived conclusions react to material rule downgrade and preserve their history', () => {
  const ruleId = 'rule:dependent';
  const record = Object.freeze({
    schemaVersion: DERIVED_RECORD_SCHEMA_VERSION,
    derivationId: 'prov_dep_1',
    ruleId,
  });

  const healthyRuleBelief = {
    schemaVersion: RULE_BELIEF_SCHEMA_VERSION,
    ruleId,
    status: CALIBRATION_STATUS.CALIBRATED,
    reason: 'observed_outcomes_calibrated',
    systemConfidence: 0.8,
  };
  const first = reviseDerivedConclusionBeliefs(
    [record],
    healthyRuleBelief,
    { at: '2026-09-10T00:00:00.000Z' },
  )[0];

  assert.equal(first.schemaVersion, DERIVED_BELIEF_SCHEMA_VERSION);
  assert.equal(first.status, 'active');

  const degradedRuleBelief = {
    schemaVersion: RULE_BELIEF_SCHEMA_VERSION,
    ruleId,
    status: CALIBRATION_STATUS.DEGRADED,
    reason: 'material_rule_belief_downgrade',
    systemConfidence: 0.5,
  };
  const second = reviseDerivedConclusionBeliefs(
    [record],
    degradedRuleBelief,
    {
      at: '2026-09-20T00:00:00.000Z',
      previousByDerivationId: { [record.derivationId]: first },
    },
  )[0];

  assert.equal(second.status, 'degraded');
  assert.equal(second.history.length, 2);
  assert.equal(
    derivedBeliefAt(second, '2026-09-15T00:00:00.000Z').status,
    'active',
  );
  assert.equal(
    derivedBeliefAt(second, '2026-09-21T00:00:00.000Z').status,
    'degraded',
  );
});

test('withdrawn support state withdraws the derived belief and preserves the reason', () => {
  const record = Object.freeze({
    schemaVersion: DERIVED_RECORD_SCHEMA_VERSION,
    derivationId: 'prov_withdrawn',
    ruleId: 'rule:withdrawn',
    state: 'withdrawn',
    history: Object.freeze([Object.freeze({
      at: '2026-09-20T00:00:00.000Z',
      state: 'withdrawn',
      reason: 'support_removed_superseded_or_contested',
    })]),
  });
  const belief = {
    schemaVersion: RULE_BELIEF_SCHEMA_VERSION,
    ruleId: 'rule:withdrawn',
    status: CALIBRATION_STATUS.CALIBRATED,
    reason: 'observed_outcomes_calibrated',
    systemConfidence: 0.8,
  };
  const revised = reviseDerivedConclusionBeliefs(
    [record],
    belief,
    { at: '2026-09-20T00:00:01.000Z' },
  )[0];
  assert.equal(revised.status, 'withdrawn');
  assert.equal(revised.history[0].reason, 'support_removed_superseded_or_contested');

  const reconciled = reconcileDerivedConclusionBeliefs([record], [{
    schemaVersion: DERIVED_BELIEF_SCHEMA_VERSION,
    derivationId: record.derivationId,
    ruleId: record.ruleId,
    status: 'active',
    systemConfidence: 0.8,
    history: [],
  }], { at: '2026-09-20T00:00:02.000Z' })[0];
  assert.equal(reconciled.status, 'withdrawn');
  assert.equal(reconciled.history.at(-1).reason, 'support_removed_superseded_or_contested');
});

test('defeated rule belief defeats dependent derived conclusion without mutating record state', () => {
  const record = Object.freeze({
    schemaVersion: DERIVED_RECORD_SCHEMA_VERSION,
    derivationId: 'prov_dep_2',
    ruleId: 'rule:defeated',
    state: 'admitted',
  });
  const belief = {
    schemaVersion: RULE_BELIEF_SCHEMA_VERSION,
    ruleId: 'rule:defeated',
    status: CALIBRATION_STATUS.DEFEATED,
    reason: 'rule_belief_below_defeat_threshold',
    systemConfidence: 0.1,
  };

  const revised = reviseDerivedConclusionBeliefs(
    [record],
    belief,
    { at: '2026-09-20T00:00:00.000Z' },
  )[0];

  assert.equal(revised.status, 'defeated');
  assert.equal(record.state, 'admitted');
});

test('calibrateRuleBeliefFromStore reads the persisted prediction pairs', (t) => {
  // The store-backed entrypoint had no repository consumer; this exercises it
  // end to end so the export is not a dead end and its wiring to
  // prediction-outcome-pairs is pinned.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-belief-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });

  const ruleId = 'rule:store';
  const actionClass = `inference-rule:${ruleId}`;
  const at = '2026-09-01T00:00:00.000Z';
  for (const id of ['d1', 'd2', 'd3', 'd4', 'd5']) {
    recordPrediction(graph, { decisionId: id, score: 80, actionClass, at });
  }
  recordOutcome(graph, { decisionId: 'd1', outcome: 'confirmed', idempotencyKey: 'o1', at });
  recordOutcome(graph, { decisionId: 'd2', outcome: 'confirmed', idempotencyKey: 'o2', at });
  for (const [id, key] of [['d3', 'o3'], ['d4', 'o4'], ['d5', 'o5']]) {
    recordOutcome(graph, { decisionId: id, outcome: 'incident', idempotencyKey: key, at });
  }

  const result = calibrateRuleBeliefFromStore(graph, {
    ruleId,
    declaredConfidence: 0.9,
    at: '2026-09-10T00:00:00.000Z',
    effectEvidence: ['d1', 'd2', 'd3', 'd4', 'd5'].map((decisionId) => ({
      decisionId,
      kind: EFFECT_KIND.OBSERVED,
    })),
  });

  assert.equal(result.status, CALIBRATION_STATUS.DEGRADED);
  assert.equal(result.observedSamples, 5);
  assert.equal(result.observedSuccesses, 2);
  assert.equal(result.observedFailures, 3);
  // Same input through the direct call agrees: the store read is the only
  // difference, so the calibration itself must not diverge.
  const direct = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.9,
    at: '2026-09-10T00:00:00.000Z',
    pairs: pairsObject([
      pair('d1', ruleId, 'confirmed'),
      pair('d2', ruleId, 'confirmed'),
      pair('d3', ruleId, 'incident'),
      pair('d4', ruleId, 'incident'),
      pair('d5', ruleId, 'incident'),
    ]),
    effectEvidence: ['d1', 'd2', 'd3', 'd4', 'd5'].map((decisionId) => ({
      decisionId,
      kind: EFFECT_KIND.OBSERVED,
    })),
  });
  assert.equal(result.systemConfidence, direct.systemConfidence);
  assert.equal(result.calibratedConfidence, direct.calibratedConfidence);
});

// The negative-evidence predicate both admission paths share. A rule whose
// calibrated belief is defeated, degraded, or below what it declared blocks
// admission; a rule with no belief is not blocked (absence is not evidence).
test('ruleAdmissionBlocked: defeated/degraded/low-confidence rules block, no-belief does not', () => {
  const calibrated = { ruleId: 'r', status: CALIBRATION_STATUS.CALIBRATED, systemConfidence: 0.9, declaredConfidence: 0.9 };
  assert.equal(ruleAdmissionBlocked([calibrated], 'r'), false);
  assert.equal(ruleAdmissionBlocked([{ ...calibrated, status: CALIBRATION_STATUS.DEFEATED }], 'r'), true);
  assert.equal(ruleAdmissionBlocked([{ ...calibrated, status: CALIBRATION_STATUS.DEGRADED }], 'r'), true);
  assert.equal(ruleAdmissionBlocked([{ ...calibrated, status: CALIBRATION_STATUS.INVALID }], 'r'), true);
  // Insufficient evidence is not negative evidence: it must not block.
  assert.equal(ruleAdmissionBlocked([{ ...calibrated, status: CALIBRATION_STATUS.INSUFFICIENT }], 'r'), false);
  assert.equal(ruleAdmissionBlocked([{ ...calibrated, systemConfidence: 0.4, declaredConfidence: 0.9 }], 'r'), true);
  assert.equal(ruleAdmissionBlocked([calibrated], 'other-rule'), false);
  assert.equal(ruleAdmissionBlocked([], 'r'), false);
  assert.equal(ruleAdmissionBlocked(null, 'r'), false);
});

// The block must not be fakeable by duplicate evidence: outcomes from one
// source event count as one independent trial, so a rule cannot be re-admitted
// by replaying the same event. `calibrateRuleBelief` de-duplicates; this pins
// the behaviour the admission gate depends on.
test('a defeated rule stays blocked; duplicate evidence cannot unblock it', () => {
  const ruleId = 'rule:blocked-once';
  const pairs = pairsObject(['d1', 'd2', 'd3', 'd4', 'd5'].map((id) => pair(id, ruleId, 'incident')));
  // Five adverse outcomes from ONE source event collapse to a single
  // independent trial, which degrades but cannot defeat a 0.95 declaration.
  const oneReport = ['d1', 'd2', 'd3', 'd4', 'd5'].map((decisionId) => ({
    decisionId,
    kind: EFFECT_KIND.OBSERVED,
    sourceEventRefs: ['event:one-report'],
  }));
  const correlated = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.95,
    at: '2026-09-10T00:00:00.000Z',
    pairs,
    effectEvidence: oneReport,
  }, { minSamples: 1 });
  assert.equal(correlated.observedSamples, 1);
  assert.notEqual(correlated.status, CALIBRATION_STATUS.DEFEATED);

  // The same five outcomes from five independent sources defeat the rule, and
  // replaying the same evidence cannot unblock it.
  const independent = ['d1', 'd2', 'd3', 'd4', 'd5'].map((decisionId) => ({
    decisionId,
    kind: EFFECT_KIND.OBSERVED,
    sourceEventRefs: [`event:${decisionId}`],
  }));
  const defeated = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.95,
    at: '2026-09-10T00:00:00.000Z',
    pairs,
    effectEvidence: independent,
  }, { minSamples: 1 });
  assert.equal(defeated.status, CALIBRATION_STATUS.DEFEATED);
  assert.equal(ruleAdmissionBlocked([defeated], ruleId), true);

  const replayed = calibrateRuleBelief({
    ruleId,
    declaredConfidence: 0.95,
    at: '2026-09-10T00:00:00.000Z',
    pairs,
    effectEvidence: independent,
  }, { minSamples: 1 });
  assert.equal(replayed.observedSamples, 5);
  assert.equal(ruleAdmissionBlocked([replayed], ruleId), true);
});
