'use strict';

/**
 * Evidence for the first-run quickstart path.
 *
 * The behaviours that matter are not "it prints something" but:
 *   1. the mutation gate is still consulted and still answers `review`;
 *   2. the canonical write happens only via huqan.approve;
 *   3. a real Trust Receipt is materialized;
 *   4. a failure anywhere fails closed rather than reporting success;
 *   5. the CLI command does not write to the caller's canonical memory.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  runQuickstart,
  formatQuickstartResult,
  DEFAULT_STATEMENT,
} = require('../lib/quickstart');

/** Minimal fakes so the flow is testable without a SQLite backend. */
function makeFakes(overrides = {}) {
  const calls = [];
  const callTool = (kernel, request) => {
    calls.push(request.name);
    if (request.name === 'huqan.learn') {
      if (overrides.learnReturnsNoApproval) return { ok: false, error: { message: 'blocked' } };
      return {
        ok: false,
        gate: { decision: 'review', reason: 'mutating_requires_review' },
        approval: { id: 'approval-test-1' },
      };
    }
    if (request.name === 'huqan.approve') {
      if (overrides.approveFails) return { ok: false, error: { message: 'nope' } };
      return { ok: true, data: { decision: 'approved' } };
    }
    throw new Error(`unexpected tool ${request.name}`);
  };
  const kernel = {
    graph: {},
    verify: () => ({ data: { status: 'verified', confidence: 0.9 } }),
  };
  const buildTrustReceipt = () => (overrides.emptyReceipt ? null : {
    receiptId: 'receipt-test-1',
    claim: 'cancer',
    status: 'canonical',
    workspaceId: 'default',
    trustPolicyVersion: '0.8.0',
    provenance: { sourceRef: 'mcp.huqan.learn.approval-test-1' },
    auditTrail: [{ auditId: 'a1' }],
  });
  return { calls, callTool, kernel, buildTrustReceipt };
}

test('quickstart reaches a Trust Receipt through review then approve', () => {
  const { calls, callTool, kernel, buildTrustReceipt } = makeFakes();

  const result = runQuickstart({ kernel, callTool, buildTrustReceipt, approvalStore: {} });

  assert.equal(result.ok, true);
  assert.equal(result.receipt.receiptId, 'receipt-test-1');
  assert.equal(result.approvalId, 'approval-test-1');
  // The write must be proposed and approved, in that order, via those tools.
  assert.deepEqual(calls, ['huqan.learn', 'huqan.approve']);
});

test('quickstart records the gate decision as review, not allow', () => {
  const { callTool, kernel, buildTrustReceipt } = makeFakes();

  const result = runQuickstart({ kernel, callTool, buildTrustReceipt, approvalStore: {} });

  const propose = result.steps.find(step => step.step === 'propose');
  assert.match(propose.detail, /review/);
  assert.match(propose.detail, /mutating_requires_review/);
});

test('quickstart fails closed when huqan.learn queues no approval', () => {
  const { calls, callTool, kernel, buildTrustReceipt } = makeFakes({ learnReturnsNoApproval: true });

  const result = runQuickstart({ kernel, callTool, buildTrustReceipt, approvalStore: {} });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'QUICKSTART_NO_APPROVAL');
  assert.equal(result.receipt, null);
  // Critically: it must not try to approve something that was never queued.
  assert.deepEqual(calls, ['huqan.learn']);
});

test('quickstart fails closed when the approval cannot be applied', () => {
  const { callTool, kernel, buildTrustReceipt } = makeFakes({ approveFails: true });

  const result = runQuickstart({ kernel, callTool, buildTrustReceipt, approvalStore: {} });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'QUICKSTART_APPROVAL_FAILED');
  assert.equal(result.receipt, null);
});

test('quickstart fails closed when no Trust Receipt materializes', () => {
  const { callTool, kernel, buildTrustReceipt } = makeFakes({ emptyReceipt: true });

  const result = runQuickstart({ kernel, callTool, buildTrustReceipt, approvalStore: {} });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'QUICKSTART_RECEIPT_EMPTY');
});

test('quickstart reports missing dependencies instead of throwing', () => {
  const result = runQuickstart({});

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'QUICKSTART_DEPS_MISSING');
});

test('formatQuickstartResult surfaces the failure code on failure', () => {
  const output = formatQuickstartResult({
    ok: false,
    steps: [{ step: 'propose', ok: false, detail: 'blocked' }],
    error: { code: 'QUICKSTART_NO_APPROVAL', message: 'nothing was written' },
  });

  assert.match(output, /QUICKSTART_NO_APPROVAL/);
  assert.match(output, /nothing was written/);
  assert.doesNotMatch(output, /Trust Receipt\n {2}receiptId/);
});

test('the seeded statement uses a supported relation marker', () => {
  // A statement HUQAN's NLP layer cannot parse would demo a failure, so the
  // default must stay within the explicit relation markers that are supported.
  assert.match(DEFAULT_STATEMENT, /\b(causes|prevents|enables|depends on)\b/);
});

test('CLI quickstart produces a receipt without touching the caller memory', (t) => {
  try {
    require.resolve('better-sqlite3');
  } catch (_) {
    return t.skip('better-sqlite3 is unavailable');
  }

  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-qs-cli-'));
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const CLI = require('../cli');
    const cli = new CLI();
    const output = cli.execute('quickstart', '');

    assert.match(output, /Trust Receipt/);
    assert.match(output, /receiptId\s+: [0-9a-f-]{8,}/);
    assert.match(output, /status\s+: canonical/);
    // The gate must still have answered review, not allow.
    assert.match(output, /mutating_requires_review/);

    // The caller's own graph must still be empty: quickstart runs in its own
    // throwaway store and must never write to canonical user memory.
    const stats = cli.kernel.graph.getStats();
    assert.equal(stats.nodes, 0, 'quickstart must not write to the caller graph');
    assert.equal(stats.edges, 0, 'quickstart must not write to the caller graph');
  } finally {
    process.chdir(previous);
  }
});
