'use strict';

const { findSecretsInText, maskSecretsInText } = require('../lib/secret-patterns');

/**
 * secret-masker (#211).
 *
 * Redacts secret-shaped substrings out of ask()/dream() output before it
 * reaches a caller. Pattern ownership lives in lib/secret-patterns.js so the
 * plugin's substring masker and the AB2/AB7 security gates cannot drift.
 *
 * Depends on fix/348-emitstrict... (afterAsk) actually reaching the final
 * answer -- see the "afterAsk mutation propagation" fix merged ahead of
 * this: without it, mutating `data.answer` here would have no effect on
 * what the caller receives.
 */

module.exports = {
  name: 'secret-masker',
  requires: [],
  optional: [],

  afterAsk(kernel, data) {
    if (data && typeof data.answer === 'string') {
      data.answer = maskSecretsInText(data.answer);
    }
  },

  afterDream(kernel, data) {
    if (data && Array.isArray(data.hypotheses)) {
      for (const hypothesis of data.hypotheses) {
        if (hypothesis && typeof hypothesis.text === 'string') {
          hypothesis.text = maskSecretsInText(hypothesis.text);
        }
      }
    }
  },
};

module.exports.findSecretsInText = findSecretsInText;
module.exports.maskSecretsInText = maskSecretsInText;
