const test = require('node:test');
const assert = require('node:assert/strict');

const { stripComments, hasPullRequestTargetTrigger, checkSource } = require('./check-workflow-governance');

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
