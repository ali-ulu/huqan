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
 * Longest-line budget (density).
 *
 * The line-count ratchet above counts lines, and a file collapsed onto one
 * line has almost none, so the size a reader actually faces is invisible to
 * it: the former public/js/app.js was 56 KB in 38 lines, one of them 39 KB,
 * and passed. That bundle is split now, but the hole it found remains, so this
 * measures the longest line instead.
 *
 * The budget is flat at 400 characters. Every shipped source file satisfies
 * it except the recorded exceptions below, which is the same shape
 * scripts/architecture-snapshot.js uses for DIP/OCP/FANOUT: a ceiling, a
 * reason and a review date, where an expired or stale entry fails the gate.
 */
const MAX_LINE_LENGTH = 400;

/**
 * Files whose longest line exceeds MAX_LINE_LENGTH and are accepted as they
 * stand: a table, a generated schema, or one long argument list, where the
 * density is the content and splitting it would only spread the same tokens
 * over more lines.
 *
 * An entry fails once its file is gone, drops at or under the budget, or
 * passes its review date -- so the list can only shrink.
 */
const LONG_LINE_ALLOWED = Object.freeze([
  { file: 'lib/observability/api-contract-schemas.js', why: 'OpenAPI component schemas: the long lines are object literals whose density is the schema itself.', review_by: '2027-03-31' },
  { file: 'lib/observability/workflow-agent-instrumentation.js', why: 'a wide recordRunFinish/recordRunStart call carries its whole field list on one line.', review_by: '2027-03-31' },
  { file: 'lib/observability/api-contract.js', why: 'OpenAPI operation descriptors, the same table shape as the schemas module.', review_by: '2027-03-31' },
  { file: 'lib/agent-memory-runtime.js', why: 'one long record literal plus a chained state read.', review_by: '2027-03-31' },
  { file: 'lib/workflow-contract.js', why: 'the workflow envelope schema: one object literal per contract field.', review_by: '2027-03-31' },
  { file: 'lib/supply-chain-activation-gate.js', why: 'a frozen export map on one line.', review_by: '2027-03-31' },
  { file: 'lib/agent-step-executor.js', why: 'a wide step projection literal.', review_by: '2027-03-31' },
  { file: 'lib/human-oversight-approval-runtime-primitives.js', why: 'a destructuring of the runtime vocabulary constants.', review_by: '2027-03-31' },
  { file: 'lib/workbench/ingest-approval-action.js', why: 'a wide public-approval projection literal.', review_by: '2027-03-31' },
  { file: 'graph.js', why: 'a long consolidateEdges call carrying its whole option object.', review_by: '2027-03-31' },
  { file: 'kernel.js', why: 'a long runLearnTransaction call carrying its whole argument object.', review_by: '2027-03-31' },
  { file: 'kernel.v2.js', why: 'a long findOppositePredicateConflict call carrying its whole argument object.', review_by: '2027-03-31' },
  { file: 'agent.js', why: 'one long bound-method map literal.', review_by: '2027-03-31' },
  { file: 'scripts/run-test-shard.js', why: 'an inline JUnit XML template string.', review_by: '2027-03-31' },
  { file: 'scripts/enforcement-coverage-classification.js', why: 'a recorded classification reason string.', review_by: '2027-03-31' },
  { file: 'public/js/app-observability-render.js', why: 'one long innerHTML template literal.', review_by: '2027-03-31' },
  { file: 'public/js/app-graph.js', why: 'one long innerHTML template literal for the graph/conflict list.', review_by: '2027-03-31' },
  { file: 'public/js/app-activity.js', why: 'one long innerHTML template literal for the activity list.', review_by: '2027-03-31' },
  { file: 'public/js/app-approvals.js', why: 'one long innerHTML template literal for the approvals queue.', review_by: '2027-03-31' },
  { file: 'public/js/app-health.js', why: 'one long innerHTML template literal for the runtime surface cards.', review_by: '2027-03-31' },
  { file: 'public/js/app-verify.js', why: 'one long innerHTML template literal for the verify result panel.', review_by: '2027-03-31' },
  { file: 'public/js/app-evidence.js', why: 'one long summary table template literal.', review_by: '2027-03-31' },
]);

const isLongLineAllowed = (file) => LONG_LINE_ALLOWED.some((entry) => entry.file === file);

/**
 * An entry is only valid while its file is present and still over the budget.
 * `measure` is injected by the caller (a file -> longest-line map) so this
 * module stays filesystem-free; when it is absent the entry's review date is
 * still checked, and staleness is left to the caller that can measure.
 */
function longLineExceptionViolations(
  entries = LONG_LINE_ALLOWED,
  { today = new Date().toISOString().slice(0, 10), measure = null } = {},
) {
  const violations = [];
  for (const entry of entries) {
    if (entry.review_by < today) {
      violations.push({
        kind: 'density-exception-expired',
        file: entry.file,
        lines: null,
        limit: MAX_LINE_LENGTH,
        message: `${entry.file}: long-line exception expired on ${entry.review_by}.`,
      });
      continue;
    }
    if (typeof measure !== 'function') continue;
    const measured = measure(entry.file);
    if (measured === null || measured === undefined) {
      violations.push({
        kind: 'density-exception-stale',
        file: entry.file,
        lines: null,
        limit: MAX_LINE_LENGTH,
        message: `${entry.file}: long-line exception is stale, the file is gone.`,
      });
    } else if (measured <= MAX_LINE_LENGTH) {
      violations.push({
        kind: 'density-exception-stale',
        file: entry.file,
        lines: measured,
        limit: MAX_LINE_LENGTH,
        message: `${entry.file}: long-line exception is unnecessary, its longest line is ${measured}.`,
      });
    }
  }
  return violations;
}

/**
 * Pure decision function: given the measured sizes and the recorded baseline,
 * report what is wrong and what the baseline should become.
 *
 * `opts.maxLineLengths` (a file -> longest-line map) turns on the density
 * budget. It is optional so the line-count ratchet can be evaluated on its
 * own, and its exceptions are in-code rather than in the ledger, so nothing
 * here feeds `nextBaseline`.
 */
function evaluate(measured, baseline, threshold = THRESHOLD, opts = {}) {
  const seedNew = Boolean(opts.seedNew);
  const reviews = opts.reviews || {};
  const today = opts.today || new Date().toISOString().slice(0, 10);
  const maxLineLengths = opts.maxLineLengths || null;
  const violations = [];
  const nextBaseline = {};

  for (const [file, lines] of Object.entries(measured)) {
    const recorded = baseline[file];

    if (maxLineLengths) {
      const longest = maxLineLengths[file];
      if (typeof longest === 'number' && longest > MAX_LINE_LENGTH && !isLongLineAllowed(file)) {
        violations.push({
          kind: 'density',
          file,
          lines: longest,
          limit: MAX_LINE_LENGTH,
          message: `${file} has a ${longest}-character line, over the ${MAX_LINE_LENGTH}-character budget.`,
        });
      }
    }

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

  if (maxLineLengths) {
    const measureLine = (file) => (
      Object.prototype.hasOwnProperty.call(maxLineLengths, file) ? maxLineLengths[file] : null
    );
    for (const item of longLineExceptionViolations(LONG_LINE_ALLOWED, { today, measure: measureLine })) {
      violations.push(item);
    }
  }

  return { violations, nextBaseline };
}

module.exports = {
  THRESHOLD,
  MAX_LINE_LENGTH,
  LONG_LINE_ALLOWED,
  isLongLineAllowed,
  longLineExceptionViolations,
  evaluate,
};
