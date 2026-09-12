'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { normalizeHookInvocation } = require('../lib/external-action-adapter');
const { normalizeExternalActionEnvelope } = require('../lib/external-action-envelope');
const { buildExternalActionAdmissionReceipt } = require('../lib/external-action-receipt');
const { recordBrowserHookOutcome, browserOutcomeReviewState } = require('../lib/browser-hook-outcome');
const { recordExternalActionReview } = require('../lib/external-action-guard');


function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-browser-outcome-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const payload = { hook_event_name: 'PostToolUse', tool_use_id: 'browser-1', session_id: 'session-1',
    tool_name: 'mcp__browser__navigate', tool_input: { url: 'https://example.com/page?token=private' },
    cwd: root, tool_response: { content: 'PRIVATE PAGE CONTENT' } };
  const envelope = normalizeExternalActionEnvelope(normalizeHookInvocation('claude-code', payload));
  const admission = buildExternalActionAdmissionReceipt(envelope, { decision: 'allow', reason: 'fixture', findings: [] });
  const receiptPath = path.join(root, 'receipts.jsonl');
  fs.writeFileSync(receiptPath, JSON.stringify(admission) + '\n');
  const receiptWriter = Object.assign(receipt => { fs.appendFileSync(receiptPath, JSON.stringify(receipt) + '\n'); return true; }, { path: receiptPath });
  return { root, payload, receiptPath, admission, receiptWriter };
}

test('browser post hook binds to admission and persists hash-only reported outcome', t => {
  const f = fixture(t);
  const result = recordBrowserHookOutcome('claude-code', f.payload, { receiptWriter: f.receiptWriter });
  assert.equal(result.ok, true);
  const lines = fs.readFileSync(f.receiptPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.equal(lines[1].metadata.outcomeStatus, 'executed');
  assert.equal(lines[1].metadata.effectVerification, 'reported');
  assert.equal(lines[1].metadata.destination.url, 'https://example.com/page');
  assert.equal(JSON.stringify(lines).includes('PRIVATE PAGE CONTENT'), false);
  // #2139: the monitor verdict surfaces on the hook result. With no baseline
  // configured the default-observe monitor flags the outcome
  // observe_quarantine_required, so a human decision is owed.
  assert.equal(result.reviewRequired, true);
  assert.equal(result.quarantined, false);
  assert.equal(result.demotedTo, null);
  assert.equal(result.monitoringDecision, 'observe_quarantine_required');
  assert.deepEqual(recordBrowserHookOutcome('claude-code', f.payload, { receiptWriter: f.receiptWriter }), { ok: true, duplicate: true });
});

test('browser outcomes reject changed workspace, session, arguments and tampered receipts', t => {
  const f = fixture(t);
  for (const change of [{ session_id: 'other' }, { tool_use_id: 'other' }, { tool_input: { url: 'https://other.example' } }]) {
    assert.throws(() => recordBrowserHookOutcome('claude-code', { ...f.payload, ...change }, { receiptWriter: f.receiptWriter }));
  }
  assert.throws(() => recordBrowserHookOutcome('claude-code', f.payload, { receiptWriter: f.receiptWriter, workspaceId: 'other' }));
  fs.writeFileSync(f.receiptPath, JSON.stringify({ ...f.admission, reason: 'tampered' }) + '\n');
  assert.throws(() => recordBrowserHookOutcome('claude-code', f.payload, { receiptWriter: f.receiptWriter }), /mismatch/);
});

test('real CLI records browser failure in durable receipt log without exposing error content', t => {
  const f = fixture(t);
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../bin/huqan-gate-hook.js'), 'browser-outcome',
    '--profile', 'claude-code', '--receipt-log', f.receiptPath,
    '--memory-path', path.join(f.root, 'memory.json'), '--db-path', path.join(f.root, 'memory.db')], {
    cwd: f.root, encoding: 'utf8', timeout: 30000,
    input: JSON.stringify({ ...f.payload, hook_event_name: 'PostToolUseFailure', error: 'PRIVATE ERROR' }),
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {});
  const lines = fs.readFileSync(f.receiptPath, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.at(-1).metadata.outcomeStatus, 'failed');
  assert.equal(JSON.stringify(lines).includes('PRIVATE ERROR'), false);
});

test('browserOutcomeReviewState resolves the review chain for a recorded outcome', t => {
  const f = fixture(t);
  const result = recordBrowserHookOutcome('claude-code', f.payload, { receiptWriter: f.receiptWriter });
  assert.equal(result.ok, true);
  const state = browserOutcomeReviewState(f.receiptPath, result.receiptId);
  assert.equal(state.outcome.receiptId, result.receiptId);
  assert.equal(state.reviewRequired, true);
  assert.equal(state.reviewed, false);
  assert.equal(state.latestReview, null);

  const review = recordExternalActionReview(state.outcome, { decision: 'approved', actor: 'human-reviewer' }, { receiptWriter: f.receiptWriter });
  assert.equal(review.ok, true);
  const after = browserOutcomeReviewState(f.receiptPath, result.receiptId);
  assert.equal(after.reviewed, true);
  assert.equal(after.latestReview.metadata.reviewDecision, 'approved');
  assert.equal(after.latestReview.metadata.reviewActor, 'human-reviewer');
});

test('browserOutcomeReviewState skips a tampered outcome and throws without an id', t => {
  const f = fixture(t);
  const result = recordBrowserHookOutcome('claude-code', f.payload, { receiptWriter: f.receiptWriter });
  const tampered = { ...JSON.parse(fs.readFileSync(f.receiptPath, 'utf8').trim().split('\n')[1]), reason: 'tampered' };
  fs.writeFileSync(f.receiptPath, JSON.stringify(f.admission) + '\n' + JSON.stringify(tampered) + '\n');
  const state = browserOutcomeReviewState(f.receiptPath, result.receiptId);
  assert.equal(state.outcome, null);
  assert.throws(() => browserOutcomeReviewState(f.receiptPath, ''), /outcome receipt id/);
});
