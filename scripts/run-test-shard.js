'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  DEFAULT_SHARDS,
  REPO_ROOT,
  discoverTestFiles,
  getShard,
} = require('./ci-shard-manifest');
const { createTestStateSandbox } = require('./test-state-sandbox');

function parseArgs(argv) {
  const options = {
    shard: null,
    total: DEFAULT_SHARDS,
    // Several legacy tests intentionally share default JSON persistence within
    // a process-level test run. CI parallelism is provided by separate shard
    // runners; keep each runner serial unless a future isolation audit proves
    // a higher value safe.
    concurrency: 1,
    report: null,
    selection: null,
    list: false,
  };
  for (const arg of argv) {
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`unsupported argument: ${arg}`);
    const [, key, value] = match;
    if (key === 'shard') options.shard = Number(value);
    else if (key === 'total') options.total = Number(value);
    else if (key === 'concurrency') options.concurrency = Number(value);
    else if (key === 'report') options.report = value;
    else if (key === 'selection') options.selection = value;
    else throw new Error(`unsupported argument: ${arg}`);
  }
  return options;
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got ${value}`);
}

function defaultReportPath(shard) {
  return path.join(os.tmpdir(), `huqan-test-shard-${shard}.xml`);
}

function loadSelection(selectionPath, knownFiles) {
  const absolute = path.resolve(selectionPath);
  const plan = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.selectedTests)) {
    throw new Error('selection manifest must contain schemaVersion=1 and selectedTests[]');
  }
  const known = new Set(knownFiles);
  const selected = [...new Set(plan.selectedTests.map((file) => String(file).replaceAll('\\', '/')))].sort();
  if (selected.length === 0) throw new Error('selection manifest selectedTests must not be empty');
  const unknown = selected.filter((file) => !known.has(file));
  if (unknown.length > 0) throw new Error(`selection manifest references unknown test files: ${unknown.join(', ')}`);
  return selected;
}

function run(options) {
  assertPositiveInteger(options.total, 'total');
  assertPositiveInteger(options.shard, 'shard');
  assertPositiveInteger(options.concurrency, 'concurrency');
  if (options.shard > options.total) throw new Error(`shard must be between 1 and ${options.total}, got ${options.shard}`);

  const files = discoverTestFiles(REPO_ROOT);
  const selectedFiles = options.selection ? loadSelection(options.selection, files) : files;
  const selected = getShard(selectedFiles, options.shard, options.total);
  const reportPath = path.resolve(options.report || defaultReportPath(options.shard));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  console.log(`Running shard ${options.shard}/${options.total}: ${selected.files.length} test files, estimated weight ${selected.weight.toFixed(3)}s${options.selection ? ` (selection=${options.selection})` : ''}`);
  if (selected.files.length === 0) {
    fs.writeFileSync(reportPath, '<?xml version="1.0" encoding="utf-8"?>\n<testsuites tests="0" failures="0" skipped="0" time="0" />\n');
    console.log('No tests assigned to this shard; skipping Node test discovery.');
    return 0;
  }
  if (options.list) {
    for (const file of selected.files) console.log(file);
    return 0;
  }

  // Sharded runs get the same throwaway gate state root as `npm test`: a shard
  // run on a developer machine must not read or extend the operator's live
  // policy and receipt trail either (#1846).
  const sandbox = createTestStateSandbox();
  let result;
  try {
    result = spawnSync(process.execPath, [
      '--test',
      `--test-concurrency=${options.concurrency}`,
      '--test-reporter=junit',
      `--test-reporter-destination=${reportPath}`,
      ...selected.files,
    ], {
      cwd: REPO_ROOT,
      env: sandbox.environment,
      stdio: 'inherit',
    });
  } finally {
    sandbox.cleanup();
  }

  if (result.error) throw result.error;
  if (result.signal) {
    console.error(`test shard terminated by signal ${result.signal}`);
    return 1;
  }
  console.log(`JUnit timing report: ${reportPath}`);
  return result.status === 0 ? 0 : (result.status || 1);
}

if (require.main === module) {
  try {
    process.exitCode = run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = {
  defaultReportPath,
  loadSelection,
  parseArgs,
  run,
};
