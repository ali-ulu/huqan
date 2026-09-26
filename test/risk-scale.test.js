'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  RISK_SCALES,
  GATE_RISK_SCALES,
  toPercentRiskScore,
  gateRiskScale,
  toPercentRisk,
} = require('../lib/risk-scale');

test('a unit score is multiplied into the canonical 0-100 scale and rounded', () => {
  assert.equal(toPercentRiskScore(0, RISK_SCALES.UNIT), 0);
  assert.equal(toPercentRiskScore(0.55, RISK_SCALES.UNIT), 55);
  assert.equal(toPercentRiskScore(0.005, RISK_SCALES.UNIT), 1);
  assert.equal(toPercentRiskScore(1, RISK_SCALES.UNIT), 100);
});

test('a percent score is kept, and both scales are clamped to 0-100', () => {
  assert.equal(toPercentRiskScore(1, RISK_SCALES.PERCENT), 1, 'one on 0-100 stays one: the value never decides the scale');
  assert.equal(toPercentRiskScore(80, RISK_SCALES.PERCENT), 80);
  assert.equal(toPercentRiskScore(80.4, RISK_SCALES.PERCENT), 80);
  assert.equal(toPercentRiskScore(250, RISK_SCALES.PERCENT), 100);
  assert.equal(toPercentRiskScore(-3, RISK_SCALES.PERCENT), 0);
  assert.equal(toPercentRiskScore(1.7, RISK_SCALES.UNIT), 100);
  assert.equal(toPercentRiskScore(-0.2, RISK_SCALES.UNIT), 0);
});

test('a missing or non-finite score is null, never zero', () => {
  for (const value of [undefined, null, '', 'high', Number.NaN, Infinity]) {
    assert.equal(toPercentRiskScore(value, RISK_SCALES.UNIT), null, String(value));
    assert.equal(toPercentRiskScore(value, RISK_SCALES.PERCENT), null, String(value));
  }
  assert.equal(toPercentRiskScore('0.5', RISK_SCALES.UNIT), 50);
});

test('an undeclared scale is refused rather than guessed', () => {
  assert.throws(() => toPercentRiskScore(0.5, 'fraction'), /unknown risk scale/);
  assert.throws(() => toPercentRiskScore(0.5), /unknown risk scale/);
  assert.equal(gateRiskScale('AB99'), null);
  assert.equal(gateRiskScale('__proto__'), null);
  assert.equal(gateRiskScale('toString'), null);
  assert.throws(() => toPercentRisk({ score: 0.5 }, 'AB99'), /no declared risk scale/);
});

test('toPercentRisk converts only the score and leaves the rest of the risk object', () => {
  const unit = { level: 'critical', score: 1, categories: ['graph'] };
  assert.deepEqual(toPercentRisk(unit, 'AB4'), { level: 'critical', score: 100, categories: ['graph'] });
  assert.deepEqual(unit, { level: 'critical', score: 1, categories: ['graph'] }, 'the input is not mutated');
  assert.deepEqual(toPercentRisk({ level: 'high', score: 95, category: 'command-exec' }, 'AB8'), { level: 'high', score: 95, category: 'command-exec' });
  const levelOnly = { level: 'high' };
  assert.equal(toPercentRisk(levelOnly, 'AB2'), levelOnly);
  assert.equal(toPercentRisk(undefined, 'AB2'), null);
  assert.deepEqual(toPercentRisk({ level: 'low', score: 'n/a' }, 'AB5'), { level: 'low', score: null });
});

test('findingPercentRiskScore converts with the finding gate scale and falls back to the level', () => {
  const { findingPercentRiskScore } = require('../lib/risk-scale');
  const levelScore = (level) => ({ HIGH: 80, critical: 100 }[level] ?? 7);
  assert.equal(findingPercentRiskScore({ gate: 'AB4', risk: { score: 0.3 } }, levelScore), 30);
  assert.equal(findingPercentRiskScore({ gate: 'AB8', risk: { score: 1 } }, levelScore), 1);
  assert.equal(findingPercentRiskScore({ gate: 'AB1', riskLevel: 'HIGH' }, levelScore), 80);
  assert.equal(findingPercentRiskScore({ gate: 'control-plane', risk: { score: 0.5 }, riskLevel: 'critical' }, levelScore), 100);
  assert.equal(findingPercentRiskScore({ gate: 'AB2', risk: { score: 'n/a' } }, levelScore), 7);
  assert.equal(findingPercentRiskScore(undefined, levelScore), 7);
});

test('highestPercentRiskScore reads findings as 0-100 and never converts them a second time', () => {
  const { highestPercentRiskScore } = require('../lib/risk-scale');
  const levelScore = (level) => ({ HIGH: 80 }[level] ?? 0);
  assert.equal(highestPercentRiskScore([{ gate: 'AB5', risk: { score: 55 } }, { gate: 'AB1', riskLevel: 'HIGH' }], levelScore), 80);
  assert.equal(highestPercentRiskScore([{ gate: 'AB5', risk: { score: 60 } }], levelScore), 60, 'an AB5 score already on 0-100 is not multiplied again');
  assert.equal(highestPercentRiskScore([{ riskScore: 250 }], levelScore), 100);
  assert.equal(highestPercentRiskScore([{ risk: { score: null }, riskLevel: 'HIGH' }], levelScore), 80);
  assert.equal(highestPercentRiskScore([], levelScore), 0);
  assert.equal(highestPercentRiskScore(undefined, levelScore), 0);
});

test('every declared gate uses one of the two scales, and the table is frozen', () => {
  assert.ok(Object.isFrozen(GATE_RISK_SCALES));
  for (const [gate, scale] of Object.entries(GATE_RISK_SCALES)) {
    assert.ok(Object.values(RISK_SCALES).includes(scale), gate);
  }
});

test('the external action guard converts a finding score with its gate scale, not its value', () => {
  const { normalizeExternalActionFindingRiskScore: score } = require('../lib/external-action-guard');
  assert.equal(score({ gate: 'AB5', risk: { score: 1 } }), 100);
  assert.equal(score({ gate: 'AB8', risk: { score: 1 } }), 1, 'one on 0-100 stays one; the old value guess made it 100');
  assert.equal(score({ gate: 'AB4', risk: { score: 0.3 } }), 30);
  assert.equal(score({ gate: 'AB12', risk: { score: 95 } }), 95);
  assert.equal(score({ gate: 'AB1', riskLevel: 'HIGH' }), 80, 'no score: the level stands in');
  assert.equal(score({ gate: 'AB2', risk: { score: 'n/a' }, riskLevel: 'medium' }), 50, 'unconvertible score: the level stands in');
  assert.equal(score({ gate: 'control-plane', risk: { score: 0.5 }, riskLevel: 'critical' }), 100, 'undeclared gate: the level, never a guessed scale');
  assert.equal(score({ gate: 'shell-side-effect' }), 10);
});

test('riskLevelForScore uses the action-taxonomy bands at their exact boundaries', () => {
  const { riskLevelForScore, RISK_LEVEL_BANDS } = require('../lib/risk-scale');
  const expected = [[0, 'low'], [24, 'low'], [25, 'medium'], [49, 'medium'], [50, 'high'], [74, 'high'], [75, 'critical'], [100, 'critical']];
  for (const [score, level] of expected) assert.equal(riskLevelForScore(score), level, `score ${score}`);
  assert.equal(riskLevelForScore(74.4), 'high');
  assert.equal(riskLevelForScore(74.6), 'critical', 'the score is rounded onto the integer scale first');
  assert.equal(riskLevelForScore(250), 'critical');
  assert.equal(riskLevelForScore(-5), 'low');
  assert.ok(Object.isFrozen(RISK_LEVEL_BANDS));
});

test('riskLevelForScore spells the level in the caller vocabulary and is null without a score', () => {
  const { riskLevelForScore } = require('../lib/risk-scale');
  const upper = { LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH', CRITICAL: 'CRITICAL' };
  assert.equal(riskLevelForScore(80, upper), 'CRITICAL');
  assert.equal(riskLevelForScore(30, upper), 'MEDIUM');
  for (const value of [undefined, null, '', 'high', Number.NaN]) {
    assert.equal(riskLevelForScore(value), null, String(value));
    assert.equal(riskLevelForScore(value, upper), null, String(value));
  }
});

test('every gate the MCP adapter and the external action guard name has a declared scale', () => {
  const root = path.join(__dirname, '..');
  for (const file of ['lib/mcp-gate-adapter.js', 'lib/external-action-guard-gate-phase.js', 'lib/external-action-egress-gates.js']) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const named = new Set([
      ...[...source.matchAll(/gate:\s*'(AB\d+)'/g)].map((match) => match[1]),
      ...[...source.matchAll(/runGate\('(AB\d+)'/g)].map((match) => match[1]),
    ]);
    assert.ok(named.size > 0, `${file} names at least one gate`);
    for (const gate of named) {
      assert.notEqual(gateRiskScale(gate), null, `${file} names ${gate}, which has no declared risk scale`);
    }
  }
});
