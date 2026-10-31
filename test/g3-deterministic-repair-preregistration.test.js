'use strict';

/**
 * G3 deterministic repair source pin (#4433).
 *
 * The preregistration for the repair measurement
 * (`docs/task-packs/g3-deterministic-repair-preregistration-20261030.md`) sources
 * tasks from verified failure records through `produceTask`, then runs them on
 * the deterministic `coder <task>` path. This file drives the real engine, the
 * real producer and the real CLI, and pins the anti-case: an unsupported
 * operation produces no task at all. #4428 established that this source does
 * not carry the learning mechanism, so the repair protocol never uses it.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'cli.js');
const MemoryStore = require('../lib/memory-store');
const { createErrorPrevention } = require('../lib/error-prevention');
const { PRODUCER_REASONS, PRODUCER_STATUSES, produceTask } = require('../lib/task-producer');

function verifiedFailure(overrides = {}) {
  const prevention = createErrorPrevention(new MemoryStore({ useSQLite: false }), {
    verifyEvidence: ({ source, evidence }) => source === 'test_failure'
      && evidence.some(item => item?.type === 'test' && item?.verifiedBy === 'ci'),
  });
  const recorded = prevention.recordFailure({
    tool: 'coder', operation: 'replace_text', path: 'docs/version.md', workspaceId: 'default',
    source: 'test_failure', observed: 'v1.0.0', expected: 'v1.1.0',
    evidence: [{ type: 'test', verifiedBy: 'ci' }],
    ...overrides,
  });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.failure.verificationStatus, 'verified');
  return recorded.failure;
}

function realRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-g3-repair-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-qb', 'feat/g3-repair');
  git('config', 'user.email', 'g3@example.invalid');
  git('config', 'user.name', 'g3');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'version.md'), 'version v1.0.0\n', 'utf8');
  git('add', '.');
  git('commit', '-qm', 'base');
  return root;
}

test('a verified failure record produces a deterministic repair task', () => {
  const produced = produceTask(verifiedFailure());
  assert.equal(produced.status, PRODUCER_STATUSES.TASK_PRODUCED);
  assert.equal(produced.task.operation.type, 'replace_text');
  assert.equal(produced.task.operation.find, 'v1.0.0');
  assert.equal(produced.task.operation.replace, 'v1.1.0');
  // Deterministic, not a learning task: no test command and no synthesis field.
  assert.equal(produced.task.test, undefined);
  assert.equal(produced.task.synthesis, undefined);
});

test('an unsupported operation produces no task (anti-case fails closed)', () => {
  const produced = produceTask(verifiedFailure({ operation: 'unsupported_operation' }));
  assert.equal(produced.status, PRODUCER_STATUSES.NEEDS_HUMAN_DECISION);
  assert.equal(produced.reason, PRODUCER_REASONS.NO_SUPPORTED_OPERATION);
  assert.ok(produced.task == null);
});

test('the deterministic repair applies and changes exactly the declared file', () => {
  const root = realRoot();
  try {
    const taskFile = path.join(root, 'task.json');
    fs.writeFileSync(taskFile, JSON.stringify(produceTask(verifiedFailure()).task), 'utf8');
    const child = spawnSync(process.execPath, [CLI, 'coder', taskFile, '--authorize',
      '--root', root, '--json'], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') },
    });
    assert.equal(child.status, 0, child.stdout + child.stderr);
    const result = JSON.parse(child.stdout);
    assert.equal(result.status, 'completed');
    assert.equal(result.data.outcome, 'applied');
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), 'version v1.1.0\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
