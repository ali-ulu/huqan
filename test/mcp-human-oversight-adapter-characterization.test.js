'use strict';

// Characterization for #2306: lib/mcp-human-oversight-adapter.js is being
// split by responsibility (input building, agent-identity evaluation,
// review-case plumbing) behind the same frozen facade. These tests pin the
// behavior the split must not change. Written before any file moved.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CASE_PREFIX,
  buildMcpOversightInput,
  buildApproverContext,
  createMcpOversightCase,
  decideMcpOversight,
  evaluateMcpAgentIdentity,
  getHumanOversightRuntime,
  identityEvidence,
  oversightSummary,
  readMcpOversightCase,
} = require('../lib/mcp-human-oversight-adapter');

function fullRuntime() {
  return {
    humanOversightApprovalRuntime: {
      createReviewCase: () => ({ ok: true, case: { caseId: 'c1', status: 'pending' } }),
      getReviewCase: () => ({ ok: true, case: { caseId: 'c1', status: 'pending' } }),
      decide: () => ({ ok: true }),
      executeApproved: () => ({ ok: true }),
    },
  };
}

const approval = {
  id: 'a1',
  approvalKey: 'k1',
  tool: 'huqan.learn',
  context: { workspaceId: 'w', args: { text: 'x' } },
};

const frozenExports = [
  'CASE_PREFIX', 'buildMcpOversightInput', 'buildApproverContext',
  'createMcpOversightCase', 'decideMcpOversight', 'evaluateMcpAgentIdentity',
  'getHumanOversightRuntime', 'identityEvidence', 'oversightSummary',
  'readMcpOversightCase',
];

test('module surface is frozen and exports exactly the known names', () => {
  const mod = require('../lib/mcp-human-oversight-adapter');
  assert.ok(Object.isFrozen(mod));
  assert.deepEqual(Object.keys(mod).sort(), frozenExports.slice().sort());
  for (const name of frozenExports.slice(1)) assert.equal(typeof mod[name], 'function', name);
  assert.equal(mod.CASE_PREFIX, 'mcp-oversight:');
});

test('buildMcpOversightInput pins the case id, action shape and hashes', () => {
  const input = buildMcpOversightInput({
    approval,
    toolName: 'huqan.learn',
    storedArgs: { text: 'x' },
    gate: { decision: 'review', risk: { score: 150 } },
    runtime: fullRuntime(),
  });
  assert.equal(input.caseId, 'mcp-oversight:a1');
  assert.ok(Object.isFrozen(input));
  assert.ok(Object.isFrozen(input.action));
  const action = input.action;
  assert.equal(action.workspaceId, 'w');
  assert.equal(action.connectorRef, 'mcp:huqan.learn');
  assert.equal(action.resourceRef, 'k1');
  assert.equal(action.target, 'k1');
  assert.equal(action.policyVersion, 'mcp-approval-v1');
  assert.equal(action.requestedVerdict, 'review');
  // Risk score is bounded to 0..100 even when the gate reports 150.
  assert.equal(action.riskScore, 100);
  assert.equal(action.requestedEffect, 'execute:huqan.learn');
  assert.equal(action.actionType, 'mcp_tool_call');
  assert.equal(action.toolName, 'huqan.learn');
  assert.deepEqual(action.evidenceRefs, ['a1']);
  assert.equal(typeof action.actionFingerprint, 'string');
  assert.equal(action.actionFingerprint.startsWith('mcp-action:'), true);
  assert.equal(typeof action.evidenceDigest, 'string');
  assert.equal(input.firewallRequest.surface, 'mcp-approval');
  assert.equal(input.firewallRequest.action, 'learn');
  assert.ok(Object.isFrozen(input.firewallRequest));
});

test('buildMcpOversightInput is deterministic: same inputs, same fingerprints', () => {
  const a = buildMcpOversightInput({ approval, toolName: 'huqan.learn', storedArgs: { text: 'x' }, gate: {}, runtime: {} });
  const b = buildMcpOversightInput({ approval, toolName: 'huqan.learn', storedArgs: { text: 'x' }, gate: {}, runtime: {} });
  assert.equal(a.action.actionFingerprint, b.action.actionFingerprint);
  assert.equal(a.action.evidenceDigest, b.action.evidenceDigest);
  const c = buildMcpOversightInput({ approval, toolName: 'huqan.learn', storedArgs: { text: 'different' }, gate: {}, runtime: {} });
  assert.notEqual(a.action.actionFingerprint, c.action.actionFingerprint);
});

test('buildMcpOversightInput falls back to the approval gate decision and metadata versions', () => {
  const withPolicyGate = buildMcpOversightInput({
    approval: { ...approval, policy: { gate: { decision: 'block', metadata: { policyVersion: 'pv-9', firewallVersion: 'fw-9' } } } },
    toolName: 'huqan.learn',
    storedArgs: {},
    gate: {},
    runtime: {},
  });
  assert.equal(withPolicyGate.action.requestedVerdict, 'block');
  assert.equal(withPolicyGate.action.policyVersion, 'pv-9');
  assert.equal(withPolicyGate.action.firewallVersion, 'fw-9');
});

test('buildMcpOversightInput refuses an unproven agent origin (#2592)', () => {
  assert.throws(
    () => buildMcpOversightInput({
      approval: { ...approval, context: { workspaceId: 'w', args: {}, provenance: { sourceType: 'agent' } } },
      toolName: 'huqan.learn',
      storedArgs: {},
      gate: {},
      runtime: {},
    }),
    (error) => error.name === 'ProvenanceError' || /provenance/i.test(error.message),
  );
});

test('requester context resolver flows through bounded and frozen', () => {
  let seen = null;
  const runtime = {
    humanOversightRequesterContext(details) {
      seen = details;
      return { subject: 'user-1', extra: 'kept' };
    },
  };
  const input = buildMcpOversightInput({ approval, toolName: 'huqan.learn', storedArgs: {}, gate: {}, runtime });
  assert.equal(seen.approvalId, 'a1');
  assert.equal(seen.action, input.action);
  assert.deepEqual(input.requesterContext, { subject: 'user-1', extra: 'kept' });
  assert.ok(Object.isFrozen(input.requesterContext));
});

test('buildApproverContext resolves the approver role', () => {
  const runtime = {
    humanOversightApproverContext: (details) => ({ approver: details.caseId }),
  };
  const context = buildApproverContext(runtime, { caseId: 'mcp-oversight:a1', decision: 'approve', reason: 'ok' });
  assert.deepEqual(context, { approver: 'mcp-oversight:a1' });
  assert.ok(Object.isFrozen(context));
});

test('getHumanOversightRuntime passes a complete runtime, rejects fragments', () => {
  assert.equal(getHumanOversightRuntime({}), null);
  assert.equal(getHumanOversightRuntime({ humanOversightApprovalRuntime: { createReviewCase() {} } }), null);
  assert.equal(getHumanOversightRuntime(fullRuntime()) !== null, true);
});

test('createMcpOversightCase stays disabled without a runtime or for other tools', () => {
  assert.deepEqual(
    createMcpOversightCase({ runtime: {}, approval, toolName: 'huqan.learn', storedArgs: {}, gate: {} }),
    { enabled: false, ok: true },
  );
  assert.deepEqual(
    createMcpOversightCase({ runtime: fullRuntime(), approval, toolName: 'huqan.agent', storedArgs: {}, gate: {} }),
    { enabled: false, ok: true },
  );
});

test('createMcpOversightCase opens a huqan.learn case with a full runtime', () => {
  const result = createMcpOversightCase({ runtime: fullRuntime(), approval, toolName: 'huqan.learn', storedArgs: { text: 'x' }, gate: {} });
  assert.equal(result.enabled, true);
  assert.equal(result.ok, true);
  assert.equal(result.input.caseId, 'mcp-oversight:a1');
  assert.equal(result.result.case.caseId, 'c1');
  assert.equal(result.summary.caseId, 'c1');
});

test('createMcpOversightCase maps a refused case to ok:false without throwing', () => {
  const runtime = {
    humanOversightApprovalRuntime: {
      createReviewCase: () => ({ ok: false, error: 'refused' }),
      getReviewCase: () => ({ ok: true }),
      decide: () => ({ ok: true }),
      executeApproved: () => ({ ok: true }),
    },
  };
  const result = createMcpOversightCase({ runtime, approval, toolName: 'huqan.learn', storedArgs: {}, gate: {} });
  assert.equal(result.enabled, true);
  assert.equal(result.ok, false);
  assert.deepEqual(result.result, { ok: false, error: 'refused' });
});

test('createMcpOversightCase catches creation errors and reports them', () => {
  const runtime = {
    humanOversightApprovalRuntime: {
      createReviewCase: () => { throw new Error('boom'); },
      getReviewCase: () => ({ ok: true }),
      decide: () => ({ ok: true }),
      executeApproved: () => ({ ok: true }),
    },
  };
  const result = createMcpOversightCase({ runtime, approval, toolName: 'huqan.learn', storedArgs: {}, gate: {} });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'boom');
});

test('readMcpOversightCase reads through the runtime and reports misses', () => {
  const ok = readMcpOversightCase({ runtime: fullRuntime(), approval, toolName: 'huqan.learn', storedArgs: {}, gate: {} });
  assert.equal(ok.enabled, true);
  assert.equal(ok.ok, true);
  const missRuntime = {
    humanOversightApprovalRuntime: {
      createReviewCase: () => ({ ok: true }),
      getReviewCase: () => null,
      decide: () => ({ ok: true }),
      executeApproved: () => ({ ok: true }),
    },
  };
  const miss = readMcpOversightCase({ runtime: missRuntime, approval, toolName: 'huqan.learn', storedArgs: {}, gate: {} });
  assert.equal(miss.ok, false);
  assert.deepEqual(
    readMcpOversightCase({ runtime: missRuntime, approval, toolName: 'huqan.agent', storedArgs: {}, gate: {} }),
    { enabled: false, ok: true },
  );
});

test('decideMcpOversight maps approved to approve and anything else to reject', () => {
  const calls = [];
  const runtime = {
    humanOversightApprovalRuntime: {
      createReviewCase: () => ({ ok: true }),
      getReviewCase: () => ({ ok: true }),
      decide: (payload) => { calls.push(payload); return { ok: true, decisionId: 'd1' }; },
      executeApproved: () => ({ ok: true }),
    },
  };
  const oversightCase = { input: buildMcpOversightInput({ approval, toolName: 'huqan.learn', storedArgs: {}, gate: {}, runtime }) };
  const approved = decideMcpOversight({ runtime, oversightCase, approval, args: { reason: 'fine' }, decision: 'approved' });
  assert.equal(approved.ok, true);
  assert.equal(calls[0].decisionType, 'approve');
  assert.equal(calls[0].caseId, 'mcp-oversight:a1');
  assert.equal(calls[0].reason, 'fine');
  assert.equal(typeof calls[0].evidenceDigest, 'string');
  const rejected = decideMcpOversight({ runtime, oversightCase, approval, args: {}, decision: 'rejected' });
  assert.equal(rejected.ok, true);
  assert.equal(calls[1].decisionType, 'reject');
  assert.equal(calls[1].reason, 'mcp_reject');
});

test('evaluateMcpAgentIdentity is disabled and ok without a config', () => {
  assert.deepEqual(evaluateMcpAgentIdentity({ runtime: {}, oversightInput: {} }), { enabled: false, ok: true });
  assert.deepEqual(
    evaluateMcpAgentIdentity({ runtime: { agentIdentityRuntime: null }, oversightInput: {} }),
    { enabled: false, ok: true },
  );
});

test('evaluateMcpAgentIdentity fails closed on a malformed config', () => {
  const result = evaluateMcpAgentIdentity({ runtime: { agentIdentityRuntime: 'nope' }, oversightInput: {} });
  assert.equal(result.enabled, true);
  assert.equal(result.ok, false);
  assert.equal(result.result.decision, 'block');
  assert.equal(result.result.reason, 'identity.evaluation_failed');
  assert.equal(result.evidence.decision, 'block');
});

test('evaluateMcpAgentIdentity blocks a subject binding mismatch', () => {
  const runtime = {
    agentIdentityRuntime: {
      authority: { kind: 'test' },
      identityRef: 'ref-1',
      receiver: { subject: 'user-1', kind: 'mcp-approval', workspaceId: 'w' },
      action: {},
    },
    humanOversightRequesterContext: () => ({ subject: 'someone-else' }),
  };
  const oversightInput = buildMcpOversightInput({ approval, toolName: 'huqan.learn', storedArgs: {}, gate: {}, runtime });
  const result = evaluateMcpAgentIdentity({ runtime, oversightInput });
  assert.equal(result.enabled, true);
  assert.equal(result.ok, false);
  assert.equal(result.result.reason, 'identity.claim_binding_mismatch');
});

test('evaluateMcpAgentIdentity blocks a workspace mismatch', () => {
  const runtime = {
    agentIdentityRuntime: {
      authority: { kind: 'test' },
      identityRef: 'ref-1',
      receiver: { subject: 'user-1', kind: 'mcp-approval', workspaceId: 'elsewhere' },
      action: {},
    },
    humanOversightRequesterContext: () => ({ subject: 'user-1' }),
  };
  const oversightInput = buildMcpOversightInput({ approval, toolName: 'huqan.learn', storedArgs: { text: 'x' }, gate: {}, runtime });
  const result = evaluateMcpAgentIdentity({ runtime, oversightInput });
  assert.equal(result.ok, false);
  assert.equal(result.result.reason, 'identity.workspace_mismatch');
});

test('identityEvidence normalizes unknown results into a frozen block record', () => {
  const evidence = identityEvidence(null);
  assert.equal(evidence.decision, 'block');
  assert.equal(evidence.allowed, false);
  assert.equal(evidence.reason, 'identity.evaluation_failed');
  assert.equal(evidence.identity, null);
  assert.equal(evidence.delegation, null);
  assert.ok(Object.isFrozen(evidence));
  const full = identityEvidence({
    version: 'v9', decision: 'allow', allowed: true, reason: 'ok', evaluatedAt: '2026-09-27T00:00:00Z',
    identity: { agentId: 'a', identityRef: 'r', identityHash: 'h', workspaceId: 'w', ownerActorId: 'o', trustTier: 't1', riskTier: 'low' },
    delegation: { chain: ['x'], scope: ['s1', 's2'] },
  });
  assert.equal(full.version, 'v9');
  assert.equal(full.allowed, true);
  assert.deepEqual(full.identity.agentId, 'a');
  assert.deepEqual(full.delegation.scope, ['s1', 's2']);
  assert.ok(Object.isFrozen(full));
  assert.ok(Object.isFrozen(full.identity));
});

test('oversightSummary reads the first available record and caps the reason', () => {
  assert.deepEqual(oversightSummary(null, null, null), {
    caseId: '', status: '', decisionId: '', decisionType: '',
    caseReceiptId: '', decisionReceiptId: '', executionReceiptId: '', reason: '',
  });
  const summary = oversightSummary(
    { case: { caseId: 'c1', status: 'pending', creationReceiptId: 'rc1' }, receipt: { receiptId: 'r-case' } },
    { decision: { decisionId: 'd1', decisionType: 'approve' }, receipt: { receiptId: 'r-dec' } },
    { execution: { case: { caseId: 'c1', status: 'executed', latestDecisionId: 'd1', latestDecisionType: 'approve' }, receipt: { receiptId: 'r-exec' }, reason: 'x'.repeat(400) } },
  );
  assert.equal(summary.caseId, 'c1');
  assert.equal(summary.status, 'executed');
  assert.equal(summary.decisionId, 'd1');
  assert.equal(summary.decisionType, 'approve');
  // The case-level receipt wins over the creation receipt recorded on the case.
  assert.equal(summary.caseReceiptId, 'r-case');
  assert.equal(summary.decisionReceiptId, 'r-dec');
  assert.equal(summary.executionReceiptId, 'r-exec');
  assert.equal(summary.reason.length, 160);
});
