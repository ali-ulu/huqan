'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildValueLedger, expectedFor, MAX_EVENTS } = require('../lib/cognition/value-ledger');

const options = { workspaceId: 'default', asOf: '2026-10-22T00:00:00Z', historyBoundary: { at: '2026-10-22T00:00:00Z', decisionId: 'next' } };
const event = (i, outcome = 'confirmed', extra = {}) => ({
  workspaceId: 'default', key: 'rule:k', decisionId: `d${i}`, outcome,
  at: new Date(Date.UTC(2026, 9, 21, 0, 0, i)).toISOString(),
  availableAt: new Date(Date.UTC(2026, 9, 21, 0, 0, i + 1)).toISOString(),
  sourceGroup: `group:${i}`, sourceRefs: [`source:${i}`], ...extra,
});
const entry = (ledger) => ledger.entries.find((row) => row.key === 'rule:k');

test('folds deterministically, freezes results and does not mutate records', () => {
  const rows = [event(3, 'rollback'), event(1), event(2)];
  const before = JSON.stringify(rows);
  const ledger = buildValueLedger(rows, options);
  assert.deepEqual(ledger, buildValueLedger([...rows].reverse(), options));
  assert.equal(JSON.stringify(rows), before);
  assert.equal(entry(ledger).value, 0.333333);
  assert.equal(entry(ledger).nObserved, 3);
  assert.equal(entry(ledger).nIndependent, 3);
  assert.equal(entry(ledger).supportScore, 0.428571);
  assert.equal(entry(ledger).success.p, 0.6);
  assert.equal(expectedFor(ledger, 'rule:k'), 0.333333);
  assert.ok(Object.isFrozen(entry(ledger).success));
  assert.equal(ledger.authority, 'SIGNAL_ONLY');
});

test('insufficient independent support never exposes a bare value or probability', () => {
  for (const rows of [[event(1), event(2)], [1, 2, 3, 4].map((i) => event(i, 'confirmed', { sourceGroup: null }))]) {
    const ledger = buildValueLedger(rows, options);
    assert.equal(entry(ledger).status, 'INSUFFICIENT');
    assert.equal(entry(ledger).value, null);
    assert.equal(entry(ledger).success.p, null);
    assert.equal(entry(ledger).provisional.value, 1);
    assert.equal(expectedFor(ledger, 'rule:k'), null);
  }
  assert.equal(expectedFor(buildValueLedger([], options), 'missing'), null);
});

test('deduplicates decisions and rejects conflicts without leaking other workspaces', () => {
  const rows = [event(1), event(2), event(3)];
  assert.deepEqual(buildValueLedger([...rows, event(1)], options), buildValueLedger(rows, options));
  assert.equal(buildValueLedger([...rows, event(1, 'rollback')], options).status, 'REJECT');
  assert.deepEqual(buildValueLedger([...rows, event(4, 'rollback', { workspaceId: 'other' })], options), buildValueLedger(rows, options));
});

test('shared source references and transitive groups cannot inflate independence', () => {
  const rows = [event(1), event(2), event(3, 'confirmed', { sourceRefs: ['source:1', 'source:2'] })];
  assert.equal(entry(buildValueLedger(rows, options)).nIndependent, 1);
  const sameGroup = [1, 2, 3].map((i) => event(i, 'confirmed', { sourceGroup: 'one' }));
  assert.equal(entry(buildValueLedger(sameGroup, options)).nIndependent, 1);
  const bridge = [event(1), event(2), event(3), event(4, 'confirmed', { sourceGroup: null, sourceRefs: ['source:1', 'source:2', 'source:3'] })];
  assert.equal(entry(buildValueLedger(bridge, options)).nIndependent, 1);
  assert.equal(entry(buildValueLedger(bridge, options)).status, 'INSUFFICIENT');
  bridge[3].outcome = 'censored';
  assert.equal(entry(buildValueLedger(bridge, options)).nIndependent, 1);
  assert.equal(entry(buildValueLedger(bridge, options)).nObserved, 3);
});

test('ties use decisionId order and repeated prefix reconstruction matches complete replay', () => {
  const at = event(1).at;
  const rows = [event(3, 'rollback', { at }), event(1, 'confirmed', { at }), event(2, 'confirmed', { at })];
  assert.equal(entry(buildValueLedger(rows, options)).arousal, 0.3735);
  for (let end = 1; end <= rows.length; end++) {
    const prefix = rows.slice(0, end);
    assert.deepEqual(buildValueLedger(prefix, options), buildValueLedger(JSON.parse(JSON.stringify(prefix)), options));
  }
});

test('excludes the scored decision, future observations and backdated late arrivals', () => {
  const rows = [event(1), event(2), event(3)];
  const cutoff = { ...options, asOf: event(4).at, historyBoundary: { at: event(4).at, decisionId: 'd4' } };
  const baseline = buildValueLedger(rows, cutoff);
  assert.deepEqual(buildValueLedger([...rows, event(4, 'rollback'), event(5, 'rollback'), event(0, 'rollback', { availableAt: options.asOf })], cutoff), baseline);
  assert.equal(buildValueLedger(rows, { ...cutoff, historyBoundary: null }).status, 'REJECT');
  const lateRows = [1, 2, 3].map((i) => event(i, 'confirmed', { availableAt: '2026-10-22T00:00:00Z' }));
  const historical = { ...options, asOf: '2026-10-23T00:00:00Z', historyBoundary: { at: '2026-10-21T12:00:00Z', decisionId: 'scored' } };
  assert.equal(buildValueLedger(lateRows, historical).status, 'INSUFFICIENT');
  assert.deepEqual(buildValueLedger(lateRows, historical).entries, []);
  assert.deepEqual(buildValueLedger([...rows, event(0, 'confirmed', { availableAt: options.asOf, sourceRefs: [42], extra: true })], cutoff), baseline);
  const ownId = buildValueLedger([event(1), event(2), event(3, 'confirmed', { decisionId: 'next' })], options);
  assert.equal(entry(ownId).nObserved, 2);
  assert.equal(entry(ownId).status, 'INSUFFICIENT');
});

test('compensation utility is separate from confirmed probability and censored is excluded', () => {
  const ledger = buildValueLedger([event(1, 'compensation'), event(2, 'compensation'), event(3, 'compensation'), event(4, 'censored')], options);
  assert.equal(entry(ledger).value, -0.5);
  assert.equal(entry(ledger).success.nConfirmed, 0);
  assert.equal(entry(ledger).success.nObserved, 3);
  assert.equal(entry(ledger).success.p, 0.2);
  assert.equal(entry(ledger).success.calibration, 'NOT_MEASURED');
});

test('arousal responds to surprise, then decays; valence has a neutral band', () => {
  const negative = buildValueLedger([event(1, 'rollback'), event(2, 'rollback'), event(3, 'rollback')], options);
  assert.equal(entry(negative).valence, 'negative');
  const positive = buildValueLedger([event(1), event(2), event(3)], options);
  assert.equal(entry(positive).valence, 'positive');
  const surprise = buildValueLedger([event(1), event(2), event(3, 'rollback')], options);
  assert.ok(entry(surprise).arousal > entry(positive).arousal);
  const settled = buildValueLedger([1, 2, 3, 4, 5, 6].map((i) => event(i)), options);
  assert.ok(entry(settled).arousal < entry(positive).arousal);
  const neutral = buildValueLedger([event(1), event(2, 'rollback'), event(3), event(4, 'rollback')], options);
  assert.equal(entry(neutral).valence, 'neutral');
});

test('keeps newest MAX_EVENTS after deduplication and flags truncation', () => {
  const rows = Array.from({ length: MAX_EVENTS + 1 }, (_, i) => event(i));
  const ledger = buildValueLedger(rows, options);
  assert.equal(ledger.truncated, true);
  assert.equal(entry(ledger).nObserved, MAX_EVENTS);
  assert.ok(!entry(ledger).sourceRefs.includes('source:0'));
  const linked = [event(0, 'confirmed', { sourceGroup: null, sourceRefs: ['r1', 'r2', 'r3'] }),
    ...Array.from({ length: MAX_EVENTS }, (_, i) => event(i + 1, 'confirmed', { sourceGroup: `g${i % 3}`, sourceRefs: [`r${i % 3 + 1}`] }))];
  const bounded = buildValueLedger(linked, options);
  assert.equal(bounded.truncated, true);
  assert.equal(entry(bounded).nIndependent, 1);
  assert.equal(entry(bounded).status, 'INSUFFICIENT');
});

test('rejects malformed inputs and bounds instead of manufacturing evidence', () => {
  for (const rows of [null, [event(1, 'confirmed', { at: 'bad' })], [event(1, 'confirmed', { availableAt: null })], [event(1, 'confirmed', { sourceRefs: [1] })]]) {
    assert.equal(buildValueLedger(rows, options).status, 'REJECT');
  }
  assert.equal(buildValueLedger([], { ...options, workspaceId: '' }).status, 'REJECT');
  assert.equal(buildValueLedger([], { ...options, asOf: '2026-10-22T00:00:00' }).status, 'REJECT');
  assert.equal(buildValueLedger([event(1, 'confirmed', { at: '2026-10-21T00:00:00' })], options).status, 'REJECT');
});
