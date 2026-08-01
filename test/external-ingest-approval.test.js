'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildExternalIngestApprovalFromResolution,
  resolveExternalIngestApproval,
  verifyExternalIngestApproval,
} = require('../lib/external-ingest-approval');
const {
  buildImmutableExternalSourceSnapshot,
  buildIngestApprovalSnapshot,
} = require('../lib/ingest');

const REQUESTED_AT = '2026-08-01T01:00:00.000Z';
const EXPIRES_AT = '2026-08-01T01:15:00.000Z';
const COMMIT_SHA = 'a'.repeat(40);
const TREE_SHA = 'b'.repeat(40);

function gitBlobSha(bytes) {
  return crypto.createHash('sha1')
    .update(Buffer.from(`blob ${bytes.length}\0`, 'utf8'))
    .update(bytes)
    .digest('hex');
}

function response(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; },
  };
}

function githubFetchFor(bytes, commitSha = COMMIT_SHA) {
  const blobSha = gitBlobSha(bytes);
  return async (url) => {
    if (url.endsWith(`/git/commits/${commitSha}`)) {
      return response({ sha: commitSha, tree: { sha: TREE_SHA } });
    }
    if (url.includes(`/git/trees/${TREE_SHA}?recursive=1`)) {
      return response({
        sha: TREE_SHA,
        truncated: false,
        tree: [{ type: 'blob', mode: '100644', path: 'README.md', sha: blobSha }],
      });
    }
    if (url.endsWith(`/git/blobs/${blobSha}`)) {
      return response({
        sha: blobSha,
        encoding: 'base64',
        content: bytes.toString('base64'),
        size: bytes.length,
      });
    }
    return response({}, 404);
  };
}

function request(overrides = {}) {
  return {
    sourceType: 'github',
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: COMMIT_SHA,
    paths: ['README.md'],
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    idempotencyKey: 'req-123',
    requestedAt: REQUESTED_AT,
    expiresAt: EXPIRES_AT,
    token: 'ghp_SECRET_SHOULD_NOT_PERSIST',
    ...overrides,
  };
}

test('trusted GitHub resolution builds a bounded approval from reviewed immutable bytes', async () => {
  const result = await resolveExternalIngestApproval(request(), {
    fetchImpl: githubFetchFor(Buffer.from('# HUQAN\n', 'utf8')),
  });

  assert.equal(result.ok, true);
  const { approval } = result;
  assert.equal(approval.sourceType, 'github');
  assert.equal(approval.sourceRef, `https://github.com/ali-ulu/huqan@${COMMIT_SHA}`);
  assert.equal(approval.immutableSourceId, COMMIT_SHA);
  assert.equal(approval.requester, 'user:alice');
  assert.equal(approval.workspaceId, 'tenant-a');
  assert.equal(approval.payload.action, 'ingest_reviewed_external_snapshot');
  assert.equal(approval.payload.reviewedSource.files[0].content, '# HUQAN\n');
  assert.match(approval.requestIdentityHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(approval.snapshotHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(approval.approvalKey, /^http\.ingest\.external\.[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(result).includes('ghp_SECRET'), false);

  const verified = verifyExternalIngestApproval(approval, { now: '2026-08-01T01:05:00.000Z' });
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.approval, approval);
});

test('request identity is independent of content so changed content can conflict instead of opening a silent second request', () => {
  const firstSnapshot = buildImmutableExternalSourceSnapshot({
    sourceType: 'github',
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: 'a'.repeat(40),
    files: [{ path: 'README.md', content: '# First' }],
  });
  const secondSnapshot = buildImmutableExternalSourceSnapshot({
    sourceType: 'github',
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: 'c'.repeat(40),
    files: [{ path: 'README.md', content: '# Changed' }],
  });

  const first = buildExternalIngestApprovalFromResolution(request(), firstSnapshot);
  const second = buildExternalIngestApprovalFromResolution(request({ commitSha: 'c'.repeat(40) }), secondSnapshot);

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.approval.requestIdentityHash, second.approval.requestIdentityHash);
  assert.equal(first.approval.approvalKey, second.approval.approvalKey);
  assert.notEqual(first.approval.snapshotHash, second.approval.snapshotHash);
  assert.notEqual(first.approval.reviewedManifestHash, second.approval.reviewedManifestHash);
});

test('invalid identity and validity-window input fails before GitHub source access', async () => {
  let fetchCalls = 0;
  const fetchImpl = async () => {
    fetchCalls += 1;
    return response({}, 500);
  };

  const cases = [
    request({ requester: '' }),
    request({ workspaceId: '' }),
    request({ idempotencyKey: '' }),
    request({ requestedAt: 'not-a-date' }),
    request({ expiresAt: REQUESTED_AT }),
  ];

  for (const data of cases) {
    const result = await resolveExternalIngestApproval(data, { fetchImpl });
    assert.equal(result.ok, false);
  }
  assert.equal(fetchCalls, 0);
});

test('approval verification rejects snapshot, identity, hash, and unknown-field tampering', async () => {
  const built = await resolveExternalIngestApproval(request(), {
    fetchImpl: githubFetchFor(Buffer.from('# HUQAN\n', 'utf8')),
  });
  assert.equal(built.ok, true);

  const cases = [];

  const contentTamper = structuredClone(built.approval);
  contentTamper.payload.reviewedSource.files[0].content = '# attacker';
  cases.push(contentTamper);

  const requesterTamper = structuredClone(built.approval);
  requesterTamper.payload.requester = 'user:mallory';
  cases.push(requesterTamper);

  const hashTamper = structuredClone(built.approval);
  hashTamper.snapshotHash = `sha256:${'0'.repeat(64)}`;
  cases.push(hashTamper);

  const unknownField = structuredClone(built.approval);
  unknownField.token = 'secret';
  cases.push(unknownField);

  const leakedRoot = structuredClone(built.approval);
  leakedRoot.payload.reviewedSource.rootPath = '/private/workspace';
  cases.push(leakedRoot);

  for (const approval of cases) {
    const verdict = verifyExternalIngestApproval(approval, { now: '2026-08-01T01:05:00.000Z' });
    assert.equal(verdict.ok, false);
  }
});

test('execution context expectations fail closed on workspace, requester, approval-key, or snapshot-hash mismatch', async () => {
  const built = await resolveExternalIngestApproval(request(), {
    fetchImpl: githubFetchFor(Buffer.from('# HUQAN\n', 'utf8')),
  });
  assert.equal(built.ok, true);
  const approval = built.approval;
  const now = '2026-08-01T01:05:00.000Z';

  const checks = [
    { expectedWorkspaceId: 'tenant-b' },
    { expectedRequester: 'user:mallory' },
    { expectedApprovalKey: 'http.ingest.external.wrong' },
    { expectedSnapshotHash: `sha256:${'0'.repeat(64)}` },
  ];
  for (const options of checks) {
    const verdict = verifyExternalIngestApproval(approval, { now, ...options });
    assert.equal(verdict.ok, false);
  }

  const accepted = verifyExternalIngestApproval(approval, {
    now,
    expectedWorkspaceId: approval.workspaceId,
    expectedRequester: approval.requester,
    expectedApprovalKey: approval.approvalKey,
    expectedSnapshotHash: approval.snapshotHash,
  });
  assert.equal(accepted.ok, true);
});

test('approval validity window is fail-closed before start and at expiry', async () => {
  const built = await resolveExternalIngestApproval(request(), {
    fetchImpl: githubFetchFor(Buffer.from('# HUQAN\n', 'utf8')),
  });
  assert.equal(built.ok, true);

  const before = verifyExternalIngestApproval(built.approval, { now: '2026-08-01T00:59:59.999Z' });
  assert.equal(before.ok, false);
  assert.equal(before.code, 'EXTERNAL_APPROVAL_NOT_YET_VALID');

  const inside = verifyExternalIngestApproval(built.approval, { now: '2026-08-01T01:14:59.999Z' });
  assert.equal(inside.ok, true);

  const expired = verifyExternalIngestApproval(built.approval, { now: EXPIRES_AT });
  assert.equal(expired.ok, false);
  assert.equal(expired.code, 'EXTERNAL_APPROVAL_EXPIRED');
});

test('trusted Markdown resolution builds an approval without persisting filesystem-only input extras', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-external-approval-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'claim.md'), '# Claim\n', 'utf8');

    const result = await resolveExternalIngestApproval({
      sourceType: 'markdown',
      rootPath: root,
      path: 'docs/claim.md',
      requester: 'user:bob',
      workspaceId: 'tenant-b',
      idempotencyKey: 'md-1',
      requestedAt: REQUESTED_AT,
      expiresAt: EXPIRES_AT,
      authorization: 'Bearer secret',
    });

    assert.equal(result.ok, true);
    assert.equal(result.approval.sourceType, 'markdown');
    assert.equal(result.approval.payload.reviewedSource.files[0].content, '# Claim\n');
    assert.equal(JSON.stringify(result).includes('Bearer secret'), false);
    assert.equal(JSON.stringify(result).includes(root), false, 'host rootPath must not persist in the approval payload');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('raw external approval gate remains closed', () => {
  for (const sourceType of ['github', 'repo', 'markdown']) {
    const result = buildIngestApprovalSnapshot(request({ sourceType }));
    assert.equal(result.ok, false);
    assert.equal(result.code, 'INGEST_SNAPSHOT_REQUIRED');
  }
});
