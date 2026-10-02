'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseProposeArgs, runCliCoderPropose } = require('../lib/cli-coder-propose');
const { runCliCoder } = require('../lib/cli-coder');
const { PRODUCER_STATUSES } = require('../lib/task-producer');

function failure(overrides = {}) {
  return {
    kind: 'failure_record',
    schemaVersion: '1.0.0',
    failureId: 'failure-abc123',
    source: 'test_failure',
    verificationStatus: 'verified',
    trust: 'high',
    verificationReason: 'verified_by_authority',
    action: { tool: 'coder', operation: 'replace_text', path: 'docs/notes.md', workspaceId: 'default' },
    expected: 'version v1.1.0\n',
    observed: 'version v1.0.0\n',
    evidence: [],
    workspaceId: 'default',
    ...overrides,
  };
}

function withFailureFile(content, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-propose-'));
  const file = path.join(root, 'failure.json');
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
  try {
    return run(file, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('coder propose', () => {
  it('parses the failure file and root without mistaking flags for it', () => {
    assert.deepEqual(parseProposeArgs(['failure.json', '--root', '/tmp/x']),
      { failureFile: 'failure.json', root: '/tmp/x' });
    assert.deepEqual(parseProposeArgs(['--json', 'failure.json']),
      { failureFile: 'failure.json', root: '' });
  });

  it('prints a task that the coder command can then run', () => {
    withFailureFile(failure(), (file) => {
      const printed = runCliCoderPropose([file]);
      const task = JSON.parse(printed);

      assert.equal(task.id, 'task-failure-abc123');
      assert.equal(task.operation.type, 'replace_text');
      assert.deepEqual(task.allowedPaths, ['docs/notes.md']);
    });
  });

  it('reports a proposal in structured form for --json callers', () => {
    withFailureFile(failure(), (file) => {
      const result = runCliCoderPropose([file], { json: true });

      assert.equal(result.status, 'completed');
      assert.equal(result.data.status, PRODUCER_STATUSES.TASK_PRODUCED);
      assert.equal(result.data.task.operation.find, 'version v1.0.0\n');
    });
  });

  it('refuses with a non-zero exit and no task when the failure cannot be mapped', () => {
    withFailureFile(failure({ action: { operation: 'insert_after', path: 'docs/notes.md' } }), (file) => {
      const result = runCliCoderPropose([file], { json: true });
      assert.equal(result.status, 'needs_human_decision');
      assert.equal(result.data.task, null);

      assert.throws(() => runCliCoderPropose([file]), (error) => {
        assert.equal(error.exitCode, 1);
        assert.match(error.message, /NO_SUPPORTED_OPERATION/);
        return true;
      });
    });
  });

  it('refuses an unverified failure rather than proposing an edit from it', () => {
    withFailureFile(failure({ verificationStatus: 'candidate' }), (file) => {
      assert.throws(() => runCliCoderPropose([file]), /FAILURE_NOT_VERIFIED/);
    });
  });

  it('reaches the proposal through the coder command itself', () => {
    withFailureFile(failure(), (file) => {
      const result = runCliCoder(['propose', file], { json: true });
      assert.equal(result.status, 'completed');
      assert.equal(result.data.task.operation.type, 'replace_text');
    });
  });

  it('proposes without touching the tree, and the follow-up run still answers to the gate', () => {
    // A real repository, not just a directory: the coder command reads repo
    // state from git, and an unrecognised tree is reported as unknown -- which
    // the gate reads as a clean, non-main tree. Only an actual checkout on
    // `main` exercises the refusal this test is about.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-propose-tree-')));
    const git = (...args) => childProcess.execFileSync('git', args, { cwd: root, stdio: 'ignore' });
    git('init', '--initial-branch=main');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    // `git commit` can start detached auto-maintenance that writes
    // .git/objects/maintenance.lock after the command returns, which made the
    // before/after tree listing below differ for reasons unrelated to propose.
    git('config', 'maintenance.auto', 'false');
    git('config', 'gc.auto', '0');
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'notes.md'), 'version v1.0.0\n', 'utf8');
    git('add', '.');
    git('commit', '-m', 'base');

    const failureFile = path.join(root, 'failure.json');
    fs.writeFileSync(failureFile, JSON.stringify(failure()), 'utf8');

    const before = fs.readdirSync(root, { recursive: true }).sort();
    const printed = runCliCoderPropose([failureFile]);
    const after = fs.readdirSync(root, { recursive: true }).sort();
    assert.deepEqual(after, before);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'notes.md'), 'utf8'), 'version v1.0.0\n');

    // The proposed task, run on main, is refused by the gate -- the proposal
    // confers nothing.
    const taskFile = path.join(root, 'task.json');
    fs.writeFileSync(taskFile, printed, 'utf8');
    const refused = runCliCoder([taskFile, '--root', root, '--json'], { json: true });
    assert.equal(refused.status, 'refused');
    assert.equal(refused.data.reason, 'GATE_REFUSED');
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'notes.md'), 'utf8'), 'version v1.0.0\n');

    fs.rmSync(root, { recursive: true, force: true });
  });
});
