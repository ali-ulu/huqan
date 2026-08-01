'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { sha256, sha256Text } = require('../lib/ingest');
const {
  REVIEWED_EXTERNAL_INGEST_BATCH_VERSION,
  REVIEWED_EXTERNAL_DOCUMENT_VERSION,
} = require('../lib/reviewed-external-ingest-batch');
const {
  REVIEWED_EXTERNAL_CANDIDATE_PLAN_VERSION,
  REVIEWED_EXTERNAL_CANDIDATE_VERSION,
  MAX_REVIEWED_EXTERNAL_SECTIONS,
  MAX_REVIEWED_SECTION_TITLE_LENGTH,
  buildReviewedExternalCandidatePlan,
} = require('../lib/reviewed-external-ingest-candidates');

const PREPARED_AT = '2026-08-01T10:00:00.000Z';
const LEASE_EXPIRES_AT = Date.parse(PREPARED_AT) + 120_000;
const COMMIT_SHA = 'a'.repeat(40);
const BLOB_SHA = 'b'.repeat(40);

function batchCore(batch) {
  const core = structuredClone(batch);
  delete core.batchHash;
  return core;
}

function buildBatch({
  sourceType = 'markdown',
  files = [{ path: 'docs/guide.md', content: '# Guide\nReviewed body.\n' }],
  requester = 'user:alice',
  reviewer = 'user:bob',
} = {}) {
  const immutableSourceId = sourceType === 'github'
    ? COMMIT_SHA
    : sha256({ contentSet: files.map(file => [file.path, sha256Text(file.content)]) });
  const sourceRef = sourceType === 'github'
    ? `https://github.com/ali-ulu/huqan@${immutableSourceId}`
    : `file:docs@${immutableSourceId}`;
  const executionPlanHash = sha256({ plan: 'reviewed-external-execution', sourceType, immutableSourceId });
  const documents = files.map((file, index) => {
    const contentHash = sha256Text(file.content);
    return {
      version: REVIEWED_EXTERNAL_DOCUMENT_VERSION,
      index,
      documentId: sha256({
        executionPlanHash,
        path: file.path,
        contentHash,
        ...(sourceType === 'github' ? { blobSha: file.blobSha || BLOB_SHA } : {}),
      }),
      path: file.path,
      content: file.content,
      contentHash,
      sizeBytes: Buffer.byteLength(file.content, 'utf8'),
      sourceRef: `${sourceRef}::${file.path}`,
      ...(sourceType === 'github' ? { blobSha: file.blobSha || BLOB_SHA } : {}),
    };
  });
  const batch = {
    version: REVIEWED_EXTERNAL_INGEST_BATCH_VERSION,
    executionPlanHash,
    approvalId: 'approval:reviewed-candidates-1',
    approvalKey: 'approval-key:reviewed-candidates-1',
    snapshotHash: sha256({ snapshot: immutableSourceId }),
    reviewedManifestHash: sha256({ manifest: files.map(file => file.path) }),
    sourceType,
    sourceRef,
    immutableSourceId,
    workspaceId: 'tenant-a',
    requester,
    reviewer,
    selfApproval: requester === reviewer,
    leaseOwner: 'worker:1',
    leaseExpiresAt: LEASE_EXPIRES_AT,
    preparedAt: PREPARED_AT,
    fileCount: documents.length,
    totalBytes: documents.reduce((sum, document) => sum + document.sizeBytes, 0),
    documents,
  };
  batch.batchHash = sha256(batchCore(batch));
  return batch;
}

function trustedOptions(batch, overrides = {}) {
  return {
    now: overrides.now || new Date(Date.parse(batch.preparedAt) + 1_000),
    approvalId: overrides.approvalId || batch.approvalId,
    approvalKey: overrides.approvalKey || batch.approvalKey,
    snapshotHash: overrides.snapshotHash || batch.snapshotHash,
    reviewedManifestHash: overrides.reviewedManifestHash || batch.reviewedManifestHash,
    executionPlanHash: overrides.executionPlanHash || batch.executionPlanHash,
    batchHash: overrides.batchHash || batch.batchHash,
    sourceType: overrides.sourceType || batch.sourceType,
    sourceRef: overrides.sourceRef || batch.sourceRef,
    immutableSourceId: overrides.immutableSourceId || batch.immutableSourceId,
    workspaceId: overrides.workspaceId || batch.workspaceId,
    requester: overrides.requester || batch.requester,
    reviewer: overrides.reviewer || batch.reviewer,
    leaseOwner: overrides.leaseOwner || batch.leaseOwner,
  };
}

function rehashBatch(input) {
  const batch = structuredClone(input);
  batch.batchHash = sha256(batchCore(batch));
  return batch;
}

function candidateNodes(plan, subtype) {
  return plan.candidates.filter(candidate => candidate.kind === 'node' && candidate.sourceSubType === subtype);
}

test('reviewed batch produces a deterministic deeply frozen candidate plan without raw body bytes', () => {
  const secretBody = 'PRIVATE-BODY-MARKER-9f3c';
  const batch = buildBatch({
    files: [{
      path: 'docs/guide.md',
      content: [
        `Root ${secretBody}`,
        '# Alpha',
        `Alpha ${secretBody}`,
        '## Child',
        'Child body',
        '# Alpha',
        'Second body',
        '#### Not parsed as a heading',
        'Tail',
        '',
      ].join('\n'),
    }],
  });

  const first = buildReviewedExternalCandidatePlan(batch, trustedOptions(batch, {
    now: new Date(Date.parse(PREPARED_AT) + 1_000),
  }));
  const second = buildReviewedExternalCandidatePlan(batch, trustedOptions(batch, {
    now: new Date(Date.parse(PREPARED_AT) + 60_000),
  }));

  assert.equal(first.ok, true);
  assert.equal(first.plan.version, REVIEWED_EXTERNAL_CANDIDATE_PLAN_VERSION);
  assert.equal(first.plan.sectionCount, 4);
  assert.equal(first.plan.documentCount, 1);
  assert.equal(first.plan.candidateCount, 11);
  assert.deepEqual(second.plan, first.plan, 'valid wall-clock choices must not affect candidate identity');
  assert.match(first.plan.candidatePlanHash, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(Object.isFrozen(first.plan), true);
  assert.equal(Object.isFrozen(first.plan.candidates), true);
  assert.equal(Object.isFrozen(first.plan.candidates[0]), true);
  assert.equal(Object.isFrozen(first.plan.candidates.find(item => item.kind === 'edge').evidence), true);
  assert.throws(() => { first.plan.candidates[0].label = 'changed'; }, TypeError);

  const serialized = JSON.stringify(first.plan);
  assert.equal(serialized.includes(secretBody), false, 'body text must not be copied into candidates');
  assert.equal(serialized.includes('Second body'), false);
  assert.equal(serialized.includes('Not parsed as a heading'), false);

  const sections = candidateNodes(first.plan, 'reviewed_external_markdown_section');
  assert.deepEqual(sections.map(section => section.label), ['root', 'Alpha', 'Child', 'Alpha']);
  assert.notEqual(sections[1].nodeId, sections[3].nodeId, 'duplicate titles remain distinct by section identity');
  assert.equal(first.plan.candidates.every((item, index) => item.ordinal === index), true);
  assert.equal(first.plan.candidates.every(item => item.version === REVIEWED_EXTERNAL_CANDIDATE_VERSION), true);
});

test('self-approval remains visible but candidate generation makes no policy decision', () => {
  const batch = buildBatch({ requester: 'user:alice', reviewer: 'user:alice' });
  const result = buildReviewedExternalCandidatePlan(batch, trustedOptions(batch));
  assert.equal(result.ok, true);
  assert.equal(result.plan.selfApproval, true);
  assert.equal(result.plan.requester, 'user:alice');
  assert.equal(result.plan.reviewer, 'user:alice');
  assert.equal(Object.hasOwn(result.plan, 'decision'), false);
  assert.equal(Object.hasOwn(result.plan, 'policy'), false);
  assert.equal(result.plan.candidates.some(item => Object.hasOwn(item, 'decision')), false);
});

test('GitHub document candidates retain immutable blob identity without source access', () => {
  const batch = buildBatch({
    sourceType: 'github',
    files: [{ path: 'README.md', content: '# GitHub\nReviewed bytes.\n', blobSha: BLOB_SHA }],
  });
  const result = buildReviewedExternalCandidatePlan(batch, trustedOptions(batch));
  assert.equal(result.ok, true);
  const fileNode = candidateNodes(result.plan, 'reviewed_external_repo_file')[0];
  assert.equal(fileNode.blobSha, BLOB_SHA);
  assert.equal(fileNode.contentHash, batch.documents[0].contentHash);
  assert.equal(result.plan.sourceType, 'github');

  const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'reviewed-external-ingest-candidates.js'), 'utf8');
  assert.doesNotMatch(moduleSource, /require\(['"](?:fs|node:fs|https?|node:https?|child_process|node:child_process)['"]\)/u);
  assert.doesNotMatch(moduleSource, /\b(?:fetch|kernel|proposeNode|proposeEdge|runCapability)\s*\(/u);
});

test('all persistent identity bindings are required and mismatches fail closed', () => {
  const batch = buildBatch();
  const missing = trustedOptions(batch);
  delete missing.approvalKey;
  assert.equal(
    buildReviewedExternalCandidatePlan(batch, missing).code,
    'REVIEWED_CANDIDATE_TRUST_CONTEXT_REQUIRED',
  );

  const checks = [
    ['approvalId', 'approval:other'],
    ['approvalKey', 'approval-key:other'],
    ['snapshotHash', sha256({ other: 'snapshot' })],
    ['reviewedManifestHash', sha256({ other: 'manifest' })],
    ['executionPlanHash', sha256({ other: 'plan' })],
    ['batchHash', sha256({ other: 'batch' })],
    ['sourceType', 'github'],
    ['sourceRef', `${batch.sourceRef}:other`],
    ['immutableSourceId', sha256({ other: 'source' })],
    ['workspaceId', 'tenant-b'],
    ['requester', 'user:mallory'],
    ['reviewer', 'user:mallory'],
    ['leaseOwner', 'worker:other'],
  ];
  for (const [key, value] of checks) {
    assert.equal(
      buildReviewedExternalCandidatePlan(batch, trustedOptions(batch, { [key]: value })).code,
      'REVIEWED_CANDIDATE_TRUST_CONTEXT_MISMATCH',
      key,
    );
  }
});

test('batch and document schema, ordering, identity, content and aggregate bindings fail closed', () => {
  const base = buildBatch({
    files: [
      { path: 'docs/a.md', content: '# A\nA body.\n' },
      { path: 'docs/b.markdown', content: '# B\nB body.\n' },
    ],
  });

  const extraBatchField = structuredClone(base);
  extraBatchField.extra = true;
  assert.equal(buildReviewedExternalCandidatePlan(extraBatchField, trustedOptions(base)).code, 'REVIEWED_CANDIDATE_BATCH_FIELDS_INVALID');

  const wrongVersion = structuredClone(base);
  wrongVersion.version = 'huqan.reviewed-external-ingest-batch.v999';
  assert.equal(buildReviewedExternalCandidatePlan(wrongVersion, trustedOptions(base)).code, 'REVIEWED_CANDIDATE_BATCH_VERSION_UNSUPPORTED');

  const extraDocumentField = structuredClone(base);
  extraDocumentField.documents[0].extra = true;
  assert.equal(buildReviewedExternalCandidatePlan(extraDocumentField, trustedOptions(base)).code, 'REVIEWED_CANDIDATE_DOCUMENT_FIELDS_INVALID');

  const reversed = structuredClone(base);
  reversed.documents.reverse();
  assert.equal(buildReviewedExternalCandidatePlan(reversed, trustedOptions(base)).code, 'REVIEWED_CANDIDATE_DOCUMENT_ORDER_INVALID');

  const badPath = structuredClone(base);
  badPath.documents[0].path = '../a.md';
  assert.equal(buildReviewedExternalCandidatePlan(badPath, trustedOptions(base)).code, 'REVIEWED_CANDIDATE_DOCUMENT_PATH_INVALID');

  const badContent = structuredClone(base);
  badContent.documents[0].content = '# A\nTampered.\n';
  assert.equal(buildReviewedExternalCandidatePlan(badContent, trustedOptions(base)).code, 'REVIEWED_CANDIDATE_DOCUMENT_CONTENT_MISMATCH');

  const badSize = structuredClone(base);
  badSize.documents[0].sizeBytes += 1;
  assert.equal(buildReviewedExternalCandidatePlan(badSize, trustedOptions(base)).code, 'REVIEWED_CANDIDATE_DOCUMENT_CONTENT_MISMATCH');

  const badSourceRef = structuredClone(base);
  badSourceRef.documents[0].sourceRef = `${base.sourceRef}::wrong.md`;
  assert.equal(buildReviewedExternalCandidatePlan(badSourceRef, trustedOptions(base)).code, 'REVIEWED_CANDIDATE_DOCUMENT_SOURCE_REF_MISMATCH');

  const badDocumentId = structuredClone(base);
  badDocumentId.documents[0].documentId = sha256({ wrong: true });
  assert.equal(buildReviewedExternalCandidatePlan(badDocumentId, trustedOptions(base)).code, 'REVIEWED_CANDIDATE_DOCUMENT_ID_MISMATCH');

  const badTotal = structuredClone(base);
  badTotal.totalBytes += 1;
  assert.equal(buildReviewedExternalCandidatePlan(badTotal, trustedOptions(base)).code, 'REVIEWED_CANDIDATE_TOTAL_BYTES_MISMATCH');

  const reboundContent = structuredClone(base);
  reboundContent.documents[0].content = '# A\nRebound content.\n';
  reboundContent.documents[0].sizeBytes = Buffer.byteLength(reboundContent.documents[0].content, 'utf8');
  reboundContent.documents[0].contentHash = sha256Text(reboundContent.documents[0].content);
  reboundContent.documents[0].documentId = sha256({
    executionPlanHash: reboundContent.executionPlanHash,
    path: reboundContent.documents[0].path,
    contentHash: reboundContent.documents[0].contentHash,
  });
  reboundContent.totalBytes = reboundContent.documents.reduce((sum, document) => sum + document.sizeBytes, 0);
  const rebound = rehashBatch(reboundContent);
  assert.equal(buildReviewedExternalCandidatePlan(rebound, trustedOptions(rebound)).ok, true, 'fully rebound synthetic batch remains internally valid');

  const badBatchHash = structuredClone(base);
  badBatchHash.batchHash = sha256({ wrong: 'batch' });
  assert.equal(
    buildReviewedExternalCandidatePlan(badBatchHash, trustedOptions(badBatchHash)).code,
    'REVIEWED_CANDIDATE_BATCH_HASH_MISMATCH',
  );
});

test('lifecycle timing and self-approval inconsistencies fail closed', () => {
  const batch = buildBatch();
  const missingNow = trustedOptions(batch);
  delete missingNow.now;
  assert.equal(buildReviewedExternalCandidatePlan(batch, missingNow).code, 'REVIEWED_CANDIDATE_NOW_REQUIRED');

  assert.equal(
    buildReviewedExternalCandidatePlan(batch, trustedOptions(batch, {
      now: new Date(Date.parse(PREPARED_AT) - 1),
    })).code,
    'REVIEWED_CANDIDATE_NOT_YET_VALID',
  );
  assert.equal(
    buildReviewedExternalCandidatePlan(batch, trustedOptions(batch, {
      now: new Date(LEASE_EXPIRES_AT),
    })).code,
    'REVIEWED_CANDIDATE_LEASE_EXPIRED',
  );

  const invalidLease = structuredClone(batch);
  invalidLease.leaseExpiresAt = Date.parse(PREPARED_AT);
  assert.equal(buildReviewedExternalCandidatePlan(invalidLease, trustedOptions(invalidLease)).code, 'REVIEWED_CANDIDATE_LEASE_INVALID');

  const selfApprovalMismatch = structuredClone(batch);
  selfApprovalMismatch.selfApproval = true;
  assert.equal(
    buildReviewedExternalCandidatePlan(selfApprovalMismatch, trustedOptions(selfApprovalMismatch)).code,
    'REVIEWED_CANDIDATE_SELF_APPROVAL_INVALID',
  );
});

test('section count and title limits fail closed before candidate expansion', () => {
  const oversizedTitle = 'x'.repeat(MAX_REVIEWED_SECTION_TITLE_LENGTH + 1);
  const longTitleBatch = buildBatch({
    files: [{ path: 'docs/long.md', content: `# ${oversizedTitle}\nbody\n` }],
  });
  assert.equal(
    buildReviewedExternalCandidatePlan(longTitleBatch, trustedOptions(longTitleBatch)).code,
    'REVIEWED_CANDIDATE_SECTION_TITLE_INVALID',
  );

  const emptyLongTitleBatch = buildBatch({
    files: [{ path: 'docs/long-empty.md', content: `# ${oversizedTitle}\n` }],
  });
  assert.equal(
    buildReviewedExternalCandidatePlan(emptyLongTitleBatch, trustedOptions(emptyLongTitleBatch)).code,
    'REVIEWED_CANDIDATE_SECTION_TITLE_INVALID',
    'oversized empty headings must not be silently ignored',
  );

  const content = Array.from({ length: MAX_REVIEWED_EXTERNAL_SECTIONS + 1 }, (_, index) => `# S${index}\nx`).join('\n');
  const tooManySections = buildBatch({ files: [{ path: 'docs/many.md', content }] });
  assert.equal(
    buildReviewedExternalCandidatePlan(tooManySections, trustedOptions(tooManySections)).code,
    'REVIEWED_CANDIDATE_SECTION_LIMIT',
  );
});

test('GitHub blob and Markdown field separation fail closed', () => {
  const github = buildBatch({ sourceType: 'github' });
  const badBlob = structuredClone(github);
  badBlob.documents[0].blobSha = 'z'.repeat(40);
  assert.equal(buildReviewedExternalCandidatePlan(badBlob, trustedOptions(github)).code, 'REVIEWED_CANDIDATE_BLOB_SHA_REQUIRED');

  const markdown = buildBatch();
  const unexpectedBlob = structuredClone(markdown);
  unexpectedBlob.documents[0].blobSha = BLOB_SHA;
  assert.equal(buildReviewedExternalCandidatePlan(unexpectedBlob, trustedOptions(markdown)).code, 'REVIEWED_CANDIDATE_DOCUMENT_FIELDS_INVALID');
});
