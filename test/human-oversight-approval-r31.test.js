'use strict';

// #3486 (R31): approval expiry + args binding + single-use idempotency.
// The decision binds the requested action's argument summary; an expired
// approval refuses at decision and execution time; a second resume of a
// consumed approval fails closed with a blocked_action_receipt.

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
const { buildMcpOversightInput } = require('../lib/mcp-oversight-input');
const { buildHttpIngestOversightInput } = require('../lib/http-human-oversight-adapter-input');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-3486-'));
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

function approveCase(runtime, overrides = {}) {
  const created = runtime.createReviewCase({ action: action(overrides), firewallDecision: 'review', requesterContext: {} });
  assert.equal(created.ok, true);
  const decided = runtime.decide({
    caseId: created.case.caseId,
    decisionType: 'approve',
    approverContext: {},
    evidenceDigest: created.case.evidenceDigest,
  });
  assert.equal(decided.ok, true);
  return { created, decided };
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

test('the decision binds the requested argument summary end to end', () => {
  const { runtime, dir } = fixture();
  try {
    const args = { to: 'mailbox-a', amount: 1 };
    const { created, decided } = approveCase(runtime, { args });
    assert.match(created.case.argsDigest, /^[0-9a-f]{64}$/);
    assert.equal(decided.decision.argsDigest, created.case.argsDigest);
    const view = runtime.getEvidenceView(created.case.caseId);
    assert.equal(view.verified.argsDigest, created.case.argsDigest);
    const authorized = runtime.authorizeExecution({
      caseId: created.case.caseId,
      action: action({ args }),
      requesterContext: {},
    });
    assert.equal(authorized.ok, true);
  } finally { cleanup(dir); }
});

test('execution with drifted arguments is refused as a scope mismatch', async () => {
  const { runtime, dir } = fixture();
  try {
    const { created } = approveCase(runtime, { args: { to: 'mailbox-a', amount: 1 } });
    const drifted = runtime.authorizeExecution({
      caseId: created.case.caseId,
      action: action({ args: { to: 'mailbox-b', amount: 1 } }),
      requesterContext: {},
    });
    assert.equal(drifted.ok, false);
    assert.equal(drifted.reason, RUNTIME_REASONS.ARGS_DIGEST_MISMATCH);
    let executions = 0;
    const result = await runtime.executeApproved({
      caseId: created.case.caseId,
      action: action({ args: { to: 'mailbox-b', amount: 1 } }),
      requesterContext: {},
      executor: () => { executions += 1; return { ok: true }; },
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, RUNTIME_REASONS.ARGS_DIGEST_MISMATCH);
    assert.equal(executions, 0);
    // The untouched approval still authorizes with the reviewed arguments.
    const retry = runtime.authorizeExecution({
      caseId: created.case.caseId,
      action: action({ args: { to: 'mailbox-a', amount: 1 } }),
      requesterContext: {},
    });
    assert.equal(retry.ok, true);
  } finally { cleanup(dir); }
});

test('cases recorded without an args digest keep the previous behavior', async () => {
  const { runtime, dir } = fixture();
  try {
    const { created } = approveCase(runtime);
    assert.equal(created.case.argsDigest, '');
    const authorized = runtime.authorizeExecution({
      caseId: created.case.caseId,
      action: action(),
      requesterContext: {},
    });
    assert.equal(authorized.ok, true);
  } finally { cleanup(dir); }
});

test('conflicting args and argsDigest never open a case', () => {
  const { runtime, dir } = fixture();
  try {
    const conflict = runtime.createReviewCase({
      action: action({ args: { to: 'mailbox-a' }, argsDigest: '0'.repeat(64) }),
      firewallDecision: 'review',
      requesterContext: {},
    });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.reason, RUNTIME_REASONS.MALFORMED_CASE);
    const malformed = runtime.createReviewCase({
      action: action({ argsDigest: 'not-a-digest' }),
      firewallDecision: 'review',
      requesterContext: {},
    });
    assert.equal(malformed.ok, false);
    assert.equal(malformed.reason, RUNTIME_REASONS.MALFORMED_CASE);
  } finally { cleanup(dir); }
});

test('an expired approval refuses at decision and execution time', async () => {
  const { runtime, dir, clockState } = fixture();
  try {
    const start = clockState.now;
    const { created } = approveCase(runtime);
    clockState.now = Date.parse(created.case.expiresAt) + 1;
    const lateDecision = runtime.decide({
      caseId: created.case.caseId,
      decisionType: 'approve',
      approverContext: {},
      evidenceDigest: created.case.evidenceDigest,
    });
    assert.equal(lateDecision.ok, false);
    assert.equal(lateDecision.reason, RUNTIME_REASONS.CASE_EXPIRED);
    let executions = 0;
    const lateExecution = await runtime.executeApproved({
      caseId: created.case.caseId,
      action: action(),
      requesterContext: {},
      executor: () => { executions += 1; return { ok: true }; },
    });
    assert.equal(lateExecution.ok, false);
    assert.equal(lateExecution.reason, RUNTIME_REASONS.CASE_EXPIRED);
    assert.equal(executions, 0);
    clockState.now = start;
  } finally { cleanup(dir); }
});

test('a second resume of a consumed approval fails closed with a blocked_action_receipt', async () => {
  const { runtime, dir } = fixture();
  try {
    const { created } = approveCase(runtime, { args: { to: 'mailbox-a' } });
    let executions = 0;
    const first = await runtime.executeApproved({
      caseId: created.case.caseId,
      action: action({ args: { to: 'mailbox-a' } }),
      requesterContext: {},
      executor: () => { executions += 1; return { ok: true }; },
    });
    assert.equal(first.ok, true);
    assert.equal(executions, 1);
    const consumed = runtime.getReviewCase(created.case.caseId).case;
    assert.equal(consumed.status, 'executed');
    assert.ok(consumed.consumedAt);
    assert.ok(consumed.consumptionNonce);
    const second = await runtime.executeApproved({
      caseId: created.case.caseId,
      action: action({ args: { to: 'mailbox-a' } }),
      requesterContext: {},
      executor: () => { executions += 1; return { ok: true }; },
    });
    assert.equal(second.ok, false);
    assert.equal(second.reason, RUNTIME_REASONS.APPROVAL_ALREADY_CONSUMED);
    assert.equal(second.receipt.receiptKind, 'blocked_action_receipt');
    assert.equal(second.receipt.caseId, created.case.caseId);
    assert.equal(second.receipt.consumedAt, consumed.consumedAt);
    assert.equal(second.receipt.argsDigest, consumed.argsDigest);
    assert.equal(executions, 1, 'the executor must run exactly once per approval');
  } finally { cleanup(dir); }
});

test('a reconciled replay after an unknown outcome is refused with a receipt', async () => {
  const { runtime, dir } = fixture();
  try {
    const { created } = approveCase(runtime);
    let executions = 0;
    const crashed = await runtime.executeApproved({
      caseId: created.case.caseId,
      action: action(),
      requesterContext: {},
      executor: () => { executions += 1; throw new Error('executor crashed mid-effect'); },
    });
    assert.equal(crashed.ok, false);
    assert.equal(runtime.getReviewCase(created.case.caseId).case.status, 'reconciliation_required');
    const replay = await runtime.executeApproved({
      caseId: created.case.caseId,
      action: action(),
      requesterContext: {},
      executor: () => { executions += 1; return { ok: true }; },
    });
    assert.equal(replay.ok, false);
    assert.equal(replay.reason, RUNTIME_REASONS.APPROVAL_ALREADY_CONSUMED);
    assert.equal(replay.receipt.receiptKind, 'blocked_action_receipt');
    assert.equal(executions, 1);
  } finally { cleanup(dir); }
});

test('oversight adapters carry the reviewed argument summary on the action', () => {
  const mcp = buildMcpOversightInput({
    approval: { id: 'a1', approvalKey: 'k1', tool: 'huqan.learn', context: { workspaceId: 'w', args: { text: 'x' } } },
    toolName: 'huqan.learn',
    storedArgs: { text: 'x' },
    gate: {},
    runtime: {},
  });
  assert.match(mcp.action.argsDigest, /^[0-9a-f]{64}$/);
  const mcpSame = buildMcpOversightInput({
    approval: { id: 'a1', approvalKey: 'k1', tool: 'huqan.learn', context: { workspaceId: 'w', args: { text: 'x' } } },
    toolName: 'huqan.learn',
    storedArgs: { text: 'x' },
    gate: {},
    runtime: {},
  });
  assert.equal(mcpSame.action.argsDigest, mcp.action.argsDigest);
  const mcpDrifted = buildMcpOversightInput({
    approval: { id: 'a1', approvalKey: 'k1', tool: 'huqan.learn', context: { workspaceId: 'w', args: { text: 'x' } } },
    toolName: 'huqan.learn',
    storedArgs: { text: 'y' },
    gate: {},
    runtime: {},
  });
  assert.notEqual(mcpDrifted.action.argsDigest, mcp.action.argsDigest);
  const prefixed = buildHttpIngestOversightInput({
    approval: { id: 'h1', context: { snapshot: { workspaceId: 'w', sourceType: 'manual', sourceRef: 's', snapshotHash: 'sha256:' + 'b'.repeat(64) } } },
  });
  assert.equal(prefixed.action.argsDigest, 'b'.repeat(64));
  const bare = buildHttpIngestOversightInput({
    approval: { id: 'h2', context: { snapshot: { workspaceId: 'w', sourceType: 'manual', sourceRef: 's', idempotencyKey: 'k' } } },
  });
  assert.match(bare.action.argsDigest, /^[0-9a-f]{64}$/);
});
