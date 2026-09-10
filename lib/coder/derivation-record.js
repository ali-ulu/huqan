'use strict';

/**
 * HUQAN Coder — derivation record.
 *
 * The coder writes code without a language model: a task names a transform
 * from lib/deterministic-task-runner.js, the transform runs over the declared
 * input files, and a patch comes out. Because nothing in that path is
 * probabilistic, the result is not merely *verifiable after the fact* — it is
 * *derivable*: the same inputs and the same transform version always produce
 * the same patch.
 *
 * This module turns that fact into a record that can be checked by someone who
 * was not present when it ran.
 *
 * Two hashes, on purpose:
 *
 *   derivationHash  covers inputs + transform + patch, and NOTHING else. It is
 *                   the reproducibility claim: re-run the same task against the
 *                   same file contents and this hash must come out identical.
 *                   No timestamp, no run id, no gate verdict.
 *
 *   recordHash      covers the whole record, timestamp and gate verdict
 *                   included. It is the audit identity of one specific run.
 *
 * Keeping them apart is the point. A single hash over everything could never
 * answer "was this the same derivation?", because the clock alone would change
 * it on every run, and reproducibility is the only claim this tool has that a
 * model-driven coder cannot make.
 */

const { stableStringify, sha256Hex } = require('../receipt/canonical-receipt');

const DERIVATION_SCHEMA_VERSION = 'huqan-derivation-v1';

/**
 * Transform catalog version. Bump this when any transform in
 * lib/deterministic-task-runner.js changes what it emits for an input it
 * already accepted; a derivationHash is only meaningful relative to it.
 */
const TRANSFORM_CATALOG_VERSION = '1.0.0';

const DERIVATION_OUTCOMES = Object.freeze({
  APPLIED: 'applied',
  DRY_RUN: 'dry_run',
  REFUSED: 'refused',
});

const EMPTY_FILE_DIGEST = 'absent';

function digestOrAbsent(content) {
  if (typeof content !== 'string') return EMPTY_FILE_DIGEST;
  return sha256Hex(content);
}

function byPath(left, right) {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

/**
 * Input fingerprint: every path the task declared as readable, with the digest
 * of what was actually there. A path the task listed but that did not exist is
 * recorded as absent rather than skipped — "the file was missing" is part of
 * what the transform saw, and dropping it would let two different situations
 * produce the same hash.
 */
function fingerprintInputs(allowedPaths, files) {
  const paths = Array.isArray(allowedPaths) ? allowedPaths : [];
  const source = files && typeof files === 'object' ? files : {};
  return paths
    .map(path => ({ path: String(path), sha256: digestOrAbsent(source[path]) }))
    .sort(byPath);
}

function fingerprintPatch(patch) {
  const changes = Array.isArray(patch) ? patch : [];
  return changes
    .map(change => ({
      path: String(change.path),
      beforeSha256: digestOrAbsent(change.before),
      afterSha256: digestOrAbsent(change.after),
    }))
    .sort(byPath);
}

/**
 * The reproducibility core. Deliberately excludes the gate verdict: whether an
 * operator's policy allowed the patch to land has no bearing on whether the
 * transform produces that patch, and folding policy into this hash would make
 * a derivation look different on a machine with different settings.
 */
function buildDerivationCore(input) {
  return {
    schemaVersion: DERIVATION_SCHEMA_VERSION,
    catalogVersion: String(input.catalogVersion || TRANSFORM_CATALOG_VERSION),
    operationType: String(input.operationType || ''),
    inputs: fingerprintInputs(input.allowedPaths, input.inputFiles),
    patch: fingerprintPatch(input.patch),
    runnerStatus: String(input.runnerStatus || ''),
    runnerReason: input.runnerReason === null || input.runnerReason === undefined
      ? ''
      : String(input.runnerReason),
  };
}

function hashDerivationCore(core) {
  return sha256Hex(stableStringify(core));
}

function normalizeGate(gate) {
  const raw = gate && typeof gate === 'object' ? gate : {};
  const risk = raw.risk && typeof raw.risk === 'object' ? raw.risk : {};
  return {
    decision: String(raw.decision || ''),
    reason: String(raw.reason || ''),
    riskLevel: String(risk.level || ''),
    policyVersion: String((raw.metadata && raw.metadata.policyVersion) || ''),
  };
}

/**
 * Build the full record for one run. `outcome` is passed in rather than
 * inferred from the gate verdict, because the caller is the only party that
 * knows whether the write actually happened — inferring it here would mean
 * this module reporting on an action it did not witness.
 */
function buildDerivationRecord(input) {
  if (!input || typeof input !== 'object') {
    throw new TypeError('buildDerivationRecord requires an input object');
  }
  if (!Object.values(DERIVATION_OUTCOMES).includes(input.outcome)) {
    throw new TypeError(`buildDerivationRecord requires a known outcome (got: ${JSON.stringify(input.outcome)})`);
  }

  const core = buildDerivationCore(input);
  const derivationHash = hashDerivationCore(core);
  const record = {
    ...core,
    derivationHash,
    taskId: String(input.taskId || ''),
    workspaceId: String(input.workspaceId || 'default'),
    outcome: input.outcome,
    gate: normalizeGate(input.gate),
    createdAt: String(input.createdAt || ''),
  };
  return { ...record, recordHash: sha256Hex(stableStringify(record)) };
}

/**
 * Re-hash a record's derivation core and compare. Answers "is this the same
 * derivation as that one?" without re-running the transform, and catches a
 * record whose stored derivationHash no longer matches its own contents.
 */
function verifyDerivationHash(record) {
  if (!record || typeof record !== 'object') {
    return { ok: false, reason: 'RECORD_NOT_OBJECT' };
  }
  const core = {
    schemaVersion: record.schemaVersion,
    catalogVersion: record.catalogVersion,
    operationType: record.operationType,
    inputs: record.inputs,
    patch: record.patch,
    runnerStatus: record.runnerStatus,
    runnerReason: record.runnerReason,
  };
  const recomputed = hashDerivationCore(core);
  if (recomputed !== record.derivationHash) {
    return { ok: false, reason: 'DERIVATION_HASH_MISMATCH', expected: recomputed, found: record.derivationHash };
  }
  return { ok: true, derivationHash: recomputed };
}

module.exports = {
  DERIVATION_SCHEMA_VERSION,
  DERIVATION_OUTCOMES,
  TRANSFORM_CATALOG_VERSION,
  buildDerivationCore,
  buildDerivationRecord,
  hashDerivationCore,
  verifyDerivationHash,
};
