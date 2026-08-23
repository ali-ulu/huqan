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

function run(options) {
  assertPositiveInteger(options.total, 'total');
  assertPositiveInteger(options.shard, 'shard');
  assertPositiveInteger(options.concurrency, 'concurrency');
  if (options.shard > options.total) throw new Error(`shard must be between 1 and ${options.total}, got ${options.shard}`);

  const files = discoverTestFiles(REPO_ROOT);
  const selected = getShard(files, options.shard, options.total);
  const reportPath = path.resolve(options.report || defaultReportPath(options.shard));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  console.log(`Running shard ${options.shard}/${options.total}: ${selected.files.length} test files, estimated weight ${selected.weight.toFixed(3)}s`);
  if (options.list) {
    for (const file of selected.files) console.log(file);
    return 0;
  }

  const result = spawnSync(process.execPath, [
    '--test',
    `--test-concurrency=${options.concurrency}`,
    '--test-reporter=junit',
    `--test-reporter-destination=${reportPath}`,
    ...selected.files,
  ], {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
  });

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
  parseArgs,
  run,
};
