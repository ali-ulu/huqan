'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  STATUS,
  loadTaskFixture,
  runTask,
} = require('../lib/deterministic-task-runner');

const FIXTURE_NAMES = [
  'l0-version-bump',
  'l0-env-var-rename',
  'l1-json-schema-route-test',
  'l1-mcp-tool-registration',
  'l2-ast-rename',
];

function fixture(name) {
  return loadTaskFixture(name);
}

describe('Deterministic coding task benchmarks', () => {
  for (const name of FIXTURE_NAMES) {
    it(`completes the ${name} fixture with the expected patch`, () => {
      const task = fixture(name);
      const result = runTask(task);

      assert.equal(result.status, STATUS.COMPLETED);
      assert.deepEqual(result.patch, task.expectedPatch);
      assert.deepEqual(result.changedPaths, task.expectedPatch.map(change => change.path));
      assert.notDeepEqual(result.files, task.files);
    });
  }

  it('replays every supported fixture identically', () => {
    for (const name of FIXTURE_NAMES) {
      const task = fixture(name);
      assert.deepEqual(runTask(task), runTask(task), `replay changed for ${name}`);
    }
  });

  it('does not write a path outside the allowlist', () => {
    const task = fixture('l0-version-bump');
    task.operation.path = 'docs/unapproved.md';

    const result = runTask(task);

    assert.equal(result.status, STATUS.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, 'PATH_NOT_ALLOWED_OR_MISSING');
    assert.deepEqual(result.files, task.files);
    assert.deepEqual(result.patch, []);
  });

  it('rejects an ambiguous literal replacement instead of guessing', () => {
    const task = fixture('l0-version-bump');
    task.operation.find = '0.9.1';
    task.operation.replace = '0.9.2';
    task.files['package.json'] = task.files['package.json'].replace(
      '"version": "0.9.1"',
      '"version": "0.9.1",\n  "legacyVersion": "0.9.1"'
    );

    const result = runTask(task);

    assert.equal(result.status, STATUS.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, 'REPLACEMENT_NOT_UNIQUE');
    assert.deepEqual(result.files, task.files);
  });

  it('rejects an unsupported operation without changing files', () => {
    const task = fixture('l1-mcp-tool-registration');
    task.operation.type = 'invent_missing_code';

    const result = runTask(task);

    assert.equal(result.status, STATUS.UNSUPPORTED_TASK);
    assert.equal(result.reason, 'OPERATION_UNSUPPORTED');
    assert.deepEqual(result.files, task.files);
    assert.deepEqual(result.patch, []);
  });

  it('fails closed when the expected patch does not match', () => {
    const task = fixture('l1-mcp-tool-registration');
    task.expectedPatch[0].after = task.expectedPatch[0].after.replace('axiom.trace', 'axiom.other');

    const result = runTask(task);

    assert.equal(result.status, STATUS.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, 'EXPECTED_PATCH_MISMATCH');
    assert.deepEqual(result.files, task.files);
    assert.deepEqual(result.patch, []);
  });

  it('requires a human decision when a fixture explicitly marks ambiguity', () => {
    const task = fixture('l2-ast-rename');
    task.requiresHumanDecision = true;

    const result = runTask(task);

    assert.equal(result.status, STATUS.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, 'TASK_REQUIRES_HUMAN_DECISION');
    assert.deepEqual(result.files, task.files);
  });

  it('does not permit schema generation to escape its two output paths', () => {
    const task = fixture('l1-json-schema-route-test');
    task.operation.testPath = 'docs/generated-test.js';

    const result = runTask(task);

    assert.equal(result.status, STATUS.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, 'PATH_NOT_ALLOWED_OR_MISSING');
    assert.deepEqual(result.files, task.files);
    assert.deepEqual(result.patch, []);
  });
});
