'use strict';

/**
 * The runtime-test matrix runs Windows and macOS on Node 24 only for pull
 * requests, and keeps Windows x Node 22 (and macOS x Node 22) on main pushes,
 * the nightly and manual runs.
 *
 * Measured over 3-5 Oct 2026 (1700 runs): Windows shards were 47% of all
 * runner time, and each PR started 20 test jobs. Dropping the PR's Windows x
 * Node 22 legs takes it to 15. #4028 added macOS to the PR arm (seven of the
 * last nine nightly alarm issues were macOS-only) and cuts its Node 22 leg the
 * same way, so a PR now starts 20 jobs. These assertions pin the scope of
 * those cuts, so they cannot quietly widen to main (losing the post-merge
 * signal) or narrow Linux (losing Node 22 coverage on PRs altogether).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'benchmark.yml'), 'utf8');
const runtimeTest = workflow.slice(workflow.indexOf('\n  runtime-test:'), workflow.indexOf('\n  runtime-test-skip:'));

function excludeFor(eventName) {
  const match = runtimeTest.match(/^\s+exclude: \$\{\{ fromJSON\(github\.event_name == '([a-z_]+)' && '(\[[^']*\])' \|\| '(\[[^']*\])'\) \}\}$/m);
  assert.ok(match, 'runtime-test matrix declares an event-scoped exclude');
  const [, scopedEvent, whenScoped, otherwise] = match;
  return JSON.parse(eventName === scopedEvent ? whenScoped : otherwise);
}

// The exclude is an expression inside a plain YAML scalar, where ": " is not
// allowed: '{"os": "windows-latest"}' made the whole workflow unparseable.
test('the workflow still parses and carries the exclude expression', () => {
  const yaml = require('js-yaml');
  const parsed = yaml.load(workflow);
  const exclude = parsed.jobs['runtime-test'].strategy.matrix.exclude;
  assert.equal(typeof exclude, 'string');
  assert.match(exclude, /^\$\{\{ fromJSON\(github\.event_name == 'pull_request'/);
});

test('the runtime-test matrix still lists both Node versions, Windows and macOS', () => {
  assert.match(runtimeTest, /^\s+node-version: \[22, 24\]$/m);
  assert.match(runtimeTest, /'\["ubuntu-latest", "windows-latest"\]'/);
  assert.match(runtimeTest, /\["ubuntu-latest", "windows-latest", "macos-latest"\]/);
});

test('pull requests run macOS as well as Windows and Ubuntu', () => {
  assert.match(
    runtimeTest,
    /fromJSON\(\(github\.event_name == 'pull_request' \|\| github\.event_name == 'schedule' \|\| github\.event_name == 'workflow_dispatch'\) && '\["ubuntu-latest", "windows-latest", "macos-latest"\]'/,
  );
});

test('pull requests drop the Windows and macOS x Node 22 legs', () => {
  assert.deepEqual(excludeFor('pull_request'), [
    { os: 'windows-latest', 'node-version': 22 },
    { os: 'macos-latest', 'node-version': 22 },
  ]);
});

test('main pushes, the nightly and manual runs keep the full matrix', () => {
  for (const eventName of ['push', 'schedule', 'workflow_dispatch']) {
    assert.deepEqual(excludeFor(eventName), [], eventName);
  }
});
