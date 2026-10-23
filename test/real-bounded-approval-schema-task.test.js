'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');

const {
  STATUS,
  loadTaskFixture,
  runTask,
} = require('../lib/deterministic-task-runner');

const TASK_NAME = 'real-huqan-approval-schema-private-object-helper-rename';
const REPO_ROOT = path.join(__dirname, '..');
const SOURCE_PATH = 'lib/approval-schema.js';
const TEST_PATH = 'test/approval-schema.test.js';

function taskFixture() {
  return loadTaskFixture(TASK_NAME);
}

function validateGenerated(t, task, source) {
  const paths = [SOURCE_PATH, TEST_PATH, 'lib/json-clone.js', 'lib/workspace-id.js'];
  const originals = new Map(paths.map(file => [file, fs.readFileSync(path.join(REPO_ROOT, file))]));
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-approval-generated-'));
  t.after(() => {
    try {
      for (const [file, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(REPO_ROOT, file)), bytes);
    } finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  for (const [file, bytes] of originals) {
    const target = path.join(directory, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file === SOURCE_PATH ? source : bytes);
  }
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return childProcess.spawnSync(process.execPath, task.validation.args,
    { cwd: directory, env, encoding: 'utf8', timeout: task.validation.timeoutMs, windowsHide: true });
}

describe('first real Huqan bounded task', () => {
  it('matches the canonical source after the runner-applied exact patch', () => {
    const task = taskFixture();
    const source = fs.readFileSync(path.join(REPO_ROOT, SOURCE_PATH), 'utf8').replace(/\r\n/g, '\n');

    assert.equal(task.allowedPaths.length, 1);
    assert.deepEqual(task.allowedPaths, [SOURCE_PATH]);
    assert.equal(task.operation.type, 'rename_identifier');
    assert.equal(task.operation.from, 'isPlainObject');
    assert.equal(task.operation.to, 'isApprovalObject');
    assert.equal(source, task.expectedPatch[0].after);
  });

  it('completes with one exact changed path and replays identically', () => {
    const task = taskFixture();
    const first = runTask(task);
    const replay = runTask(task);

    assert.equal(first.status, STATUS.COMPLETED);
    assert.deepEqual(first.patch, task.expectedPatch);
    assert.deepEqual(first.changedPaths, [SOURCE_PATH]);
    assert.deepEqual(first, replay);
    assert.equal(first.files[SOURCE_PATH].includes('isApprovalObject'), true);
    assert.equal(Object.hasOwn(first.files, TEST_PATH), false);
  });

  it('passes the existing approval-schema contract test on the generated copy', t => {
    const task = taskFixture();
    const result = runTask(task);
    assert.equal(result.status, STATUS.COMPLETED);
    const testRun = validateGenerated(t, task, result.files[SOURCE_PATH]);

    assert.equal(testRun.status, 0, `${testRun.stdout}\n${testRun.stderr}`);
  });

  it('rejects semantic corruption in the generated copy while the repository stays unchanged', t => {
    const task = taskFixture();
    const result = runTask(task);
    assert.equal(result.status, STATUS.COMPLETED);
    const source = result.files[SOURCE_PATH];
    const broken = source.replace("return Boolean(value) && typeof value === 'object' && !Array.isArray(value);", 'return false;');
    assert.notEqual(broken, source);
    const testRun = validateGenerated(t, task, broken);
    assert.equal(testRun.status, 1, `${testRun.stdout}\n${testRun.stderr}`);
  });

  it('fails closed when the operation path leaves the allowlist', () => {
    const task = structuredClone(taskFixture());
    task.operation.path = TEST_PATH;

    const result = runTask(task);

    assert.equal(result.status, STATUS.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, 'PATH_NOT_ALLOWED_OR_MISSING');
    assert.deepEqual(result.patch, []);
    assert.deepEqual(result.files, task.files);
  });

  it('fails closed when the expected patch is altered', () => {
    const task = structuredClone(taskFixture());
    task.expectedPatch[0].after += '\n// unexpected change';

    const result = runTask(task);

    assert.equal(result.status, STATUS.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, 'EXPECTED_PATCH_MISMATCH');
    assert.deepEqual(result.patch, []);
    assert.deepEqual(result.files, task.files);
  });

  it('fails closed when the source identifier is absent', () => {
    const task = structuredClone(taskFixture());
    task.operation.from = 'identifierThatDoesNotExist';

    const result = runTask(task);

    assert.equal(result.status, STATUS.NEEDS_HUMAN_DECISION);
    assert.equal(result.reason, 'IDENTIFIER_NOT_FOUND');
    assert.deepEqual(result.patch, []);
    assert.deepEqual(result.files, task.files);
  });
});
