'use strict';

// Pure evaluation policy for the large-file threshold gate (#2264, issue #328).
//
// Single responsibility: given measured sizes and the recorded baseline,
// decide what is wrong and what the baseline should become. No filesystem
// reads, no writes, no git, no console output — the only impurity is the
// default `today`, which callers may inject via opts. Ledger IO
// (readBaseline/writeBaseline/readReviews) and the CLI layer (main) stay in
// scripts/check-file-size.js; this module is never a second authority for
// them. THRESHOLD lives here because it parameterizes the policy, not the
// ledger; check-file-size.js re-exports it so existing importers keep working.

const THRESHOLD = 400;

/**
 * Pure decision function: given the measured sizes and the recorded baseline,
 * report what is wrong and what the baseline should become.
 */
function evaluate(measured, baseline, threshold = THRESHOLD, opts = {}) {
  const seedNew = Boolean(opts.seedNew);
  const reviews = opts.reviews || {};
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const violations = [];
  const nextBaseline = {};

  for (const [file, lines] of Object.entries(measured)) {
    const recorded = baseline[file];

    if (recorded === undefined) {
      if (lines > threshold) {
        const over = lines - threshold;
        violations.push({
          kind: 'new-over-threshold',
          file,
          lines,
          limit: threshold,
          message: `${file} is ${lines} lines, ${over} over the ${threshold}-line threshold.`,
        });
        // Seeding the ledger has to be possible, but only under the explicit
        // --seed-new flag (#1289) -- a plain --update run never adds an
        // entry the baseline didn't already have. The safety here is the
        // reviewed diff: a new entry in the JSON is a visible claim that a
        // file was allowed to cross the threshold.
        if (seedNew) nextBaseline[file] = lines;
      }
      continue;
    }

    if (lines > recorded) {
      violations.push({
        kind: 'grew',
        file,
        lines,
        limit: recorded,
        message: `${file} grew to ${lines} lines, past its recorded ${recorded}.`,
      });
      nextBaseline[file] = recorded;
      continue;
    }

    if (lines <= threshold) {
      violations.push({
        kind: 'baseline-clearable',
        file,
        lines,
        limit: threshold,
        message: `${file} is down to ${lines} lines and no longer needs a baseline entry.`,
      });
      continue;
    }

    if (lines < recorded) {
      violations.push({
        kind: 'baseline-stale',
        file,
        lines,
        limit: recorded,
        message: `${file} shrank to ${lines} lines; its baseline still says ${recorded}.`,
      });
    }

    // An entry nobody revisits is a decision nobody made. Past its date it
    // fails, and the fix is to shrink the file or write down why it stays and
    // set the next date -- either way, deliberately.
    const review = reviews[file];
    if (!review || !review.review_by) {
      violations.push({
        kind: 'review-missing',
        file,
        lines,
        limit: recorded,
        message: `${file} has a recorded ceiling but no review date.`,
      });
    } else if (review.review_by < today) {
      violations.push({
        kind: 'review-expired',
        file,
        lines,
        limit: recorded,
        message: `${file} was due for review by ${review.review_by} and is still ${lines} lines.`,
      });
    }

    nextBaseline[file] = lines;
  }

  for (const file of Object.keys(baseline)) {
    if (Object.prototype.hasOwnProperty.call(measured, file)) continue;
    violations.push({
      kind: 'baseline-orphan',
      file,
      lines: null,
      limit: baseline[file],
      message: `${file} is in the baseline but is no longer a tracked source file.`,
    });
  }

  return { violations, nextBaseline };
}

module.exports = { THRESHOLD, evaluate };
