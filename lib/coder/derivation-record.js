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

/**
 * v2 added `operation` and `allowedPaths` to the core. v3 normalizes line
 * endings before hashing file content -- see digestOrAbsent() below for why a
 * byte-exact digest could not survive a git checkout.
 *
 * v1 recorded only `operationType`, which was enough to tell two derivations
 * apart but not enough to *redo* one: nothing in the record said what the
 * transform had actually been asked to do. A record you cannot re-derive from
 * can only be checked against itself, and a check against itself is precisely
 * what this tool exists to avoid. With the operation and the declared paths in
 * the core, someone holding the record and the base tree can run the transform
 * again and see whether the same patch falls out.
 */
const DERIVATION_SCHEMA_VERSION = 'huqan-derivation-v3';

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

/**
 * Digest of a file's content with line endings normalized to LF.
 *
 * A deliberate narrowing, and worth being precise about what it gives up. Git
 * rewrites line endings on checkout according to per-platform configuration:
 * the same commit is CRLF in a Windows working tree and LF in the blob and on
 * a Linux runner. A byte-exact digest therefore certifies the checkout policy
 * of whoever ran the transform, and a record produced on Windows could never
 * verify against a git ref or in CI -- observed while wiring PR Guardian, not
 * theorised.
 *
 * So a record certifies content up to line-ending normalization, not exact
 * bytes. The cost is real: a change that only rewrites line endings verifies as
 * derived. That is the right trade, because those bytes are not the change's to
 * control -- git rewrites them -- and a claim that cannot survive a checkout is
 * not a useful claim.
 */
function digestOrAbsent(content) {
  if (typeof content !== 'string') return EMPTY_FILE_DIGEST;
  return sha256Hex(normalizeLineEndings(content));
}

function normalizeLineEndings(content) {
  return content.replace(/\r\n/gu, '\n');
}

/**
 * A plain, JSON-round-tripped copy of the operation. stableStringify sorts keys
 * on the way to the hash, so insertion order cannot change the digest; this
 * only strips anything that is not plain data (functions, prototypes, undefined
 * values) so a record cannot carry a payload that survives hashing but not
 * serialization.
 */
function normalizeOperation(operation) {
  if (!operation || typeof operation !== 'object') return {};
  return JSON.parse(JSON.stringify(operation));
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
    // The transform's own arguments. Stored verbatim rather than hashed: a
    // hash would prove the record had not been edited, but would not let
    // anyone re-run the transform, which is the check that actually matters.
    operation: normalizeOperation(input.operation),
    allowedPaths: (Array.isArray(input.allowedPaths) ? input.allowedPaths : []).map(String).slice().sort(),
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
    operation: record.operation,
    allowedPaths: record.allowedPaths,
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
