'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_EXTERNAL_APPROVAL_WINDOW_MS,
  resolveExternalIngestApproval,
} = require('../lib/external-ingest-approval');

test('external approval validity window is capped at 15 minutes before source access', async () => {
  assert.equal(MAX_EXTERNAL_APPROVAL_WINDOW_MS, 15 * 60 * 1000);

  let fetchCalls = 0;
  const result = await resolveExternalIngestApproval({
    sourceType: 'github',
    repoUrl: 'https://github.com/ali-ulu/huqan',
    commitSha: 'a'.repeat(40),
    paths: ['README.md'],
    requester: 'user:alice',
    workspaceId: 'tenant-a',
    idempotencyKey: 'window-too-long',
    requestedAt: '2026-08-01T01:00:00.000Z',
    expiresAt: '2026-08-01T01:15:00.001Z',
  }, {
    fetchImpl: async () => {
      fetchCalls += 1;
      throw new Error('source access must not occur');
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'EXTERNAL_APPROVAL_WINDOW_TOO_LONG');
  assert.equal(fetchCalls, 0);
});
