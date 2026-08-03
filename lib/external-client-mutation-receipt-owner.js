'use strict';

const {
  stableStringify,
  sha256Hex,
} = require('./receipt/canonical-receipt');
const {
  buildCanonicalReceiptPayloadV2,
} = require('./receipt/canonical-receipt-v2');
const { validateAxiomPackage } = require('./axiom-package-format');

const EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION =
  'external-client-mutation-receipt-owner-0-v1';
const EXTERNAL_CLIENT_MUTATION_KIND = 'external_client_candidate_claim_quarantine';
const EXTERNAL_CLIENT_RECEIPT_KIND = 'external_client_candidate_claim_admission';
const AUTHORITY_VERSION = 'external-client-authority-0-v1';
const REPLAY_KEY_PATTERN = /^external-client-authority-0-v1:[a-f0-9]{64}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS = Object.freeze({
  INPUT_INVALID: 'EXTERNAL_CLIENT_MUTATION_INPUT_INVALID',
  AUTHORITY_MISMATCH: 'EXTERNAL_CLIENT_MUTATION_AUTHORITY_MISMATCH',
  CANDIDATE_INVALID: 'EXTERNAL_CLIENT_MUTATION_CANDIDATE_INVALID',
  GRAPH_REQUIRED: 'EXTERNAL_CLIENT_MUTATION_GRAPH_REQUIRED',
  LOCAL_CANDIDATE_COLLISION: 'EXTERNAL_CLIENT_MUTATION_LOCAL_CANDIDATE_COLLISION',
  OUTCOME_UNKNOWN: 'EXTERNAL_CLIENT_MUTATION_OUTCOME_UNKNOWN',
});

const PACKAGE_KEYS = Object.freeze(['manifest', 'objects', 'index', 'metadata']);
const OBJECT_COLLECTIONS = Object.freeze([
  'provenanceRecords',
  'auditEvents',
  'candidateClaims',
  'conflictResults',
  'verificationResults',
  'trustReceipts',
  'causalChains',
  'simulationResults',
]);
const CONTEXT_KEYS = Object.freeze([
  'identity', 'workspaceId', 'packageId', 'packageHash', 'signature',
  'gateVersion', 'gateReceipt', 'authorityVersion', 'permission', 'replayKey',
  'authorityReceipt', 'authority',
]);
const CANDIDATE_KEYS = Object.freeze([
  'candidateId', 'claim', 'proposedEdge', 'provenance', 'conflict',
  'recommendation', 'status', 'workspaceId', 'createdAt', 'reviewedAt',
  'reviewedBy', 'warnings', 'canonical',
]);
const PROPOSED_EDGE_KEYS = Object.freeze([
  'from', 'to', 'relation', 'polarity', 'confidence', 'strength',
  'provenanceId', 'workspaceId',
]);
const PROVENANCE_KEYS = Object.freeze([
  'provenanceId', 'sourceRef', 'sourceTitle', 'sourceType', 'sourceSubType',
  'actor', 'timestamp', 'workspaceId', 'confidence', 'trustPolicyVersion',
]);
const RESULT_KEYS = Object.freeze([
  'outcome', 'operationId', 'workspaceId', 'packageId', 'packageHash',
  'externalCandidateId', 'localCandidateId', 'receiptId',
]);

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = Object.freeze({ ...details });
  throw error;
}

function isPlainObject(value) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch (_) {
    return false;
  }
}

function copyDeterministicJson(value, state = { depth: 0, nodes: 0, seen: new WeakSet() }) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('JSON number must be finite');
    return value;
  }
  if (!value || typeof value !== 'object') throw new TypeError('value is not JSON data');
  if (state.depth >= 32 || state.nodes >= 10000 || state.seen.has(value)) {
    throw new TypeError('JSON structure is unbounded or circular');
  }

  const array = Array.isArray(value);
  if (!array && !isPlainObject(value)) throw new TypeError('JSON object must be plain');
  const keys = Reflect.ownKeys(value);
  const output = array ? [] : {};
  state.seen.add(value);
  state.nodes += 1;
  try {
    if (array) {
      if (keys.length !== value.length + 1 || keys.some((key) => {
        if (key === 'length') return false;
        if (typeof key !== 'string') return true;
        const index = Number(key);
        return !Number.isInteger(index) || index < 0 || index >= value.length
          || String(index) !== key;
      })) {
        throw new TypeError('JSON array must be dense and unextended');
      }
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
          throw new TypeError('JSON array entry must be an enumerable data property');
        }
        output.push(copyDeterministicJson(descriptor.value, {
          ...state,
          depth: state.depth + 1,
        }));
      }
      return output;
    }

    for (const key of keys) {
      if (typeof key !== 'string' || key === '__proto__') {
        throw new TypeError('JSON object key is unsupported');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw new TypeError('JSON object entry must be an enumerable data property');
      }
      output[key] = copyDeterministicJson(descriptor.value, {
        ...state,
        depth: state.depth + 1,
      });
    }
    return output;
  } finally {
    state.seen.delete(value);
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotJson(value, code, message) {
  try {
    return deepFreeze(copyDeterministicJson(value));
  } catch (_) {
    fail(code, message);
  }
}

function assertExactKeys(value, allowed, code, message) {
  if (!isPlainObject(value)) fail(code, message);
  const allowedSet = new Set(allowed);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== allowed.length || keys.some((key) => (
    typeof key !== 'string' || !allowedSet.has(key)
  ))) {
    fail(code, message);
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(code, message, { field: key });
    }
  }
}

function assertAllowedKeys(value, allowed, code, message) {
  if (!isPlainObject(value)) fail(code, message);
  const allowedSet = new Set(allowed);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = typeof key === 'string'
      ? Object.getOwnPropertyDescriptor(value, key)
      : null;
    if (typeof key !== 'string' || !allowedSet.has(key)
      || !descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(code, message, { field: typeof key === 'string' ? key : 'symbol' });
    }
  }
}

function text(value, code, message, details = {}) {
  if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
    fail(code, message, details);
  }
  return value;
}

function canonicalInstant(value, code, message, details = {}) {
  const normalized = text(value, code, message, details);
  const milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== normalized) {
    fail(code, message, details);
  }
  return normalized;
}

function snapshotPackage(input) {
  const pkg = snapshotJson(
    input,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.INPUT_INVALID,
    'external client package must be bounded deterministic JSON',
  );
  assertExactKeys(
    pkg,
    PACKAGE_KEYS,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.INPUT_INVALID,
    'external client package top-level shape is invalid',
  );
  const validation = validateAxiomPackage(pkg, { allowExtensions: false });
  if (!validation.ok || validation.warnings.length > 0) {
    fail(
      EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.INPUT_INVALID,
      'external client package validation failed',
      { errors: validation.errors.length, warnings: validation.warnings.length },
    );
  }
  return pkg;
}

function snapshotContext(input) {
  const context = snapshotJson(
    input,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'external client authority context must be bounded deterministic JSON',
  );
  assertExactKeys(
    context,
    CONTEXT_KEYS,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'external client authority context shape is invalid',
  );
  assertAllowedKeys(
    context.identity,
    ['subject', 'kind'],
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'verified identity is invalid',
  );
  const subject = text(
    context.identity.subject,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'verified identity subject is required',
  );
  const kind = text(
    context.identity.kind,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'verified identity kind is required',
  );
  const workspaceId = text(
    context.workspaceId,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'authoritative workspace is required',
  );
  const packageId = text(
    context.packageId,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'authoritative package ID is required',
  );
  if (typeof context.packageHash !== 'string' || !HASH_PATTERN.test(context.packageHash)) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'authoritative package hash is invalid');
  }
  if (context.authorityVersion !== AUTHORITY_VERSION || context.permission !== 'package:admit'
    || typeof context.replayKey !== 'string' || !REPLAY_KEY_PATTERN.test(context.replayKey)) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'authority version, permission or replay key is invalid');
  }
  if (!Number.isFinite(context.authority?.reservedAt) || context.authority.reservedAt < 0) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'trusted reservation time is invalid');
  }
  const authority = context.authority;
  if (!isPlainObject(authority)
    || authority.authorityVersion !== AUTHORITY_VERSION
    || authority.permission !== context.permission
    || authority.workspaceId !== workspaceId
    || authority.packageId !== packageId
    || authority.packageHash !== context.packageHash
    || authority.replayKey !== context.replayKey
    || authority.identity?.subject !== subject
    || authority.identity?.kind !== kind) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'authority result does not match SDK context');
  }
  const trustedKeyId = text(
    authority.trustedKeyId,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH,
    'trusted key ID is required',
  );
  if (context.signature?.keyId !== trustedKeyId || context.signature?.verified !== true) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'verified signature does not match authority');
  }
  return Object.freeze({
    context,
    subject,
    kind,
    workspaceId,
    packageId,
    packageHash: context.packageHash,
    replayKey: context.replayKey,
    trustedKeyId,
    reservedAt: authority.reservedAt,
  });
}

function selectCandidate(pkg, authority) {
  assertExactKeys(
    pkg.objects,
    OBJECT_COLLECTIONS,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external package object collections are invalid',
  );
  for (const collection of OBJECT_COLLECTIONS) {
    if (!Array.isArray(pkg.objects[collection])) {
      fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID, 'external package collection must be an array', { collection });
    }
    const expected = collection === 'candidateClaims' ? 1 : 0;
    if (pkg.objects[collection].length !== expected) {
      fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID, 'external package must contain exactly one candidate claim and no other objects', { collection });
    }
  }

  const candidate = pkg.objects.candidateClaims[0];
  assertAllowedKeys(
    candidate,
    CANDIDATE_KEYS,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate shape is invalid',
  );
  assertAllowedKeys(
    candidate.proposedEdge,
    PROPOSED_EDGE_KEYS,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate proposed edge is invalid',
  );
  assertAllowedKeys(
    candidate.provenance,
    PROVENANCE_KEYS,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate provenance is invalid',
  );

  const externalCandidateId = text(candidate.candidateId,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate ID is required');
  text(candidate.claim, EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate claim is required');
  if (candidate.status !== 'pending' || candidate.canonical === true) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID, 'external candidate must be pending and non-canonical');
  }
  if (candidate.workspaceId !== authority.workspaceId
    || candidate.proposedEdge.workspaceId !== authority.workspaceId
    || candidate.provenance.workspaceId !== authority.workspaceId
    || candidate.provenance.actor !== authority.subject) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'candidate workspace or actor does not match authority');
  }
  for (const field of ['from', 'to', 'relation']) {
    text(candidate.proposedEdge[field],
      EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
      `external candidate proposedEdge.${field} is required`);
  }
  text(candidate.provenance.provenanceId,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate provenance ID is required');
  canonicalInstant(candidate.createdAt,
    EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.CANDIDATE_INVALID,
    'external candidate createdAt is invalid');

  if (pkg.manifest.packageId !== authority.packageId
    || pkg.manifest.workspaceId !== authority.workspaceId
    || pkg.manifest.createdBy !== authority.subject
    || sha256Hex(stableStringify(pkg)) !== authority.packageHash) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.AUTHORITY_MISMATCH, 'signed package does not match authority context');
  }
  return Object.freeze({ candidate, externalCandidateId });
}

function graphDependency(options) {
  if (!isPlainObject(options) || Reflect.ownKeys(options).length !== 1) {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.GRAPH_REQUIRED, 'exact graph dependency is required');
  }
  const descriptor = Object.getOwnPropertyDescriptor(options, 'graph');
  const graph = descriptor?.enumerable && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : null;
  if (!graph || typeof graph.runMutationOnce !== 'function'
    || typeof graph.addCandidateClaim !== 'function'
    || typeof graph.getCandidateClaims !== 'function') {
    fail(EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.GRAPH_REQUIRED, 'SQLite Graph mutation owner is required');
  }
  return graph;
}

function exactStoredResult(value, expected) {
  try {
    assertExactKeys(
      value,
      RESULT_KEYS,
      EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.OUTCOME_UNKNOWN,
      'stored mutation result is invalid',
    );
    return stableStringify(value) === stableStringify(expected);
  } catch (_) {
    return false;
  }
}

function commitExternalClientCandidateClaim(pkgInput, contextInput, options = {}) {
  const graph = graphDependency(options);
  const pkg = snapshotPackage(pkgInput);
  const authority = snapshotContext(contextInput);
  const { candidate, externalCandidateId } = selectCandidate(pkg, authority);

  const operationId = `external-client-candidate-claim:${authority.replayKey}`;
  const localCandidateId = `external_candidate_${sha256Hex(stableStringify({
    ownerVersion: EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION,
    workspaceId: authority.workspaceId,
    packageHash: authority.packageHash,
    externalCandidateId,
  }))}`;
  const receiptId = `external_candidate_receipt_${sha256Hex(operationId)}`;
  const externalCandidateHash = sha256Hex(stableStringify(candidate));
  const localProvenanceId = `external:${authority.packageHash}:${candidate.provenance.provenanceId}`;
  const createdAt = new Date(authority.reservedAt).toISOString();

  const localCandidate = deepFreeze({
    candidateId: localCandidateId,
    claim: candidate.claim,
    proposedEdge: {
      ...candidate.proposedEdge,
      provenanceId: localProvenanceId,
      workspaceId: authority.workspaceId,
    },
    provenance: {
      ...candidate.provenance,
      provenanceId: localProvenanceId,
      workspaceId: authority.workspaceId,
      actor: authority.subject,
    },
    conflict: null,
    recommendation: 'flag',
    status: 'pending',
    workspaceId: authority.workspaceId,
    createdAt: candidate.createdAt,
    reviewedAt: '',
    reviewedBy: '',
    warnings: [],
  });

  const metadata = deepFreeze({
    mutationKind: EXTERNAL_CLIENT_MUTATION_KIND,
    operationId,
    packageId: authority.packageId,
    packageHash: authority.packageHash,
    replayKey: authority.replayKey,
    trustedKeyId: authority.trustedKeyId,
    externalCandidateId,
    localCandidateId,
    externalCandidateHash,
  });
  const canonicalReceipt = deepFreeze(buildCanonicalReceiptPayloadV2({
    receiptId,
    receiptKind: EXTERNAL_CLIENT_RECEIPT_KIND,
    decision: 'review',
    status: 'pending',
    admissionId: operationId,
    workspaceId: authority.workspaceId,
    actor: authority.subject,
    agentId: authority.subject,
    memoryDraftId: localCandidateId,
    provenanceId: localProvenanceId,
    trustPolicyVersion: EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION,
    approvalId: '',
    approvalStatus: 'pending',
    reason: 'external_verified_candidate_requires_review',
    riskScore: 0,
    createdAt,
    metadata,
  }, {
    verdict: 'review',
    trustRoot: 'external_verified_client',
  }));

  const expectedResult = deepFreeze({
    outcome: 'pending_review',
    operationId,
    workspaceId: authority.workspaceId,
    packageId: authority.packageId,
    packageHash: authority.packageHash,
    externalCandidateId,
    localCandidateId,
    receiptId,
  });

  let committed;
  try {
    committed = graph.runMutationOnce(operationId, () => {
      const existing = graph.getCandidateClaims({
        workspaceId: authority.workspaceId,
        candidateId: localCandidateId,
      });
      if (existing.length > 0) {
        const collision = new Error('derived local candidate ID already exists');
        collision.code = EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.LOCAL_CANDIDATE_COLLISION;
        collision.details = Object.freeze({ operationId, localCandidateId });
        throw collision;
      }
      const stored = graph.addCandidateClaim(localCandidate, {
        workspaceId: authority.workspaceId,
      });
      if (!stored || stored.candidateId !== localCandidateId
        || stored.workspaceId !== authority.workspaceId
        || stored.status !== 'pending' || stored.recommendation !== 'flag'
        || stored.conflict !== null) {
        throw new Error('local candidate projection was not stored exactly');
      }
      return expectedResult;
    }, {
      buildCanonicalReceipt: () => canonicalReceipt,
    });
  } catch (error) {
    if (error?.code === EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.LOCAL_CANDIDATE_COLLISION) {
      throw error;
    }
    fail(
      EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.OUTCOME_UNKNOWN,
      'external client mutation outcome is unknown; automatic retry is forbidden',
      { operationId, reconciliationRequired: true },
    );
  }

  if (!committed || typeof committed.replayed !== 'boolean'
    || !exactStoredResult(committed.result, expectedResult)
    || committed.receipt?.operationId !== operationId
    || committed.receipt?.receiptId !== receiptId
    || committed.receipt?.workspaceId !== authority.workspaceId
    || stableStringify(committed.receipt?.canonicalPayload) !== stableStringify(canonicalReceipt)
    || typeof committed.receipt?.receiptHash !== 'string'
    || !HASH_PATTERN.test(committed.receipt.receiptHash)) {
    fail(
      EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS.OUTCOME_UNKNOWN,
      'external client committed result could not be reconciled',
      { operationId, reconciliationRequired: true },
    );
  }

  return deepFreeze({
    ok: true,
    outcome: 'pending_review',
    replayed: committed.replayed,
    operationId,
    workspaceId: authority.workspaceId,
    packageId: authority.packageId,
    packageHash: authority.packageHash,
    externalCandidateId,
    localCandidateId,
    receiptId,
    receiptHash: committed.receipt.receiptHash,
    previousReceiptHash: committed.receipt.previousReceiptHash,
  });
}

module.exports = {
  EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_VERSION,
  EXTERNAL_CLIENT_MUTATION_RECEIPT_OWNER_ERRORS,
  EXTERNAL_CLIENT_MUTATION_KIND,
  EXTERNAL_CLIENT_RECEIPT_KIND,
  commitExternalClientCandidateClaim,
};
