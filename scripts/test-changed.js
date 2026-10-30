#!/usr/bin/env node
'use strict';

/**
 * Run only the tests a local change can reach.
 *
 * CI already asks `scripts/ci-impact-plan.js` which tests a pull request needs
 * and runs that subset (dependency-derived selection, #2610). Locally there was
 * no such entry point, so the only command a contributor knew was `npm test`,
 * which walks all ~1500 files and takes minutes even for a one-line change.
 *
 * This is the local face of the same selector. It reuses `buildTestImpactPlan`
 * unchanged rather than inventing a second rule set: whatever CI decides to run
 * for a change is what this runs, so a local green is the same signal CI gives.
 *
 * Unlike the CI plan it also sees the working tree -- uncommitted, staged and
 * untracked files -- because the question a developer asks is "what did I change
 * so far", not "what is in my last commit".
 *
 * Usage:  node scripts/test-changed.js [--base=<ref>] [--concurrency=<n>] [--dry-run]
 */

const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { buildTestImpactPlan } = require('./ci-impact-plan');
const { REPO_ROOT } = require('./ci-shard-manifest');

const DEFAULT_CONCURRENCY = 4;

function parseArgs(argv) {
  const options = { base: null, concurrency: DEFAULT_CONCURRENCY, dryRun: false };
  for (const arg of argv) {
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`unsupported argument: ${arg}`);
    const [, key, value] = match;
    if (key === 'base') options.base = value;
    else if (key === 'concurrency') options.concurrency = Number(value);
    else if (key === 'dry-run') options.dryRun = true;
    else throw new Error(`unsupported argument: ${arg}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  return options;
}

function gitLines(args, root) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} exited with ${result.status}`);
  }
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** The first ref that exists, so a fresh clone without a remote still works. */
function defaultBase(root) {
  for (const ref of ['origin/main', 'main']) {
    const result = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd: root });
    if (result.status === 0) return ref;
  }
  throw new Error('no base ref found (tried origin/main, main); pass --base=<ref>');
}

/**
 * Every path that differs from `base`, working tree included.
 *
 * The diff is taken from the merge base, not from the base tip, for the same
 * reason the CI plan does (#4245): a branch that fell behind `main` would
 * otherwise report `main`'s newer commits as this change's.
 */
function collectChangedFiles({ root = REPO_ROOT, base } = {}) {
  const mergeBase = gitLines(['merge-base', base, 'HEAD'], root)[0];
  if (!mergeBase) throw new Error(`no merge base between ${base} and HEAD`);
  const tracked = gitLines(['diff', '--name-only', mergeBase], root);
  const untracked = gitLines(['ls-files', '--others', '--exclude-standard'], root);
  return [...new Set([...tracked, ...untracked])].sort();
}

function resolveSelection({ root = REPO_ROOT, base } = {}) {
  const changedFiles = collectChangedFiles({ root, base });
  const plan = buildTestImpactPlan({ root, changedFiles });
  return { changedFiles, plan };
}

/** The `run-tests.js` arguments for a selection. Empty `files` means the full suite. */
function buildRunnerArgs({ files, concurrency = DEFAULT_CONCURRENCY }) {
  return [`--test-concurrency=${concurrency}`, ...files];
}

function defaultRun({ files, concurrency, root }) {
  const args = [path.join(root, 'scripts', 'run-tests.js'), ...buildRunnerArgs({ files, concurrency })];
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'inherit' });
    child.on('error', (error) => {
      process.stderr.write(`could not start the test runner: ${error.message}\n`);
      resolve(1);
    });
    child.on('exit', (code, signal) => resolve(signal ? 128 : code === null ? 1 : code));
  });
}

async function main(argv, { root = REPO_ROOT, run = defaultRun, log = console.log } = {}) {
  const options = parseArgs(argv);
  const base = options.base || defaultBase(root);
  const { changedFiles, plan } = resolveSelection({ root, base });

  if (changedFiles.length === 0) {
    log(`no changed files against ${base}; nothing to run`);
    return 0;
  }
  if (!plan.runTests) {
    log(`${changedFiles.length} changed file(s) against ${base}, none runtime or test; nothing to run`);
    return 0;
  }

  const files = plan.fullSuite ? [] : plan.selectedTests;
  log(`${changedFiles.length} changed file(s) against ${base} -> ${plan.fullSuite ? 'full suite' : `${files.length} test file(s)`}`);
  if (options.dryRun) {
    for (const file of files) log(`  ${file}`);
    return 0;
  }
  return run({ files, concurrency: options.concurrency, root });
}

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      console.error(`test-changed: ${error.message}`);
      process.exitCode = 2;
    });
}

module.exports = {
  buildRunnerArgs,
  collectChangedFiles,
  defaultBase,
  main,
  parseArgs,
  resolveSelection,
};
