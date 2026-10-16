'use strict';

// One risk scale for every gate (#2505): an integer from 0 to 100.
//
// Some gates score on 0-1 (the tool call gate, memory mutation, automation
// safety, sandbox isolation, the code-change gate, the agent action firewall)
// and some on 0-100 (the action risk classifier, command exec, egress,
// residency, cross-workspace, and the adapters that aggregate them). The
// adapters used to read a 0-1 score as if it were 0-100, so a block on a
// secret write reported a risk of 1 while an ordinary review reported 80.
//
// A gate's scale is declared here, by name. It is never guessed from the
// value: 1 is a valid low score on 0-100 and a maximal one on 0-1, so a value
// test cannot tell them apart.

const RISK_SCALES = Object.freeze({
  UNIT: 'unit',
  PERCENT: 'percent',
});

const GATE_RISK_SCALES = Object.freeze({
  AB1: RISK_SCALES.PERCENT,
  AB2: RISK_SCALES.UNIT,
  AB4: RISK_SCALES.UNIT,
  AB5: RISK_SCALES.UNIT,
  AB6: RISK_SCALES.UNIT,
  AB8: RISK_SCALES.PERCENT,
  AB9: RISK_SCALES.PERCENT,
  AB11: RISK_SCALES.PERCENT,
  AB12: RISK_SCALES.PERCENT,
  AB13: RISK_SCALES.PERCENT,
  AB14: RISK_SCALES.PERCENT,
  'code-change': RISK_SCALES.UNIT,
  'agent-action-firewall': RISK_SCALES.UNIT,
});

/**
 * A score on the canonical 0-100 scale, or `null` when there is no finite
 * score to convert. `null` means "not computed"; it is never read as 0.
 */
function toPercentRiskScore(score, scale) {
  if (scale !== RISK_SCALES.UNIT && scale !== RISK_SCALES.PERCENT) {
    throw new TypeError(`unknown risk scale: ${String(scale)}`);
  }
  if (score === null || score === undefined || score === '') return null;
  const value = Number(score);
  if (!Number.isFinite(value)) return null;
  const percent = scale === RISK_SCALES.UNIT ? value * 100 : value;
  return Math.round(Math.max(0, Math.min(100, percent)));
}

/** The declared scale of a gate, or `null` when the gate has not declared one. */
function gateRiskScale(gate) {
  return Object.hasOwn(GATE_RISK_SCALES, gate) ? GATE_RISK_SCALES[gate] : null;
}

/**
 * A gate's `risk` object with its score on the canonical scale. Returns the
 * input unchanged when it has no score, and `null` when there is no object.
 */
function toPercentRisk(risk, gate) {
  if (!risk || typeof risk !== 'object') return null;
  const scale = gateRiskScale(gate);
  if (!scale) throw new TypeError(`gate ${String(gate)} has no declared risk scale`);
  if (!Object.hasOwn(risk, 'score')) return risk;
  return { ...risk, score: toPercentRiskScore(risk.score, scale) };
}

/**
 * A finding's score on the canonical scale, converted with its own gate's
 * declared scale. Without a score or a declared scale, `levelScore(level)`
 * stands in -- each aggregator keeps its own level table until #2505 unifies
 * the level boundaries.
 */
function findingPercentRiskScore(finding, levelScore) {
  const scale = gateRiskScale(finding?.gate);
  const score = scale ? toPercentRiskScore(finding?.risk?.score, scale) : null;
  return score === null ? levelScore(finding?.riskLevel) : score;
}

/**
 * The highest score among findings that are already on the canonical scale.
 * An adapter converts a 0-1 gate score once, where it records the finding;
 * converting again here would scale an already converted score a second time.
 * Without a score, `levelScore(level)` stands in.
 */
function highestPercentRiskScore(findings, levelScore) {
  return (findings || []).reduce((highest, finding) => {
    const direct = toPercentRiskScore(finding?.risk?.score ?? finding?.riskScore, RISK_SCALES.PERCENT);
    return Math.max(highest, direct === null ? levelScore(finding?.riskLevel) : direct);
  }, 0);
}

// The level bands in docs/action-taxonomy.md §3: 0-24 low, 25-49 medium,
// 50-74 high, 75-100 critical. A reported level is derived from the score with
// these bands, never from the decision, so the two cannot disagree (#2505).
const RISK_LEVEL_BANDS = Object.freeze([[75, 'CRITICAL'], [50, 'HIGH'], [25, 'MEDIUM'], [0, 'LOW']]);
const CANONICAL_RISK_LEVELS = Object.freeze({ LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' });

/**
 * The level for a 0-100 score, spelled in the caller's vocabulary (an object
 * with LOW / MEDIUM / HIGH / CRITICAL keys). `null` when there is no score.
 */
function riskLevelForScore(score, vocabulary = CANONICAL_RISK_LEVELS) {
  const percent = toPercentRiskScore(score, RISK_SCALES.PERCENT);
  if (percent === null) return null;
  const [, key] = RISK_LEVEL_BANDS.find(([floor]) => percent >= floor);
  return vocabulary[key];
}

module.exports = {
  RISK_SCALES,
  GATE_RISK_SCALES,
  RISK_LEVEL_BANDS,
  toPercentRiskScore,
  gateRiskScale,
  toPercentRisk,
  findingPercentRiskScore,
  highestPercentRiskScore,
  riskLevelForScore,
};
