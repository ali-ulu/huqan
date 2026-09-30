'use strict';

/**
 * Deliberate acceptances of a layer violation, on scripts/check-layers.js's
 * terms: a reason and a review date, with `--check` failing on an entry that
 * expired or that no longer describes a live edge. Existing violations are
 * not listed here -- they are the recorded baseline, which is machine-written,
 * reviewed as a diff, and may only shrink.
 *
 * Lives in a module of its own because the list grows entry by entry while
 * scripts/architecture-dependency-graph.js must stay at or under the 400-line
 * file-size budget.
 *
 * @type {ReadonlyArray<{from: string, to: string, why: string, review_by: string}>}
 */
const LAYER_EXCEPTIONS = Object.freeze([
  {
    from: 'lib/provenance-query-trust-receipt.js',
    to: 'lib/causal/causal-verdict.js',
    why: 'The trust-receipt causal bridge block normalizes a caller-supplied causal verdict into'
      + ' the published receipt shape. The same Core -> Application edge was a recorded baseline'
      + ' violation on lib/provenance-query.js; #2162 split that file and the edge moved onto the'
      + ' new module name, which the cannot-add-debt ratchet treats as new. The verdict stays'
      + ' caller-supplied (no production caller passes one), so the follow-up fix is to lift the'
      + ' bridge behind an injected normalizer rather than move the causal verdict into Core.',
    review_by: '2026-12-31',
  },
  {
    from: 'lib/cli-coder.js',
    to: 'lib/coder/journal-store.js',
    why: 'The coder command opens the pilot journal store it hands to applyDerivation; the opener'
      + ' lives beside the command (Core) while the store builder lives with the pipeline'
      + ' (Application). The follow-up fix is to open the store behind the cli.js entrypoint once'
      + ' it owns --journal, and pass the handle in.',
    review_by: '2026-12-31',
  },
  {
    from: 'lib/cli-coder.js',
    to: 'lib/coder/verify-ocr.js',
    why: 'The coder command resolves --verify ocr into the observed-verification seam it hands to'
      + ' applyDerivation (#3196); the flag table lives beside the command (Core) while the'
      + ' verifier lives with the pipeline (Application), the same shape as the journal-store'
      + ' edge above. The require is lazy, so a run without --verify never loads it. The follow-up'
      + ' fix is the same: resolve the verifier behind the cli.js entrypoint and pass it in.',
    review_by: '2026-12-31',
  },
  {
    from: 'lib/cli-experience-learn.js',
    to: 'lib/experience/learning-intake.js',
    why: 'The experience-learn command builds the learning proposal it prints; the command lives'
      + ' beside the other experience CLI handlers (Core) while the intake that reads the sealed'
      + ' journal and admits it lives with the experience pipeline (Application) -- the same shape'
      + ' as the cli-experience-read -> read-model edge already in the recorded baseline. The'
      + ' follow-up fix is the same as the coder command: open the journal behind the cli.js'
      + ' entrypoint and pass the intake in.',
    review_by: '2026-12-31',
  },
  {
    from: 'lib/external-action-receipt-batch.js',
    to: 'lib/receipt/signed-receipt-batch.js',
    why: 'The batch envelope signs itself with the receipt signing primitive; the envelope builder'
      + ' lives flat in lib/ (Core) while signing lives with receipts (Application). The follow-up'
      + ' fix is to evaluate whether the signing primitive belongs in a shared helper, or the'
      + ' envelope beside it in lib/receipt/.',
    review_by: '2026-12-31',
  },
]);

function exceptionMessages(exceptions, current, today) {
  const live = new Set(current.violations.map((edge) => `${edge.from}>${edge.to}`));
  const messages = [];
  for (const entry of exceptions) {
    if (entry.review_by < today) {
      messages.push(`FAIL expired layer exception: ${entry.from} -> ${entry.to} was due by ${entry.review_by}.`);
    } else if (!live.has(`${entry.from}>${entry.to}`)) {
      messages.push(`FAIL stale layer exception: ${entry.from} -> ${entry.to} is no longer a live violation.`);
    }
  }
  return messages;
}

module.exports = {
  LAYER_EXCEPTIONS,
  exceptionMessages,
};
