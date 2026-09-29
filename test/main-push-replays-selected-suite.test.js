'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');

const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'benchmark.yml');
const workflow = yaml.load(fs.readFileSync(WORKFLOW, 'utf8'));

// #3177 was merged with ten red checks -- including the required "npm test
// gate" -- and the post-merge push run still showed every shard `skipped`,
// because the shard job was gated on `github.event_name != 'push'` and the
// NOT_APPLICABLE job reported success in its place. `main-ci-watch` counts a
// skipped run as green, so a broken main stayed invisible until the next PR
// tripped over it. These pin the fix: a main push replays the selected suite.

test('a main push replays the selected suite instead of skipping it', () => {
  const shardJob = workflow.jobs['runtime-test'];
  assert.ok(shardJob, 'runtime-test job must exist');
  assert.doesNotMatch(String(shardJob.if), /event_name\s*!=\s*'push'/);
  assert.match(String(shardJob.if), /run_tests\s*==\s*'true'/);

  // The NOT_APPLICABLE job must only cover "nothing to run", never a push.
  const skipJob = workflow.jobs['runtime-test-skip'];
  assert.ok(skipJob, 'runtime-test-skip job must exist');
  assert.doesNotMatch(String(skipJob.if), /event_name\s*==\s*'push'/);
  assert.match(String(skipJob.if), /run_tests\s*!=\s*'true'/);
});

test('a main push runs the same shard matrix as a pull request', () => {
  const matrix = workflow.jobs['runtime-test'].strategy.matrix;
  const os = String(matrix.os);
  const node = String(matrix['node-version']);

  // The wide matrix is nightly/manual only. A push must match the PR legs, or
  // the replay would be weaker than the check it stands in for.
  assert.match(os, /schedule/);
  assert.match(os, /workflow_dispatch/);
  assert.match(os, /ubuntu-latest/);
  assert.match(os, /windows-latest/);
  assert.match(node, /\[22\]/);

  assert.deepEqual(matrix.shard, [1, 2, 3, 4, 5]);
});

test('the shard job stays gated on the plan having something to run', () => {
  // Replaying on push must not turn every main push into a full-suite run: the
  // job is still conditional on the impact plan selecting tests.
  const shardJob = workflow.jobs['runtime-test'];
  assert.match(String(shardJob.if), /needs\['test-impact-plan'\]\.outputs\.run_tests/);
});
