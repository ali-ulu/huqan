'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'benchmark.yml');
// Normalize line endings before matching. .gitattributes pins this file to LF,
// but a clone that already checked it out under core.autocrlf=true still has
// CRLF on disk, and the marker regex below is LF-anchored. Normalizing here
// also keeps stray CR bytes out of the extracted shell, where bash would treat
// them as part of the command rather than as a line separator.
const workflow = fs.readFileSync(workflowPath, 'utf8').replace(/\r\n/g, '\n');
const marker = workflow.match(
  /^          # CI_CLASSIFIER_FUNCTIONS_START\n([\s\S]*?)^          # CI_CLASSIFIER_FUNCTIONS_END$/m,
);

assert.ok(marker, 'classifier function markers must exist in benchmark.yml');

const classifierFunctions = marker[1]
  .split('\n')
  .map((line) => line.startsWith('          ') ? line.slice(10) : line)
  .join('\n');

function usableBash() {
  const probe = spawnSync('bash', ['-c', '[ "$1" = cli.js ] && printf huqan-bash-ok', 'huqan-probe', 'cli.js'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout === 'huqan-bash-ok';
}

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

test('CI classifier maps representative paths to the intended gates', (t) => {
  if (!usableBash()) return t.skip('requires a usable POSIX bash; Windows system bash.exe is not one');
  const cases = new Map([
    ['cli.js', 'yes,no,no'],
    ['lib/contradiction-rules.js', 'yes,no,no'],
    ['kernel.js', 'yes,yes,no'],
    ['test/ci-change-classifier.test.js', 'yes,no,no'],
    ['Dockerfile', 'no,no,yes'],
    // The manifest declares the test command and the dependency set, so a
    // change to it can alter how the whole suite runs. is_runtime_file()
    // classifies it as runtime (#752 deny-by-default), and it stays a Docker
    // surface because the image is built from it.
    ['package.json', 'yes,no,yes'],
    ['package-lock.json', 'yes,no,yes'],
    ['docs/current-operating-roadmap.md', 'no,no,no'],
  ]);

  for (const [file, expected] of cases) {
    assert.equal(classify(file), expected, file);
  }
});
