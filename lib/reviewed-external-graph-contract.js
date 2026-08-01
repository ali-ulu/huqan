'use strict';

const { sha256 } = require('./ingest');
const {
  REVIEWED_EXTERNAL_CANDIDATE_PLAN_VERSION,
  REVIEWED_EXTERNAL_CANDIDATE_VERSION,
} = require('./reviewed-external-ingest-candidates');
const {
  REVIEWED_EXTERNAL_ADMISSION_RESERVATION_VERSION,
} = require('./reviewed-external-admission-reservation');

const HASH = /^sha256:[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;
const PLAN_KEYS = new Set(['version','batchHash','executionPlanHash','approvalId','approvalKey','snapshotHash','reviewedManifestHash','sourceType','sourceRef','immutableSourceId','workspaceId','requester','reviewer','selfApproval','leaseOwner','leaseExpiresAt','preparedAt','sourceNodeId','documentCount','sectionCount','candidateCount','candidates','candidatePlanHash']);
const RESERVATION_KEYS = new Set(['version','approvalId','approvalKey','admissionHash','candidatePlanHash','approvalRecordHash','workspaceId','requester','reviewer','selfApproval','leaseOwner','leaseExpiresAt','admittedAt','reservedAt','approvalUpdatedAt','reservationHash']);
const NODE_KEYS = new Set(['version','ordinal','kind','nodeId','label','sourceRef','sourceTitle','sourceType','sourceSubType','confidence','contentHash','candidateId']);
const NODE_BLOB_KEYS = new Set([...NODE_KEYS, 'blobSha']);
const EDGE_KEYS = new Set(['version','ordinal','kind','fromId','toId','relation','sourceRef','sourceTitle','sourceType','sourceSubType','confidence','evidence','candidateId']);
const TRUST_KEYS = ['approvalId','approvalKey','reservationHash','admissionHash','candidatePlanHash','workspaceId','leaseOwner','sourceRef','immutableSourceId'];

function failure(code, error) { return { ok: false, code, error }; }
function exact(value, allowed) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === allowed.size
    && Object.keys(value).every(key => allowed.has(key));
}
function without(value, key) { const copy = { ...value }; delete copy[key]; return copy; }
function printable(value, max = 512) {
  return typeof value === 'string' && value === value.trim() && value.length > 0
    && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
}
function canonicalTime(value) {
  const text = value instanceof Date ? value.toISOString() : String(value || '');
  const millis = Date.parse(text);
  return text && Number.isFinite(millis) && new Date(millis).toISOString() === text
    ? { ok: true, text, millis } : { ok: false };
}

function validatePlan(plan) {
  if (!exact(plan, PLAN_KEYS)) return failure('REVIEWED_GRAPH_PLAN_FIELDS_INVALID', 'candidate plan fields are invalid');
  if (plan.version !== REVIEWED_EXTERNAL_CANDIDATE_PLAN_VERSION) return failure('REVIEWED_GRAPH_PLAN_VERSION_UNSUPPORTED', 'candidate plan version is unsupported');
  for (const key of ['batchHash','executionPlanHash','snapshotHash','reviewedManifestHash','candidatePlanHash']) {
    if (!HASH.test(plan[key])) return failure('REVIEWED_GRAPH_PLAN_HASH_INVALID', `${key} is invalid`);
  }
  for (const [key,max] of [['approvalId',128],['approvalKey',256],['sourceRef',2048],['workspaceId',128],['requester',128],['reviewer',128],['leaseOwner',128],['sourceNodeId',256]]) {
    if (!printable(plan[key], max)) return failure('REVIEWED_GRAPH_PLAN_IDENTITY_INVALID', `${key} is invalid`);
  }
  if (!['github','markdown'].includes(plan.sourceType)) return failure('REVIEWED_GRAPH_SOURCE_TYPE_UNSUPPORTED', 'source type is unsupported');
  if (plan.sourceType === 'github') {
    if (!GIT_SHA.test(plan.immutableSourceId) || !plan.sourceRef.endsWith(`@${plan.immutableSourceId}`)) return failure('REVIEWED_GRAPH_IMMUTABLE_SOURCE_INVALID', 'GitHub source is not commit-bound');
  } else if (!HASH.test(plan.immutableSourceId) || !plan.sourceRef.endsWith(`@${plan.immutableSourceId}`)) {
    return failure('REVIEWED_GRAPH_IMMUTABLE_SOURCE_INVALID', 'Markdown source is not content-bound');
  }
  if (plan.selfApproval !== (plan.requester === plan.reviewer)) return failure('REVIEWED_GRAPH_SELF_APPROVAL_INVALID', 'self-approval visibility is inconsistent');
  const prepared = canonicalTime(plan.preparedAt);
  if (!prepared.ok || !Number.isSafeInteger(plan.leaseExpiresAt) || plan.leaseExpiresAt <= prepared.millis) return failure('REVIEWED_GRAPH_LEASE_INVALID', 'candidate plan lease is invalid');
  if (!Number.isSafeInteger(plan.documentCount) || plan.documentCount < 1
    || !Number.isSafeInteger(plan.sectionCount) || plan.sectionCount < 0 || plan.sectionCount > 5000
    || !Number.isSafeInteger(plan.candidateCount) || plan.candidateCount > 10101
    || !Array.isArray(plan.candidates) || plan.candidates.length !== plan.candidateCount
    || plan.candidateCount !== 1 + (2 * (plan.documentCount + plan.sectionCount))) {
    return failure('REVIEWED_GRAPH_PLAN_COUNT_INVALID', 'candidate counts are inconsistent');
  }
  if (sha256(without(plan, 'candidatePlanHash')) !== plan.candidatePlanHash) return failure('REVIEWED_GRAPH_PLAN_HASH_MISMATCH', 'candidate plan hash is invalid');

  const nodes = new Set();
  const edges = new Set();
  let sourceNodes = 0; let documents = 0; let sections = 0; let edgeCount = 0;
  const expectedSourceType = plan.sourceType === 'github' ? 'github' : 'document';
  for (let index = 0; index < plan.candidates.length; index += 1) {
    const item = plan.candidates[index];
    const keys = item?.kind === 'edge' ? EDGE_KEYS : Object.hasOwn(item || {}, 'blobSha') ? NODE_BLOB_KEYS : NODE_KEYS;
    if (!exact(item, keys) || item.version !== REVIEWED_EXTERNAL_CANDIDATE_VERSION || item.ordinal !== index) return failure('REVIEWED_GRAPH_CANDIDATE_FIELDS_INVALID', `candidate ${index} is invalid`);
    if (!HASH.test(item.candidateId) || sha256(without(item, 'candidateId')) !== item.candidateId) return failure('REVIEWED_GRAPH_CANDIDATE_HASH_MISMATCH', `candidate ${index} hash is invalid`);
    if (!Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1
      || item.sourceType !== expectedSourceType || !printable(item.sourceRef, 2304)
      || !item.sourceRef.startsWith(plan.sourceRef) || !printable(item.sourceTitle)
      || !printable(item.sourceSubType, 128)) return failure('REVIEWED_GRAPH_CANDIDATE_SOURCE_MISMATCH', `candidate ${index} source is invalid`);

    if (item.kind === 'node') {
      if (!printable(item.nodeId,256) || !printable(item.label) || !HASH.test(item.contentHash)) return failure('REVIEWED_GRAPH_NODE_INVALID', `candidate ${index} node is invalid`);
      if (item.blobSha !== undefined && (plan.sourceType !== 'github' || !item.nodeId.startsWith('external-document:') || !GIT_SHA.test(item.blobSha))) return failure('REVIEWED_GRAPH_NODE_BLOB_INVALID', `candidate ${index} blob is invalid`);
      if (nodes.has(item.nodeId)) return failure('REVIEWED_GRAPH_NODE_DUPLICATE', 'candidate plan duplicates a node');
      nodes.add(item.nodeId);
      if (item.nodeId.startsWith('external-source:')) sourceNodes += 1;
      else if (item.nodeId.startsWith('external-document:')) documents += 1;
      else if (item.nodeId.startsWith('external-section:')) sections += 1;
      else return failure('REVIEWED_GRAPH_NODE_INVALID', `candidate ${index} node type is invalid`);
      continue;
    }
    if (item.kind !== 'edge' || !printable(item.fromId,256) || !printable(item.toId,256)
      || !['içerir','özellik'].includes(item.relation) || !Array.isArray(item.evidence)
      || item.evidence.length < 1 || item.evidence.length > 4
      || item.evidence.some(value => !printable(value))) return failure('REVIEWED_GRAPH_EDGE_INVALID', `candidate ${index} edge is invalid`);
    const edgeKey = `${item.fromId}\u0000${item.relation}\u0000${item.toId}`;
    if (edges.has(edgeKey)) return failure('REVIEWED_GRAPH_EDGE_DUPLICATE', 'candidate plan duplicates an edge');
    edges.add(edgeKey); edgeCount += 1;
  }
  if (plan.candidates[0]?.kind !== 'node' || plan.candidates[0]?.nodeId !== plan.sourceNodeId
    || sourceNodes !== 1 || documents !== plan.documentCount || sections !== plan.sectionCount
    || edgeCount !== plan.documentCount + plan.sectionCount) return failure('REVIEWED_GRAPH_PLAN_TOPOLOGY_INVALID', 'candidate topology is invalid');
  for (const item of plan.candidates) {
    if (item.kind !== 'edge') continue;
    if (!nodes.has(item.fromId) || !nodes.has(item.toId)) return failure('REVIEWED_GRAPH_EDGE_ENDPOINT_INVALID', 'edge endpoint is outside the reviewed node set');
    if (item.relation === 'içerir' && (item.fromId !== plan.sourceNodeId || !item.toId.startsWith('external-document:'))) return failure('REVIEWED_GRAPH_PLAN_TOPOLOGY_INVALID', 'containment topology is invalid');
    if (item.relation === 'özellik' && (!item.fromId.startsWith('external-document:') || !item.toId.startsWith('external-section:'))) return failure('REVIEWED_GRAPH_PLAN_TOPOLOGY_INVALID', 'section topology is invalid');
  }
  return { ok: true };
}

function validateReservation(plan, reservation) {
  if (!exact(reservation, RESERVATION_KEYS) || reservation.version !== REVIEWED_EXTERNAL_ADMISSION_RESERVATION_VERSION) return failure('REVIEWED_GRAPH_RESERVATION_INVALID', 'reservation fields or version are invalid');
  for (const key of ['admissionHash','candidatePlanHash','approvalRecordHash','reservationHash']) if (!HASH.test(reservation[key])) return failure('REVIEWED_GRAPH_RESERVATION_HASH_INVALID', `${key} is invalid`);
  if (!canonicalTime(reservation.admittedAt).ok || !canonicalTime(reservation.reservedAt).ok
    || !Number.isSafeInteger(reservation.leaseExpiresAt) || !Number.isSafeInteger(reservation.approvalUpdatedAt)
    || sha256(without(reservation, 'reservationHash')) !== reservation.reservationHash) return failure('REVIEWED_GRAPH_RESERVATION_HASH_MISMATCH', 'reservation identity is invalid');
  for (const key of ['approvalId','approvalKey','candidatePlanHash','workspaceId','requester','reviewer','selfApproval','leaseOwner','leaseExpiresAt']) {
    if (reservation[key] !== plan[key]) return failure('REVIEWED_GRAPH_RESERVATION_PLAN_MISMATCH', `${key} does not match the plan`);
  }
  return { ok: true };
}

function validateTrust(plan, reservation, options) {
  const expected = { approvalId:plan.approvalId, approvalKey:plan.approvalKey, reservationHash:reservation.reservationHash, admissionHash:reservation.admissionHash, candidatePlanHash:plan.candidatePlanHash, workspaceId:plan.workspaceId, leaseOwner:plan.leaseOwner, sourceRef:plan.sourceRef, immutableSourceId:plan.immutableSourceId };
  for (const key of TRUST_KEYS) {
    if (!printable(options[key], key === 'sourceRef' ? 2048 : key === 'approvalKey' ? 256 : 128)) return failure('REVIEWED_GRAPH_TRUST_CONTEXT_REQUIRED', `${key} is required`);
    if (options[key] !== expected[key]) return failure('REVIEWED_GRAPH_TRUST_CONTEXT_MISMATCH', `${key} does not match trusted context`);
  }
  return { ok: true };
}

module.exports = { failure, exact, without, printable, canonicalTime, validatePlan, validateReservation, validateTrust };
