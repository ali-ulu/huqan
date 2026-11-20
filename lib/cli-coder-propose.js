'use strict';
const { CLI_EXIT_CODES } = require('./cli-workflow-envelope');

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
const { resolveLearningSource, attachLearningSource, ELIGIBILITY, CODES, ACCEPTANCE_ENV } = require('./experience/learning-source');
const { resolveApprovalAuthorityMode } = require('./authority/authority-mode');

function cliError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function parseProposeArgs(tokens) {
  const flags = { failureFile: '', root: '', sourceFile: '' };
  // A flag that names a file must name one. `--source` with nothing after it,
  // or with the next flag in that position, is a request for validation whose
  // evidence is missing; treating it as "no source" would silently downgrade
  // the caller to the plain task and hide the mistake.
  const valueAfter = (index, name) => {
    const value = tokens[index + 1];
    if (typeof value !== 'string' || !value || value.startsWith('--')) {
      throw cliError(`Usage: ${name} needs a file path.`, CLI_EXIT_CODES.review_required);
    }
    return value;
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--root') { flags.root = valueAfter(index, '--root'); index += 1; }
    else if (token === '--source') { flags.sourceFile = valueAfter(index, '--source'); index += 1; }
    else if (token === '--json') { /* handled by the caller via opts.json */ }
    else if (!flags.failureFile && !token.startsWith('--')) flags.failureFile = token;
  }
  return flags;
}

function readJson(file, label) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw cliError(`${label} could not be read: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw cliError(`${label} is not valid JSON: ${error.message}`);
  }
}

const readFailure = (failureFile) => readJson(failureFile, 'Failure record');
const readSource = (sourceFile) => readJson(sourceFile, 'Learning source');

/**
 * The signed acceptance attestation, read from the path the launcher named
 * (#4624).
 *
 * The path itself is not evidence -- a proposer can set the variable -- so a
 * file that does not parse is handed on as `null` and the verifier refuses it
 * as `oracle_supply_unverified`. A malformed attestation must not crash the
 * command: it is the same refusal as no attestation at all.
 */
function readAttestation(environment) {
  const env = environment && typeof environment === 'object' ? environment : {};
  const file = env[ACCEPTANCE_ENV.ATTESTATION];
  if (typeof file !== 'string' || !file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * The pinned signing key the attestation must verify against, or `null`.
 *
 * Only an `os-service` authority counts. `resolveApprovalAuthorityMode` reports
 * three service shapes and they are not equally trustworthy:
 *
 *   os-service    the pin sits on a path the agent user cannot write
 *   env-override  the pin is wherever `HUQAN_AUTHORITY_PIN_PATH` says, i.e.
 *                 wherever the launching process chose -- and the proposing
 *                 agent chooses its own launcher, so it can mint that pin and
 *                 the keypair beside it
 *   legacy        no pin at all
 *
 * Accepting `env-override` here would rebuild the exact hole #4624 is about,
 * one layer down: instead of setting a channel variable the agent would point
 * at its own key. So the boundary has to be the one the OS enforces, and
 * everything else answers `null`, which the verifier refuses.
 */
function resolveTrustedKey(opts) {
  try {
    const mode = opts.authorityMode || resolveApprovalAuthorityMode();
    if (!mode || mode.mode !== 'service' || mode.boundary !== 'os-service') return null;
    return mode.pin ? mode.pin.signingKey : null;
  } catch (_) {
    return null;
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
  let result = produceTask(failure);

  // Learning attachment is opt-in through --source and never inferred: a task
  // without a declared, independently verified acceptance oracle stays exactly
  // what it was, so the synthesis arms keep refusing it fail-closed.
  let learningSource = null;
  if (result.status === PRODUCER_STATUSES.TASK_PRODUCED && flags.sourceFile) {
    learningSource = resolveLearningSource({
      failure,
      source: readSource(flags.sourceFile),
      attestation: readAttestation(opts.environment || process.env),
      trustedKey: resolveTrustedKey(opts),
      now: typeof opts.now === 'number' ? opts.now : Date.now(),
    });
    // A resolved-but-conflicting outcome is evidence a human must settle, not
    // a task to print. `attachLearningSource` would return `attached: false`
    // and leave the task looking successful while carrying no oracle, so the
    // decision is made here and the task is dropped.
    if (learningSource.ok === true && learningSource.eligibility === ELIGIBILITY.NEEDS_REVIEW) {
      result = {
        status: PRODUCER_STATUSES.NEEDS_HUMAN_DECISION,
        reason: CODES.OUTCOME_CONFLICTING,
        task: null,
        sourceFailureId: result.sourceFailureId,
        operationType: result.operationType,
      };
    } else if (learningSource.ok !== true) {
      result = {
        status: PRODUCER_STATUSES.NEEDS_HUMAN_DECISION,
        reason: learningSource.code,
        task: null,
        sourceFailureId: result.sourceFailureId,
        operationType: result.operationType,
      };
    } else {
      const attached = attachLearningSource(result.task, learningSource);
      if (attached.ok !== true || attached.attached !== true) {
        result = {
          status: PRODUCER_STATUSES.NEEDS_HUMAN_DECISION,
          reason: attached.code || CODES.INVALID_INPUT,
          task: null,
          sourceFailureId: result.sourceFailureId,
          operationType: result.operationType,
        };
      } else {
        result = { ...result, task: attached.task };
      }
    }
  }

  if (opts.json) {
    return {
      status: result.status === PRODUCER_STATUSES.TASK_PRODUCED ? 'completed' : 'needs_human_decision',
      data: {
        status: result.status,
        reason: result.reason,
        sourceFailureId: result.sourceFailureId,
        operationType: result.operationType,
        learningEligibility: learningSource && learningSource.ok === true ? learningSource.eligibility : null,
        task: result.task,
      },
    };
  }

  if (result.status !== PRODUCER_STATUSES.TASK_PRODUCED) {
    throw Object.assign(cliError(formatProposeText(result)), { exitCode: CLI_EXIT_CODES.review_required });
  }
  return formatProposeText(result);
}

module.exports = {
  formatProposeText,
  parseProposeArgs,
  runCliCoderPropose,
};
