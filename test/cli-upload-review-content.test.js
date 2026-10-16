'use strict';

// #3644: on the real argv path the gate branch queues the durable review
// proposal itself (cli.js#execute is bypassed). `upload:`/`yükle:` must hand
// the queue helper `{ readFile: true }` so it loads the file's content, while
// `learn:` keeps the plain-text path. An unreadable upload names no fact and
// must fail instead of queueing the path.

const assert = require('node:assert/strict');
const test = require('node:test');

const { runCliArgv, CLI_EXIT_CODES } = require('../lib/cli-workflow-adapter');

function reviewCli(command, args) {
  const queued = [];
  return {
    queued,
    parse: () => ({ command, args, workflowId: 'learn-review' }),
    evaluateCliGate: () => ({ canExecute: false, decision: 'review', reason: 'policy' }),
    execute: () => { throw new Error('the review branch must not run execute'); },
    queueLearnReview: (a, opts) => {
      queued.push({ args: a, opts });
      return { approval: { id: 'approval-1' } };
    },
  };
}

test('upload: review asks the queue helper to read the file', async () => {
  const cli = reviewCli('yükle', '/tmp/notes.txt');
  const out = [];
  const result = await runCliArgv(['upload:', '/tmp/notes.txt'], { cli, stdout: v => out.push(v) });

  assert.deepEqual(cli.queued, [{ args: '/tmp/notes.txt', opts: { readFile: true } }]);
  assert.equal(out[0], 'Learn requires review. Approval queued: approval-1');
  assert.equal(result.exitCode, CLI_EXIT_CODES.review_required);
});

test('learn: review keeps the plain-text path (no file read)', async () => {
  const cli = reviewCli('öğret', 'cats are animals');
  await runCliArgv(['learn:', 'cats', 'are', 'animals'], { cli, stdout: () => {} });

  assert.deepEqual(cli.queued, [{ args: 'cats are animals', opts: { readFile: false } }]);
});

test('an unreadable upload fails instead of queueing the path', async () => {
  const cli = reviewCli('yükle', '/tmp/missing.txt');
  cli.queueLearnReview = () => { throw new Error('ENOENT: no such file or directory'); };
  const err = [];
  const result = await runCliArgv(['upload:', '/tmp/missing.txt'], { cli, stdout: () => {}, stderr: v => err.push(v) });

  assert.equal(result.exitCode, CLI_EXIT_CODES.failed);
  assert.match(err[0], /Could not read file: ENOENT/);
});
