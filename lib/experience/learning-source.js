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
const { verifyAcceptanceAttestation } = require('./acceptance-attestation');

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
  WORKSPACE_MISSING: 'workspace_missing',
  WORKSPACE_MISMATCH: 'workspace_mismatch',
});

/**
 * Which *channel* may hand this process an acceptance oracle.
 *
 * A label inside the source file cannot establish independence: `--source`
 * reads a caller-selected file, so the agent that proposes the task can write
 * `suppliedBy: 'ci'` into it and grade its own work. #4624 widened the finding:
 * an environment variable is no better, because the proposing agent's launcher
 * sets its own environment. Independence is a property of *who signed* the
 * oracle, so it comes from a decision envelope the approval authority minted
 * (`./acceptance-attestation.js`), verified against the pinned key. These names
 * survive only to describe the two channels an attestation may claim and to
 * keep `source-file` refusable by name.
 */
const SUPPLY_CHANNELS = Object.freeze({
  OPERATOR: 'operator',
  CI: 'ci',
  SOURCE_FILE: 'source-file',
});
const INDEPENDENT_CHANNELS = Object.freeze([SUPPLY_CHANNELS.OPERATOR, SUPPLY_CHANNELS.CI]);

/**
 * The environment key that names the attestation file.
 *
 * This variable is *not* proof of anything -- a proposer can set it, and #4624
 * exists because an earlier version treated its sibling channel variable as
 * proof. It only points at where the signed envelope can be read. The proof is
 * the envelope's signature against the pinned authority key; an unsigned file
 * at this path, or no pinned key at all, refuses. Naming the file through the
 * environment keeps the "harness hands over the oracle" shape while moving the
 * trust to the signature.
 *
 *   HUQAN_ACCEPTANCE_ATTESTATION   path to the signed acceptance attestation
 *
 * `HUQAN_ACCEPTANCE_CHANNEL` and `HUQAN_ACCEPTANCE_COMMAND` were the old inputs
 * and are no longer read at all (#4624). A launcher still setting them grants
 * nothing: the oracle check refuses for want of a verified attestation, which is
 * the correct outcome for a self-declared channel.
 */
const ACCEPTANCE_ENV = Object.freeze({
  ATTESTATION: 'HUQAN_ACCEPTANCE_ATTESTATION',
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
    // The workspace is inside the hash because a grant is scoped to one. Left
    // out, a workspace-B record could be relabelled as workspace A and keep
    // its hash, so an approval for A would cover evidence it never saw.
    workspaceId: cleanString(failure.workspaceId),
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
 * Validate the externally supplied acceptance oracle against a signed attestation.
 *
 * Independence is a property of the *signer*, never of a label and never of an
 * environment variable: the source file is written by whoever proposes the
 * task, and the environment is written by whoever launches the process. #4624
 * is exactly the second half of that sentence. Only a decision envelope the
 * approval authority minted -- verified here against the pinned key, over the
 * exact source hash, command and path set -- can declare the channel.
 *
 * The command itself may come from the source file (it is data the operator can
 * read), but its *supplier* may not. `source.oracle.suppliedBy` is accepted only
 * when it agrees with the signed channel; a mismatch is a refusal, not a
 * tie-break, because disagreeing declarations are ambiguous evidence.
 *
 * `attestation` is the parsed signed envelope the launcher pointed at. It is
 * passed in rather than read here: this module stays pure, and the file read
 * (and the pinned-key resolution) belong to the CLI boundary.
 */
function resolveOracle(oracle, attestation, context = {}) {
  if (!isPlainObject(oracle)) return { code: CODES.ORACLE_MISSING };
  const command = cleanString(oracle.command);
  if (!command) return { code: CODES.ORACLE_MISSING };

  const verified = verifyAcceptanceAttestation(attestation, {
    sourceHash: context.sourceHash,
    command,
    allowedPaths: context.allowedPaths,
    trustedKey: context.trustedKey,
    workspaceId: context.workspaceId,
    now: context.now,
  });
  if (!verified.ok) {
    // The attestation's own refusal is precise (signature_invalid,
    // binding_mismatch, expired, ...). The public code stays
    // `oracle_supply_unverified` -- "no independent supplier" is the fact a
    // refusal is about -- and the precise reason travels in `detail` so an
    // operator can tell a forgery from an expired grant without reading code.
    return { code: CODES.ORACLE_SUPPLY_UNVERIFIED, detail: verified.detail || verified.code };
  }
  if (!INDEPENDENT_CHANNELS.includes(verified.channel)) {
    return { code: CODES.ORACLE_NOT_INDEPENDENT };
  }

  const declared = cleanString(oracle.suppliedBy).toLowerCase();
  if (declared && declared !== verified.channel) return { code: CODES.ORACLE_SUPPLY_UNVERIFIED };

  const timeoutMs = oracle.timeoutMs === undefined ? 120000 : oracle.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) return { code: CODES.ORACLE_INVALID };
  return {
    test: Object.freeze({ command, timeoutMs }),
    evidence: Object.freeze({
      command, channel: verified.channel, commandHash: sha256(command),
      approvalId: verified.approvalId, actionHash: verified.actionHash,
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
 * `attestation` is the parsed signed envelope from the approval authority, and
 * `trustedKey` the pinned signing key it must verify against. #4624: these
 * replace the environment lookup, because an environment variable is written by
 * whoever launches the process and proves nothing about who supplied the
 * oracle. With no `trustedKey` there is no trust anchor and the resolution
 * refuses; that is deliberate, so a caller cannot opt into independence by
 * simply not configuring an authority.
 *
 * `now` is injected so the tests can pin the clock; production passes the wall
 * clock through `Date.now`.
 */
function resolveLearningSource({ failure, source, attestation, trustedKey, workspaceId, now = Date.now() } = {}) {
  if (!isPlainObject(failure) || !isPlainObject(source)) return refuse(CODES.INVALID_INPUT);

  if (cleanString(failure.kind) !== 'failure_record') return refuse(CODES.INVALID_INPUT);
  if (cleanString(failure.verificationStatus) !== 'verified') return refuse(CODES.FAILURE_NOT_VERIFIED);

  // The workspace comes from the failure record, never from the attestation.
  // Reading it out of the signed envelope would compare the envelope with
  // itself and let a grant for workspace A attach learning eligibility to a
  // workspace-B failure that happened to match on the rest of the evidence.
  // `workspaceId` may be passed explicitly (a producer that knows it better
  // than the record), but it must agree with the record when both exist.
  const recordWorkspace = cleanString(failure.workspaceId);
  const declaredWorkspace = cleanString(workspaceId);
  if (recordWorkspace && declaredWorkspace && recordWorkspace !== declaredWorkspace) {
    return refuse(CODES.WORKSPACE_MISMATCH);
  }
  const boundWorkspace = declaredWorkspace || recordWorkspace;
  if (!boundWorkspace) return refuse(CODES.WORKSPACE_MISSING);

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

  const oracle = resolveOracle(source.oracle, attestation, {
    sourceHash: sealed, allowedPaths: declaredPaths, trustedKey, workspaceId: boundWorkspace, now,
  });
  if (oracle.code) return refuse(oracle.code, oracle.detail || '');

  // A conflicting outcome is real evidence that must not be resolved here:
  // deciding which side is right is a human call, not a default.
  if (source.verificationConflicting === true) {
    return { ok: true, code: null, eligibility: ELIGIBILITY.NEEDS_REVIEW,
      evidence: { sourceHash: sealed, workspaceId: boundWorkspace, outcomeStatus, oracle: oracle.evidence } };
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
      workspaceId: boundWorkspace,
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
