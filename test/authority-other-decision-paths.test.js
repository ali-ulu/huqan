'use strict';

// ADR-016: decision surfaces outside handleMcpApprovalDecision that cannot
// carry the approval authority's signed decision decide nothing where an
// authority is installed.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createReviewService } = require('../lib/pr-guardian/review-service');
const { createIngestApprovalRuntime } = require('../lib/http/ingest-approval-runtime');
const { createKernel } = require('../lib/kernel-factory');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SERVICE = () => ({ mode: 'service', boundary: 'os-service', pin: {} });
const UNUSABLE = () => ({ mode: 'required_unavailable', reason: 'pin_malformed' });
const LEGACY = () => ({ mode: 'legacy', boundary: 'same-user' });

function recordingStorage() {
  const calls = [];
  return {
    calls,
    saveToolApprovalIfAbsent: () => ({}),
    getToolApprovalById: () => { calls.push('get'); return { id: 'pr_1', tool: 'github.pr.guardian' }; },
    resolveToolApproval: () => { calls.push('resolve'); return null; },
    rejectToolApproval: () => { calls.push('reject'); return null; },
  };
}

test('PR Guardian decisions are refused before the store is touched where an authority is installed', () => {
  for (const resolveAuthorityMode of [SERVICE, UNUSABLE]) {
    const storage = recordingStorage();
    const service = createReviewService({ storage, resolveAuthorityMode });
    for (const decision of ['approved', 'rejected']) {
      assert.deepEqual(service.decide('pr_1', decision), { ok: false, status: 409, code: 'AUTHORITY_DECISION_REQUIRED' });
    }
    assert.deepEqual(storage.calls, []);
  }
});

test('PR Guardian decisions behave as before without an authority', () => {
  const storage = recordingStorage();
  createReviewService({ storage, resolveAuthorityMode: LEGACY }).decide('pr_1', 'approved');
  assert.ok(storage.calls.includes('resolve'));
});

test('the HTTP ingest approval route decides nothing where an authority is installed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-authority-ingest-'));
  const saved = { mem: process.env.HUQAN_MEMORY_PATH, db: process.env.HUQAN_DB_PATH };
  process.env.HUQAN_MEMORY_PATH = path.join(dir, 'memory.json');
  process.env.HUQAN_DB_PATH = path.join(dir, 'memory.db');
  const kernel = createKernel({ loadPlugins: false });
  t.after(() => {
    kernel.graph?.close?.();
    for (const [key, value] of [['HUQAN_MEMORY_PATH', saved.mem], ['HUQAN_DB_PATH', saved.db]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  for (const resolveAuthorityMode of [SERVICE, UNUSABLE]) {
    const runtime = createIngestApprovalRuntime({ kernel, readEnvironment: () => undefined, ensureRuntime: () => {},
      resolveAuthorityMode });
    const outcome = await runtime.decide({ approvalId: 'apr_1', workspaceId: 'default', decision: 'approved', reason: '' });
    assert.equal(outcome.status, 409);
    assert.equal(outcome.error.code, 'AUTHORITY_DECISION_REQUIRED');
  }
});
