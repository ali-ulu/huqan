'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const {
  createHumanOversightApprovalRuntime,
  RUNTIME_REASONS,
} = require('../lib/human-oversight-approval-runtime');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-942-'));
  const clockState = { now: Date.parse('2026-08-19T10:00:00.000Z') };
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  const ledger = createTrustEvidenceLedger({ graph });
  const resolveIdentity = ({ role, context, action }) => ({
    decision: context?.deny ? 'block' : 'allow',
    identity: context?.deny ? null : {
      identityRef: context?.identityRef || (role === 'requester' ? 'agent:worker-a' : 'human:operator-a'),
      identityHash: context?.identityHash || (role === 'requester' ? 'hash-worker-a' : 'hash-operator-a'),
      workspaceId: action.workspaceId,
      agentId: role === 'requester' ? 'agent-a' : '',
      ownerActorId: role === 'requester' ? 'owner-a' : context?.identityRef || 'operator-a',
      authorityRef: 'authority:workspace-a',
    },
  });
  const runtime = createHumanOversightApprovalRuntime({
    graph,
    ledger,
    resolveIdentity,
    firewallEvaluator: () => ({ decision: 'allow', metadata: { firewallVersion: 'agent-action-firewall-v1' } }),
    clock: () => clockState.now,
  });
  return { dir, graph, ledger, runtime, clockState };
}

function action(overrides = {}) {
  return {
    workspaceId: 'workspace-a',
    actionFingerprint: 'action:send-email:001',
    connectorRef: 'connector:mcp-mail',
    resourceRef: 'resource:mailbox-a',
    policyVersion: 'policy-v1',
    firewallVersion: 'agent-action-firewall-v1',
    requestedVerdict: 'review',
    requestedEffect: 'send one bounded email',
    actionType: 'send_email',
    toolName: 'mcp.mail.send',
    target: 'mailbox-a',
    agentId: 'agent-a',
    evidenceRefs: ['evidence:approval-context'],
    provenanceRefs: ['provenance:request-001'],
    ...overrides,
  };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('critical-risk approvals require a second distinct approver before execution is authorized', () => {
  const { runtime, dir } = fixture();
  try {
    const created = runtime.createReviewCase({
      action: action({ riskScore: 90 }), firewallDecision: 'review', requesterContext: {},
      policy: { approvalCooldownMs: 0, criticalRiskScore: 80, requiredApprovers: 2 },
    });
    const first = runtime.decide({ caseId: created.case.caseId, decisionType: 'approve', approverContext: { identityRef: 'human:one', identityHash: 'one' }, evidenceDigest: created.case.evidenceDigest });
    assert.equal(first.ok, true);
    assert.equal(first.case.status, 'escalated');
    const same = runtime.decide({ caseId: created.case.caseId, decisionType: 'approve', approverContext: { identityRef: 'human:one', identityHash: 'one' }, evidenceDigest: created.case.evidenceDigest });
    assert.equal(same.ok, false);
    assert.equal(same.reason, RUNTIME_REASONS.QUORUM_DISTINCT_APPROVER_REQUIRED);
    const second = runtime.decide({ caseId: created.case.caseId, decisionType: 'approve', approverContext: { identityRef: 'human:two', identityHash: 'two' }, evidenceDigest: created.case.evidenceDigest });
    assert.equal(second.ok, true);
    assert.equal(second.case.status, 'approved');
  } finally { cleanup(dir); }
});

test('approval cooldown is scoped to the same approver and workspace', () => {
  const { runtime, dir } = fixture();
  try {
    const first = runtime.createReviewCase({ action: action({ actionFingerprint: 'action:one', riskScore: 90 }), firewallDecision: 'review', requesterContext: {}, policy: { approvalCooldownMs: 60_000, requiredApprovers: 1 } });
    assert.equal(runtime.decide({ caseId: first.case.caseId, decisionType: 'approve', approverContext: { identityRef: 'human:one', identityHash: 'one' }, evidenceDigest: first.case.evidenceDigest }).ok, true);
    const second = runtime.createReviewCase({ action: action({ actionFingerprint: 'action:two', riskScore: 90 }), firewallDecision: 'review', requesterContext: {}, policy: { approvalCooldownMs: 60_000, requiredApprovers: 1 } });
    const blocked = runtime.decide({ caseId: second.case.caseId, decisionType: 'approve', approverContext: { identityRef: 'human:one', identityHash: 'one' }, evidenceDigest: second.case.evidenceDigest });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.reason, RUNTIME_REASONS.APPROVAL_COOLDOWN_ACTIVE);
  } finally { cleanup(dir); }
});

test('review case creation is receiver-identity-bound, durable, receipt-linked, and replay-safe', () => {
  const { runtime, dir } = fixture();
  try {
    const first = runtime.createReviewCase({
      action: action(),
      firewallDecision: 'review',
      requesterContext: { session: 'receiver-owned-session' },
      metadata: { source: 'mcp-gate', bounded: true },
    });
    assert.equal(first.ok, true);
    assert.equal(first.replayed, false);
    assert.equal(first.case.status, 'pending');
    assert.ok(first.case.caseId.startsWith('review-case:'));
    assert.ok(first.case.creationReceiptId.startsWith('trust-receipt:'));
    assert.equal(first.verification.valid, true);
    assert.equal(first.receipt.canonicalPayload.receiptKind, 'trust_evidence');
    assert.equal(first.receipt.canonicalPayload.metadata.eventType, 'review_case_created');

    const replay = runtime.createReviewCase({
      action: action(),
      firewallDecision: 'review',
      requesterContext: { session: 'receiver-owned-session' },
      caseId: first.case.caseId,
    });
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.case.creationReceiptId, first.case.creationReceiptId);
    assert.equal(runtime.getReviewCase(first.case.caseId).case.status, 'pending');
  } finally {
    cleanup(dir);
  }
});

test('approval requires a distinct authenticated approver and binds the immutable action scope', () => {
  const { runtime, dir } = fixture();
  try {
    const created = runtime.createReviewCase({
      action: action(),
      firewallDecision: 'review',
      requesterContext: {},
    });
    assert.equal(created.ok, true);

    const self = runtime.decide({
      caseId: created.case.caseId,
      decisionType: 'approve',
      approverContext: { identityRef: 'agent:worker-a', identityHash: 'hash-worker-a' },
      evidenceDigest: created.case.evidenceDigest,
    });
    assert.equal(self.ok, false);
    assert.equal(self.reason, RUNTIME_REASONS.SELF_APPROVAL_REJECTED);

    const approved = runtime.decide({
      caseId: created.case.caseId,
      decisionType: 'approve',
      approverContext: { identityRef: 'human:operator-a', identityHash: 'hash-operator-a' },
      reason: 'operator reviewed bounded action context',
      evidenceDigest: created.case.evidenceDigest,
    });
    assert.equal(approved.ok, true);
    assert.equal(approved.case.status, 'approved');
    assert.equal(approved.decision.approver.identityRef, 'human:operator-a');
    assert.ok(approved.decision.receiptId.startsWith('trust-receipt:'));

    const duplicate = runtime.decide({
      caseId: created.case.caseId,
      decisionType: 'approve',
      approverContext: { identityRef: 'human:operator-a', identityHash: 'hash-operator-a' },
      evidenceDigest: created.case.evidenceDigest,
    });
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.reason, RUNTIME_REASONS.DUPLICATE_OR_AMBIGUOUS_DECISION);

    const evidence = runtime.getEvidenceView(created.case.caseId);
    assert.equal(evidence.ok, true);
    assert.deepEqual(evidence.verified, {
      workspaceId: 'workspace-a',
      actionFingerprint: 'action:send-email:001',
      connectorRef: 'connector:mcp-mail',
      resourceRef: 'resource:mailbox-a',
      policyVersion: 'policy-v1',
      firewallVersion: 'agent-action-firewall-v1',
      evidenceDigest: created.case.evidenceDigest,
    });
    assert.deepEqual(evidence.unverified, ['model_risk_claims']);
  } finally {
    cleanup(dir);
  }
});

test('ASI09: blocked-action overrides require a bounded operator reason', () => {
  const { runtime, dir } = fixture();
  try {
    const created = runtime.createReviewCase({
      action: action({ requestedVerdict: 'block', actionFingerprint: 'action:blocked-override' }),
      firewallDecision: 'block',
      requesterContext: {},
      policy: { allowOverride: true },
    });
    assert.equal(created.ok, true);
    assert.equal(created.case.status, 'blocked');

    const missingReason = runtime.decide({
      caseId: created.case.caseId,
      decisionType: 'override',
      approverContext: {},
      evidenceDigest: created.case.evidenceDigest,
    });
    assert.equal(missingReason.ok, false);
    assert.equal(missingReason.reason, RUNTIME_REASONS.DECISION_REASON_REQUIRED);
    assert.equal(missingReason.details.reasonRequired, true);

    const approved = runtime.decide({
      caseId: created.case.caseId,
      decisionType: 'override',
      approverContext: {},
      reason: 'operator reviewed the blocked action and accepted the bounded exception',
      evidenceDigest: created.case.evidenceDigest,
    });
    assert.equal(approved.ok, true);
    assert.equal(approved.decision.reason, 'operator reviewed the blocked action and accepted the bounded exception');
    assert.equal(approved.case.status, 'approved');
  } finally {
    cleanup(dir);
  }
});

test('expired cases, action drift, dry-run execution, and firewall disagreement fail closed', () => {
  const { runtime, dir, clockState } = fixture();
  try {
    const created = runtime.createReviewCase({
      action: action({ requestedVerdict: 'dry_run_only' }),
      firewallDecision: 'dry_run_only',
      requesterContext: {},
      expiresAt: '2026-08-19T10:01:00.000Z',
    });
    assert.equal(created.ok, true);
    clockState.now = Date.parse('2026-08-19T10:02:00.000Z');
    const expired = runtime.decide({
      caseId: created.case.caseId,
      decisionType: 'approve',
      approverContext: {},
      evidenceDigest: created.case.evidenceDigest,
    });
    assert.equal(expired.ok, false);
    assert.equal(expired.reason, RUNTIME_REASONS.CASE_EXPIRED);
  } finally {
    cleanup(dir);
  }

  const second = fixture();
  try {
    const created = second.runtime.createReviewCase({ action: action(), firewallDecision: 'review', requesterContext: {} });
    const approved = second.runtime.decide({
      caseId: created.case.caseId,
      decisionType: 'approve',
      approverContext: {},
      evidenceDigest: created.case.evidenceDigest,
    });
    assert.equal(approved.ok, true);
    const drifted = second.runtime.authorizeExecution({
      caseId: created.case.caseId,
      action: action({ actionFingerprint: 'action:drifted' }),
      requesterContext: {},
    });
    assert.equal(drifted.ok, false);
    assert.equal(drifted.reason, RUNTIME_REASONS.SCOPE_MISMATCH);

    const dryRunCreated = second.runtime.createReviewCase({
      action: action({ requestedVerdict: 'dry_run_only', actionFingerprint: 'action:dry-run' }),
      firewallDecision: 'dry_run_only',
      requesterContext: {},
    });
    const dryRunApproved = second.runtime.decide({
      caseId: dryRunCreated.case.caseId,
      decisionType: 'approve',
      approverContext: {},
      evidenceDigest: dryRunCreated.case.evidenceDigest,
    });
    assert.equal(dryRunApproved.ok, true);
    const dryRunExecution = second.runtime.authorizeExecution({
      caseId: dryRunCreated.case.caseId,
      action: action({ requestedVerdict: 'dry_run_only', actionFingerprint: 'action:dry-run' }),
      requesterContext: {},
    });
    assert.equal(dryRunExecution.ok, false);
    assert.equal(dryRunExecution.reason, RUNTIME_REASONS.DRY_RUN_EXECUTOR_BLOCKED);
  } finally {
    cleanup(second.dir);
  }
});

test('executor is reachable only after approval and unknown outcome is durably reconciliable', async () => {
  const { runtime, dir } = fixture();
  try {
    const created = runtime.createReviewCase({ action: action(), firewallDecision: 'review', requesterContext: {} });
    const beforeApproval = await runtime.executeApproved({
      caseId: created.case.caseId,
      action: action(),
      requesterContext: {},
      executor: () => { throw new Error('must not run'); },
    });
    assert.equal(beforeApproval.ok, false);
    assert.equal(beforeApproval.reason, RUNTIME_REASONS.APPROVAL_REQUIRED);

    const approved = runtime.decide({
      caseId: created.case.caseId,
      decisionType: 'approve',
      approverContext: {},
      evidenceDigest: created.case.evidenceDigest,
    });
    assert.equal(approved.ok, true);
    let executions = 0;
    const result = await runtime.executeApproved({
      caseId: created.case.caseId,
      action: action(),
      requesterContext: {},
      executor: () => {
        executions += 1;
        throw new Error('outcome unavailable');
      },
    });
    assert.equal(executions, 1);
    assert.equal(result.ok, false);
    assert.equal(result.reason, RUNTIME_REASONS.EXECUTION_RECONCILIATION_REQUIRED);
    assert.equal(result.execution.ok, true);
    assert.equal(result.execution.execution.outcome, 'unknown');
    assert.equal(result.execution.case.status, 'reconciliation_required');
    assert.equal(runtime.getReviewCase(created.case.caseId).case.status, 'reconciliation_required');
  } finally {
    cleanup(dir);
  }
});
