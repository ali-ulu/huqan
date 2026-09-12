#!/usr/bin/env node
'use strict';

/**
 * Enforce the large-file threshold as a ratchet (issue #328, acceptance
 * criterion 3).
 *
 * #328 asks for three things: every source file under a threshold, behavior
 * parity after splitting, and the threshold enforced in CI. Only the third is
 * implemented here.
 *
 * This used to be justified by `docs/v4/big-file-refactor-gate.md`, which
 * forbade splitting a large file except immediately before a runtime PR that
 * had to edit it heavily, and classified `kernel.js` as "do not touch
 * speculatively". That document was deleted on 2026-09-11;
 * `docs/architecture-policy.md` replaced it. The target is 200 lines, and
 * closing recorded debt no longer needs a runtime PR to justify it.
 *
 * The ratchet below is the right mechanism and is kept. What it lacked was
 * downward pressure -- a ceiling that may fall is not a ceiling that must.
 *
 * THRESHOLD is 400, down from 800. That is not the 200-line target and is not
 * meant to be: a file under 400 with no structural signal against it is
 * accepted as it stands, and the gate's job there is to keep it that way. The
 * 542 files at or under 400 can never cross it, and the 75 above it are
 * recorded at today's size and can only shrink. Splitting is reserved for
 * files that have a reason beyond their length -- a boundary violation, a
 * growing dispatch, a fan-out -- which the other gates and the epic track
 * separately. Chasing every 250-line module down to 200 buys nothing and
 * risks trading one cohesive file for three coupled ones.
 *
 * The rule is a ratchet, not a flat limit:
 *
 *   - a file that is not already over the threshold must stay at or under it;
 *   - a file that is already over it (recorded in the baseline) may not grow
 *     past the size it had when the baseline was taken;
 *   - when such a file shrinks, the baseline must be lowered to match, so the
 *     gain is locked in and cannot be spent later;
 *   - when it drops to the threshold, its baseline entry must be removed.
 *
 * `--update` rewrites the baseline, but only ever downward: a `grew`
 * violation keeps its old, lower recorded ceiling regardless of `--update`,
 * and the only way to raise one is a hand edit to the JSON, visible in
 * review. Seeding a *new* debt entry -- a file crossing the threshold for
 * the first time -- is the one case `--update` alone used to also perform,
 * which meant a single routine `--update` run could write an arbitrarily
 * high ceiling for a brand-new file with no hand edit and no distinct
 * command-line signal (#1289). That is now gated behind a second, explicit
 * flag: `--update --seed-new`. `--update` on its own never adds an entry
 * that was not already in the baseline.
 *
 * Usage:  node scripts/check-file-size.js [--update] [--seed-new]
 * Exit 0 = within budget, exit 1 = a violation.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'file-size-baseline.json');

const THRESHOLD = 400;
// Above this a file owes a decomposition, so its entry comes up for review first.
const DECOMPOSE_AT = 800;

// Generated bundles are never hand-split -- the gate document classifies them
// LEAVE_AS_IS -- so counting them would only produce noise no one may act on.
const EXCLUDE = /(^|\/)(node_modules|graphify-out)\/|obsidian-plugin\/dist\//;

// Tests are out of scope for the same reason scripts/check-import-cycles.js
// excludes them: the invariant #328 describes is about the shipped runtime,
// and a long table-driven test file is not the "god module" problem.
const IS_TEST = /(\.test\.js$|(^|\/)test\/|(^|\/)benchmarks\/|(^|\/)demo)/;

function listSourceFiles() {
  const out = execFileSync('git', ['ls-files', '*.js'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((file) => !EXCLUDE.test(file))
    .filter((file) => !IS_TEST.test(file));
}

/**
 * Counts lines the same way `wc -l` does, so a number reported here can be
 * reproduced from the shell without explanation.
 */
function countLines(absolutePath) {
  const source = fs.readFileSync(absolutePath, 'utf8');
  if (source === '') return 0;
  let lines = 0;
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') lines += 1;
  }
  if (!source.endsWith('\n')) lines += 1;
  return lines;
}

function readBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return {};
  const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  return parsed && typeof parsed.files === 'object' && parsed.files !== null ? parsed.files : {};
}

/**
 * The reason and the review date for each recorded entry, kept beside the
 * ceilings rather than inside them so the arithmetic above stays about
 * numbers.
 *
 * This is the half the ratchet was missing. A ceiling that may fall is not a
 * ceiling that must: without a date, an entry sits at today's size forever and
 * the ledger freezes exactly the way the policy this replaced did, one
 * threshold lower. An expired entry fails the gate, which forces the choice to
 * be made again out loud -- shrink it, or write down why it stays.
 */
function readReviews() {
  if (!fs.existsSync(BASELINE_PATH)) return {};
  const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  return parsed && typeof parsed.reviews === 'object' && parsed.reviews !== null ? parsed.reviews : {};
}

function defaultReviewDate(lines) {
  // Staggered so the ledger does not come due all at once, and so the files
  // that owe a decomposition come up first.
  return lines > DECOMPOSE_AT ? '2026-10-31' : '2027-03-31';
}

function writeBaseline(files, previousReviews = {}) {
  const ordered = {};
  const reviews = {};
  for (const file of Object.keys(files).sort()) {
    ordered[file] = files[file];
    const recorded = previousReviews[file];
    reviews[file] = {
      why: (recorded && recorded.why)
        || 'Pre-existing debt recorded when the banded budget was introduced.',
      review_by: (recorded && recorded.review_by) || defaultReviewDate(files[file]),
    };
  }
  const document = {
    _comment: [
      'Line-count debt ledger for scripts/check-file-size.js (issue #328).',
      `Every entry is a file that already exceeded ${THRESHOLD} lines when it was recorded.`,
      'Entries may only shrink. Lower them with `npm run check:file-size -- --update`',
      'after a file gets smaller; raising one is a hand edit so it shows up in review.',
      'A brand-new entry requires `--update --seed-new` explicitly (#1289); plain',
      '--update never adds a file that was not already in this ledger.',
      'An entry that reaches the threshold must be deleted, not set to the threshold.',
    ],
    threshold: THRESHOLD,
    files: ordered,
    reviews,
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(document, null, 2)}\n`);
}

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

function measure(files) {
  const measured = {};
  for (const file of files) measured[file] = countLines(path.join(repoRoot, file));
  return measured;
}

function main(argv = process.argv.slice(2)) {
  const update = argv.includes('--update');
  const seedNew = argv.includes('--seed-new');
  const files = listSourceFiles();
  const measured = measure(files);
  const baseline = readBaseline();
  const reviews = readReviews();
  const { violations, nextBaseline } = evaluate(measured, baseline, THRESHOLD, { seedNew, reviews });

  if (update) {
    // An existing ceiling is never raised: a `grew` violation keeps its old,
    // lower number, so --update cannot bless a file that got bigger. A file
    // crossing the threshold for the first time is recorded only when
    // --seed-new was also passed (#1289) -- a plain --update never adds a
    // new entry -- and even then it is reported loudly, with the added JSON
    // line as what a reviewer sees.
    writeBaseline(nextBaseline, reviews);
    const added = violations.filter((item) => item.kind === 'new-over-threshold');
    const grew = violations.filter((item) => item.kind === 'grew');

    if (added.length > 0 && seedNew) {
      console.error(`Recorded ${added.length} file(s) newly over ${THRESHOLD} lines:\n`);
      for (const item of added) console.error(`  ${item.message}`);
      console.error('\nThese are new debt entries. Do not commit them unless crossing the'
        + '\nthreshold was a deliberate, reviewed decision.');
    } else if (added.length > 0) {
      console.error(`${added.length} file(s) are newly over ${THRESHOLD} lines and were NOT recorded:\n`);
      for (const item of added) console.error(`  ${item.message}`);
      console.error('\nRe-run with --update --seed-new if crossing the threshold was a'
        + '\ndeliberate, reviewed decision.');
    }
    if (grew.length > 0) {
      console.error(`\n${grew.length} file(s) exceed a recorded ceiling and were NOT blessed:\n`);
      for (const item of grew) console.error(`  ${item.message}`);
      return 1;
    }

    if (added.length > 0 && !seedNew) return 1;

    console.log(`Baseline updated: ${Object.keys(nextBaseline).length} file(s) over ${THRESHOLD} lines.`);
    return 0;
  }

  if (violations.length === 0) {
    const over = Object.keys(baseline).length;
    console.log(
      `OK: ${files.length} source files within budget `
      + `(${over} known over ${THRESHOLD} lines, none grew).`,
    );
    return 0;
  }

  console.error(`FAIL: ${violations.length} file-size violation(s).\n`);
  for (const item of violations) console.error(`  ${item.message}`);

  const grew = violations.some((item) => item.kind === 'grew' || item.kind === 'new-over-threshold');
  if (grew) {
    console.error(
      `\nFiles at or under ${THRESHOLD} lines must stay there, and files already`
      + '\nover it may not grow further (issue #328). Move the new code into a'
      + '\nmodule of its own rather than extending one of these.',
    );
  } else {
    console.error(
      '\nThese are shrink-side violations: a file got smaller and the ledger'
      + '\nis out of date. Run `npm run check:file-size -- --update` to lock the'
      + '\ngain in.',
    );
  }
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = {
  THRESHOLD,
  BASELINE_PATH,
  listSourceFiles,
  countLines,
  measure,
  readBaseline,
  writeBaseline,
  evaluate,
  main,
};
