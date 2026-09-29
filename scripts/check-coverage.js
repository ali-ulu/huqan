#!/usr/bin/env node
'use strict';

/**
 * Enforce code coverage as a ratchet (issue #3077).
 *
 * #3077: the repository carries ~1,045 test files and ~7,900 cases, but no
 * line or branch ratio is measured or bound to a threshold anywhere. A new
 * behavior can land green while coverage quietly falls in an unrelated module,
 * and nobody sees it. Heavyweight repositories gate merge on a coverage floor;
 * this is that gate, in this repository's own ratchet idiom.
 *
 * Two independent floors:
 *
 *   - global: the four `totals` metrics may not fall below the recorded
 *     global floor;
 *   - per-file: a file's line and branch ratio may not fall below its own
 *     recorded floor.
 *
 * `slackPoints` is a small tolerance so measurement noise (a v8 counting an
 * implicit branch one run and not the next) does not flap the gate. The
 * recorded numbers are the measured value plus that tolerance, so the floor
 * is the value the metric actually has to drop *below* to fail.
 *
 * `--update` rewrites the baseline, but only ever downward: a `regressed`
 * file keeps its old, higher floor regardless of `--update`, and the only way
 * to raise one is a hand edit to the JSON, visible in review -- the same
 * rule scripts/check-file-size.js uses for a grown file.
 *
 * Usage:
 *   node scripts/check-coverage.js [--baseline=<path>] [--coverage=<path>] [--update]
 *
 * Exit 0 = within budget, exit 1 = a violation, exit 2 = bad usage.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASELINE = path.join(REPO_ROOT, 'config', 'coverage-baseline.json');
const DEFAULT_SUMMARY = path.join(REPO_ROOT, 'coverage', 'coverage-summary.json');
const RATCHET_METRICS = ['lines', 'statements', 'functions', 'branches'];

function readJson(filePath, label) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`could not read the ${label} at ${filePath}: ${error.message}`);
  }
}

/**
 * The relative paths in a c8 json-summary, with `total` removed.
 *
 * c8 writes absolute paths under the working directory it measured. Only
 * `lib/`, `scripts/` and the repository's root runtime modules are tracked;
 * tests are not, because a file with no assertions should not be scored on
 * how much of itself it executes.
 *
 * Summary keys arrive in the producer's separator form (c8 emits its own
 * absolute paths, but a hand-built fixture may use forward slashes on
 * Windows, #3148), so both separators are normalized to the host form before
 * the root prefix is stripped. The stored key leaves as forward slashes --
 * the same form the baseline records on every platform.
 */
function measuredFiles(summary, root = REPO_ROOT) {
  const files = {};
  for (const [absolutePath, metrics] of Object.entries(summary)) {
    if (absolutePath === 'total') continue;
    const hostPath = absolutePath.split('\\').join(path.sep).split('/').join(path.sep);
    const relative = path.isAbsolute(hostPath) ? path.relative(root, hostPath) : hostPath;
    const key = relative.split(path.sep).join('/');
    if (key === '..' || key.startsWith('../') || path.isAbsolute(relative)) continue;
    if (key.startsWith('test/')) continue;
    if (metrics && metrics.lines) files[key] = metrics;
  }
  return files;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Violations and the entries a downward `--update` would write.
 *
 * A file present in the measurement but absent from the baseline is recorded
 * on `--update`; it is not a violation on its own, because adding a file must
 * not require a hand edit before the gate will pass.
 */
function evaluate(baseline, summary, root = REPO_ROOT) {
  const slack = Number.isFinite(baseline.slackPoints) ? baseline.slackPoints : 0;
  const minFileLines = Number.isFinite(baseline.minFileLines) ? baseline.minFileLines : 0;
  const violations = [];
  const nextTotals = {};
  const nextFiles = { ...(baseline.files || {}) };

  const measuredTotal = summary.total || {};
  for (const metric of RATCHET_METRICS) {
    const value = Number(measuredTotal[metric] && measuredTotal[metric].pct);
    if (!Number.isFinite(value)) continue;
    const floor = baseline.totals && baseline.totals[metric];
    if (!Number.isFinite(floor)) {
      nextTotals[metric] = round(value + slack);
    } else if (value < floor - slack) {
      // Same rule as a per-file regression: the floor stays put.
      nextTotals[metric] = floor;
      violations.push(`global ${metric}: ${value}% is below the ${floor}% floor`);
    } else {
      nextTotals[metric] = Math.min(floor, round(value + slack));
    }
  }

  const files = measuredFiles(summary, root);
  for (const [file, metrics] of Object.entries(files)) {
    if (metrics.lines.total < minFileLines) continue;
    const measured = { lines: round(metrics.lines.pct), branches: round(metrics.branches.pct) };
    const recorded = nextFiles[file];
    if (!recorded) {
      nextFiles[file] = measured;
      continue;
    }
    const nextEntry = { lines: recorded.lines, branches: recorded.branches };
    for (const metric of ['lines', 'branches']) {
      if (measured[metric] < recorded[metric] - slack) {
        // A regression is not spendable: the floor stays where it was.
        violations.push(`${file} ${metric}: ${measured[metric]}% is below the ${recorded[metric]}% floor`);
      } else {
        nextEntry[metric] = Math.min(recorded[metric], round(measured[metric] + slack));
      }
    }
    nextFiles[file] = nextEntry;
  }

  return { violations, nextTotals, nextFiles };
}

function parseArgs(argv) {
  const options = { baseline: DEFAULT_BASELINE, summary: DEFAULT_SUMMARY, update: false };
  for (const arg of argv) {
    if (arg === '--update') { options.update = true; continue; }
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`unexpected argument ${arg}`);
    if (match[1] === 'baseline') options.baseline = path.resolve(match[2]);
    else if (match[1] === 'coverage') options.summary = path.resolve(match[2]);
    else throw new Error(`unknown option --${match[1]}`);
  }
  return options;
}

/**
 * Rewrite the baseline with the downward-only values, preserving the note and
 * measurement provenance.
 */
function writeBaseline(baselinePath, baseline, nextTotals, nextFiles) {
  const document = {
    ...baseline,
    totals: nextTotals,
    files: Object.fromEntries(Object.entries(nextFiles).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(document, null, 2)}\n`);
}

function main(argv) {
  const options = parseArgs(argv);
  const baseline = readJson(options.baseline, 'coverage baseline');
  let summary;
  try {
    summary = readJson(options.summary, 'coverage summary');
  } catch (error) {
    console.error(`${error.message}\nRun \`npm run coverage\` first.`);
    return 2;
  }

  const { violations, nextTotals, nextFiles } = evaluate(baseline, summary);

  if (options.update) {
    writeBaseline(options.baseline, baseline, nextTotals, nextFiles);
    console.log(`updated ${options.baseline}: ${Object.keys(nextFiles).length} files`);
    // A regression is not spendable by --update: the floor it broke stays put,
    // so the run still fails and the drop is visible.
    if (violations.length > 0) {
      console.error(`${violations.length} floor(s) still exceeded after update:`);
      for (const violation of violations) console.error(`  ${violation}`);
      return 1;
    }
    return 0;
  }

  if (violations.length > 0) {
    console.error(`coverage regressed in ${violations.length} place(s):`);
    for (const violation of violations) console.error(`  ${violation}`);
    console.error('Restore the coverage or lower the floor only if the drop is intended and reviewed.');
    return 1;
  }

  const total = summary.total || {};
  console.log(`coverage within budget: lines ${total.lines && total.lines.pct}%, branches ${total.branches && total.branches.pct}%, functions ${total.functions && total.functions.pct}%`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = {
  DEFAULT_BASELINE,
  DEFAULT_SUMMARY,
  RATCHET_METRICS,
  evaluate,
  main,
  measuredFiles,
  parseArgs,
};
