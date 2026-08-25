'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const minimal = require('./fixtures/v5/agent-identity/valid.minimal.json');
const { canonicalHash } = require('../lib/a2a/bounded-exchange');
const {
  IDENTITY_RUNTIME_ERRORS,
  composeReceiverOwnedIdentityClaim,
  evaluateAgentIdentity,
  snapshotAgentIdentityAuthority,
} = require('../lib/agent-identity-runtime');

const NOW = Date.parse('2026-08-19T00:00:00.000Z');

function authority(records = [{ ref: 'identity:minimal', record: minimal }]) {
  return snapshotAgentIdentityAuthority({
    workspaceId: 'workspace-alpha',
    identities: records,
    clock: () => NOW,
  });
}

function claim(record, identityRef = 'identity:minimal', delegationChain = [record.agent_id]) {
  return {
    agentId: record.agent_id,
    identityRef,
    identityHash: canonicalHash(record),
    workspaceId: record.workspace_id,
    delegationChain,
  };
}

function action(overrides = {}) {
  return {
    capability: 'verify',
    target: 'memory://read/receipt-agent-valid-minimal',
    riskTier: 'low',
    tool: 'axiom.verify',
    connector: 'local_stdio_mcp',
    ...overrides,
  };
}

test('runtime identity evaluator allows a receiver-owned, bounded action', () => {
  const result = evaluateAgentIdentity({
    authority: authority(),
    claim: claim(minimal),
    action: action(),
  });

  assert.equal(result.allowed, true);
  assert.equal(result.decision, 'allow');
  assert.equal(result.reason, 'ok');
  assert.equal(result.identity.agentId, minimal.agent_id);
  assert.equal(result.identity.workspaceId, minimal.workspace_id);
  assert.deepEqual(result.delegation.chain, [minimal.agent_id]);
});

test('runtime identity evaluator fails closed on workspace mismatch and claim hash tampering', () => {
  const identityAuthority = authority();
  const mismatchedWorkspace = evaluateAgentIdentity({
    authority: identityAuthority,
    claim: { ...claim(minimal), workspaceId: 'workspace-other' },
    action: action(),
  });
  assert.equal(mismatchedWorkspace.reason, IDENTITY_RUNTIME_ERRORS.WORKSPACE_MISMATCH);

  const tamperedHash = evaluateAgentIdentity({
    authority: identityAuthority,
    claim: { ...claim(minimal), identityHash: '0'.repeat(64) },
    action: action(),
  });
  assert.equal(tamperedHash.reason, IDENTITY_RUNTIME_ERRORS.IDENTITY_HASH_INVALID);
});

test('runtime identity evaluator blocks capability, tool, connector and risk escalation', () => {
  const identityAuthority = authority();
  const cases = [
    ['capability', { capability: 'invoke' }, IDENTITY_RUNTIME_ERRORS.CAPABILITY_NOT_ALLOWED],
    ['tool', { tool: 'shell.exec' }, IDENTITY_RUNTIME_ERRORS.TOOL_NOT_ALLOWED],
    ['connector', { connector: 'github' }, IDENTITY_RUNTIME_ERRORS.CONNECTOR_NOT_ALLOWED],
    ['risk', { riskTier: 'medium' }, IDENTITY_RUNTIME_ERRORS.RISK_TIER_EXCEEDED],
  ];
  for (const [, override, reason] of cases) {
    const result = evaluateAgentIdentity({
      authority: identityAuthority,
      claim: claim(minimal),
      action: action(override),
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, reason);
  }
});

test('runtime identity evaluator blocks expired receiver-owned identity', () => {
  const expired = {
    ...minimal,
    expires_at: '2026-08-18T00:00:00.000Z',
  };
  const result = evaluateAgentIdentity({
    authority: authority([{ ref: 'identity:expired', record: expired }]),
    claim: claim(expired, 'identity:expired'),
    action: action(),
  });
  assert.equal(result.allowed, false);
  assert.equal(result.reason, IDENTITY_RUNTIME_ERRORS.EXPIRED);
});

test('runtime identity evaluator preserves delegated scope monotonicity', () => {
  const child = {
    ...minimal,
    agent_id: 'agent-child-001',
    display_name: 'Child Agent',
    owner_actor_id: 'actor-owner-001',
    delegation_scope: ['verify'],
    allowed_tools: ['axiom.verify'],
    allowed_connectors: ['local_stdio_mcp'],
    parent_agent_id: minimal.agent_id,
    delegation_chain: [minimal.agent_id, 'agent-child-001'],
    receipt_refs: ['receipt-agent-child-001'],
    provenance_refs: ['provenance-agent-child-001'],
  };
  const result = evaluateAgentIdentity({
    authority: authority([
      { ref: 'identity:parent', record: minimal },
      { ref: 'identity:child', record: child },
    ]),
    claim: claim(child, 'identity:child', [minimal.agent_id, child.agent_id]),
    action: action(),
  });
  assert.equal(result.allowed, true);
  assert.deepEqual(result.delegation.chain, [minimal.agent_id, child.agent_id]);
});


test('runtime identity evaluator rejects a delegated chain whose first record is not an authority root', () => {
  const parent = {
    ...minimal,
    agent_id: 'agent-parent-001',
    display_name: 'Parent Agent',
    parent_agent_id: 'agent-missing-grandparent',
    delegation_chain: ['agent-missing-grandparent', 'agent-parent-001'],
    receipt_refs: ['receipt-agent-parent-001'],
    provenance_refs: ['provenance-agent-parent-001'],
  };
  const child = {
    ...minimal,
    agent_id: 'agent-child-001',
    display_name: 'Child Agent',
    parent_agent_id: parent.agent_id,
    delegation_chain: [parent.agent_id, 'agent-child-001'],
    receipt_refs: ['receipt-agent-child-001'],
    provenance_refs: ['provenance-agent-child-001'],
  };
  const result = evaluateAgentIdentity({
    authority: authority([
      { ref: 'identity:parent', record: parent },
      { ref: 'identity:child', record: child },
    ]),
    claim: claim(child, 'identity:child', [parent.agent_id, child.agent_id]),
    action: action(),
  });

  assert.equal(result.allowed, false);
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, IDENTITY_RUNTIME_ERRORS.DELEGATION_CHAIN_INVALID);
});

test('receiver-owned claim composition derives identity fields from the authority snapshot', () => {
  const identityAuthority = authority();
  const result = composeReceiverOwnedIdentityClaim({
    authority: identityAuthority,
    identityRef: 'identity:minimal',
    receiver: { subject: minimal.owner_actor_id, kind: 'receiver', workspaceId: minimal.workspace_id },
  });

  assert.equal(result.allowed, true);
  assert.deepEqual(Object.keys(result.claim).sort(), [
    'agentId', 'delegationChain', 'identityHash', 'identityRef', 'workspaceId',
  ]);
  assert.equal(result.claim.agentId, minimal.agent_id);
  assert.deepEqual(result.claim.delegationChain, [minimal.agent_id]);
});

test('receiver-owned claim composition fails closed on workspace and subject drift', () => {
  const identityAuthority = authority();
  const workspaceMismatch = composeReceiverOwnedIdentityClaim({
    authority: identityAuthority,
    identityRef: 'identity:minimal',
    receiver: { subject: minimal.owner_actor_id, kind: 'receiver', workspaceId: 'workspace-other' },
  });
  assert.equal(workspaceMismatch.reason, IDENTITY_RUNTIME_ERRORS.WORKSPACE_MISMATCH);

  const subjectMismatch = composeReceiverOwnedIdentityClaim({
    authority: identityAuthority,
    identityRef: 'identity:minimal',
    receiver: { subject: 'caller-controlled', kind: 'receiver', workspaceId: minimal.workspace_id },
  });
  assert.equal(subjectMismatch.reason, IDENTITY_RUNTIME_ERRORS.IDENTITY_UNKNOWN);
});

test('package root exposes the same Agent Identity Runtime seam', () => {
  const pkg = require('..');
  const direct = require('../lib/agent-identity-runtime.js');

  assert.equal(pkg.AgentIdentityRuntime, direct);
  assert.equal(pkg.evaluateAgentIdentity, direct.evaluateAgentIdentity);
  assert.equal(pkg.snapshotAgentIdentityAuthority, direct.snapshotAgentIdentityAuthority);
  assert.equal(pkg.composeReceiverOwnedIdentityClaim, direct.composeReceiverOwnedIdentityClaim);
  assert.equal(pkg.AGENT_IDENTITY_RUNTIME_VERSION, direct.AGENT_IDENTITY_RUNTIME_VERSION);
});
