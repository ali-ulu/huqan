'use strict';

/**
 * G3 real-cohort result pin (#4423 result).
 *
 * The preregistration (`docs/task-packs/g3-real-cohort-preregistration-20261030.md`)
 * froze two things that do not fit together: §2 sources tasks from verified
 * failure records through `produceTask`, while §3 runs those tasks through the
 * coder's synthesis learning arms (`--synthesize` / `--adapt-memory`). The real
 * chain yields deterministic transform tasks with no `test` and no `synthesis`,
 * so the learning arms fail closed. This file pins that gap with the real
 * engine, the real producer and the real CLI, so the preregistered measurement
 * cannot be re-run against a source it was never defined for.
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
const { PRODUCER_STATUSES, produceTask } = require('../lib/task-producer');

// A real repository on a feature branch: the gate refuses on `main`, so only a
// checkout on a working branch exercises the apply path the measurement needs.
function realRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-g3-real-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-qb', 'feat/g3-real');
  git('config', 'user.email', 'g3@example.invalid');
  git('config', 'user.name', 'g3');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, 'docs', 'version.md'), 'version v1.0.0\n', 'utf8');
  git('add', '.');
  git('commit', '-qm', 'base');
  return root;
}

/** A verified failure record produced by the real error-prevention engine. */
function verifiedFailure() {
  const prevention = createErrorPrevention(new MemoryStore({ useSQLite: false }), {
    verifyEvidence: ({ source, evidence }) => source === 'test_failure'
      && evidence.some(item => item?.type === 'test' && item?.verifiedBy === 'ci'),
  });
  const recorded = prevention.recordFailure({
    tool: 'coder', operation: 'replace_text', path: 'docs/version.md', workspaceId: 'default',
    source: 'test_failure', observed: 'v1.0.0', expected: 'v1.1.0',
    evidence: [{ type: 'test', verifiedBy: 'ci' }],
  });
  assert.equal(recorded.ok, true);
  assert.equal(recorded.failure.verificationStatus, 'verified');
  return recorded.failure;
}

function runCoder(root, taskFile, mode) {
  const args = [CLI, 'coder', taskFile, '--authorize', '--root', root, '--json'];
  if (mode) args.splice(3, 0, mode);
  const child = spawnSync(process.execPath, args, {
    cwd: root, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') },
  });
  return { status: child.status, json: child.stdout ? JSON.parse(child.stdout) : null };
}

test('the real failure-record chain yields deterministic tasks, not synthesis tasks', () => {
  const produced = produceTask(verifiedFailure());
  assert.equal(produced.status, PRODUCER_STATUSES.TASK_PRODUCED);
  assert.equal(produced.task.operation.type, 'replace_text');
  assert.equal(produced.task.operation.find, 'v1.0.0');
  assert.equal(produced.task.operation.replace, 'v1.1.0');
  assert.equal(produced.task.test, undefined);
  assert.equal(produced.task.synthesis, undefined);
});

test('the preregistered learning arm fails closed on a real task', () => {
  const root = realRoot();
  try {
    const taskFile = path.join(root, 'task.json');
    fs.writeFileSync(taskFile, JSON.stringify(produceTask(verifiedFailure()).task), 'utf8');
    const attempted = runCoder(root, taskFile, '--synthesize');
    assert.notEqual(attempted.status, 0);
    assert.equal(attempted.json.error.code, 'COMMAND_FAILED');
    assert.match(attempted.json.error.message, /Synthesis requires independent test\.command/);
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), 'version v1.0.0\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the deterministic arm applies the real task and changes exactly the declared file', () => {
  const root = realRoot();
  try {
    const taskFile = path.join(root, 'task.json');
    fs.writeFileSync(taskFile, JSON.stringify(produceTask(verifiedFailure()).task), 'utf8');
    const applied = runCoder(root, taskFile);
    assert.equal(applied.status, 0);
    assert.equal(applied.json.status, 'completed');
    assert.equal(applied.json.data.outcome, 'applied');
    assert.equal(fs.readFileSync(path.join(root, 'docs', 'version.md'), 'utf8'), 'version v1.1.0\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
