#!/usr/bin/env node
'use strict';

/**
 * Unresolved coverage alarm for the Benchmark Regression workflow (#3970).
 *
 * The `Coverage` job runs only when the change classification says a measured
 * source file changed (`source_only == yes`); every other commit answers with
 * the `Coverage (NOT_APPLICABLE)` skip job, and `coverage-gate` accepts that
 * skip as a pass. On a pull request that is the right answer to the only
 * question a merge can ask -- "does this change satisfy the ratchet?" -- and
 * blocking a docs-only change on carried history was explicitly rejected in
 * #3970, because a stale red result carried into the merge requirement would
 * lock PRs that cannot repair the alarm.
 *
 * After a merge the same green skip means something different: nothing about
 * that commit was measured. If the most recent completed measured run failed
 * the ratchet, a green NOT_APPLICABLE on top of it hides the regression --
 * exactly the false-green window #3970 records: run 38887101909 failed the
 * `lib/predicate-parser.js` branch floor and run 38890084690 then reported
 * green through a skip. This tool closes the window. The caller feeds it the
 * recent completed Benchmark Regression runs on main together with the
 * conclusion of their `Coverage` job, and it refuses (exit 1) while the
 * newest measured verdict is anything but success.
 *
 * Alarm states:
 *   none        no completed measured `Coverage` job in the supplied history;
 *   clear       the newest measured verdict is success;
 *   unresolved  the newest measured verdict is failure, cancelled, timed_out
 *               or any other non-success conclusion (fail closed).
 *
 * Only a completed successful measurement clears the alarm. Re-running the
 * failed jobs (a new attempt of the same run), a later source commit, and the
 * operator's explicit `workflow_dispatch` with `force_coverage: true` all
 * produce such a measurement, which is the auditable superseding result
 * #3970 asks for; the gate never clears on skips alone.
 *
 * Usage:
 *   node scripts/coverage-gate-history.js --runs=<path>
 *
 * Input: a JSON array of run objects
 *   { head_sha, event, status, run_number, run_attempt, html_url, coverage }
 * where `coverage` is the conclusion of the job named exactly "Coverage" in
 * that run, or null when the run took the NOT_APPLICABLE skip path. A
 * `skipped` conclusion is treated the same as null: the job did not measure.
 *
 * Exit 0 = none or clear, exit 1 = unresolved, exit 2 = bad usage or input.
 */

const fs = require('node:fs');

/** The only job whose verdict can raise or clear the alarm. */
const COVERAGE_JOB_NAME = 'Coverage';

function parseArgs(argv) {
  const options = { runs: null };
  for (const arg of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`unexpected argument ${arg}`);
    if (match[1] === 'runs') options.runs = match[2];
    else throw new Error(`unknown option --${match[1]}`);
  }
  if (!options.runs) throw new Error('missing required --runs=<path>');
  return options;
}

/**
 * The alarm decision over the supplied run history.
 *
 * Runs are ordered by the workflow's own run number (monotonic per workflow)
 * with the attempt as the tiebreaker, newest first. Runs from pull_request
 * events and runs that have not completed cannot carry a measured verdict and
 * are ignored: a measurement still in flight neither raises nor clears an
 * alarm, and a pull request's own red coverage says nothing about main.
 */
function decide(runs) {
  const candidates = (Array.isArray(runs) ? runs : [])
    .filter((run) => {
      if (!run || typeof run !== 'object') return false;
      if (run.status !== 'completed') return false;
      if (run.event === 'pull_request') return false;
      return true;
    })
    .sort((a, b) =>
      (Number(b.run_number) || 0) - (Number(a.run_number) || 0) ||
      (Number(b.run_attempt) || 0) - (Number(a.run_attempt) || 0));

  const measured = candidates.find((run) => {
    const conclusion = run.coverage;
    return typeof conclusion === 'string' && conclusion.length > 0 && conclusion !== 'skipped';
  });

  if (!measured) {
    return {
      verdict: 'none',
      measured: null,
      reason: `no completed measured ${COVERAGE_JOB_NAME} job in the supplied main history`,
    };
  }

  const measuredView = {
    head_sha: measured.head_sha,
    event: measured.event,
    run_number: measured.run_number,
    run_attempt: measured.run_attempt,
    coverage: measured.coverage,
    html_url: measured.html_url,
  };

  if (measured.coverage === 'success') {
    return {
      verdict: 'clear',
      measured: measuredView,
      reason: `the newest measured ${COVERAGE_JOB_NAME} verdict is success (run #${measured.run_number}, attempt ${measured.run_attempt})`,
    };
  }

  return {
    verdict: 'unresolved',
    measured: measuredView,
    reason: `the newest completed measured ${COVERAGE_JOB_NAME} verdict is "${measured.coverage}" (run #${measured.run_number}, attempt ${measured.run_attempt}, ${measured.head_sha || 'unknown sha'}) and no later successful measurement exists`,
  };
}

function readRuns(runsPath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(runsPath, 'utf8'));
  } catch (error) {
    throw new Error(`could not read the runs history at ${runsPath}: ${error.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`the runs history at ${runsPath} must be a JSON array`);
  }
  return parsed;
}

function main(argv) {
  const options = parseArgs(argv);
  const decision = decide(readRuns(options.runs));
  process.stdout.write(`${JSON.stringify(decision)}\n`);
  if (decision.verdict === 'unresolved') {
    process.stderr.write(`::error::Coverage alarm unresolved: ${decision.reason}\n`);
    return 1;
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  COVERAGE_JOB_NAME,
  decide,
  main,
  parseArgs,
  readRuns,
};
