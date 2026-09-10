'use strict';

/**
 * HUQAN Coder — independent re-derivation.
 *
 * A derivation record says: "this patch is what transform T produces from these
 * inputs." That is a claim, and until somebody re-runs T it is only the claim of
 * the process that made the patch. This module is the party that re-runs it.
 *
 * Three separate questions, answered in order, because they fail for different
 * reasons and collapsing them would hide which one went wrong:
 *
 *   1. Is the record internally consistent?  (has it been edited since it was written)
 *   2. Does the transform, re-run on the BASE tree, produce the same patch?
 *   3. Does the HEAD tree actually contain that patch's output?
 *
 * Question 3 is the one with teeth. A record that passes 1 and 2 still proves
 * nothing about the code under review: someone can derive a patch honestly and
 * then commit something else. Comparing the derived output against what is
 * really in the tree is what turns the record into evidence about the diff.
 *
 * Readers are injected as `(path) => string | null` rather than taken as two
 * directory paths, so a caller can read the base side straight out of git
 * (`git show <base>:<path>`) without a second checkout.
 */

const nodeFs = require('node:fs');
const nodePath = require('node:path');

const { STATUS, runTask } = require('../deterministic-task-runner');
const { resolvePathWithinRoot } = require('../path-safety');
const {
  DERIVATION_SCHEMA_VERSION,
  buildDerivationCore,
  hashDerivationCore,
  verifyDerivationHash,
} = require('./derivation-record');
const { sha256Hex } = require('../receipt/canonical-receipt');

const VERIFY_REASONS = Object.freeze({
  RECORD_NOT_OBJECT: 'RECORD_NOT_OBJECT',
  RECORD_TAMPERED: 'RECORD_TAMPERED',
  SCHEMA_NOT_REDERIVABLE: 'SCHEMA_NOT_REDERIVABLE',
  NOT_A_COMPLETED_DERIVATION: 'NOT_A_COMPLETED_DERIVATION',
  BASE_INPUT_MISMATCH: 'BASE_INPUT_MISMATCH',
  RERUN_FAILED: 'RERUN_FAILED',
  DERIVATION_MISMATCH: 'DERIVATION_MISMATCH',
  HEAD_MISMATCH: 'HEAD_MISMATCH',
});

const ABSENT = 'absent';

function digestOrAbsent(content) {
  return typeof content === 'string' ? sha256Hex(content) : ABSENT;
}

function failure(reason, detail, checks) {
  return { ok: false, reason, detail: detail || '', checks };
}

function readAll(paths, reader) {
  const files = {};
  for (const path of paths) {
    const content = reader(path);
    if (typeof content === 'string') files[path] = content;
  }
  return files;
}

/**
 * Verify one derivation record against a base tree and a head tree.
 *
 * `readBase(path)` returns the file as it was before the change; `readHead(path)`
 * as it is in the tree under review. Both return null (or undefined) for a file
 * that does not exist on that side.
 */
function verifyDerivation(options = {}) {
  const { record, readBase, readHead } = options;
  const checks = [];

  if (!record || typeof record !== 'object') {
    return failure(VERIFY_REASONS.RECORD_NOT_OBJECT, 'record is not an object', checks);
  }
  if (typeof readBase !== 'function' || typeof readHead !== 'function') {
    throw new TypeError('verifyDerivation requires readBase and readHead functions');
  }

  const integrity = verifyDerivationHash(record);
  if (!integrity.ok) {
    return failure(VERIFY_REASONS.RECORD_TAMPERED, integrity.reason, checks);
  }
  checks.push('record_integrity');

  // A v1 record carries no operation, so there is nothing to re-run. Saying so
  // is not the same as saying the derivation is wrong -- it is unverifiable by
  // this method, and reporting it as a failure of the code would be a lie about
  // which thing is missing.
  if (record.schemaVersion !== DERIVATION_SCHEMA_VERSION) {
    return failure(
      VERIFY_REASONS.SCHEMA_NOT_REDERIVABLE,
      `record schema ${record.schemaVersion} carries no operation to re-run; ${DERIVATION_SCHEMA_VERSION} does`,
      checks,
    );
  }
  if (record.runnerStatus !== STATUS.COMPLETED) {
    return failure(
      VERIFY_REASONS.NOT_A_COMPLETED_DERIVATION,
      `runnerStatus is ${record.runnerStatus}; only a completed derivation claims a patch`,
      checks,
    );
  }

  const allowedPaths = Array.isArray(record.allowedPaths) ? record.allowedPaths : [];
  const baseFiles = readAll(allowedPaths, readBase);

  // Does the base tree look like what the transform was run against? If not,
  // re-running would answer a different question than the record asked, and a
  // mismatch here is the honest report rather than a derivation failure.
  for (const declared of record.inputs || []) {
    const actual = digestOrAbsent(baseFiles[declared.path]);
    if (actual !== declared.sha256) {
      return failure(
        VERIFY_REASONS.BASE_INPUT_MISMATCH,
        `${declared.path}: record expected ${declared.sha256}, base tree has ${actual}`,
        checks,
      );
    }
  }
  checks.push('base_inputs');

  const rerun = runTask({
    id: record.taskId || 'rederivation',
    level: 'verify',
    allowedPaths,
    operation: record.operation,
    files: baseFiles,
  });
  if (rerun.status !== STATUS.COMPLETED) {
    return failure(VERIFY_REASONS.RERUN_FAILED, `${rerun.status}: ${rerun.reason}`, checks);
  }

  const rederivedHash = hashDerivationCore(buildDerivationCore({
    catalogVersion: record.catalogVersion,
    operationType: record.operationType,
    operation: record.operation,
    allowedPaths,
    inputFiles: baseFiles,
    patch: rerun.patch,
    runnerStatus: rerun.status,
    runnerReason: rerun.reason,
  }));
  if (rederivedHash !== record.derivationHash) {
    return failure(
      VERIFY_REASONS.DERIVATION_MISMATCH,
      `re-derivation produced ${rederivedHash}, record claims ${record.derivationHash}`,
      checks,
    );
  }
  checks.push('rederivation');

  // The check that says something about the diff rather than about the record.
  for (const change of rerun.patch) {
    const actual = digestOrAbsent(readHead(change.path));
    const expected = digestOrAbsent(change.after);
    if (actual !== expected) {
      return failure(
        VERIFY_REASONS.HEAD_MISMATCH,
        `${change.path}: tree under review does not contain the derived output`,
        checks,
      );
    }
  }
  checks.push('head_matches_derivation');

  return {
    ok: true,
    reason: null,
    detail: '',
    checks,
    derivationHash: rederivedHash,
    verifiedPaths: rerun.patch.map(change => change.path).sort(),
  };
}

/**
 * Reader over a directory tree, for the local case where both sides are on disk.
 *
 * Paths come out of a record, and a record is an input like any other: a
 * declared path of `../../somewhere` must not read outside the tree just
 * because a verifier was pointed at it. Containment is enforced here rather
 * than trusted, and an escaping path reads as absent, which fails the
 * comparison rather than silently succeeding on a foreign file.
 */
function directoryReader(root, fs = nodeFs) {
  return function read(relative) {
    let absolute;
    try {
      absolute = resolvePathWithinRoot(root, nodePath.resolve(root, String(relative || '')), { allowMissing: true });
    } catch {
      return null;
    }
    try {
      return fs.readFileSync(absolute, 'utf8');
    } catch {
      return null;
    }
  };
}

module.exports = {
  VERIFY_REASONS,
  directoryReader,
  verifyDerivation,
};
