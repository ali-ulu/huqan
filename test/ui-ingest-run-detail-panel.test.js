'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { readHtml } = require('./helpers/dashboard-source');
const { publicWorkflowManifest } = require('../lib/workflow-contract');
const { buildIngestWorkflowRun } = require('../lib/ingest-workflow-run');

const script = () => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'ingest-run-detail.js'), 'utf8');

function approval(status, receiptId = '') {
  return {
    id: `run-${status}`,
    status,
    context: {
      snapshot: {
        workspaceId: 'alpha', sourceType: 'manual', sourceRef: 'note.md',
        snapshotHash: 'digest-1', idempotencyKey: 'key-1',
      },
      receipt: receiptId ? { receiptId } : null,
    },
  };
}

test('the dashboard has a real ingest run lookup panel and loads its script', () => {
  const html = readHtml();
  assert.match(html, /id="v-ingest-run"/);
  assert.match(html, /id="ingestrunid"/);
  assert.match(html, /id="ingestrunsummary"/);
  assert.match(html, /id="ingestrunraw"/);
  assert.match(html, /<script src="\/js\/ingest-run-detail\.js"><\/script>/);
});

test('the panel follows the advertised route template with workspace and auth', () => {
  const capability = publicWorkflowManifest().workflows.find(item => item.workflowId === 'ingest-run-detail');
  assert.equal(capability.availability.ui, true);
  assert.equal(capability.method, 'GET');
  assert.equal(capability.route, '/api/v2/ingest/runs/{id}');

  const source = script();
  assert.match(source, /find\(item => item\.workflowId === 'ingest-run-detail'\)/);
  assert.match(source, /capability\.route\.replace\('\{id\}', encodeURIComponent\(runId\)\)/);
  assert.match(source, /new URLSearchParams\(\{ workspaceId: workspaceId\(\) \}\)/);
  assert.match(source, /Authorization: `Bearer \$\{key\}`/);
  assert.match(source, /body\.data\.workflowId !== 'ingest-run-detail'/);
});

test('approval-wait, running, completed, rejected, and failed projections retain recovery fields', () => {
  const expected = {
    pending: ['review_required', 'awaiting_review', 'review'],
    executing: ['queued', 'executing', 'poll'],
    approved: ['completed', 'finalized', null],
    rejected: ['blocked', 'rejected', null],
    failed: ['failed', 'reconciliation_required', null],
  };
  for (const [status, [publicStatus, phase, nextAction]] of Object.entries(expected)) {
    const run = buildIngestWorkflowRun(approval(status, status === 'approved' ? 'receipt-1' : ''));
    assert.equal(run.status, publicStatus);
    assert.equal(run.phase, phase);
    assert.equal(run.nextAction, status === 'approved' ? 'read_receipt' : nextAction);
    assert.deepEqual(run.progress, { completed: status === 'approved' ? 1 : 0, total: 1, hasMore: false });
    assert.equal(run.sourceManifest.workspaceId, 'alpha');
    assert.equal(run.sourceManifest.sourceDigest, 'digest-1');
    assert.equal(run.retry.allowed, false);
    assert.equal(run.resume.allowed, false);
  }
  assert.equal(buildIngestWorkflowRun(approval('approved', 'receipt-1')).receiptId, 'receipt-1');
});

test('the panel renders every state-bearing field and links a final receipt', () => {
  const source = script();
  for (const field of ['Status', 'Phase', 'Run ID', 'Approval', 'Workspace', 'Source', 'Digest',
    'Idempotency key', 'Progress', 'Next action', 'Retry', 'Resume', 'Receipt']) {
    assert.match(source, new RegExp(`\\['${field}'`), `${field} must remain visible`);
  }
  assert.match(source, /data-ingest-receipt/);
  assert.match(source, /byId\('emode'\)\.value = 'receiptId'/);
  assert.match(source, /byId\('eload'\)\.click\(\)/);
  assert.match(source, /data-ingest-run/);
  assert.match(source, /MutationObserver/);
});
