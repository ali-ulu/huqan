'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { HORIZON_MS_BY_RISK_LEVEL, computeReverificationHorizon } = require('./admission-horizon');

const CREATED_AT = '2026-01-01T00:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

test('every risk level maps to a horizon or explicitly none', () => {
  assert.deepEqual(Object.keys(HORIZON_MS_BY_RISK_LEVEL).sort(), ['critical', 'high', 'low', 'medium']);
});

test('CRITICAL gets the shortest horizon: 24 hours', () => {
  const horizon = computeReverificationHorizon({ riskScore: 90, createdAt: CREATED_AT });
  assert.equal(horizon, new Date(Date.parse(CREATED_AT) + DAY_MS).toISOString());
});

test('HIGH gets a longer horizon than CRITICAL: 7 days', () => {
  const critical = computeReverificationHorizon({ riskScore: 90, createdAt: CREATED_AT });
  const high = computeReverificationHorizon({ riskScore: 60, createdAt: CREATED_AT });
  assert.equal(high, new Date(Date.parse(CREATED_AT) + 7 * DAY_MS).toISOString());
  assert.ok(Date.parse(high) > Date.parse(critical), 'HIGH horizon must be later than CRITICAL');
});

test('MEDIUM gets a longer horizon than HIGH: 30 days', () => {
  const high = computeReverificationHorizon({ riskScore: 60, createdAt: CREATED_AT });
  const medium = computeReverificationHorizon({ riskScore: 30, createdAt: CREATED_AT });
  assert.equal(medium, new Date(Date.parse(CREATED_AT) + 30 * DAY_MS).toISOString());
  assert.ok(Date.parse(medium) > Date.parse(high), 'MEDIUM horizon must be later than HIGH');
});

test('LOW gets no computed horizon at all', () => {
  assert.equal(computeReverificationHorizon({ riskScore: 10, createdAt: CREATED_AT }), null);
  assert.equal(computeReverificationHorizon({ riskScore: 0, createdAt: CREATED_AT }), null);
});

test('risk-band boundaries (24/25, 49/50, 74/75) land in the correct band', () => {
  assert.equal(computeReverificationHorizon({ riskScore: 24, createdAt: CREATED_AT }), null); // low
  assert.notEqual(computeReverificationHorizon({ riskScore: 25, createdAt: CREATED_AT }), null); // medium
  assert.equal(
    computeReverificationHorizon({ riskScore: 49, createdAt: CREATED_AT }),
    new Date(Date.parse(CREATED_AT) + 30 * DAY_MS).toISOString(),
  ); // still medium
  assert.equal(
    computeReverificationHorizon({ riskScore: 50, createdAt: CREATED_AT }),
    new Date(Date.parse(CREATED_AT) + 7 * DAY_MS).toISOString(),
  ); // high
  assert.equal(
    computeReverificationHorizon({ riskScore: 74, createdAt: CREATED_AT }),
    new Date(Date.parse(CREATED_AT) + 7 * DAY_MS).toISOString(),
  ); // still high
  assert.equal(
    computeReverificationHorizon({ riskScore: 75, createdAt: CREATED_AT }),
    new Date(Date.parse(CREATED_AT) + DAY_MS).toISOString(),
  ); // critical
});

test('an unreadable riskScore produces no horizon rather than a guess', () => {
  assert.equal(computeReverificationHorizon({ riskScore: undefined, createdAt: CREATED_AT }), null);
  assert.equal(computeReverificationHorizon({ riskScore: NaN, createdAt: CREATED_AT }), null);
  assert.equal(computeReverificationHorizon({}), null);
});

test('an unparseable createdAt produces no horizon rather than a guess', () => {
  assert.equal(computeReverificationHorizon({ riskScore: 90, createdAt: 'not-a-date' }), null);
});

test('createdAt defaults to now when omitted', () => {
  const before = Date.now();
  const horizon = computeReverificationHorizon({ riskScore: 90 });
  const after = Date.now();
  const horizonMs = Date.parse(horizon);
  assert.ok(horizonMs >= before + DAY_MS && horizonMs <= after + DAY_MS);
});
