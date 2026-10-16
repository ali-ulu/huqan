const test = require('node:test');
const assert = require('node:assert/strict');

const { stripComments, hasPullRequestTargetTrigger, checkSource, checkDependencyReviewSeverity } = require('./check-workflow-governance');

test('stripComments: strips a real trailing comment', () => {
  assert.equal(stripComments('foo: bar # a comment'), 'foo: bar ');
});

test('stripComments: preserves a "#" inside a quoted string (#1312)', () => {
  assert.equal(stripComments('run: echo "hello # world"'), 'run: echo "hello # world"');
  assert.equal(stripComments("run: echo 'hello # world'"), "run: echo 'hello # world'");
});

test('stripComments: does not treat a "#" glued to non-whitespace as a comment', () => {
  assert.equal(stripComments('run: curl "https://example.com/#ref"'), 'run: curl "https://example.com/#ref"');
});

test('stripComments: still strips a comment that follows a closed quoted string', () => {
  assert.equal(stripComments('run: echo "hi" # trailing note'), 'run: echo "hi" ');
});

test('hasPullRequestTargetTrigger: a quoted "#" does not corrupt trigger detection', () => {
  const source = [
    'on:',
    '  pull_request:',
    'jobs:',
    '  build:',
    '    steps:',
    '      - run: echo "not a # pull_request_target: trigger"',
  ].join('\n');
  assert.equal(hasPullRequestTargetTrigger(source), false);
});

test('hasPullRequestTargetTrigger: still detects a real pull_request_target trigger', () => {
  const source = 'on:\n  pull_request_target:\n';
  assert.equal(hasPullRequestTargetTrigger(source), true);
});

test('checkSource: tolerates an inline comment on permissions/concurrency (#1312)', () => {
  const source = [
    'permissions: # inherited from org default',
    'on:',
    '  pull_request:',
    'concurrency: # shared group',
    'jobs: {}',
  ].join('\n');
  const failures = checkSource('wf.yml', source);
  assert.deepEqual(failures, []);
});

test('checkSource: still flags a genuinely missing permissions/concurrency block', () => {
  const source = [
    'on:',
    '  pull_request:',
    'jobs: {}',
  ].join('\n');
  const failures = checkSource('wf.yml', source);
  assert.ok(failures.some((f) => f.includes('missing explicit top-level permissions')));
  assert.ok(failures.some((f) => f.includes('must define concurrency')));
});

const reviewWorkflow = (severity) => (
  'uses: actions/dependency-review-action@' + 'a'.repeat(40) + '\n'
  + `with:\n  fail-on-severity: ${severity}\n`
);

test('checkDependencyReviewSeverity: passes when every invocation shares a threshold', () => {
  const failures = checkDependencyReviewSeverity([
    { file: 'security.yml', source: reviewWorkflow('moderate') },
    { file: 'dependency-review.yml', source: reviewWorkflow('moderate') },
  ]);
  assert.deepEqual(failures, []);
});

test('checkDependencyReviewSeverity: flags disagreeing thresholds (#3008)', () => {
  const failures = checkDependencyReviewSeverity([
    { file: 'security.yml', source: reviewWorkflow('moderate') },
    { file: 'dependency-review.yml', source: reviewWorkflow('high') },
  ]);
  assert.equal(failures.length, 1);
  assert.match(failures[0], /#3008/);
  assert.match(failures[0], /security\.yml=moderate/);
  assert.match(failures[0], /dependency-review\.yml=high/);
});

test('checkDependencyReviewSeverity: ignores files that do not run the action', () => {
  const failures = checkDependencyReviewSeverity([
    { file: 'ci.yml', source: 'jobs:\n  build: {}\n' },
    { file: 'security.yml', source: reviewWorkflow('moderate') },
  ]);
  assert.deepEqual(failures, []);
});
