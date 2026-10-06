'use strict';

/**
 * B7 bounded temporal-accumulation environment (#3474, I6).
 *
 * The outcome oracle for the B7 experiment: a binary sequence of exactly
 * `STEPS` steps, labelled positive when it carries at least `THRESHOLD` ones.
 * The label depends on the *count* over time, not on any single position, so a
 * memoryless model cannot recover it and a recurrent model can -- which is what
 * makes it a fair test of a local sequence model rather than of a lookup.
 *
 * This module is the law and nothing else. The model module never imports it;
 * the experiment calls `label` to produce the training labels and the holdout
 * outcomes, exactly as a host would consult the environment. The generator in
 * the design module emits *inputs only*, so a leaked outcome cannot come from
 * here.
 */

const FRAME = 'bounded-binary-accumulation-v1';
const STEPS = 8;
const THRESHOLD = 4;

function label(sequence) {
  if (!Array.isArray(sequence) || sequence.length !== STEPS) throw new TypeError(`sequence must have exactly ${STEPS} steps`);
  let ones = 0;
  for (const step of sequence) {
    if (step !== 0 && step !== 1) throw new TypeError('each step must be 0 or 1');
    ones += step;
  }
  return ones >= THRESHOLD ? 1 : 0;
}

module.exports = { FRAME, STEPS, THRESHOLD, label };
