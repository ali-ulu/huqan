'use strict';

/**
 * Experience — re-verify a task's learning evidence when it executes (#4632).
 *
 * `coder propose --source` verifies the signed acceptance attestation and then
 * hands the result to the caller as a JSON task file. A task file is editable
 * between the two commands, so the copy of `learningSource` it carries is a
 * claim, not evidence. #4632 is the audit finding: the execution path read that
 * copy and sealed it into the journal without ever asking the authority again,
 * so a proposer could swap the acceptance command, widen the allowlist or
 * rewrite the oracle hashes and still produce a learning-eligible record that
 * pointed at a signature it no longer matched.
 *
 * ## What this does
 *
 * It re-runs the proposal-time check at the boundary that actually executes the
 * test, and it binds the *executed* facts, not the recorded ones:
 *
 *   sourceHash        the sealed failure record the candidate derives from
 *   command           `task.test.command`, the command about to run
 *   allowedPaths      `task.allowedPaths`, the set the gate will enforce
 *   workspaceId       the workspace this run writes into
 *   approvalId        the approval named in the signed envelope
 *   actionHash        the canonical action hash the envelope signs
 *
 * Each of those is compared with the task's own copy and with the signature.
 * Any edit between propose and execute therefore fails the check: the task's
 * copy disagrees with the executed value, or the executed value no longer
 * hashes to what was signed.
 *
 * ## Fail closed
 *
 * A task that carries `learningSource` but no usable attestation, no pinned
 * key, an expired grant, a wrong key or a mismatched binding is refused before
 * the run starts. It is not downgraded to "run without learning": a silent
 * downgrade would let a forged task produce a real patch while only the
 * provenance quietly disappears, and the caller could not tell which happened.
 *
 * ## What is not bound
 *
 * The signed envelope covers the failure record, the command and the path set,
 * not the transform's own parameters. Swapping `operation.find` for a different
 * edit on the same declared path is not caught here; the journal's
 * `action_proposed` event records the operation that actually ran beside the
 * signed source, so the record shows it.
 *
 * The outcome fields are not signed either: `outcomeStatus` is the source's own
 * claim, and `eligibility` is derived from it here and at proposal time rather
 * than trusted from the task. A task can therefore still relabel a `failed`
 * source as `verified` together with its outcome hashes; the sealed
 * `sourceHash` names the record, so an auditor can re-derive that record's own
 * hash from the sealed fields and see the relabel. Binding them properly means
 * adding them to the acceptance decision, which changes the contract the
 * Authority registers and signs.
 * // shortcut: operation parameters and outcome fields are unsigned; upgrade
 * // when the acceptance envelope gains an operation and outcome hash.
 */

const { createHash } = require('node:crypto');
const { isPlainObject } = require('../is-plain-object');
const { LEARNING_ELIGIBILITY } = require('./contract');
const { CODES, SUPPLY_CHANNELS } = require('./learning-source');
const { verifyAcceptanceAttestation } = require('./acceptance-attestation');
const { readAttestation, resolveTrustedKey } = require('../acceptance-attestation-source');

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const INDEPENDENT_CHANNELS = Object.freeze([SUPPLY_CHANNELS.OPERATOR, SUPPLY_CHANNELS.CI]);
const EXECUTED_OUTCOMES = Object.freeze(['verified', 'failed']);

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function repoRelative(value) {
  const cleaned = cleanString(value).replace(/\\/gu, '/');
  if (!cleaned || cleaned.startsWith('/') || /^[a-zA-Z]:/u.test(cleaned)) return false;
  if (cleaned.split('/').some((part) => !part || part === '.' || part === '..')) return false;
  return true;
}

/** The task's allowlist, as the gate will read it. `null` when it is not a usable set. */
function executedPaths(task) {
  const paths = task.allowedPaths;
  if (!Array.isArray(paths) || paths.length === 0) return null;
  const normalized = paths.map(value => cleanString(value).replace(/\\/gu, '/'));
  if (!normalized.every(repoRelative) || new Set(normalized).size !== normalized.length) return null;
  return normalized;
}

function samePathSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((value, index) => value === b[index]);
}

function refuse(code, detail = '') {
  return Object.freeze({
    ok: false,
    refusal: Object.freeze({ outcome: 'needs_human_decision', reason: code, detail }),
  });
}

/**
 * Verify the learning evidence a task carries against the authority's signature.
 *
 * @param {object} task the parsed task file, exactly as it will execute
 * @param {object} opts `environment` and `authorityMode` from the process
 *   boundary, plus `workspaceId` and `now`
 * @returns {{ok: true, task: object} | {ok: false, refusal: object}}
 */
function verifyExecutionLearningSource(task, opts = {}) {
  if (!isPlainObject(task)) return refuse(CODES.INVALID_INPUT);
  const source = task.learningSource;
  // A task without learning evidence is every ordinary Coder task; it runs
  // exactly as before and seals no source.
  if (source === undefined || source === null) return Object.freeze({ ok: true, task });
  if (!isPlainObject(source)) return refuse(CODES.INVALID_INPUT);

  const test = isPlainObject(task.test) ? task.test : {};
  const command = typeof test.command === 'string' ? test.command : '';
  if (!command) return refuse(CODES.ORACLE_MISSING);

  const allowedPaths = executedPaths(task);
  if (!allowedPaths) return refuse(CODES.ALLOWED_PATHS_INVALID);
  if (!samePathSet(allowedPaths, source.allowedPaths)) {
    return refuse(CODES.ORACLE_SUPPLY_UNVERIFIED, 'allowed_paths_mismatch');
  }

  const sourceHash = cleanString(source.sourceHash);
  if (!HASH_PATTERN.test(sourceHash)) return refuse(CODES.SOURCE_HASH_MISSING);

  const oracle = isPlainObject(source.oracle) ? source.oracle : {};
  const commandHash = sha256(command);
  // The task's own claim about the signed command is checked first, so an
  // edited command reads as an edit rather than as a broken signature.
  if (cleanString(oracle.commandHash) !== commandHash) {
    return refuse(CODES.ORACLE_SUPPLY_UNVERIFIED, 'command_hash_mismatch');
  }

  const verified = verifyAcceptanceAttestation(readAttestation(opts.environment), {
    sourceHash,
    command,
    allowedPaths,
    trustedKey: resolveTrustedKey(opts),
    workspaceId: cleanString(opts.workspaceId) || 'default',
    now: Number.isFinite(opts.now) ? opts.now : Date.now(),
  });
  if (!verified.ok) return refuse(CODES.ORACLE_SUPPLY_UNVERIFIED, verified.detail || verified.code);
  if (!INDEPENDENT_CHANNELS.includes(verified.channel)) return refuse(CODES.ORACLE_NOT_INDEPENDENT);

  if (cleanString(oracle.channel).toLowerCase() !== verified.channel) {
    return refuse(CODES.ORACLE_SUPPLY_UNVERIFIED, 'channel_mismatch');
  }
  if (cleanString(oracle.approvalId) !== verified.approvalId) {
    return refuse(CODES.ORACLE_SUPPLY_UNVERIFIED, 'approval_id_mismatch');
  }
  if (cleanString(oracle.actionHash) !== verified.actionHash) {
    return refuse(CODES.ORACLE_SUPPLY_UNVERIFIED, 'action_hash_mismatch');
  }

  const outcomeStatus = cleanString(source.outcomeStatus).toLowerCase();
  if (!EXECUTED_OUTCOMES.includes(outcomeStatus)) return refuse(CODES.ORACLE_INVALID, 'outcomeStatus');
  // Eligibility is a function of the outcome (`learning-source.js` derives it
  // the same way), so it is recomputed here rather than read from the task.
  const eligibility = outcomeStatus === 'verified'
    ? LEARNING_ELIGIBILITY.POSITIVE_PROCEDURE
    : LEARNING_ELIGIBILITY.NEGATIVE_EXAMPLE;
  if (cleanString(source.eligibility) !== eligibility) {
    return refuse(CODES.ORACLE_INVALID, 'eligibility');
  }
  const observedHash = cleanString(source.observedHash);
  const expectedHash = cleanString(source.expectedHash);
  if (!HASH_PATTERN.test(observedHash) || !HASH_PATTERN.test(expectedHash)) {
    return refuse(CODES.ORACLE_INVALID, 'outcome_hashes');
  }
  // The failure record has to show a change; `learning-source.js` refuses an
  // equal pair at proposal time, so an equal pair here was edited in.
  if (observedHash === expectedHash) return refuse(CODES.ORACLE_INVALID, 'outcome_hashes');

  // The sealed record is rebuilt from what was verified plus what the signed
  // source hash already covers, never from the task's oracle copy: the journal
  // must not be able to say a command or an approval it did not check. The
  // executed allowlist is the verified, normalized set for the same reason --
  // the runner and the gate must see exactly the paths the signature covered.
  return Object.freeze({
    ok: true,
    task: {
      ...task,
      allowedPaths: Object.freeze([...allowedPaths]),
      learningSource: Object.freeze({
        eligibility,
        sourceHash,
        outcomeStatus,
        observedHash,
        expectedHash,
        allowedPaths: Object.freeze([...allowedPaths]),
        oracle: Object.freeze({
          commandHash,
          channel: verified.channel,
          approvalId: verified.approvalId,
          actionHash: verified.actionHash,
        }),
      }),
    },
  });
}

module.exports = { verifyExecutionLearningSource };
