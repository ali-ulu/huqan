/**
 * Durable Trust Evidence & Receipt Ledger — #941 first runtime slice.
 *
 * This module deliberately uses Graph.runMutationOnce() as the existing
 * durability authority. It does not create a second SQLite table, signer,
 * receipt family, or status vocabulary. The caller supplies bounded references
 * only; raw credentials and unrestricted request content are rejected.
 */

const {
  stableStringify,
  sha256Hex,
} = require('./receipt/canonical-receipt');
const {
  GENESIS_PREVIOUS_HASH,
  validateReceiptChain,
} = require('./receipt/receipt-chain');
const { CANONICAL_VERDICTS } = require('./verdict/action-verdict');

const TRUST_EVIDENCE_SCHEMA_VERSION = 'huqan-trust-evidence-v1';
const TRUST_EVIDENCE_RECEIPT_KIND = 'trust_evidence';
const JUSTIFICATION_VERSION = 'huqan-decision-justification-v1';
const MAX_REFERENCE_LENGTH = 512;
const MAX_REASON_LENGTH = 1024;
const MAX_METADATA_BYTES = 4096;
const MAX_REFS = 32;
const MAX_DIMENSIONS = 16;
const MAX_THRESHOLDS = 16;
const MAX_JUSTIFICATION_UNKNOWN_LENGTH = 256;
const MAX_THRESHOLD_KEY_LENGTH = 64;

const ALLOWED_EVENT_FIELDS = Object.freeze([
  'workspaceId',
  'operationId',
  'decision',
  'reason',
  'actionFingerprint',
  'identityRef',
  'identityHash',
  'authorityRef',
  'delegationRef',
  'policyVersion',
  'firewallVersion',
  'connectorRef',
  'resourceRef',
  'approvalRef',
  'executionOutcome',
  'sourceRefs',
  'provenanceRefs',
  'createdAt',
  'justification',
  'metadata',
]);

const FORBIDDEN_EVENT_KEYS = Object.freeze([
  'prompt',
  'input',
  'rawInput',
  'content',
  'requestBody',
  'token',
  'accessToken',
  'secret',
  'credential',
  'password',
  'privateKey',
]);

function assertPlainObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be a plain object`);
  }
}

function boundedString(value, field, { required = false, max = MAX_REFERENCE_LENGTH } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new TypeError(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`);
  const normalized = value.trim();
  if (required && !normalized) throw new TypeError(`${field} is required`);
  if (normalized.length > max) throw new TypeError(`${field} exceeds bounded length`);
  return normalized;
}

function boundedRefs(value, field) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_REFS) {
    throw new TypeError(`${field} must be a bounded array`);
  }
  return value.map((item, index) => boundedString(item, `${field}[${index}]`));
}

function cloneJson(value, field) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw new TypeError(`${field} must be JSON-serializable`);
  }
}

function boundedScalar(value, field) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized.length > MAX_REFERENCE_LENGTH) throw new TypeError(`${field} exceeds bounded length`);
    return normalized;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new TypeError(`${field} must be finite`);
    return value;
  }
  throw new TypeError(`${field} must be a bounded scalar`);
}

/**
 * #2505 B: the decision justification a receipt carries next to the decision:
 * the score, the dimensions and inputs it came from, the thresholds that
 * applied, the reason, and an explicit unknown state. Unknown is never 0: a
 * missing computation arrives as score null with a reason, never as a
 * harmless zero. Absent entirely when the caller records none, so unsigned
 * historical payloads keep their exact canonical shape.
 */
function normalizeJustification(value) {
  if (value === undefined || value === null) return null;
  assertPlainObject(value, 'justification');

  if (value.version !== undefined && value.version !== JUSTIFICATION_VERSION) {
    throw new TypeError(`justification version must be ${JUSTIFICATION_VERSION}`);
  }

  const scored = value.score !== undefined && value.score !== null;
  let score = null;
  if (scored) {
    if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > 100) {
      throw new TypeError('justification score must be a number between 0 and 100, or null when unknown');
    }
    score = value.score;
  }
  const unknown = boundedString(value.unknown, 'justification.unknown', { max: MAX_JUSTIFICATION_UNKNOWN_LENGTH });
  if (!scored && !unknown) throw new TypeError('justification without a score requires an unknown reason');
  if (scored && unknown) throw new TypeError('justification unknown must be empty when scored');

  const rawDimensions = value.dimensions === undefined ? [] : value.dimensions;
  if (!Array.isArray(rawDimensions) || rawDimensions.length > MAX_DIMENSIONS) {
    throw new TypeError('justification dimensions must be a bounded array');
  }
  const dimensions = rawDimensions.map((entry, index) => {
    assertPlainObject(entry, `justification.dimensions[${index}]`);
    return Object.freeze({
      dimension: boundedString(entry.dimension, `justification.dimensions[${index}].dimension`, { required: true, max: MAX_THRESHOLD_KEY_LENGTH }),
      value: boundedScalar(entry.value, `justification.dimensions[${index}].value`),
      source: boundedString(entry.source, `justification.dimensions[${index}].source`),
    });
  });

  const rawThresholds = value.thresholds === undefined ? {} : value.thresholds;
  assertPlainObject(rawThresholds, 'justification.thresholds');
  const thresholdKeys = Object.keys(rawThresholds);
  if (thresholdKeys.length > MAX_THRESHOLDS) throw new TypeError('justification thresholds must be bounded');
  const thresholds = {};
  for (const key of thresholdKeys) {
    if (!key.trim() || key.length > MAX_THRESHOLD_KEY_LENGTH) throw new TypeError('justification threshold names must be bounded');
    if (FORBIDDEN_EVENT_KEYS.includes(key)) throw new TypeError(`forbidden trust evidence field: justification.thresholds.${key}`);
    thresholds[key] = boundedScalar(rawThresholds[key], `justification.thresholds.${key}`);
  }

  return Object.freeze({
    version: JUSTIFICATION_VERSION,
    score,
    unknown,
    dimensions: Object.freeze(dimensions),
    thresholds: Object.freeze(thresholds),
  });
}

function assertNoForbiddenFields(event) {
  const keys = Object.keys(event);
  for (const key of keys) {
    if (FORBIDDEN_EVENT_KEYS.includes(key)) {
      throw new TypeError(`forbidden trust evidence field: ${key}`);
    }
    if (!ALLOWED_EVENT_FIELDS.includes(key)) {
      throw new TypeError(`unknown trust evidence field: ${key}`);
    }
  }
}

function assertSafeMetadata(value, path = 'metadata', depth = 0) {
  if (depth > 4) throw new TypeError(`${path} exceeds nested depth`);
  if (Array.isArray(value)) {
    if (value.length > MAX_REFS) throw new TypeError(`${path} exceeds bounded array length`);
    value.forEach((item, index) => assertSafeMetadata(item, `${path}[${index}]`, depth + 1));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_EVENT_KEYS.includes(key)) {
      throw new TypeError(`forbidden trust evidence field: ${path}.${key}`);
    }
    assertSafeMetadata(child, `${path}.${key}`, depth + 1);
  }
}

function buildTrustEvidencePayload(event) {
  assertPlainObject(event, 'trust evidence event');
  assertNoForbiddenFields(event);

  const workspaceId = boundedString(event.workspaceId, 'workspaceId', { required: true });
  const operationId = boundedString(event.operationId, 'operationId', { required: true });
  const decision = boundedString(event.decision, 'decision', { required: true });
  if (!CANONICAL_VERDICTS.includes(decision)) {
    throw new TypeError(`decision must be a canonical verdict: ${decision}`);
  }

  const reason = boundedString(event.reason, 'reason', { max: MAX_REASON_LENGTH });
  const actionFingerprint = boundedString(event.actionFingerprint, 'actionFingerprint', { required: true });
  const createdAt = boundedString(event.createdAt, 'createdAt', { required: true });
  const justification = normalizeJustification(event.justification);
  const metadata = event.metadata === undefined ? {} : cloneJson(event.metadata, 'metadata');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new TypeError('metadata must be a JSON object');
  }
  assertSafeMetadata(metadata);
  if (Buffer.byteLength(stableStringify(metadata), 'utf8') > MAX_METADATA_BYTES) {
    throw new TypeError('metadata exceeds bounded size');
  }

  const payload = {
    schemaVersion: TRUST_EVIDENCE_SCHEMA_VERSION,
    receiptKind: TRUST_EVIDENCE_RECEIPT_KIND,
    receiptId: '',
    eventId: '',
    workspaceId,
    operationId,
    decision,
    verdict: decision,
    reason,
    actionFingerprint,
    identityRef: boundedString(event.identityRef, 'identityRef'),
    identityHash: boundedString(event.identityHash, 'identityHash'),
    authorityRef: boundedString(event.authorityRef, 'authorityRef'),
    delegationRef: boundedString(event.delegationRef, 'delegationRef'),
    policyVersion: boundedString(event.policyVersion, 'policyVersion'),
    firewallVersion: boundedString(event.firewallVersion, 'firewallVersion'),
    connectorRef: boundedString(event.connectorRef, 'connectorRef'),
    resourceRef: boundedString(event.resourceRef, 'resourceRef'),
    approvalRef: boundedString(event.approvalRef, 'approvalRef'),
    executionOutcome: boundedString(event.executionOutcome, 'executionOutcome'),
    sourceRefs: boundedRefs(event.sourceRefs, 'sourceRefs'),
    provenanceRefs: boundedRefs(event.provenanceRefs, 'provenanceRefs'),
    createdAt,
    // Present only when recorded: historical payloads keep their exact
    // canonical shape, and the chain hash of every unsigned receipt is
    // exactly as it was.
    ...(justification ? { justification } : {}),
    metadata,
  };

  const eventDigest = sha256Hex(stableStringify({ ...payload, receiptId: '', eventId: '' }));
  payload.eventId = `trust-event:${eventDigest}`;
  payload.receiptId = `trust-receipt:${eventDigest}`;
  return Object.freeze(payload);
}

function toChainRecord(storedReceipt) {
  if (!storedReceipt || typeof storedReceipt !== 'object') return null;
  if (!storedReceipt.canonicalPayload || typeof storedReceipt.canonicalPayload !== 'object') return null;
  return {
    ...storedReceipt.canonicalPayload,
    previousReceiptHash: storedReceipt.previousReceiptHash,
    receiptHash: storedReceipt.receiptHash,
  };
}

function verifyTrustEvidenceReceipt(storedReceipt, opts = {}) {
  const record = toChainRecord(storedReceipt);
  if (!record || !record.receiptHash || !record.previousReceiptHash) {
    return Object.freeze({ valid: false, reason: 'receipt_structure_invalid', receipt: storedReceipt || null });
  }

  const expectedPrevious = opts.expectedPreviousReceiptHash;
  if (expectedPrevious && record.previousReceiptHash !== expectedPrevious) {
    return Object.freeze({ valid: false, reason: 'chain_link_broken', receipt: storedReceipt });
  }

  // A single-record read can always prove self-integrity. Parent linkage is
  // proved when the bounded caller supplies the expected predecessor hash.
  const self = validateReceiptChain([record], {
    genesisPreviousHash: record.previousReceiptHash,
  });
  if (!self.valid) {
    return Object.freeze({ valid: false, reason: self.reason, receipt: storedReceipt });
  }

  return Object.freeze({
    valid: true,
    reason: null,
    selfIntegrity: true,
    chainLinkage: Boolean(expectedPrevious || record.previousReceiptHash === GENESIS_PREVIOUS_HASH),
    receipt: storedReceipt,
  });
}

function createTrustEvidenceLedger({ graph }) {
  if (!graph || typeof graph.runMutationOnce !== 'function') {
    throw new Error('graph with runMutationOnce is required');
  }
  if (typeof graph.getCommittedMutationReceiptByOperation !== 'function') {
    throw new Error('graph mutation receipt read API is required');
  }
  if (typeof graph.getCommittedMutationReceiptById !== 'function') {
    throw new Error('graph mutation receipt id read API is required');
  }

  function append({ operationId, event, mutate }) {
    if (typeof mutate !== 'function') throw new TypeError('ledger mutate callback is required');
    const payload = buildTrustEvidencePayload({ ...event, operationId });
    const result = graph.runMutationOnce(operationId, mutate, {
      buildCanonicalReceipt: () => payload,
    });
    const verified = verifyTrustEvidenceReceipt(result.receipt);
    if (!verified.valid) {
      const error = new Error(`trust evidence receipt failed verification: ${verified.reason}`);
      error.code = 'TRUST_EVIDENCE_VERIFICATION_FAILED';
      throw error;
    }
    return Object.freeze({
      replayed: Boolean(result.replayed),
      result: result.result,
      receipt: result.receipt,
      verification: verified,
    });
  }

  function readByOperation(operationId) {
    const receipt = graph.getCommittedMutationReceiptByOperation(operationId);
    return receipt ? Object.freeze({ receipt, verification: verifyTrustEvidenceReceipt(receipt) }) : null;
  }

  function readByReceiptId(receiptId) {
    const receipt = graph.getCommittedMutationReceiptById(receiptId);
    return receipt ? Object.freeze({ receipt, verification: verifyTrustEvidenceReceipt(receipt) }) : null;
  }

  return Object.freeze({
    append,
    readByOperation,
    readByReceiptId,
  });
}

module.exports = Object.freeze({
  TRUST_EVIDENCE_SCHEMA_VERSION,
  TRUST_EVIDENCE_RECEIPT_KIND,
  JUSTIFICATION_VERSION,
  ALLOWED_EVENT_FIELDS,
  FORBIDDEN_EVENT_KEYS,
  buildTrustEvidencePayload,
  normalizeJustification,
  verifyTrustEvidenceReceipt,
  createTrustEvidenceLedger,
});

