'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'benchmark.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');
const marker = workflow.match(
  /^          # CI_CLASSIFIER_FUNCTIONS_START\n([\s\S]*?)^          # CI_CLASSIFIER_FUNCTIONS_END$/m,
);

assert.ok(marker, 'classifier function markers must exist in benchmark.yml');

const classifierFunctions = marker[1]
  .split('\n')
  .map((line) => line.startsWith('          ') ? line.slice(10) : line)
  .join('\n');

function classify(file) {
  const script = `${classifierFunctions}
    runtime=no
    perf=no
    docker=no
    if is_runtime_file "$1" || is_test_file "$1"; then runtime=yes; fi
    if is_perf_file "$1"; then perf=yes; fi
    if is_docker_file "$1"; then docker=yes; fi
    printf '%s,%s,%s' "$runtime" "$perf" "$docker"
  `;
  const result = spawnSync('bash', ['-c', script, 'ci-classifier', file], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('CI classifier maps representative paths to the intended gates', () => {
  const cases = new Map([
    ['cli.js', 'yes,no,no'],
    ['lib/contradiction-rules.js', 'yes,no,no'],
    ['kernel.js', 'yes,yes,no'],
    ['test/ci-change-classifier.test.js', 'yes,no,no'],
    ['Dockerfile', 'no,no,yes'],
    ['package.json', 'no,no,yes'],
    ['docs/current-operating-roadmap.md', 'no,no,no'],
  ]);

  for (const [file, expected] of cases) {
    assert.equal(classify(file), expected, file);
  }
});
