#!/usr/bin/env node
'use strict';

/**
 * Main CI Watch verdict for one main commit (#3662).
 *
 * The watcher used to call main green when "some workflow runs exist and none
 * failed". A push to main produces only a few of the ruleset's required
 * checks, so that rule could not tell "every expected check passed" from
 * "most expected checks never ran". This module compares the commit's check
 * runs against an explicit inventory (.github/main-ci-watch-contexts.json) and
 * gives every post-merge context a state:
 *
 *   SUCCESS  the latest check run with that name completed success/skipped/neutral
 *   PENDING  the latest check run has not completed
 *   FAILED   the latest check run completed with any other conclusion
 *   MISSING  no check run with that name exists for the commit
 *
 * Main is green only when the commit has settled, at least one workflow ran,
 * no latest workflow run is blocking, and every post-merge context is SUCCESS.
 * PR-only contexts are listed as not observable post-merge, never as green.
 *
 * Node built-ins only: the watcher job runs without `npm ci`.
 *
 * CLI: node scripts/main-ci-watch-state.js --inventory <json> --check-runs <json>
 *        --workflow-runs <json> --committed-at <iso> [--now <iso>]
 * prints the verdict as JSON on stdout.
 */

const fs = require('node:fs');

const SETTLE_SECONDS = 300;
const PASSING_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

const VERDICTS = Object.freeze({
  GREEN: 'ALL_EXPECTED_CHECKS_OBSERVED_AND_GREEN',
  NOT_SETTLED: 'NOT_SETTLED',
  NO_WORKFLOW_RUNS: 'NO_WORKFLOW_RUNS',
  FAILED: 'EXPECTED_CHECK_FAILED',
  MISSING: 'SOME_EXPECTED_CHECKS_NOT_OBSERVED',
  PENDING: 'EXPECTED_CHECK_PENDING',
  WORKFLOW_BLOCKING: 'WORKFLOW_RUN_BLOCKING',
});

function readInventory(inventory) {
  if (!inventory || typeof inventory !== 'object') throw new TypeError('inventory must be an object');
  const postMerge = inventory.postMerge && typeof inventory.postMerge === 'object' ? inventory.postMerge : null;
  const prOnly = inventory.prOnly && typeof inventory.prOnly === 'object' ? inventory.prOnly : null;
  if (!postMerge || Object.keys(postMerge).length === 0) throw new TypeError('inventory.postMerge must name at least one context');
  if (!prOnly) throw new TypeError('inventory.prOnly must be an object');
  return { postMerge: Object.keys(postMerge), prOnly: Object.keys(prOnly) };
}

/** The latest check run per name; a rerun gets a higher id than the run it replaces. */
function latestCheckRunsByName(checkRuns) {
  const latest = new Map();
  for (const run of Array.isArray(checkRuns) ? checkRuns : []) {
    if (!run || typeof run.name !== 'string') continue;
    const known = latest.get(run.name);
    if (!known || Number(run.id) > Number(known.id)) latest.set(run.name, run);
  }
  return latest;
}

function contextState(run) {
  if (!run) return 'MISSING';
  if (run.status !== 'completed') return 'PENDING';
  return PASSING_CONCLUSIONS.has(run.conclusion) ? 'SUCCESS' : 'FAILED';
}

/** Workflow runs whose latest attempt is still running or did not pass. */
function blockingWorkflowRuns(workflowRuns) {
  const latest = new Map();
  for (const run of Array.isArray(workflowRuns) ? workflowRuns : []) {
    if (!run || typeof run.name !== 'string' || run.name === 'Main CI Watch') continue;
    const known = latest.get(run.name);
    const rank = [Number(run.run_number) || 0, Number(run.run_attempt) || 0];
    const knownRank = known ? [Number(known.run_number) || 0, Number(known.run_attempt) || 0] : null;
    if (!known || rank[0] > knownRank[0] || (rank[0] === knownRank[0] && rank[1] > knownRank[1])) latest.set(run.name, run);
  }
  const runs = [...latest.values()];
  return {
    count: runs.length,
    blocking: runs.filter((run) => run.status !== 'completed' || !PASSING_CONCLUSIONS.has(run.conclusion)).map((run) => run.name),
  };
}

function pickVerdict({ settled, workflows, states }) {
  const withState = (state) => states.filter((item) => item.state === state).map((item) => item.context);
  if (!settled) return VERDICTS.NOT_SETTLED;
  if (workflows.count === 0) return VERDICTS.NO_WORKFLOW_RUNS;
  if (withState('FAILED').length > 0) return VERDICTS.FAILED;
  if (withState('MISSING').length > 0) return VERDICTS.MISSING;
  if (withState('PENDING').length > 0) return VERDICTS.PENDING;
  if (workflows.blocking.length > 0) return VERDICTS.WORKFLOW_BLOCKING;
  return VERDICTS.GREEN;
}

function mainCiState({ inventory, checkRuns, workflowRuns, committedAt, now }) {
  const { postMerge, prOnly } = readInventory(inventory);
  const committed = Date.parse(committedAt);
  const current = now === undefined ? Date.now() : Date.parse(now);
  if (!Number.isFinite(committed)) throw new TypeError('committedAt must be an ISO timestamp');
  if (!Number.isFinite(current)) throw new TypeError('now must be an ISO timestamp');
  const settled = (current - committed) / 1000 >= SETTLE_SECONDS;
  const latest = latestCheckRunsByName(checkRuns);
  const states = postMerge.map((context) => ({ context, state: contextState(latest.get(context)) }));
  const workflows = blockingWorkflowRuns(workflowRuns);
  const verdict = pickVerdict({ settled, workflows, states });
  const of = (state) => states.filter((item) => item.state === state).map((item) => item.context);
  return {
    verdict,
    mainGreen: verdict === VERDICTS.GREEN,
    settled,
    contexts: states,
    missing: of('MISSING'),
    pending: of('PENDING'),
    failed: of('FAILED'),
    blockingWorkflows: workflows.blocking,
    workflowRunCount: workflows.count,
    notObservablePostMerge: prOnly,
  };
}

function optionValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function readJsonFile(file, label) {
  if (!file) throw new TypeError(`${label} is required`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(argv = process.argv.slice(2)) {
  const state = mainCiState({
    inventory: readJsonFile(optionValue(argv, '--inventory'), '--inventory'),
    checkRuns: readJsonFile(optionValue(argv, '--check-runs'), '--check-runs'),
    workflowRuns: readJsonFile(optionValue(argv, '--workflow-runs'), '--workflow-runs'),
    committedAt: optionValue(argv, '--committed-at'),
    now: optionValue(argv, '--now'),
  });
  process.stdout.write(`${JSON.stringify(state)}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`main-ci-watch-state: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = { SETTLE_SECONDS, VERDICTS, mainCiState, latestCheckRunsByName, blockingWorkflowRuns, main };
