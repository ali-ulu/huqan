'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const BASELINE_PATH = path.join('config', 'mutation-baseline.json');

function normalizePath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

function changedFiles(baseRef) {
  const output = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], { encoding: 'utf8' });
  return output.split(/\r?\n/).map(normalizePath).filter(Boolean);
}

function selectMutationTargets(baseRef, baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))) {
  const tracked = new Set(Object.keys(baseline.files || {}).map(normalizePath));
  return changedFiles(baseRef).filter(file => tracked.has(file));
}

function main(argv = process.argv.slice(2)) {
  const baseRef = argv[0];
  if (!baseRef) throw new Error('base ref is required');
  process.stdout.write(selectMutationTargets(baseRef).join(','));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Mutation target selection failed: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { normalizePath, selectMutationTargets };
