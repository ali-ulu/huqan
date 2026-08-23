#!/usr/bin/env node
'use strict';

/**
 * Enforce the large-file threshold as a ratchet (issue #328, acceptance
 * criterion 3).
 *
 * #328 asks for three things: every source file under a threshold, behavior
 * parity after splitting, and the threshold enforced in CI. Only the third is
 * implemented here, deliberately.
 *
 * `docs/v4/big-file-refactor-gate.md` is a binding policy in this repository
 * and it forbids exactly what criteria 1 and 2 would require right now:
 *
 *   "A refactor must happen immediately BEFORE the runtime PR that depends on
 *    the file — not earlier 'for cleanliness'."
 *
 * and it classifies `kernel.js` as NEEDS_MANUAL_REVIEW ("do not touch
 * speculatively") with `lib/memory-store.js` and `mcpServer.js` deferred to
 * just-in-time audits. Splitting them now to satisfy a line count would
 * violate that gate. So this file does the part that is safe and unblocked:
 * it stops the problem from growing, which is the precondition for any later
 * split rather than a substitute for it.
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

const THRESHOLD = 800;

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

function writeBaseline(files) {
  const ordered = {};
  for (const file of Object.keys(files).sort()) ordered[file] = files[file];
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
  };
  fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(document, null, 2)}\n`);
}

/**
 * Pure decision function: given the measured sizes and the recorded baseline,
 * report what is wrong and what the baseline should become.
 */
function evaluate(measured, baseline, threshold = THRESHOLD, opts = {}) {
  const seedNew = Boolean(opts.seedNew);
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
  const { violations, nextBaseline } = evaluate(measured, baseline, THRESHOLD, { seedNew });

  if (update) {
    // An existing ceiling is never raised: a `grew` violation keeps its old,
    // lower number, so --update cannot bless a file that got bigger. A file
    // crossing the threshold for the first time is recorded only when
    // --seed-new was also passed (#1289) -- a plain --update never adds a
    // new entry -- and even then it is reported loudly, with the added JSON
    // line as what a reviewer sees.
    writeBaseline(nextBaseline);
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
