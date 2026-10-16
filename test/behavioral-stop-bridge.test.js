'use strict';

// Behavioral-containment stop bridge (#2505 F-3): a quarantine, block or
// pause recommendation opens a Human Oversight review case. Execution travels
// the existing F-2 operator surfaces; this module binds the execution
// arguments to the approved case. The runtime and the ledger below are real
// (in-memory graph, temp-dir ledger); only identity is stubbed.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const { createHumanOversightApprovalRuntime } = require('../lib/human-oversight-approval-runtime');
const { createEmergencyStop } = require('../lib/emergency-stop');
const { initializeBehavioralState } = require('../lib/agent-behavioral-integrity');
const { executeAgentStep } = require('../lib/agent-step-executor');
const {
  proposeBehavioralStop,
  stopRequestForCase,
  proposeStopForBlockedStep,
  stopScopeFor,
} = require('../lib/behavioral-stop-bridge');

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-f3-bridge-'));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  const ledger = createTrustEvidenceLedger({ graph });
  const runtime = createHumanOversightApprovalRuntime({
    graph,
    ledger,
    clock: () => Date.parse('2026-09-15T20:00:00.000Z'),
    resolveIdentity: ({ role, context, action }) => ({
      decision: 'allow',
      identity: {
        identityRef: String(context.subject || (role === 'requester' ? 'agent:req' : 'human:op')),
        identityHash: 'hash-' + String(context.subject || role),
        workspaceId: action.workspaceId,
        agentId: role === 'requester' ? 'agent-v3' : '',
        ownerActorId: role === 'requester' ? 'owner-req' : 'operator-op',
        authorityRef: 'authority:test',
      },
    }),
    firewallEvaluator: () => ({ decision: 'allow', metadata: { firewallVersion: 'AAFW-v1.0.0' } }),
  });
  const stopLedger = createEmergencyStop({ directory: path.join(dir, 'stops') });
  const requesterContext = { subject: 'agent:agent-v3', kind: 'agent-step', workspaceId: 'ws-alpha', agentId: 'agent-v3' };
  return {
    dir,
    runtime,
    stopLedger,
    requesterContext,
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function recommendation(overrides = {}) {
  return {
    decision: 'quarantine',
    deviationCode: 'unexpected_tool',
    receiptId: 'asi10_abcdef0123456789',
    baselineHash: 'baseline-hash-1',
    scope: { workspaceId: 'ws-alpha', agentId: 'agent-v3' },
    reason: 'unexpected_tool detected against the declared baseline',
    ...overrides,
  };
}

function approveQuorum(f, caseId) {
  const op1 = { subject: 'human:op1', kind: 'operator' };
  const op2 = { subject: 'human:op2', kind: 'operator' };
  const first = f.runtime.decide({ caseId, decisionType: 'approve', approverContext: op1, reason: 'first review' });
  assert.equal(first.ok, true);
  assert.equal(first.case.status, 'escalated');
  const second = f.runtime.decide({ caseId, decisionType: 'approve', approverContext: op2, reason: 'second review' });
  assert.equal(second.ok, true);
  assert.equal(second.case.status, 'approved');
}

test('a quarantine recommendation opens a review case for an agent-scoped stop', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const proposal = proposeBehavioralStop({ recommendation: recommendation(), approvalRuntime: f.runtime, requesterContext: f.requesterContext });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.proposed, true);
  assert.match(proposal.case.caseId, /./);
  assert.equal(proposal.case.workspaceId, 'ws-alpha');
  assert.equal(proposal.case.connectorRef, 'behavioral-containment');
  assert.equal(proposal.case.resourceRef, 'asi10_abcdef0123456789');
});

test('a pause without an agent id proposes a workspace-scoped stop', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const proposal = proposeBehavioralStop({
    recommendation: recommendation({ decision: 'require_review', scope: { workspaceId: 'ws-alpha', agentId: null } }),
    approvalRuntime: f.runtime,
    requesterContext: f.requesterContext,
  });
  assert.equal(proposal.proposed, true);
  assert.equal(proposal.case.workspaceId, 'ws-alpha');
});

test('observe proposes nothing and the ledger is untouched', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const proposal = proposeBehavioralStop({
    recommendation: recommendation({ decision: 'observe', deviationCode: null, receiptId: null }),
    approvalRuntime: f.runtime,
    requesterContext: f.requesterContext,
  });
  assert.deepEqual(proposal, { ok: true, proposed: false, reason: 'no_containment' });
  assert.equal(f.stopLedger.check({ workspaceId: 'ws-alpha' }).stopped, false);
});

test('without an approval runtime the bridge reports unavailable and never throws', () => {
  for (const runtime of [undefined, null, {}]) {
    const proposal = proposeBehavioralStop({ recommendation: recommendation(), approvalRuntime: runtime, requesterContext: {} });
    assert.equal(proposal.proposed, false);
    assert.equal(proposal.reason, 'approval_runtime_not_configured');
  }
  const derived = stopRequestForCase({ approvalRuntime: null, caseId: 'c' });
  assert.equal(derived.ok, false);
});

test('an approved case yields the reviewed stop arguments, and the stop lands', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const proposal = proposeBehavioralStop({ recommendation: recommendation(), approvalRuntime: f.runtime, requesterContext: f.requesterContext });
  assert.equal(proposal.proposed, true);
  // riskScore 90 clears the critical bar: one approval escalates, a second,
  // distinct approver is required. The two-person rule for stops.
  approveQuorum(f, proposal.case.caseId);
  const derived = stopRequestForCase({ approvalRuntime: f.runtime, caseId: proposal.case.caseId });
  assert.equal(derived.ok, true);
  assert.deepEqual(derived.stop, {
    scope: 'agent',
    workspaceId: 'ws-alpha',
    agentId: 'agent-v3',
    reason: `approved case ${proposal.case.caseId}: asi10_abcdef0123456789`,
  });
  // The operator executes through the F-2 surface with these exact arguments.
  const outcome = f.stopLedger.stop({ ...derived.stop, actor: 'operator:mcp' });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.created, true);
  const check = f.stopLedger.check({ workspaceId: 'ws-alpha', agentId: 'agent-v3' });
  assert.equal(check.stopped, true);
  assert.equal(check.scope, 'agent');
  assert.equal(check.record.actor, 'operator:mcp');
});

test('unapproved cases yield no stop arguments', (t) => {
  const f = fixture();
  t.after(() => f.cleanup());
  const proposal = proposeBehavioralStop({ recommendation: recommendation(), approvalRuntime: f.runtime, requesterContext: f.requesterContext });
  const pending = stopRequestForCase({ approvalRuntime: f.runtime, caseId: proposal.case.caseId });
  assert.equal(pending.ok, false);
  assert.equal(pending.reason, 'case_not_approved');
  f.runtime.decide({ caseId: proposal.case.caseId, decisionType: 'reject', approverContext: { subject: 'human:op1', kind: 'operator' }, reason: 'no' });
  const rejected = stopRequestForCase({ approvalRuntime: f.runtime, caseId: proposal.case.caseId });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.reason, 'case_not_approved');
  const missing = stopRequestForCase({ approvalRuntime: f.runtime, caseId: 'no-such-case' });
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'case_not_found');
});

test('a foreign approved case is refused even when approved', () => {
  const foreign = {
    getReviewCase: () => ({
      ok: true,
      case: {
        caseId: 'foreign-1',
        status: 'approved',
        latestDecisionType: 'approve',
        connectorRef: 'self-healer',
        actionType: 'dryrun',
        workspaceId: 'ws-alpha',
        metadata: {},
      },
    }),
  };
  const derived = stopRequestForCase({ approvalRuntime: foreign, caseId: 'foreign-1' });
  assert.equal(derived.ok, false);
  assert.equal(derived.reason, 'not_a_behavioral_stop_case');
});

test('the step executor attaches a proposal on quarantine and stays silent without a runtime', () => {
  const state = { goal: 'inspect', workspaceId: 'ws-alpha', agentId: 'agent-v3', selectedTools: ['ask'], steps: [] };
  initializeBehavioralState(state);
  const step = { id: 's1', action: 'ask', tool: 'ask', input: { connector: 'remote' }, rationale: 'drift' };
  const kernel = {};
  const emit = () => undefined;

  const withRuntime = executeAgentStep({
    step,
    state: { ...state, steps: [] },
    opts: {},
    runtime: {
      kernel,
      allowedTools: new Set(['ask']),
      emit,
      humanOversightApprovalRuntime: {
        createReviewCase: () => ({ ok: true, case: { caseId: 'case-1' }, receipt: null }),
      },
    },
  });
  assert.equal(withRuntime.result.meta.containment, 'quarantine');
  assert.equal(withRuntime.result.meta.behavioralStopProposal.proposed, true);
  assert.equal(withRuntime.result.meta.behavioralStopProposal.case.caseId, 'case-1');

  const dormantState = { goal: 'inspect', workspaceId: 'ws-alpha', agentId: 'agent-v3', selectedTools: ['ask'], steps: [] };
  initializeBehavioralState(dormantState);
  const dormant = executeAgentStep({
    step,
    state: dormantState,
    opts: {},
    runtime: { kernel, allowedTools: new Set(['ask']), emit },
  });
  assert.equal(dormant.result.meta.containment, 'quarantine');
  assert.equal('behavioralStopProposal' in dormant.result.meta, false);
});

test('stop scopes map agent ids to agent stops and missing ids to workspace stops', () => {
  assert.deepEqual(stopScopeFor({ workspaceId: 'w', agentId: 'a' }), { scope: 'agent', workspaceId: 'w', agentId: 'a' });
  assert.deepEqual(stopScopeFor({ workspaceId: 'w', agentId: '' }), { scope: 'workspace', workspaceId: 'w', agentId: null });
  assert.deepEqual(stopScopeFor({ workspaceId: 'w' }), { scope: 'workspace', workspaceId: 'w', agentId: null });
});
