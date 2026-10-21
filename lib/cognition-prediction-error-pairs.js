'use strict';

// COG-M2 (#4061): thin Adapters-ring reader that turns the prediction/outcome pairs
// already in the graph journal into prediction-error signals. Read-only: it never
// writes the graph, and a read failure yields INSUFFICIENT with no errors.

const { readPredictionPairs } = require('./prediction-outcome-pairs');
const { computePredictionError } = require('./cognition/prediction-error');
const { COGNITION_STATUS } = require('./cognition/contract');

function readPredictionErrors(graph) {
  try {
    const errors = Object.values(readPredictionPairs(graph))
      .sort((a, b) => (a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0))
      .map(({ decisionId, prediction, outcome }) => computePredictionError({
        kind: 'risk',
        decisionId,
        key: `risk:${prediction.actionClass || 'unclassified'}`,
        score: prediction.score,
        outcome: outcome ? outcome.state : null,
        at: outcome ? outcome.at : prediction.at,
      }));
    return Object.freeze({ status: COGNITION_STATUS.MEASURED, errors: Object.freeze(errors) });
  } catch (_) {
    return Object.freeze({ status: COGNITION_STATUS.INSUFFICIENT, errors: Object.freeze([]) });
  }
}

module.exports = { readPredictionErrors };
