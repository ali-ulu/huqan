const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  APPROVAL_REQUEST_SCHEMA,
  APPROVAL_REQUEST_STATUSES,
  APPROVAL_REQUEST_VERDICTS,
  buildApprovalRequest,
  normalizeApprovalRequest,
  validateApprovalRequest,
} = require('../lib/approval-schema');

function baseRequest(overrides = {}) {
  return {
    approvalId: '  apr-001  ',
    workspaceId: '  workspace-a  ',
    agentId: '  agent-1  ',
    actor: '  ali  ',
    owner: '  sonfi  ',
    actionType: '  tool_call  ',
    toolName: '  axiom.learn  ',
    actionPayload: { text: 'HUQAN dış marka ürün kimliğidir' },
    requestedVerdict: '  review  ',
    riskScore: ' 17 ',
    reason: '  demo seed  ',
    provenanceId: '  prov-001  ',
    trustPolicyVersion: ' 0.9.0 ',
    status: ' pending ',
    createdAt: ' 2026-06-11T21:00:00.000Z ',
    expiresAt: ' 2026-06-12T21:00:00.000Z ',
    metadata: { source: 'seed' },
    ...overrides,
  };
}

describe('approval-schema', () => {
  it('exposes stable schema metadata', () => {
    assert.ok(APPROVAL_REQUEST_SCHEMA.required.includes('approvalId'));
    assert.ok(APPROVAL_REQUEST_SCHEMA.required.includes('agentId'));
    assert.ok(APPROVAL_REQUEST_STATUSES.includes('pending'));
    assert.ok(APPROVAL_REQUEST_VERDICTS.includes('review'));
  });

  it('normalizes whitespace and defaults without mutating input', () => {
    const input = baseRequest({ status: ' approved ', requestedVerdict: ' block ' });
    const normalized = normalizeApprovalRequest(input);

    assert.strictEqual(normalized.approvalId, 'apr-001');
    assert.strictEqual(normalized.workspaceId, 'workspace-a');
    assert.strictEqual(normalized.agentId, 'agent-1');
    assert.strictEqual(normalized.actor, 'ali');
    assert.strictEqual(normalized.owner, 'sonfi');
    assert.strictEqual(normalized.actionType, 'tool_call');
    assert.strictEqual(normalized.toolName, 'axiom.learn');
    assert.strictEqual(normalized.requestedVerdict, 'block');
    assert.strictEqual(normalized.riskScore, 17);
    assert.strictEqual(normalized.status, 'approved');
    assert.strictEqual(input.workspaceId, '  workspace-a  ');
    assert.deepStrictEqual(normalized.actionPayload, { text: 'HUQAN dış marka ürün kimliğidir' });
  });

  it('builds a canonical pending request with defaults', () => {
    const built = buildApprovalRequest({
      agentId: 'agent-2',
      actor: 'system',
      owner: 'ali',
      actionType: 'memory_write',
      toolName: 'axiom.learn',
      actionPayload: { text: 'AXIOM bilgi grafiği motorudur' },
      reason: 'identity seed',
      provenanceId: 'prov-002',
      trustPolicyVersion: '0.9.0',
    });

    assert.ok(built.ok, JSON.stringify(built.errors, null, 2));
    assert.strictEqual(built.request.workspaceId, 'default');
    assert.strictEqual(built.request.status, 'pending');
    assert.strictEqual(built.request.requestedVerdict, 'review');
    assert.strictEqual(built.request.riskScore, 0);
    assert.match(built.request.approvalId, /^apr_[a-f0-9]{16}$/);
    assert.ok(Date.parse(built.request.createdAt));
    assert.deepStrictEqual(built.request.metadata, {});
  });

  it('accepts a valid approval request', () => {
    const request = buildApprovalRequest({
      workspaceId: 'workspace-a',
      agentId: 'agent-1',
      actor: 'ali',
      owner: 'sonfi',
      actionType: 'tool_call',
      toolName: 'axiom.verify',
      actionPayload: { statement: 'HUQAN nedir?' },
      requestedVerdict: 'review',
      riskScore: 20,
      reason: 'needs review',
      provenanceId: 'prov-003',
      trustPolicyVersion: '0.9.0',
      status: 'pending',
    }).request;

    const validation = validateApprovalRequest(request);
    assert.ok(validation.ok, JSON.stringify(validation.errors, null, 2));
    assert.strictEqual(validation.request.workspaceId, 'workspace-a');
    assert.strictEqual(validation.request.actionPayload.statement, 'HUQAN nedir?');
  });

  it('rejects invalid payloads cleanly', () => {
    const invalid = validateApprovalRequest({
      workspaceId: 'workspace-a',
      agentId: '',
      actor: '',
      owner: '',
      actionType: 'tool_call',
      toolName: 'axiom.learn',
      actionPayload: null,
      requestedVerdict: 'maybe',
      riskScore: 500,
      reason: '',
      provenanceId: '',
      trustPolicyVersion: '',
      status: 'queued',
      createdAt: 'not-a-date',
    });

    assert.strictEqual(invalid.ok, false);
    assert.ok(invalid.errors.some((error) => error.field === 'agentId'));
    assert.ok(invalid.errors.some((error) => error.field === 'actor'));
    assert.ok(invalid.errors.some((error) => error.field === 'owner'));
    assert.ok(invalid.errors.some((error) => error.field === 'actionPayload'));
    assert.ok(invalid.errors.some((error) => error.field === 'requestedVerdict'));
    assert.ok(invalid.errors.some((error) => error.field === 'riskScore'));
    assert.ok(invalid.errors.some((error) => error.field === 'reason'));
    assert.ok(invalid.errors.some((error) => error.field === 'provenanceId'));
    assert.ok(invalid.errors.some((error) => error.field === 'trustPolicyVersion'));
    assert.ok(invalid.errors.some((error) => error.field === 'status'));
    assert.ok(invalid.errors.some((error) => error.field === 'createdAt'));
  });
});
