'use strict';

/**
 * `coder propose` — turn a verified failure record into a candidate task.
 *
 *   coder propose <failure.json> [--root <dir>] [--json]
 *
 * This is the missing input stage of the coder path. `coder <task.json>`
 * already runs, gates and writes; the only way to get a task was to hand-write
 * one. This command is what stands in that gap, and it stops exactly where the
 * gap ends: it prints a task, or prints why there is none. It does not run the
 * task, does not touch the working tree, and does not decide anything.
 *
 * The output is meant to be piped straight into the existing command:
 *
 *   huqan coder propose failure.json > task.json
 *   huqan coder task.json --dry-run
 *
 * That second command is where the gate runs, and it still can refuse. A
 * proposal is not a change and this command cannot make it one.
 */

const fs = require('node:fs');
const nodePath = require('node:path');

const {
  PRODUCER_STATUSES,
  produceTask,
} = require('./task-producer');

function cliError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function parseProposeArgs(tokens) {
  const flags = { failureFile: '', root: '' };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--root') { flags.root = tokens[index + 1] || ''; index += 1; }
    else if (token === '--json') { /* handled by the caller via opts.json */ }
    else if (!flags.failureFile && !token.startsWith('--')) flags.failureFile = token;
  }
  return flags;
}

function readFailure(failureFile) {
  let raw;
  try {
    raw = fs.readFileSync(failureFile, 'utf8');
  } catch (error) {
    throw cliError(`Failure record could not be read: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw cliError(`Failure record is not valid JSON: ${error.message}`);
  }
}

function formatProposeText(result) {
  if (result.status === PRODUCER_STATUSES.TASK_PRODUCED) {
    return JSON.stringify(result.task, null, 2);
  }
  // Say plainly that there is no task, and why. A command that printed an
  // empty object here would let a caller mistake "could not decide" for "here
  // is a no-op task", and no-op tasks are exactly the ones nobody reviews.
  return `No task proposed: ${result.reason}\n`
    + `Failure:   ${result.sourceFailureId || '(unnamed)'}\n`
    + 'This failure cannot be projected onto a supported transform. It needs a human decision; '
    + 'nothing was written.';
}

function runCliCoderPropose(tokens, opts = {}) {
  const flags = parseProposeArgs(tokens);
  if (!flags.failureFile) {
    throw cliError('Usage: coder propose <failure.json> [--root <dir>] [--json]');
  }

  // Accepted and unused on purpose. The producer never reads the tree, so a
  // --root here cannot change its answer. The flag exists so the command can
  // be written the same way as its siblings, and if a future version does
  // read files, it will read them from here.
  void flags.root;

  const failure = readFailure(flags.failureFile);
  const result = produceTask(failure);

  if (opts.json) {
    return {
      status: result.status === PRODUCER_STATUSES.TASK_PRODUCED ? 'completed' : 'needs_human_decision',
      data: {
        status: result.status,
        reason: result.reason,
        sourceFailureId: result.sourceFailureId,
        operationType: result.operationType,
        task: result.task,
      },
    };
  }

  if (result.status !== PRODUCER_STATUSES.TASK_PRODUCED) {
    throw cliError(formatProposeText(result));
  }
  return formatProposeText(result);
}

module.exports = {
  formatProposeText,
  parseProposeArgs,
  runCliCoderPropose,
};
