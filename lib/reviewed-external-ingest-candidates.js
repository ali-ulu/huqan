'use strict';

const {
  MAX_EXTERNAL_SNAPSHOT_FILES,
  MAX_EXTERNAL_SNAPSHOT_BYTES,
  normalizeSnapshotPath,
  sha256,
  sha256Text,
} = require('./ingest');
const {
  REVIEWED_EXTERNAL_INGEST_BATCH_VERSION,
  REVIEWED_EXTERNAL_DOCUMENT_VERSION,
} = require('./reviewed-external-ingest-batch');

const REVIEWED_EXTERNAL_CANDIDATE_PLAN_VERSION = 'huqan.reviewed-external-candidate-plan.v1';
const REVIEWED_EXTERNAL_CANDIDATE_VERSION = 'huqan.reviewed-external-candidate.v1';
const MAX_REVIEWED_EXTERNAL_SECTIONS = 5000;
const MAX_REVIEWED_SECTION_TITLE_LENGTH = 512;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const GIT_SHA_PATTERN = /^[0-9a-f]{40}$/u;
const BATCH_FIELDS = new Set([
  'version',
  'executionPlanHash',
  'approvalId',
  'approvalKey',
  'snapshotHash',
  'reviewedManifestHash',
  'sourceType',
  'sourceRef',
  'immutableSourceId',
  'workspaceId',
  'requester',
  'reviewer',
  'selfApproval',
  'leaseOwner',
  'leaseExpiresAt',
  'preparedAt',
  'fileCount',
  'totalBytes',
  'documents',
  'batchHash',
]);
const BASE_DOCUMENT_FIELDS = new Set([
  'version',
  'index',
  'documentId',
  'path',
  'content',
  'contentHash',
  'sizeBytes',
  'sourceRef',
]);
const GITHUB_DOCUMENT_FIELDS = new Set([...BASE_DOCUMENT_FIELDS, 'blobSha']);
const TRUSTED_CONTEXT_FIELDS = [
  ['approvalId', 128],
  ['approvalKey', 256],
  ['snapshotHash', 128],
  ['reviewedManifestHash', 128],
  ['executionPlanHash', 128],
  ['batchHash', 128],
  ['sourceType', 32],
  ['sourceRef', 2048],
  ['immutableSourceId', 128],
  ['workspaceId', 128],
  ['requester', 128],
  ['reviewer', 128],
  ['leaseOwner', 128],
];

function failure(code, error) {
  return { ok: false, code, error };
}

function exactFields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === allowed.size && keys.every(key => allowed.has(key));
}

function boundedPrintable(value, label, code, maxLength = 512) {
  const text = String(value == null ? '' : value).trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) {
    return failure(code, `${label} is required and must be a bounded printable string`);
  }
  return { ok: true, value: text };
}

function canonicalTime(value, label, code) {
  const text = value instanceof Date ? value.toISOString() : String(value == null ? '' : value).trim();
  const millis = Date.parse(text);
  if (!text || !Number.isFinite(millis) || new Date(millis).toISOString() !== text) {
    return failure(code, `${label} must be a canonical ISO-8601 timestamp`);
  }
  return { ok: true, value: text, millis };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function batchCore(batch) {
  return {
    version: batch.version,
    executionPlanHash: batch.executionPlanHash,
    approvalId: batch.approvalId,
    approvalKey: batch.approvalKey,
    snapshotHash: batch.snapshotHash,
    reviewedManifestHash: batch.reviewedManifestHash,
    sourceType: batch.sourceType,
    sourceRef: batch.sourceRef,
    immutableSourceId: batch.immutableSourceId,
    workspaceId: batch.workspaceId,
    requester: batch.requester,
    reviewer: batch.reviewer,
    selfApproval: batch.selfApproval,
    leaseOwner: batch.leaseOwner,
    leaseExpiresAt: batch.leaseExpiresAt,
    preparedAt: batch.preparedAt,
    fileCount: batch.fileCount,
    totalBytes: batch.totalBytes,
    documents: batch.documents.map(document => ({ ...document })),
  };
}

function verifyBatchIdentity(batch) {
  const boundedFields = [
    ['approvalId', 128],
    ['approvalKey', 256],
    ['sourceRef', 2048],
    ['workspaceId', 128],
    ['requester', 128],
    ['reviewer', 128],
    ['leaseOwner', 128],
  ];
  for (const [key, maxLength] of boundedFields) {
    const checked = boundedPrintable(batch[key], key, 'REVIEWED_CANDIDATE_BATCH_IDENTITY_INVALID', maxLength);
    if (!checked.ok || checked.value !== batch[key]) {
      return failure('REVIEWED_CANDIDATE_BATCH_IDENTITY_INVALID', `${key} is invalid`);
    }
  }

  if (!SHA256_PATTERN.test(batch.snapshotHash)
    || !SHA256_PATTERN.test(batch.reviewedManifestHash)
    || !SHA256_PATTERN.test(batch.executionPlanHash)
    || !SHA256_PATTERN.test(batch.batchHash)) {
    return failure('REVIEWED_CANDIDATE_HASH_INVALID', 'reviewed batch hashes must be canonical sha256 values');
  }
  if (!['github', 'markdown'].includes(batch.sourceType)) {
    return failure('REVIEWED_CANDIDATE_SOURCE_TYPE_UNSUPPORTED', 'reviewed candidates support github or markdown only');
  }
  if (batch.sourceType === 'github') {
    if (!GIT_SHA_PATTERN.test(batch.immutableSourceId) || !batch.sourceRef.endsWith(`@${batch.immutableSourceId}`)) {
      return failure('REVIEWED_CANDIDATE_IMMUTABLE_SOURCE_INVALID', 'GitHub batch is not bound to a full commit SHA');
    }
  } else if (!SHA256_PATTERN.test(batch.immutableSourceId) || !batch.sourceRef.endsWith(`@${batch.immutableSourceId}`)) {
    return failure('REVIEWED_CANDIDATE_IMMUTABLE_SOURCE_INVALID', 'Markdown batch is not bound to its content-set hash');
  }
  if (typeof batch.selfApproval !== 'boolean' || batch.selfApproval !== (batch.requester === batch.reviewer)) {
    return failure('REVIEWED_CANDIDATE_SELF_APPROVAL_INVALID', 'self-approval visibility does not match requester and reviewer identities');
  }
  return { ok: true };
}

function verifyTrustedContext(batch, options) {
  for (const [key, maxLength] of TRUSTED_CONTEXT_FIELDS) {
    const checked = boundedPrintable(options[key], key, 'REVIEWED_CANDIDATE_TRUST_CONTEXT_REQUIRED', maxLength);
    if (!checked.ok) return checked;
    if (checked.value !== batch[key]) {
      return failure('REVIEWED_CANDIDATE_TRUST_CONTEXT_MISMATCH', `${key} does not match the trusted execution context`);
    }
  }
  return { ok: true };
}

function verifyTiming(batch, options) {
  if (options.now === undefined || options.now === null || options.now === '') {
    return failure('REVIEWED_CANDIDATE_NOW_REQUIRED', 'an explicit trusted candidate-generation time is required');
  }
  const preparedAt = canonicalTime(batch.preparedAt, 'preparedAt', 'REVIEWED_CANDIDATE_PREPARED_AT_INVALID');
  if (!preparedAt.ok) return preparedAt;
  const now = canonicalTime(options.now, 'now', 'REVIEWED_CANDIDATE_NOW_INVALID');
  if (!now.ok) return now;
  if (!Number.isSafeInteger(batch.leaseExpiresAt) || batch.leaseExpiresAt <= preparedAt.millis) {
    return failure('REVIEWED_CANDIDATE_LEASE_INVALID', 'candidate-generation lease expiry is invalid');
  }
  if (now.millis < preparedAt.millis) {
    return failure('REVIEWED_CANDIDATE_NOT_YET_VALID', 'reviewed batch preparation time is in the future');
  }
  if (now.millis >= batch.leaseExpiresAt) {
    return failure('REVIEWED_CANDIDATE_LEASE_EXPIRED', 'execution lease expired before candidate generation');
  }
  return { ok: true };
}

function verifyDocuments(batch) {
  if (!Number.isSafeInteger(batch.fileCount)
    || batch.fileCount < 1
    || batch.fileCount > MAX_EXTERNAL_SNAPSHOT_FILES
    || !Array.isArray(batch.documents)
    || batch.documents.length !== batch.fileCount) {
    return failure('REVIEWED_CANDIDATE_DOCUMENT_COUNT_INVALID', 'reviewed batch document count is invalid');
  }
  if (!Number.isSafeInteger(batch.totalBytes)
    || batch.totalBytes < 0
    || batch.totalBytes > MAX_EXTERNAL_SNAPSHOT_BYTES) {
    return failure('REVIEWED_CANDIDATE_TOTAL_BYTES_INVALID', 'reviewed batch total byte count is invalid');
  }

  const documents = [];
  const seen = new Set();
  let previousPath = '';
  let totalBytes = 0;

  for (let index = 0; index < batch.documents.length; index += 1) {
    const document = batch.documents[index];
    const allowed = batch.sourceType === 'github' ? GITHUB_DOCUMENT_FIELDS : BASE_DOCUMENT_FIELDS;
    if (!exactFields(document, allowed)) {
      return failure('REVIEWED_CANDIDATE_DOCUMENT_FIELDS_INVALID', 'reviewed document contains unsupported or missing fields');
    }
    if (document.version !== REVIEWED_EXTERNAL_DOCUMENT_VERSION || document.index !== index) {
      return failure('REVIEWED_CANDIDATE_DOCUMENT_ORDER_INVALID', 'reviewed documents must use the expected version and contiguous indexes');
    }

    const documentPath = normalizeSnapshotPath(document.path);
    if (!documentPath || documentPath !== document.path || !/\.(?:md|markdown)$/iu.test(documentPath)) {
      return failure('REVIEWED_CANDIDATE_DOCUMENT_PATH_INVALID', 'reviewed candidate documents require canonical Markdown paths');
    }
    if (previousPath && documentPath <= previousPath) {
      return failure('REVIEWED_CANDIDATE_DOCUMENT_ORDER_INVALID', 'reviewed candidate documents must be strictly sorted by path');
    }
    previousPath = documentPath;

    const dedupeKey = documentPath.normalize('NFC').toLowerCase();
    if (seen.has(dedupeKey)) {
      return failure('REVIEWED_CANDIDATE_DOCUMENT_DUPLICATE', `duplicate reviewed document path: ${documentPath}`);
    }
    seen.add(dedupeKey);

    if (typeof document.content !== 'string') {
      return failure('REVIEWED_CANDIDATE_DOCUMENT_CONTENT_REQUIRED', `reviewed content is required for ${documentPath}`);
    }
    const sizeBytes = Buffer.byteLength(document.content, 'utf8');
    totalBytes += sizeBytes;
    if (totalBytes > MAX_EXTERNAL_SNAPSHOT_BYTES) {
      return failure('REVIEWED_CANDIDATE_TOTAL_BYTES_INVALID', 'reviewed batch exceeds the aggregate byte limit');
    }
    if (!Number.isSafeInteger(document.sizeBytes)
      || document.sizeBytes !== sizeBytes
      || document.contentHash !== sha256Text(document.content)) {
      return failure('REVIEWED_CANDIDATE_DOCUMENT_CONTENT_MISMATCH', `reviewed document content binding mismatch: ${documentPath}`);
    }
    if (!SHA256_PATTERN.test(document.contentHash)) {
      return failure('REVIEWED_CANDIDATE_DOCUMENT_HASH_INVALID', `reviewed document hash is invalid: ${documentPath}`);
    }
    if (document.sourceRef !== `${batch.sourceRef}::${documentPath}`) {
      return failure('REVIEWED_CANDIDATE_DOCUMENT_SOURCE_REF_MISMATCH', `reviewed document sourceRef mismatch: ${documentPath}`);
    }
    if (batch.sourceType === 'github' && !GIT_SHA_PATTERN.test(document.blobSha)) {
      return failure('REVIEWED_CANDIDATE_BLOB_SHA_REQUIRED', `GitHub reviewed document requires a canonical blob SHA: ${documentPath}`);
    }

    const expectedDocumentId = sha256({
      executionPlanHash: batch.executionPlanHash,
      path: documentPath,
      contentHash: document.contentHash,
      ...(document.blobSha ? { blobSha: document.blobSha } : {}),
    });
    if (document.documentId !== expectedDocumentId) {
      return failure('REVIEWED_CANDIDATE_DOCUMENT_ID_MISMATCH', `reviewed document identity mismatch: ${documentPath}`);
    }

    documents.push({ ...document });
  }

  if (totalBytes !== batch.totalBytes) {
    return failure('REVIEWED_CANDIDATE_TOTAL_BYTES_MISMATCH', 'reviewed batch totalBytes does not match its documents');
  }
  return { ok: true, documents };
}

function parseReviewedMarkdown(content) {
  const lines = String(content).split(/\r?\n/u);
  const sections = [];
  let currentTitle = 'root';
  let currentLevel = 0;
  let currentLines = [];

  const flush = () => {
    const text = currentLines.join('\n').trim();
    currentLines = [];
    if (!text) return { ok: true };
    const title = boundedPrintable(
      currentTitle,
      'sectionTitle',
      'REVIEWED_CANDIDATE_SECTION_TITLE_INVALID',
      MAX_REVIEWED_SECTION_TITLE_LENGTH,
    );
    if (!title.ok) return title;
    sections.push({
      index: sections.length,
      title: title.value,
      level: currentLevel,
      contentHash: sha256Text(text),
      sizeBytes: Buffer.byteLength(text, 'utf8'),
    });
    if (sections.length > MAX_REVIEWED_EXTERNAL_SECTIONS) {
      return failure(
        'REVIEWED_CANDIDATE_SECTION_LIMIT',
        `reviewed candidate plan may contain at most ${MAX_REVIEWED_EXTERNAL_SECTIONS} sections`,
      );
    }
    return { ok: true };
  };

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,3})\s+(.+?)\s*$/u);
    if (headerMatch) {
      const flushed = flush();
      if (!flushed.ok) return flushed;
      const title = boundedPrintable(
        headerMatch[2],
        'sectionTitle',
        'REVIEWED_CANDIDATE_SECTION_TITLE_INVALID',
        MAX_REVIEWED_SECTION_TITLE_LENGTH,
      );
      if (!title.ok) return title;
      currentTitle = title.value;
      currentLevel = headerMatch[1].length;
      continue;
    }
    currentLines.push(line);
  }

  const flushed = flush();
  if (!flushed.ok) return flushed;
  return { ok: true, sections };
}

function hashedId(prefix, value) {
  return `${prefix}:${sha256(value).slice('sha256:'.length)}`;
}

function candidate(core) {
  return {
    ...core,
    candidateId: sha256(core),
  };
}

function sourceLabel(batch) {
  const suffix = batch.immutableSourceId.startsWith('sha256:')
    ? batch.immutableSourceId.slice('sha256:'.length, 'sha256:'.length + 12)
    : batch.immutableSourceId.slice(0, 12);
  return `${batch.sourceType === 'github' ? 'GitHub' : 'Markdown'} source ${suffix}`;
}

function buildNodeCandidate({ ordinal, nodeId, label, sourceRef, sourceTitle, sourceType, sourceSubType, confidence, contentHash, blobSha }) {
  return candidate({
    version: REVIEWED_EXTERNAL_CANDIDATE_VERSION,
    ordinal,
    kind: 'node',
    nodeId,
    label,
    sourceRef,
    sourceTitle,
    sourceType,
    sourceSubType,
    confidence,
    contentHash,
    ...(blobSha ? { blobSha } : {}),
  });
}

function buildEdgeCandidate({ ordinal, fromId, toId, relation, sourceRef, sourceTitle, sourceType, sourceSubType, confidence, evidence }) {
  return candidate({
    version: REVIEWED_EXTERNAL_CANDIDATE_VERSION,
    ordinal,
    kind: 'edge',
    fromId,
    toId,
    relation,
    sourceRef,
    sourceTitle,
    sourceType,
    sourceSubType,
    confidence,
    evidence,
  });
}

function buildReviewedExternalCandidatePlan(batch, options = {}) {
  if (!exactFields(batch, BATCH_FIELDS)) {
    return failure('REVIEWED_CANDIDATE_BATCH_FIELDS_INVALID', 'reviewed batch contains unsupported or missing fields');
  }
  if (batch.version !== REVIEWED_EXTERNAL_INGEST_BATCH_VERSION) {
    return failure('REVIEWED_CANDIDATE_BATCH_VERSION_UNSUPPORTED', 'reviewed batch version is unsupported');
  }

  const identity = verifyBatchIdentity(batch);
  if (!identity.ok) return identity;
  const trusted = verifyTrustedContext(batch, options);
  if (!trusted.ok) return trusted;
  const timing = verifyTiming(batch, options);
  if (!timing.ok) return timing;
  const verifiedDocuments = verifyDocuments(batch);
  if (!verifiedDocuments.ok) return verifiedDocuments;

  const expectedBatchHash = sha256(batchCore(batch));
  if (batch.batchHash !== expectedBatchHash) {
    return failure('REVIEWED_CANDIDATE_BATCH_HASH_MISMATCH', 'reviewed batch no longer matches its content-bound identity');
  }

  const parsedDocuments = [];
  let totalSections = 0;
  for (const document of verifiedDocuments.documents) {
    const parsed = parseReviewedMarkdown(document.content);
    if (!parsed.ok) return parsed;
    totalSections += parsed.sections.length;
    if (totalSections > MAX_REVIEWED_EXTERNAL_SECTIONS) {
      return failure(
        'REVIEWED_CANDIDATE_SECTION_LIMIT',
        `reviewed candidate plan may contain at most ${MAX_REVIEWED_EXTERNAL_SECTIONS} sections`,
      );
    }
    parsedDocuments.push({ document, sections: parsed.sections });
  }

  const provenanceSourceType = batch.sourceType === 'github' ? 'github' : 'document';
  const sourceNodeId = hashedId('external-source', {
    sourceType: batch.sourceType,
    sourceRef: batch.sourceRef,
    immutableSourceId: batch.immutableSourceId,
  });
  const candidates = [];
  const addCandidate = builder => {
    candidates.push(builder(candidates.length));
  };

  addCandidate(ordinal => buildNodeCandidate({
    ordinal,
    nodeId: sourceNodeId,
    label: sourceLabel(batch),
    sourceRef: batch.sourceRef,
    sourceTitle: sourceLabel(batch),
    sourceType: provenanceSourceType,
    sourceSubType: 'reviewed_external_source',
    confidence: batch.sourceType === 'github' ? 0.8 : 0.68,
    contentHash: batch.reviewedManifestHash,
  }));

  for (const { document, sections } of parsedDocuments) {
    const documentNodeId = `external-document:${document.documentId.slice('sha256:'.length)}`;
    const documentSourceSubType = batch.sourceType === 'github'
      ? 'reviewed_external_repo_file'
      : 'reviewed_external_markdown_file';
    addCandidate(ordinal => buildNodeCandidate({
      ordinal,
      nodeId: documentNodeId,
      label: document.path,
      sourceRef: document.sourceRef,
      sourceTitle: document.path,
      sourceType: provenanceSourceType,
      sourceSubType: documentSourceSubType,
      confidence: batch.sourceType === 'github' ? 0.8 : 0.68,
      contentHash: document.contentHash,
      ...(document.blobSha ? { blobSha: document.blobSha } : {}),
    }));
    addCandidate(ordinal => buildEdgeCandidate({
      ordinal,
      fromId: sourceNodeId,
      toId: documentNodeId,
      relation: 'içerir',
      sourceRef: document.sourceRef,
      sourceTitle: document.path,
      sourceType: provenanceSourceType,
      sourceSubType: documentSourceSubType,
      confidence: batch.sourceType === 'github' ? 0.8 : 0.68,
      evidence: [document.path, document.contentHash],
    }));

    for (const section of sections) {
      const sectionNodeId = hashedId('external-section', {
        documentId: document.documentId,
        index: section.index,
        title: section.title,
        contentHash: section.contentHash,
      });
      const sectionSourceRef = `${document.sourceRef}#section=${section.index}`;
      const sectionSourceSubType = batch.sourceType === 'github'
        ? 'reviewed_external_repo_section'
        : 'reviewed_external_markdown_section';
      addCandidate(ordinal => buildNodeCandidate({
        ordinal,
        nodeId: sectionNodeId,
        label: section.title,
        sourceRef: sectionSourceRef,
        sourceTitle: section.title,
        sourceType: provenanceSourceType,
        sourceSubType: sectionSourceSubType,
        confidence: batch.sourceType === 'github' ? 0.72 : 0.68,
        contentHash: section.contentHash,
      }));
      addCandidate(ordinal => buildEdgeCandidate({
        ordinal,
        fromId: documentNodeId,
        toId: sectionNodeId,
        relation: 'özellik',
        sourceRef: sectionSourceRef,
        sourceTitle: section.title,
        sourceType: provenanceSourceType,
        sourceSubType: sectionSourceSubType,
        confidence: batch.sourceType === 'github' ? 0.72 : 0.68,
        evidence: [section.title, section.contentHash],
      }));
    }
  }

  const core = {
    version: REVIEWED_EXTERNAL_CANDIDATE_PLAN_VERSION,
    batchHash: batch.batchHash,
    executionPlanHash: batch.executionPlanHash,
    approvalId: batch.approvalId,
    approvalKey: batch.approvalKey,
    snapshotHash: batch.snapshotHash,
    reviewedManifestHash: batch.reviewedManifestHash,
    sourceType: batch.sourceType,
    sourceRef: batch.sourceRef,
    immutableSourceId: batch.immutableSourceId,
    workspaceId: batch.workspaceId,
    requester: batch.requester,
    reviewer: batch.reviewer,
    selfApproval: batch.selfApproval,
    leaseOwner: batch.leaseOwner,
    leaseExpiresAt: batch.leaseExpiresAt,
    preparedAt: batch.preparedAt,
    sourceNodeId,
    documentCount: batch.fileCount,
    sectionCount: totalSections,
    candidateCount: candidates.length,
    candidates,
  };
  const plan = deepFreeze({
    ...core,
    candidatePlanHash: sha256(core),
  });
  return { ok: true, plan };
}

module.exports = {
  REVIEWED_EXTERNAL_CANDIDATE_PLAN_VERSION,
  REVIEWED_EXTERNAL_CANDIDATE_VERSION,
  MAX_REVIEWED_EXTERNAL_SECTIONS,
  MAX_REVIEWED_SECTION_TITLE_LENGTH,
  buildReviewedExternalCandidatePlan,
};
