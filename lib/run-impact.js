'use strict';

// An agent run's cumulative impact, from the step records the run already
// keeps (#2505).
//
// Every step report carries the agent action firewall's decision, and with it
// a risk score on the firewall's declared 0-1 scale. The run state holds those
// steps, and storage.saveRun persists the whole state as state_json, so the
// summary needs no new column. It is the recorded firewall risk scores summed,
// not a blast radius: that is what the run records per step.
//
// Recorded, not enforced: the owner's decision is to record the total first and
// enforce a threshold only after it has been calibrated against these records.
// A step without a firewall score (a step stopped by goal binding before the
// firewall ran) is listed as unscored, never counted as 0.

const { GATE_RISK_SCALES, toPercentRiskScore } = require('./risk-scale');

const SOURCE = 'steps[].actionFirewall.risk.score';

/** The recorded firewall risk of every step in an agent run. */
function summarizeRunImpact(steps) {
  if (!Array.isArray(steps)) {
    return Object.freeze({
      steps: null,
      scoredSteps: null,
      unscoredSteps: null,
      recordedScoreTotal: null,
      maxScore: null,
      status: 'unknown',
      reasons: Object.freeze(['the run carries no step records']),
      source: SOURCE,
      enforced: false,
    });
  }
  let recordedScoreTotal = 0;
  let maxScore = null;
  let scoredSteps = 0;
  for (const step of steps) {
    const score = toPercentRiskScore(step?.actionFirewall?.risk?.score, GATE_RISK_SCALES['agent-action-firewall']);
    if (score === null) continue;
    scoredSteps += 1;
    recordedScoreTotal += score;
    maxScore = maxScore === null ? score : Math.max(maxScore, score);
  }
  const unscoredSteps = steps.length - scoredSteps;
  const reasons = unscoredSteps > 0 ? [`${unscoredSteps} step(s) carry no firewall risk score`] : [];
  return Object.freeze({
    steps: steps.length,
    scoredSteps,
    unscoredSteps,
    recordedScoreTotal,
    maxScore,
    status: reasons.length > 0 ? 'partial' : 'computed',
    reasons: Object.freeze(reasons),
    source: SOURCE,
    enforced: false,
  });
}

module.exports = { summarizeRunImpact };
