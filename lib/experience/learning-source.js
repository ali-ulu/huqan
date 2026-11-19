'use strict';

/**
 * Experience — learning source contract (#4599).
 *
 * The gap this closes: `produceTask()` turns a verified failure record into a
 * deterministic transform, and that is all. The transform carries no `test`,
 * so the coder's synthesis learning arms refuse it (`Synthesis requires
 * independent test.command`) and the observed failure never reaches the
 * learning path. A deterministic repair succeeding is not behavioural
 * learning, and this module must not pretend otherwise.
 *
 * ## What it does
 *
 * It decides whether a verified failure plus externally supplied acceptance
 * evidence is *eligible* to become a learning candidate, and it attaches that
 * evidence to the task only when every part of the contract holds. It is a
 * pure predicate over data: no filesystem, no clock, no execution.
 *
 * ## What it refuses to do
 *
 * It never invents an oracle. The acceptance command must be supplied by an
 * operator or CI and must be declared as such; a record that names HUQAN, an
 * agent or a model as its own acceptance authority is refused. That refusal is
 * the whole point — HUQAN grading its own homework would turn every repair
 * into a "lesson" and make the learning claim unfalsifiable.
 *
 * Every other missing, ambiguous or untrusted field is also fail-closed, and
 * the returned `code` says which one, so "we could not decide" stays
 * distinguishable from "we decided no".
 */

const { createHash } = require('node:crypto');
const { isPlainObject } = require('../is-plain-object');
const { LEARNING_ELIGIBILITY } = require('./contract');

const CODES = Object.freeze({
  INVALID_INPUT: 'invalid_input',
  FAILURE_NOT_VERIFIED: 'failure_not_verified',
  SOURCE_HASH_MISSING: 'source_hash_missing',
  SOURCE_HASH_MISMATCH: 'source_hash_mismatch',
  OUTCOME_MISSING: 'outcome_missing',
  OUTCOME_EQUALS: 'outcome_equals',
  OUTCOME_CONFLICTING: 'outcome_conflicting',
  ALLOWED_PATHS_MISSING: 'allowed_paths_missing',
  ALLOWED_PATHS_INVALID: 'allowed_paths_invalid',
  PATH_NOT_ALLOWED: 'path_not_allowed',
  ORACLE_MISSING: 'oracle_missing',
  ORACLE_NOT_INDEPENDENT: 'oracle_not_independent',
  ORACLE_INVALID: 'oracle_invalid',
  ORACLE_SUPPLY_UNVERIFIED: 'oracle_supply_unverified',
});

/**
 * Which *channel* may hand this process an acceptance oracle.
 *
 * A label inside the source file cannot establish independence: `--source`
 * reads a caller-selected file, so the agent that proposes the task can write
 * `suppliedBy: 'ci'` into it and grade its own work. Independence is therefore
 * a property of how the oracle reached the process, and only these channels
 * qualify. `source-file` is listed to be refusable by name -- a declaration
 * that admits where it came from is still not independent.
 */
const SUPPLY_CHANNELS = Object.freeze({
  OPERATOR: 'operator',
  CI: 'ci',
  SOURCE_FILE: 'source-file',
});
const INDEPENDENT_CHANNELS = Object.freeze([SUPPLY_CHANNELS.OPERATOR, SUPPLY_CHANNELS.CI]);

/**
 * Environment variables a harness or a CI job sets to hand over an oracle.
 *
 * Neither can be written by the proposing agent through the task path: the
 * agent writes files, and the source file is the one it controls. This is the
 * same shape the repository already uses for out-of-band authority
 * (`HUQAN_HUMAN_SPONSOR_AUTHORITY` in human-sponsor-authority.js).
 *
 *   HUQAN_ACCEPTANCE_CHANNEL   operator | ci
 *   HUQAN_ACCEPTANCE_COMMAND   the acceptance command itself
 */
const ACCEPTANCE_ENV = Object.freeze({
  CHANNEL: 'HUQAN_ACCEPTANCE_CHANNEL',
  COMMAND: 'HUQAN_ACCEPTANCE_COMMAND',
});

// The journal already owns this vocabulary (lib/experience/contract.js), and the
// downstream readers -- canary.js, capability-trust.js -- compare against those
// exact strings. A private copy would publish values nothing recognises.
const ELIGIBILITY = LEARNING_ELIGIBILITY;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function repoRelative(path) {
  const cleaned = cleanString(path).replace(/\\/gu, '/');
  if (!cleaned || cleaned.startsWith('/') || /^[a-zA-Z]:/u.test(cleaned)) return false;
  if (cleaned.split('/').some((part) => !part || part === '.' || part === '..')) return false;
  return true;
}

/**
 * The sealed source hash of a failure record. Deterministic and order-stable:
 * the same record always hashes the same, so a task derived from it can be
 * pinned to exactly this evidence and a re-run cannot silently bind a
 * different record.
 *
 * Only the fields a candidate is derived from are covered. `recordedAt` is
 * deliberately excluded: it is a timestamp, not evidence, and including it
 * would make two identical observations hash differently.
 */
function sealedFailureHash(failure) {
  if (!isPlainObject(failure)) return null;
  // Every field the producer reads must be here. `action.paths` drives a
  // multi-file rename and `payload.content` drives create_file, so leaving
  // either out would let a swapped failure keep an older failure's hash and
  // inherit its eligibility. `recordedAt` stays out: it is when we looked, not
  // what we saw.
  const action = isPlainObject(failure.action) ? failure.action : {};
  const paths = Array.isArray(action.paths)
    ? action.paths.map(value => (typeof value === 'string' ? value : ''))
    : [];
  const payload = isPlainObject(failure.payload) ? failure.payload : {};
  const projection = {
    failureId: cleanString(failure.failureId),
    kind: cleanString(failure.kind),
    verificationStatus: cleanString(failure.verificationStatus),
    observed: typeof failure.observed === 'string' ? failure.observed : '',
    expected: typeof failure.expected === 'string' ? failure.expected : '',
    path: cleanString(action.path),
    paths,
    operation: cleanString(action.operation),
    content: typeof payload.content === 'string' ? payload.content : '',
  };
  if (!projection.failureId || !projection.kind) return null;
  return sha256(JSON.stringify(projection));
}

function refuse(code, detail = '') {
  return { ok: false, code, detail, eligibility: ELIGIBILITY.INELIGIBLE, evidence: null };
}

/**
 * Validate the externally supplied acceptance oracle.
 *
 * Independence is a property of the *channel*, never of a label: the source
 * file is written by whoever proposes the task, so a `suppliedBy: 'ci'` field
 * inside it proves nothing. Only an environment variable the harness or CI job
 * sets -- out of the agent's file-writing reach -- can declare the channel.
 *
 * The command itself may come from the source file (it is data the operator
 * can read), but its supplier may not. `source.oracle.suppliedBy` is accepted
 * only when it agrees with the verified channel; a mismatch is a refusal, not
 * a tie-break, because disagreeing declarations are ambiguous evidence.
 */
function resolveOracle(oracle, environment = process.env) {
  // Not `isPlainObject`: `process.env` is a special object whose prototype is
  // neither Object.prototype nor null, so that predicate would empty it and
  // every real invocation would look like "no channel declared".
  const env = environment && typeof environment === 'object' && !Array.isArray(environment)
    ? environment
    : {};
  const channel = cleanString(env[ACCEPTANCE_ENV.CHANNEL]).toLowerCase();
  if (!channel) return { code: CODES.ORACLE_SUPPLY_UNVERIFIED };
  if (!INDEPENDENT_CHANNELS.includes(channel)) return { code: CODES.ORACLE_NOT_INDEPENDENT };

  if (!isPlainObject(oracle)) return { code: CODES.ORACLE_MISSING };
  const command = cleanString(oracle.command);
  if (!command) return { code: CODES.ORACLE_MISSING };

  const declared = cleanString(oracle.suppliedBy).toLowerCase();
  if (declared && declared !== channel) return { code: CODES.ORACLE_SUPPLY_UNVERIFIED };

  // A harness may also carry the command itself, so a CI job can hand over a
  // complete oracle without writing a file at all. When it does, it wins: the
  // environment is the trusted side of this seam.
  const envCommand = cleanString(env[ACCEPTANCE_ENV.COMMAND]);
  if (envCommand && envCommand !== command) return { code: CODES.ORACLE_SUPPLY_UNVERIFIED };
  const effectiveCommand = envCommand || command;

  const timeoutMs = oracle.timeoutMs === undefined ? 120000 : oracle.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return { code: CODES.ORACLE_INVALID };
  return {
    test: Object.freeze({ command: effectiveCommand, timeoutMs }),
    evidence: Object.freeze({
      command: effectiveCommand, channel, commandHash: sha256(effectiveCommand),
    }),
  };
}

/**
 * Resolve whether a verified failure plus its declared learning source may
 * produce a learning-eligible candidate.
 *
 * `source` is the caller's declaration of what it believes the record is:
 *   { hash, outcomeStatus, allowedPaths, oracle }
 *
 * The hash must match the record's own sealed hash. That is what stops a
 * caller from pairing one failure's id with another failure's evidence.
 *
 * `environment` is the only place oracle independence can come from; it
 * defaults to `process.env` but is injected in tests so a run cannot inherit
 * an operator's channel by accident.
 */
function resolveLearningSource({ failure, source, environment = process.env } = {}) {
  if (!isPlainObject(failure) || !isPlainObject(source)) return refuse(CODES.INVALID_INPUT);

  if (cleanString(failure.kind) !== 'failure_record') return refuse(CODES.INVALID_INPUT);
  if (cleanString(failure.verificationStatus) !== 'verified') return refuse(CODES.FAILURE_NOT_VERIFIED);

  const sealed = sealedFailureHash(failure);
  if (!sealed) return refuse(CODES.SOURCE_HASH_MISSING);
  const declaredHash = cleanString(source.hash);
  if (!HASH_PATTERN.test(declaredHash)) return refuse(CODES.SOURCE_HASH_MISSING);
  if (declaredHash !== sealed) return refuse(CODES.SOURCE_HASH_MISMATCH);

  const observed = typeof failure.observed === 'string' ? failure.observed : '';
  const expected = typeof failure.expected === 'string' ? failure.expected : '';
  if (!observed || !expected) return refuse(CODES.OUTCOME_MISSING);
  if (observed === expected) return refuse(CODES.OUTCOME_EQUALS);

  const declaredPaths = source.allowedPaths;
  if (!Array.isArray(declaredPaths) || declaredPaths.length === 0) return refuse(CODES.ALLOWED_PATHS_MISSING);
  if (!declaredPaths.every(repoRelative) || new Set(declaredPaths).size !== declaredPaths.length) {
    return refuse(CODES.ALLOWED_PATHS_INVALID);
  }
  const failurePath = cleanString(failure.action && failure.action.path).replace(/\\/gu, '/');
  if (failurePath && !declaredPaths.includes(failurePath)) return refuse(CODES.PATH_NOT_ALLOWED);
  // A multi-file rename carries its targets in `action.paths` and has no
  // single `action.path`, so the check above would skip it entirely and hand
  // eligibility to targets the source never declared.
  const failurePaths = Array.isArray(failure.action && failure.action.paths)
    ? failure.action.paths
    : [];
  const undeclared = failurePaths
    .map(value => (typeof value === 'string' ? value.replace(/\\/gu, '/') : ''))
    .filter(value => !value || !declaredPaths.includes(value));
  if (undeclared.length > 0) return refuse(CODES.PATH_NOT_ALLOWED);

  const outcomeStatus = cleanString(source.outcomeStatus).toLowerCase();
  if (!['verified', 'failed', 'unknown'].includes(outcomeStatus)) return refuse(CODES.OUTCOME_MISSING);

  const oracle = resolveOracle(source.oracle, environment);
  if (oracle.code) return refuse(oracle.code);

  // A conflicting outcome is real evidence that must not be resolved here:
  // deciding which side is right is a human call, not a default.
  if (source.verificationConflicting === true) {
    return { ok: true, code: null, eligibility: ELIGIBILITY.NEEDS_REVIEW,
      evidence: { sourceHash: sealed, outcomeStatus, oracle: oracle.evidence } };
  }
  if (outcomeStatus === 'unknown') return refuse(CODES.OUTCOME_MISSING);

  const eligibility = outcomeStatus === 'verified'
    ? ELIGIBILITY.POSITIVE_PROCEDURE
    : ELIGIBILITY.NEGATIVE_EXAMPLE;

  return {
    ok: true,
    code: null,
    eligibility,
    evidence: {
      sourceHash: sealed,
      outcomeStatus,
      observedHash: sha256(observed),
      expectedHash: sha256(expected),
      allowedPaths: Object.freeze([...declaredPaths]),
      oracle: oracle.evidence,
    },
    test: oracle.test,
  };
}

/**
 * Attach the resolved acceptance evidence to a produced task. Returns a new
 * task; the input is never mutated.
 *
 * `test` is the field `cli-coder` and `learned-candidate` already require for
 * a learning arm, so this is the seam that lets a verified failure reach one.
 * `learningSource` is the sealed record the candidate binds to, so a later
 * promotion can prove which evidence it learned from.
 *
 * Only an eligible resolution may reach here; a non-eligible one has no `test`
 * and attaching nothing is the correct outcome, not an error.
 */
function attachLearningSource(task, resolved) {
  if (!isPlainObject(task)) return { ok: false, code: CODES.INVALID_INPUT, task: null };
  if (!isPlainObject(resolved) || resolved.ok !== true) {
    return { ok: false, code: CODES.INVALID_INPUT, task: null };
  }
  if (resolved.eligibility !== ELIGIBILITY.POSITIVE_PROCEDURE
    && resolved.eligibility !== ELIGIBILITY.NEGATIVE_EXAMPLE) {
    return { ok: true, code: null, task: { ...task }, attached: false };
  }
  return {
    ok: true,
    code: null,
    attached: true,
    task: {
      ...task,
      test: { command: resolved.test.command, timeoutMs: resolved.test.timeoutMs },
      learningSource: {
        eligibility: resolved.eligibility,
        sourceHash: resolved.evidence.sourceHash,
        outcomeStatus: resolved.evidence.outcomeStatus,
        observedHash: resolved.evidence.observedHash,
        expectedHash: resolved.evidence.expectedHash,
        allowedPaths: [...resolved.evidence.allowedPaths],
        oracle: { ...resolved.evidence.oracle },
      },
    },
  };
}

module.exports = {
  CODES,
  ELIGIBILITY,
  SUPPLY_CHANNELS,
  ACCEPTANCE_ENV,
  sealedFailureHash,
  resolveLearningSource,
  attachLearningSource,
};
