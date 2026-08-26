const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const plugin = require('../plugins/self-healer-audit');

const repoRoot = path.resolve(__dirname, '..');

function securityFinding(overrides = {}) {
  return {
    kind: 'security',
    severity: 'high',
    confidence: 0.9,
    title: 'Bounded plugin wiring finding',
    summary: 'A finding used to verify the governed plugin chain.',
    evidence: [{ type: 'manual', ref: 'test:wiring', detail: 'bounded evidence' }],
    affectedFiles: ['server.js'],
    suggestedTests: ['node --test test/self-healer-audit-plugin-wiring.test.js'],
    riskFlags: ['runtime_mutation'],
    ...overrides,
  };
}

test('governFindings routes raw findings through classifier and audit-runner before dry-run', () => {
  const result = plugin._test.governFindings({}, [securityFinding()], {
    workspaceId: 'default',
    repoRoot,
    maxIterationsPerWindow: 10,
    now: 1_700_000_000_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.auditReport.mode, 'audit_only');
  assert.equal(result.auditReport.findingCount, 1);
  assert.equal(result.auditReport.findings[0].kind, 'security');
  assert.equal(result.auditReport.findings[0].workspaceId, 'default');
  assert.equal(result.auditReportId, result.auditReport.reportId);
  assert.equal(result.applied, false);
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].decision, 'require_review');
  assert.equal(result.proposals[0].approvalRequest.requestedVerdict, 'review');
});

test('governFindings keeps budget blocking and does not create proposals', () => {
  const kernel = {};
  const result = plugin._test.governFindings(kernel, [securityFinding()], {
    workspaceId: 'default',
    repoRoot,
    maxIterationsPerWindow: 1,
    now: 1_700_000_000_000,
  });

  const blocked = plugin._test.governFindings(kernel, [securityFinding()], {
    workspaceId: 'default',
    repoRoot,
    maxIterationsPerWindow: 1,
    now: 1_700_000_001_000,
  });

  assert.equal(blocked.blockedByBudget, true);
  assert.equal(blocked.processedFindingCount, 0);
  assert.deepEqual(blocked.proposals, []);
  assert.equal(blocked.applied, false);
});

test('reachability audit exposes audit report evidence without autonomous action', () => {
  const result = plugin._test.runReachabilityAudit({}, {
    workspaceId: 'default',
    root: repoRoot,
    repoRoot,
    maxIterationsPerWindow: 10,
    now: 1_700_000_000_000,
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, undefined);
  assert.equal(typeof result.auditReportId, 'string');
  assert.equal(result.auditReport.mode, 'audit_only');
  assert.equal(result.applied, false);
});

test('unsupported raw finding fails closed at the plugin boundary', () => {
  assert.throws(() => plugin._test.governFindings({}, [{ title: 'unclassified' }], {
    workspaceId: 'default',
    repoRoot,
  }), /Unable to classify raw finding type/);
});

test('optional approval bridge materializes review cases but never applies or executes', () => {
  const calls = [];
  const approvalRuntime = {
    createReviewCase(input) {
      calls.push(input);
      return {
        ok: true,
        replayed: false,
        case: { caseId: input.caseId },
        receipt: { receiptId: 'receipt-self-healer-001' },
      };
    },
  };

  const result = plugin._test.governFindings({}, [securityFinding()], {
    workspaceId: 'default',
    repoRoot,
    approvalRuntime,
    requesterContext: { actor: 'self-healer-requester' },
    maxIterationsPerWindow: 10,
    now: 1_700_000_000_000,
  });

  assert.equal(result.approvalBridge.ok, true);
  assert.equal(result.approvalBridge.status, 'materialized');
  assert.equal(result.approvalBridge.created.length, 1);
  assert.equal(result.approvalBridge.blocked.length, 0);
  assert.equal(result.approvalBridge.applied, false);
  assert.equal(result.approvalBridge.executed, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].firewallDecision, 'review');
  assert.equal(calls[0].action.requestedEffect, 'review');
  assert.equal(calls[0].action.connectorRef, 'self-healer');
  assert.equal(Object.hasOwn(calls[0].action, 'patch'), false);
});

test('default plugin run makes approval bridge state explicit when no runtime is injected', () => {
  const result = plugin._test.governFindings({}, [securityFinding()], {
    workspaceId: 'default',
    repoRoot,
    maxIterationsPerWindow: 10,
    now: 1_700_000_000_000,
  });

  assert.equal(result.approvalBridge.ok, false);
  assert.equal(result.approvalBridge.status, 'not_configured');
  assert.equal(result.approvalBridge.applied, false);
  assert.equal(result.approvalBridge.executed, false);
});
